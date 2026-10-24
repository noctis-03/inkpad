// 문서(text 모드): 새로 만들기 → 블록 편집(마크다운 단축키·나누기·합치기·들여쓰기·슬래시·번호·할 일·토글·되돌리기·서식·붙여넣기·끌기·메뉴)
// → 저장·다시 열기·HTML 정리 → 카드 → 동기화 대상 → .inkpad 왕복
import type { Page } from 'playwright'
import { device, sleep, type Ctx } from './lib.ts'

type B = { id: string; type: string; indent: number; html: string; checked?: boolean; collapsed?: boolean }
type W = { inkpadText: { blocks: B[]; flush: () => Promise<void>; input: (id: string, html: string) => void } }

export default async function textdoc(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  const errs: string[] = []
  p.on('pageerror', (e) => errs.push(String(e)))

  // ── 새로 만들기 → 문서 ──
  await p.click('#new-doc-btn')
  await p.getByRole('button', { name: /문서\s*키보드로 쓰는 블록 문서/ }).click()
  check('새로 만들기: 문서 카드를 고르면 속지·페이지 설정이 숨음', (await p.locator('.paper-picker').count()) === 0)
  await p.fill('#new-doc-title', '')
  await p.click('#create-doc-btn')
  await p.waitForSelector('.tdoc-title', { timeout: 15000 })
  await p.waitForFunction(() => !!(window as unknown as W).inkpadText)
  await sleep(500)
  const blocks = () => p.evaluate(() => (window as unknown as W).inkpadText.blocks.map((b) => ({ ...b })))
  const types = async () => (await blocks()).map((b) => b.type + (b.indent ? `>${b.indent}` : ''))
  const texts = async () => p.evaluate(() => [...document.querySelectorAll('.tdoc-blocks .tb-text')].map((e) => e.textContent ?? ''))
  check('빈 문단 하나로 시작', (await types()).join() === 'p')

  // ── 제목 ──
  await p.click('.tdoc-title')
  await p.keyboard.type('회의 메모')
  await p.keyboard.press('Enter') // 제목에서 Enter → 첫 블록
  await sleep(500)
  const docId = await p.evaluate(() => location.hash.split('/').pop()!)
  check('제목 → 문서 이름', (await p.evaluate(async (id) => (await (await import('/src/storage/db.ts')).db.documents.get(id))?.title, docId)) === '회의 메모')

  // ── 마크다운 단축키 ──
  const kb = p.keyboard
  await kb.type('# 큰 제목')
  await kb.press('Enter')
  await kb.type('## 중간')
  await kb.press('Enter')
  await kb.type('### 작은')
  await kb.press('Enter')
  await kb.type('- 글머리')
  await kb.press('Enter')
  await kb.type('안쪽')
  await kb.press('Tab')
  await kb.press('Enter')
  await kb.press('Enter') // 빈 안쪽 줄 → 한 단계 밖으로
  await kb.press('Enter') // 빈 글머리 → 문단
  await kb.type('1. 하나')
  await kb.press('Enter')
  await kb.type('둘')
  await kb.press('Enter')
  await kb.press('Enter')
  await kb.type('[] 할 일')
  await kb.press('Enter')
  await kb.press('Enter')
  await kb.type('> 인용')
  await kb.press('Enter')
  await kb.type('>> 토글')
  await kb.press('Enter') // 펼친 토글에서 Enter → 안쪽 줄
  await kb.type('토글 안')
  await kb.press('Enter')
  await kb.press('Shift+Tab')
  await kb.type('```')
  await kb.type('let a = 1')
  await kb.press('Shift+Enter') // 코드에서 나가기
  await kb.type('---')
  await kb.type('끝')
  await sleep(200)
  const t1 = await types()
  check(
    '단축키: # ## ### - Tab 1. [] > >> ``` ---',
    t1.join() === ['h1', 'h2', 'h3', 'bullet', 'bullet>1', 'number', 'number', 'todo', 'quote', 'toggle', 'p>1', 'code', 'divider', 'p'].join(),
    t1.join()
  )
  check('…빈 목록 줄 Enter는 밖으로 → 문단으로', !t1.includes('bullet>1') || t1.filter((x) => x.startsWith('bullet')).length === 2)
  check('…접두어는 지워짐', (await texts()).slice(0, 4).join('|') === '큰 제목|중간|작은|글머리', (await texts()).join('|'))

  // ── 번호 ──
  const nums = await p.evaluate(() => [...document.querySelectorAll('.tb-number')].map((e) => e.textContent))
  check('번호 목록 1. 2.', nums.join() === '1.,2.', nums.join())

  // ── 나누기·합치기 ──
  await kb.type('앞뒤')
  await kb.press('ArrowLeft')
  await kb.press('Enter')
  let tx = await texts()
  check('캐럿에서 Enter → 둘로 나눔', tx.slice(-2).join('|') === '끝앞|뒤', tx.slice(-2).join('|'))
  await kb.press('Backspace') // 맨 앞에서 Backspace → 위와 합치기
  tx = await texts()
  check('맨 앞 Backspace → 위 블록과 합침', tx[tx.length - 1] === '끝앞뒤', tx[tx.length - 1])
  await kb.type('!')
  tx = await texts()
  check('…캐럿은 합친 자리', tx[tx.length - 1] === '끝앞!뒤', tx[tx.length - 1])

  // ── 되돌리기 ──
  const before = (await blocks()).length
  await kb.press('End')
  await kb.press('Enter')
  await kb.type('새 줄')
  await sleep(900) // 입력 묶음이 닫히게
  await kb.press('Control+z')
  await kb.press('Control+z')
  check('Ctrl+Z → 입력과 나누기를 되돌림', (await blocks()).length === before, String((await blocks()).length))
  await kb.press('Control+Shift+z')
  check('Ctrl+Shift+Z → 다시', (await blocks()).length === before + 1)
  await kb.press('Control+z')

  // ── 슬래시 메뉴 ──
  await kb.press('End')
  await kb.press('Enter')
  await kb.type('/')
  check('/ → 메뉴', (await p.locator('.tdoc-slash').count()) === 1)
  await kb.type('할일')
  const first = await p.locator('.tdoc-slash-item.is-current b').textContent()
  check('…검색어로 거름', first === '할 일', first ?? '')
  await kb.press('Enter')
  await kb.type('메뉴로 만든 할 일')
  let bl = await blocks()
  check('…고르면 블록이 바뀌고 /검색어는 지워짐', bl[bl.length - 1].type === 'todo' && (await texts()).slice(-1)[0] === '메뉴로 만든 할 일')

  // ── 할 일 체크 ──
  await p.locator('.tb-row.t-todo .tb-check').last().click()
  bl = await blocks()
  check('체크 상자 → 했음', bl[bl.length - 1].checked === true)

  // ── 토글 접기 ──
  await p.locator('.tb-row.t-toggle .tb-toggle').click()
  check('토글 접기 → 안쪽 줄 숨김', !(await texts()).includes('토글 안'))
  await p.locator('.tb-row.t-toggle .tb-toggle').click()
  check('토글 펼치기 → 다시 보임', (await texts()).includes('토글 안'))

  // ── 굵게 (문단) · 제목에서는 그대로 ──
  await p.locator('.tb-row.t-h2 .tb-text').click()
  await kb.press('End')
  await kb.press('Shift+Home')
  await kb.press('Control+b')
  bl = await blocks()
  check('제목에서 Ctrl+B → 바뀌지 않음 (이미 굵다)', bl[1].html === '중간', bl[1].html)
  const lastP = (await blocks()).filter((b) => b.type === 'p').slice(-1)[0]
  await p.locator(`.tb-row[data-id="${lastP.id}"] .tb-text`).click()
  await kb.press('End')
  await kb.press('Shift+Home')
  await kb.press('Control+b')
  check('문단에서 Ctrl+B → 굵게', (await blocks()).find((b) => b.id === lastP.id)?.html === '<b>끝앞!뒤</b>', (await blocks()).find((b) => b.id === lastP.id)?.html)

  // ── 여러 줄 붙여넣기 ──
  await p.locator('.tb-row.t-h3 .tb-text').click()
  await kb.press('End')
  await p.evaluate(() => {
    const dt = new DataTransfer()
    dt.setData('text/plain', '\n- 붙인 하나\n- 붙인 둘\n[x] 끝낸 일')
    document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  bl = await blocks()
  const pasted = bl.slice(2, 6).map((b) => b.type + (b.checked ? '✓' : ''))
  check('여러 줄 붙여넣기 → 줄마다 블록 (마크다운 표시 반영)', pasted.join() === 'h3,bullet,bullet,todo✓', pasted.join())

  // ── 끌어서 순서 바꾸기 (손잡이) ──
  const quoteId = bl.find((b) => b.type === 'quote')!.id
  const grip = p.locator(`.tb-row[data-id="${quoteId}"] .tb-grip`)
  await p.locator(`.tb-row[data-id="${quoteId}"]`).hover()
  const gb = (await grip.boundingBox())!
  const topRow = (await p.locator('.tb-row').first().boundingBox())!
  await p.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2)
  await p.mouse.down()
  await p.mouse.move(gb.x + gb.width / 2, topRow.y + 3, { steps: 10 })
  await p.mouse.up()
  bl = await blocks()
  check('손잡이 끌기 → 맨 위로', bl[0].id === quoteId, bl.map((b) => b.type).join())
  await kb.press('Control+z')
  check('…되돌리기', (await blocks())[0].id !== quoteId)

  // ── 손잡이 누르기 → 메뉴 (복제·바꾸기·삭제) ──
  const n0 = (await blocks()).length
  await p.locator(`.tb-row[data-id="${quoteId}"]`).hover()
  await grip.click()
  await p.getByRole('menuitem', { name: '복제' }).click()
  check('메뉴 → 복제', (await blocks()).length === n0 + 1)
  await p.locator(`.tb-row[data-id="${quoteId}"]`).hover()
  await grip.click()
  await p.getByRole('menuitem', { name: '제목 1(으)로 바꾸기' }).click()
  check('메뉴 → 종류 바꾸기', (await blocks()).find((b) => b.id === quoteId)?.type === 'h1')
  await p.locator(`.tb-row[data-id="${quoteId}"]`).hover()
  await grip.click()
  await p.getByRole('menuitem', { name: '삭제' }).click()
  check('메뉴 → 삭제', !(await blocks()).some((b) => b.id === quoteId))

  // ── HTML 정리: 허용하지 않는 태그·속성은 저장 때 빠진다 ──
  const dirtyId = (await blocks())[0].id
  await p.evaluate((id) => (window as unknown as W).inkpadText.input(id, '<span style="font-weight:bold">굵</span><img src=x onerror="alert(1)"><a href="javascript:alert(1)">나쁜</a><a href="https://example.com">좋은</a><script>x()</script>'), dirtyId)
  await p.evaluate(() => (window as unknown as W).inkpadText.flush())
  const stored = await p.evaluate(async (id) => (await (await import('/src/storage/db.ts')).db.textBlocks.get(id))?.html, dirtyId)
  check('저장 때 HTML 정리 (script·img·javascript: 링크 제거)', stored === '<b>굵</b>나쁜<a href="https://example.com/">좋은</a>x()', stored ?? '')

  // ── 다시 열기 ──
  const saved = (await blocks()).map((b) => [b.id, b.type, b.indent, b.checked ?? false].join(':'))
  await p.goto(`${base}/#/`)
  await p.waitForSelector('#new-doc-btn')
  await sleep(600)
  await p.goto(`${base}/#/doc/${docId}`)
  await p.waitForFunction(() => !!(window as unknown as W).inkpadText && !!document.querySelector('.tdoc-blocks .tb-row'))
  await sleep(200)
  const again = (await blocks()).map((b) => [b.id, b.type, b.indent, b.checked ?? false].join(':'))
  check('다시 열면 그대로 (종류·들여쓰기·체크)', again.join() === saved.join(), `${again.length} vs ${saved.length}`)
  check('…제목도', (await p.locator('.tdoc-title').textContent()) === '회의 메모')

  // ── 카드: 메타 '문서', 미리보기 ──
  await p.locator('button[aria-label="문서 목록"]').click()
  await p.waitForSelector('#new-doc-btn')
  await sleep(800)
  const thumb = await p.evaluate(async (id) => !!(await (await import('/src/storage/db.ts')).db.thumbnails.get(id)), docId)
  check('문서를 닫으면 카드 미리보기가 생김', thumb)
  await p.click('.lib-view-btn[aria-label="목록 보기"]').catch(() => {})
  const meta = await p.evaluate(() => document.body.innerText.includes('문서 ·'))
  check('카드 메타에 "문서"', meta)

  // ── 동기화 대상 (노트와 같게) ──
  const sync = await p.evaluate(async (id) => {
    const s = await import('/src/sync/sync.ts')
    const plan = await s.planPush()
    const states = await s.cardSyncStates()
    return { inPlan: plan.docs.some((d: { docId: string }) => d.docId === id), dot: states.has(id) }
  }, docId)
  check('문서도 올릴 것·카드 점에 들어감', sync.inPlan && sync.dot, JSON.stringify(sync))

  // ── .inkpad 왕복 ──
  const round = await p.evaluate(async (id) => {
    const io = await import('/src/io/inkpadFormat.ts')
    const repo = await import('/src/storage/repo.ts')
    const blob = await io.exportInkpad([id], 'document')
    const r = await io.importInkpad(blob, null)
    const nd = r.documents[0]
    const a = (await repo.loadTextBlocks(id)).map((b) => [b.type, b.indent, b.html, !!b.checked].join(':'))
    const b = (await repo.loadTextBlocks(nd.id)).map((b) => [b.type, b.indent, b.html, !!b.checked].join(':'))
    return { mode: nd.mode, same: a.join('\n') === b.join('\n'), n: b.length }
  }, docId)
  check('.inkpad 내보내기 → 가져오기: 블록 그대로', round.mode === 'text' && round.same && round.n > 10, JSON.stringify(round))

  check('문서: 페이지 오류 없음', errs.length === 0, errs.join(' | '))
  await p.context().close()
}

export type { Page }
