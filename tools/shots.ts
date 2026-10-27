/**
 * 화면 스크린샷 — UI 손볼 때 전후 비교용 (docs/ui-plan.md 0단계).
 *
 * 실행:  npm run shots                  → shots/<이름>/ 에 화면 × 크기 × 테마 PNG
 *        npm run shots -- before        (폴더 이름, 기본 'now')
 *        npm run shots -- after library editor   (화면 이름으로 골라 찍기)
 *        npm run shots -- now --audit   (찍으면서 화면마다 점검 — 32px보다 작은 누름 대상, 대비 4.5:1 미만 글자 → audit.json)
 *
 * 개발 서버를 띄우고, 기기마다 같은 예시 데이터(카테고리·노트·문서)를 DB에 넣고 가짜 Drive(e2e/fake-drive.ts)에 올린 뒤 찍는다.
 * shots/ 는 저장소에 올리지 않는다(.gitignore).
 */
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Page } from 'playwright'
import { launch, sleep, addStroke, openEditor } from './e2e/lib.ts'
import { createFakeDrive } from './e2e/fake-drive.ts'

const VIEWPORTS = {
  pad: { width: 1180, height: 820, touch: true }, // iPad Air 가로
  padv: { width: 820, height: 1180, touch: true }, // iPad Air 세로
  phone: { width: 390, height: 844, touch: true }
} as const
const THEMES = ['light', 'dark'] as const

type Seed = { paged: string; infinite: string; text: string; app: string; all: string[] }

/** 예시 데이터 — 카테고리 묶음·여러 노트·문서 */
async function seed(p: Page): Promise<Seed> {
  const ids = await p.evaluate(async () => {
    const r = await import('/src/storage/repo.ts')
    const m = await import('/src/shared/model.ts')
    const A4 = { w: 595.28, h: 841.89 }
    const mk = (title: string, category: string | null, bg = 'lined', pages = 2) =>
      r.createDocument({ title, mode: 'paged', folderId: null, category, pages: Array.from({ length: pages }, () => ({ size: A4, background: m.makeBackground(bg as 'lined') })) })
    const docs = [
      await mk('디지털 시스템 3주차', '[과제] 디지털 시스템', 'grid', 4),
      await mk('플립플롭 정리', '[시험] 디지털 시스템', 'lined', 3),
      await mk('회로 실습 보고서', '[과제] 회로 실습', 'dot'),
      await mk('독서 메모', '개인', 'lined'),
      await mk('아이디어 스케치', '개인', 'blank', 1),
      await mk('주간 계획', null, 'cornell', 1),
      await mk('영어 단어', '어학', 'lined', 5),
      await mk('수학 오답노트', '[시험] 수학', 'grid', 6)
    ]
    const inf = await r.createDocument({ title: '무한 캔버스 마인드맵', mode: 'infinite', folderId: null, category: '개인', pages: [{ size: null, background: m.makeBackground('dot') }] })
    const text = await r.createDocument({ title: '회의 메모', mode: 'text', folderId: null, category: '개인', pages: [] })
    const app = (await (await import('/src/sync/apps.ts')).addApp(new File(['<title>단어 카드</title><body style="font:16px system-ui;padding:24px">단어 카드 앱</body>'], '단어 카드.html', { type: 'text/html' }), '어학')).app.id
    return { paged: docs[0].id, infinite: inf.id, text: text.id, app, all: docs.map((d) => d.id) }
  })
  for (const id of ids.all) for (let i = 0; i < 6; i++) await addStroke(p, id, `s-${id}-${i}`)
  // 가짜 Drive에 올려 둔다 — 동기화 화면에 클라우드 노트가 보이게. 앞 두 노트는 올린 뒤 더 고쳐 '올릴 것'이 남는다
  await p.evaluate(async () => (await import('/src/sync/sync.ts')).pushNow())
  return ids
}

const push = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pushNow())

/** 다른 기기(같은 가짜 Drive)가 첫 노트를 고쳐 올린 뒤 이 기기도 고쳐 올린다 — 갈라짐 → 머지 관리에 한 줄.
 *  그다음 앞 두 노트를 더 고쳐 '올릴 것'이 남게 한다 */
async function diverge(p: Page, other: Page, s: Seed) {
  await other.evaluate(async () => (await import('/src/sync/sync.ts')).pullNow())
  await addStroke(other, s.paged, 's-pad')
  await push(other)
  await addStroke(p, s.paged, 's-pc')
  await push(p)
  for (const id of s.all.slice(0, 2)) await addStroke(p, id, `s-${id}-after`)
}

/** 화면 점검(4단계) — 페이지 안에서 돈다. 같은 모양(태그·클래스·이름)은 한 번만 */
function auditPage() {
  const vis = (e: Element) => {
    const r = e.getBoundingClientRect()
    if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false
    for (let n: Element | null = e; n; n = n.parentElement) {
      const cs = getComputedStyle(n)
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) return false
    }
    return true
  }
  const sig = (e: Element) => {
    const cls = [...e.classList].filter((c) => !/^is-|^on$|^hot$/.test(c)).slice(0, 3).join('.')
    const name = (e.getAttribute('aria-label') || (e as HTMLElement).innerText || (e as HTMLInputElement).placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 24)
    return `${e.tagName.toLowerCase()}${cls ? '.' + cls : ''}${name ? ` "${name}"` : ''}`
  }
  const small: Record<string, string> = {}
  for (const e of document.querySelectorAll('button, a[href], [role=button], [role=menuitem], [role=menuitemradio], [role=radio], [role=tab], input:not([type=hidden]), select, summary')) {
    if (!vis(e) || (e as HTMLButtonElement).disabled) continue
    const r = e.getBoundingClientRect()
    // ::after로 넓힌 누름 영역(inset 음수)까지 — 보이는 크기는 작아도 손가락이 닿는 영역
    const a = getComputedStyle(e, '::after')
    const out = (v: string) => (a.content !== 'none' && a.position === 'absolute' ? Math.max(0, -parseFloat(v) || 0) : 0)
    const w = r.width + out(a.left) + out(a.right)
    const h = r.height + out(a.top) + out(a.bottom)
    // 입력칸은 둘레 상자(검색창 등)가 누름 대상이다 — 상자 높이로 잰다
    const box = e.tagName === 'INPUT' && e.parentElement ? e.parentElement.getBoundingClientRect() : null
    const hh = box ? Math.max(h, box.height) : h
    if (w < 32 || hh < 32) small[sig(e)] = `${Math.round(w)}×${Math.round(hh)}`
  }
  // 대비 — 글자를 직접 품은 요소의 글자색 vs 위로 올라가며 처음 만나는 불투명 바탕(그림·그라데이션 바탕이면 건너뛴다)
  // rgb(…)는 0–255, color-mix 결과인 color(srgb …)는 0–1
  const rgb = (s: string) => {
    const v = (s.match(/[\d.]+/g) ?? []).map(Number)
    return s.startsWith('color(srgb') ? [...v.slice(0, 3).map((x) => x * 255), ...v.slice(3)] : v
  }
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const low: Record<string, string> = {}
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const seen = new Set<Element>()
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement
    // 비활성 컨트롤의 글자는 대비 기준(WCAG 1.4.3)의 예외라 건너뛴다
    if (!el || seen.has(el) || !n.textContent?.trim() || el.closest('svg, canvas, iframe, .doc-thumb, .board-item, .merge-canvas, button:disabled, [aria-disabled="true"]')) continue
    seen.add(el)
    if (!vis(el)) continue
    const cs = getComputedStyle(el)
    let fg = rgb(cs.color)
    if (fg.length < 3) continue
    let bg: number[] | null = null
    let alpha = (fg[3] ?? 1) * Number(cs.opacity)
    for (let a: Element | null = el; a; a = a.parentElement) {
      const s = getComputedStyle(a)
      if (a !== el) alpha *= Number(s.opacity)
      if (s.backgroundImage !== 'none') break
      const c = rgb(s.backgroundColor)
      if (c.length >= 3 && (c[3] ?? 1) > 0.5) { // 반투명 판(서랍·떠 있는 막대)도 바탕으로 — 그 위 조상까지 올라가면 엉뚱한 색과 비교한다
        bg = c
        break
      }
    }
    if (!bg) continue
    fg = fg.slice(0, 3).map((v, i) => v * alpha + bg![i] * (1 - alpha)) // 반투명 글자는 바탕과 섞는다
    const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a)
    const ratio = (l1 + 0.05) / (l2 + 0.05)
    const size = parseFloat(cs.fontSize)
    const big = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700)
    if (ratio < (big ? 3 : 4.5)) low[sig(el)] = `${ratio.toFixed(2)}:1 · ${size}px`
  }
  return { small, low }
}

async function settle(p: Page, ms = 700) {
  await p.evaluate(() => document.fonts?.ready)
  await sleep(ms)
}

/** 화면 이름 → 찍기 직전까지 이동. 홈(라이브러리)에서 시작한다 */
const SCREENS: Record<string, (p: Page, base: string, s: Seed) => Promise<void>> = {
  library: async () => {},
  'library-menu': async (p) => {
    await p.click('[aria-label="카테고리"], [aria-label="폴더 목록"]', { timeout: 3000 }).catch(() => {})
  },
  'library-list': async (p) => {
    await p.getByRole('radio', { name: '목록' }).click({ timeout: 3000 })
  },
  'library-group': async (p) => {
    // 카테고리 묶음 머리글 이름 → 묶음 화면(태그별 소제목)
    await p.locator('.tree-group-main').first().click({ timeout: 3000 })
  },
  'library-select': async (p) => {
    // 카드를 꾹 누르면 선택 모드
    const b = (await p.locator('.doc-card .doc-thumb').first().boundingBox())!
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await p.mouse.down()
    await sleep(700)
    await p.mouse.up()
  },
  'new-doc': async (p) => {
    await p.click('#new-doc-btn')
  },
  settings: async (p) => {
    // 휴대폰 폭에서는 설정이 ⋯(보기·정렬) 메뉴 안에 있다
    if (await p.locator('[aria-label="설정"]:visible').count()) await p.click('[aria-label="설정"]:visible')
    else {
      await p.click('[aria-label="보기·정렬"]')
      await p.getByRole('menuitem', { name: /설정/ }).click()
    }
  },
  'settings-storage': async (p) => {
    await SCREENS.settings(p, '', {} as Seed)
    await p.locator('.sheet-header button', { hasText: '저장소' }).click()
  },
  history: async (p, base, s) => {
    await openEditor(p, base, s.paged)
    await p.click('.toolbar-doc [aria-label="더보기"]')
    await p.getByRole('menuitem', { name: /버전 기록/ }).click()
  },
  sync: async (p) => {
    await p.click('.sync-btn')
  },
  'sync-sheet': async (p) => {
    await p.click('.sync-btn')
    await p.getByRole('menuitem', { name: /동기화 관리/ }).click()
  },
  assets: async (p) => {
    await p.click('.sync-btn')
    await p.getByRole('menuitem', { name: /에셋 원본/ }).click()
  },
  editor: async (p, base, s) => {
    await openEditor(p, base, s.paged)
  },
  'editor-pages': async (p, base, s) => {
    await openEditor(p, base, s.paged)
    await p.click('[aria-label="페이지 목록"]').catch(() => {})
  },
  'editor-more': async (p, base, s) => {
    await openEditor(p, base, s.paged)
    await p.locator('.ft-bar [aria-label="더보기"]').first().click().catch(() => {})
  },
  infinite: async (p, base, s) => {
    await openEditor(p, base, s.infinite)
  },
  textdoc: async (p, base, s) => {
    await p.goto(`${base}/#/doc/${s.text}`)
    await p.waitForSelector('.tdoc-title', { timeout: 15000 })
    // 처음 한 번만 내용을 적는다 (같은 기기에서 다시 찍으면 그대로 보인다)
    if ((await p.locator('.tdoc-blocks .tb-text').first().innerText()).trim() === '') {
      await p.click('.tdoc-blocks .tb-text')
      for (const line of ['# 안건', '- 디자인 토큰 정리', '밀도 한 단계', '', '[] 다음 회의 전에 스크린샷 비교', '', '> 메모: 펜 대상은 40px 밑으로 줄이지 않는다']) {
        if (line) await p.keyboard.type(line)
        await p.keyboard.press('Enter')
      }
      await p.locator('.tdoc-title').click()
    }
  },
  board: async (p, base) => {
    await p.goto(`${base}/#/board`)
  },
  'board-edit': async (p, base) => {
    await p.goto(`${base}/#/board`)
    await p.locator('.board-topbar-center button', { hasText: '편집' }).click()
  },
  merge: async (p, _base, s) => {
    await p.evaluate(async (docId) => {
      const entry = (await (await import('/src/sync/sync.ts')).listMergeQueue()).find((e) => e.docId === docId && e.mine)
      if (!entry) throw new Error('머지할 것이 없다')
      ;(await import('/src/ui/merge/MergeView.tsx')).openMergeView(entry)
    }, s.paged)
    await p.waitForSelector('.merge-view .merge-canvas', { timeout: 15000 })
  },
  app: async (p, _base, s) => {
    await p.evaluate(async (id) => (await import('/src/app/store.ts')).useUI.getState().navigate({ name: 'app', appId: id }), s.app)
    await p.waitForSelector('.app-runner-bar', { timeout: 15000 })
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const outName = args[0] && !SCREENS[args[0]] ? args.shift()! : 'now'
const pick = args.length ? args : Object.keys(SCREENS)
for (const n of pick) if (!SCREENS[n]) throw new Error(`모르는 화면: ${n} (있는 것: ${Object.keys(SCREENS).join(', ')})`)
const doAudit = process.argv.includes('--audit')
const report: Record<string, ReturnType<typeof auditPage>> = {}
const outDir = join(root, 'shots', outName)
mkdirSync(outDir, { recursive: true })

const server = await createServer({ root, logLevel: 'silent', server: { port: 0, host: '127.0.0.1' } })
await server.listen()
const addr = server.httpServer!.address()
const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 5173}`
const browser = await launch()
let n = 0
try {
  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    for (const theme of THEMES) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2, hasTouch: vp.touch, colorScheme: theme })
      const drive = createFakeDrive()
      await drive.attach(context) // 네트워크·계정 없이 동기화 화면을 채운다
      const p = await context.newPage()
      await p.goto(base + '/')
      await p.waitForSelector('#root *')
      await p.evaluate(() => localStorage.setItem('inkpad.installHint', '1'))
      const s = await seed(p)
      // 갈라짐을 만들 다른 기기 — 저장소가 따로인 컨텍스트, 같은 가짜 Drive
      const otherCtx = await browser.newContext({ viewport: { width: 800, height: 600 } })
      await drive.attach(otherCtx)
      const other = await otherCtx.newPage()
      await other.goto(base + '/')
      await other.waitForSelector('#root *')
      await diverge(p, other, s)
      await otherCtx.close()
      for (const name of pick) {
        try {
          await p.goto(base + '/')
          await p.waitForSelector('.doc-card', { timeout: 15000 })
          await settle(p, 400)
          await SCREENS[name](p, base, s)
          await settle(p)
          await p.screenshot({ path: join(outDir, `${name}.${vpName}.${theme}.png`) })
          if (doAudit) report[`${name}.${vpName}.${theme}`] = await p.evaluate(auditPage)
          n++
        } catch (e) {
          console.error(`✗ ${name} ${vpName} ${theme}: ${(e as Error).message.split('\n')[0]}`)
        }
      }
      await context.close()
    }
  }
} finally {
  await browser.close()
  await server.close()
}
console.log(`${n}장 → ${outDir}`)
if (doAudit) {
  writeFileSync(join(outDir, 'audit.json'), JSON.stringify(report, null, 1))
  // 화면을 가로질러 모은 요약 — 같은 문제는 한 줄, 나온 화면 수와 함께
  for (const kind of ['small', 'low'] as const) {
    const all = new Map<string, Set<string>>()
    for (const [shot, r] of Object.entries(report)) for (const [k, v] of Object.entries(r[kind])) all.set(`${k} — ${v.split(' · ')[0]}`, (all.get(`${k} — ${v.split(' · ')[0]}`) ?? new Set()).add(shot.split('.')[0]))
    console.log(`\n${kind === 'small' ? '32px보다 작은 누름 대상' : '대비 부족 글자'}: ${all.size}종`)
    for (const [k, s] of [...all].sort()) console.log(`  ${k}  [${[...s].join(', ')}]`)
  }
}
