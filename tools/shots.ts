/**
 * 화면 스크린샷 — UI 손볼 때 전후 비교용 (docs/ui-plan.md 0단계).
 *
 * 실행:  npm run shots                  → shots/<이름>/ 에 화면 × 크기 × 테마 PNG
 *        npm run shots -- before        (폴더 이름, 기본 'now')
 *        npm run shots -- after library editor   (화면 이름으로 골라 찍기)
 *
 * 개발 서버를 띄우고, 기기마다 같은 예시 데이터(카테고리·노트·문서)를 DB에 넣고 가짜 Drive(e2e/fake-drive.ts)에 올린 뒤 찍는다.
 * shots/ 는 저장소에 올리지 않는다(.gitignore).
 */
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { Page } from 'playwright'
import { launch, sleep, addStroke, openEditor } from './e2e/lib.ts'
import { createFakeDrive } from './e2e/fake-drive.ts'

const VIEWPORTS = {
  pad: { width: 1180, height: 820, touch: true }, // iPad Air 가로
  padv: { width: 820, height: 1180, touch: true }, // iPad Air 세로
  phone: { width: 390, height: 844, touch: true }
} as const
const THEMES = ['light', 'dark'] as const

type Seed = { paged: string; infinite: string; text: string }

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
    return { paged: docs[0].id, infinite: inf.id, text: text.id, all: docs.map((d) => d.id) }
  })
  for (const id of ids.all) for (let i = 0; i < 6; i++) await addStroke(p, id, `s-${id}-${i}`)
  // 가짜 Drive에 올려 둔다 — 동기화 화면에 클라우드 노트가 보이게. 앞 두 노트는 올린 뒤 더 고쳐 '올릴 것'이 남는다
  await p.evaluate(async () => (await import('/src/sync/sync.ts')).pushNow())
  for (const id of ids.all.slice(0, 2)) await addStroke(p, id, `s-${id}-after`)
  return ids
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
  },
  board: async (p, base) => {
    await p.goto(`${base}/#/board`)
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const outName = args[0] && !SCREENS[args[0]] ? args.shift()! : 'now'
const pick = args.length ? args : Object.keys(SCREENS)
for (const n of pick) if (!SCREENS[n]) throw new Error(`모르는 화면: ${n} (있는 것: ${Object.keys(SCREENS).join(', ')})`)
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
      await createFakeDrive().attach(context) // 네트워크·계정 없이 동기화 화면을 채운다
      const p = await context.newPage()
      await p.goto(base + '/')
      await p.waitForSelector('#root *')
      await p.evaluate(() => localStorage.setItem('inkpad.installHint', '1'))
      const s = await seed(p)
      for (const name of pick) {
        try {
          await p.goto(base + '/')
          await p.waitForSelector('.doc-card', { timeout: 15000 })
          await settle(p, 400)
          await SCREENS[name](p, base, s)
          await settle(p)
          await p.screenshot({ path: join(outDir, `${name}.${vpName}.${theme}.png`) })
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
