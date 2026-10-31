// 일정 — 할 일과 캘린더 (#/plan). 라이브러리 사이드바에서 열고, 빠른 추가·끝내기·자세히(제목·마감·카테고리·메모)·
// 휴지통(되돌리기·되살리기·30일 정리)·주·월(그날 만든 노트·그날을 마지막으로 고친 노트)·연결한 노트 열기·다시 열어도 남는지
import type { Page } from 'playwright'
import { createDoc, device, logsOf, sleep, type Ctx } from './lib.ts'

const tasks = (p: Page) =>
  p.evaluate(async () => (await (await import('/src/storage/tasks.ts')).listTasks()).map((t) => ({ id: t.id, title: t.title, due: t.due, done: !!t.doneAt, deleted: !!t.deletedAt, memo: t.memo, category: t.category, ts: t.ts })))
const dayKey = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const rowTitles = (p: Page) => p.locator('.plan-main .task-title').allInnerTexts()
const sideCount = (p: Page, label: string) => p.locator('.plan-side .tree-item', { hasText: label }).locator('.count').innerText()

export default async function plan(ctx: Ctx) {
  const { check, base } = ctx
  const p = await device(ctx)
  const noteId = await createDoc(p, '디지털 시스템 3주차')
  // 이틀 전에 만들고 오늘 마지막으로 고친 노트
  const oldId = await createDoc(p, '회로 정리')
  await p.evaluate(async (id) => {
    const { db } = await import('/src/storage/db.ts')
    await db.documents.update(id, { createdAt: Date.now() - 2 * 86400_000 })
  }, oldId)
  await p.reload()
  await p.waitForSelector('.lib-side')

  // ── 라이브러리 사이드바에서 연다 ──
  await p.locator('.lib-side .side-link', { hasText: '일정' }).click()
  await p.waitForSelector('.plan')
  check('라이브러리 사이드바 「일정」으로 연다 (#/plan, 홈 탭은 일정)', p.url().endsWith('#/plan') && (await p.locator('.tabbar .tab-home').getAttribute('aria-label')) === '일정')
  check('처음엔 오늘 보기 · 할 일 없음', (await p.locator('.plan-title').innerText()).startsWith('오늘') && (await p.locator('.plan-empty').count()) === 1)

  // ── 빠른 추가 — 오늘 보기에서는 오늘 마감 ──
  const input = p.getByRole('textbox', { name: '할 일 추가' })
  await input.fill('보고서 쓰기')
  await input.press('Enter')
  await p.locator('.task-title', { hasText: '보고서 쓰기' }).waitFor()
  check('빠른 추가: Enter로 넣으면 오늘 묶음에 생기고 칸이 비워진다', (await input.inputValue()) === '' && (await p.locator('.plan-group-head', { hasText: '오늘' }).count()) === 1 && (await tasks(p))[0].due === dayKey(0))
  await p.getByRole('combobox', { name: '마감' }).selectOption('tomorrow')
  await input.fill('단어 외우기')
  await input.press('Enter')
  await sleep(300)
  check('마감 내일로 넣으면 오늘 보기에는 없다', !(await rowTitles(p)).includes('단어 외우기') && (await sideCount(p, '예정')) === '1')
  await p.locator('.plan-side .tree-item', { hasText: '예정' }).click()
  await p.locator('.task-title', { hasText: '단어 외우기' }).waitFor()
  check('예정 보기: 내일 묶음', (await p.locator('.plan-group-head', { hasText: '내일' }).count()) === 1)
  await p.locator('.plan-side .tree-item', { hasText: '오늘' }).click()

  // ── 끝내기 ──
  await p.getByRole('button', { name: '보고서 쓰기 — 끝냄' }).click()
  await sleep(300)
  check('끝내기: 줄은 오늘에 남고 줄이 그어진다, 완료 1', (await p.locator('.task-row.is-done .task-title', { hasText: '보고서 쓰기' }).count()) === 1 && (await sideCount(p, '완료')) === '1' && (await sideCount(p, '오늘')) === '0')
  await p.getByRole('button', { name: '보고서 쓰기 — 끝냄 취소' }).click()
  await sleep(300)
  check('끝냄 취소', !(await tasks(p)).find((t) => t.title === '보고서 쓰기')!.done)

  // ── 자세히: 제목·메모·마감 ──
  await p.locator('.task-main', { hasText: '보고서 쓰기' }).click()
  await p.waitForSelector('.task-detail')
  const titleBox = p.getByRole('textbox', { name: '제목' })
  await titleBox.fill('실습 보고서 쓰기')
  await titleBox.press('Enter')
  await p.getByRole('textbox', { name: '메모' }).fill('측정값 표 넣기')
  await p.getByRole('textbox', { name: '메모' }).blur()
  await sleep(300)
  const t1 = (await tasks(p)).find((t) => t.title === '실습 보고서 쓰기')
  check('자세히: 제목·메모가 저장되고 그 칸의 고친 시각이 남는다', !!t1 && t1.memo === '측정값 표 넣기' && t1.ts.title! > 0 && t1.ts.memo! >= t1.ts.title!, JSON.stringify(t1))
  check('…목록 줄도 바뀐다', (await rowTitles(p)).includes('실습 보고서 쓰기'))
  await p.locator('.task-detail .task-due .lib-chip', { hasText: '내일' }).click()
  await sleep(300)
  check('자세히: 마감을 내일로 — 오늘 보기에서 빠진다', (await tasks(p)).find((t) => t.title === '실습 보고서 쓰기')!.due === dayKey(1) && !(await rowTitles(p)).includes('실습 보고서 쓰기'))

  // ── 카테고리 ──
  await p.evaluate(async () => (await import('/src/storage/tasks.ts')).createTask({ title: '진리표 외우기', due: null, category: '[과제] 디지털 시스템' }))
  await p.locator('.plan-side .tree-item', { hasText: '[과제] 디지털 시스템' }).waitFor()
  await p.locator('.plan-side .tree-item', { hasText: '[과제] 디지털 시스템' }).click()
  check('카테고리 보기: 그 카테고리 할 일만, 날짜 없음 묶음', (await rowTitles(p)).join() === '진리표 외우기' && (await p.locator('.plan-group-head', { hasText: '날짜 없음' }).count()) === 1)
  await p.getByRole('textbox', { name: '할 일 추가' }).fill('4:1 MUX 그리기')
  await p.getByRole('textbox', { name: '할 일 추가' }).press('Enter')
  await sleep(300)
  check('카테고리 보기에서 넣으면 그 카테고리로', (await tasks(p)).find((t) => t.title === '4:1 MUX 그리기')?.category === '[과제] 디지털 시스템')

  // ── 휴지통: 되돌리기 · 되살리기 · 영구 삭제 ──
  await p.locator('.task-main', { hasText: '4:1 MUX 그리기' }).click()
  await p.getByRole('button', { name: '휴지통으로' }).click()
  await p.locator('.toast', { hasText: '휴지통으로 옮겼습니다' }).getByRole('button', { name: '되돌리기' }).click()
  await sleep(300)
  check('휴지통으로 → 알림의 되돌리기로 돌아온다', !(await tasks(p)).find((t) => t.title === '4:1 MUX 그리기')!.deleted && (await rowTitles(p)).includes('4:1 MUX 그리기'))
  await p.locator('.task-main', { hasText: '4:1 MUX 그리기' }).click()
  await p.getByRole('button', { name: '휴지통으로' }).click()
  await sleep(300)
  await p.locator('.plan-side .tree-item', { hasText: '휴지통' }).click()
  check('휴지통 보기: 지운 할 일, 다른 보기에는 없다', (await rowTitles(p)).join() === '4:1 MUX 그리기' && (await sideCount(p, '전체')) === '3')
  await p.locator('.task-main', { hasText: '4:1 MUX 그리기' }).click()
  await p.getByRole('button', { name: '되살리기' }).click()
  await sleep(300)
  check('휴지통에서 되살리기', !(await tasks(p)).find((t) => t.title === '4:1 MUX 그리기')!.deleted)
  // 30일 지난 휴지통은 정리된다 (앱을 열 때)
  await p.evaluate(async () => {
    const { db } = await import('/src/storage/db.ts')
    const t = await import('/src/storage/tasks.ts')
    const x = (await t.listTasks()).find((r) => r.title === '4:1 MUX 그리기')!
    await db.tasks.update(x.id, { deletedAt: Date.now() - 31 * 86400_000 })
    await t.purgeExpiredTasks()
  })
  check('휴지통 30일 지난 할 일은 지워진다', !(await tasks(p)).some((t) => t.title === '4:1 MUX 그리기'))

  // ── 연결한 노트 — 열고, 뒤로 가면 일정으로 ──
  await p.evaluate(async (docId) => (await import('/src/storage/tasks.ts')).createTask({ title: '노트 복습', due: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })(), link: { docId } }), noteId)
  await p.locator('.plan-side .tree-item', { hasText: '오늘' }).click()
  await p.locator('.task-main', { hasText: '노트 복습' }).click()
  check('목록·자세히에 연결한 노트 이름', (await p.locator('.task-row', { hasText: '노트 복습' }).innerText()).includes('디지털 시스템 3주차') && (await p.locator('.task-note-card').innerText()).includes('디지털 시스템 3주차'))
  await p.locator('.task-note-card').click()
  await p.waitForFunction((id) => location.hash === `#/doc/${id}`, noteId)
  check('연결한 노트를 누르면 그 노트가 열린다', true)
  await p.getByRole('button', { name: '문서 목록' }).click()
  await p.waitForSelector('.plan')
  check('노트에서 뒤로 — 일정으로 돌아온다', p.url().endsWith('#/plan'))

  // ── 주·월 ──
  await p.locator('.plan-view-seg').getByRole('radio', { name: '주' }).click()
  await p.waitForSelector('.cal-week')
  const todayCol = p.locator('.cal-week-day.is-today')
  check('주: 오늘 칸에 오늘 마감 할 일, 내일 칸에 내일 것', (await todayCol.innerText()).includes('노트 복습') && (await todayCol.innerText()).includes('보고서') === false)
  const group = (kind: string) => todayCol.locator(`.cal-note-group[data-kind="${kind}"]`)
  check('주: 오늘 만든 노트', (await group('made').locator('small').innerText()) === '만든 노트' && (await group('made').locator('.cal-note').allInnerTexts()).includes('디지털 시스템 3주차'))
  check(
    '주: 오늘 마지막으로 고친 노트 (전에 만든 것) — 만든 노트에는 없다',
    (await group('last').locator('small').innerText()) === '마지막으로 고친 노트' && (await group('last').locator('.cal-note').allInnerTexts()).join() === '회로 정리' && !(await group('made').locator('.cal-note').allInnerTexts()).includes('회로 정리')
  )
  await todayCol.getByRole('button', { name: '노트 복습 — 끝냄' }).click()
  await sleep(300)
  check('주: 동그라미로 끝내기', (await tasks(p)).find((t) => t.title === '노트 복습')!.done)
  await p.locator('.plan-view-seg').getByRole('radio', { name: '월' }).click()
  await p.waitForSelector('.cal-month')
  check('월: 오늘을 고른 채로 그날 칸', (await p.locator('.day-panel h2').innerText()).length > 0 && (await p.locator('.day-panel').innerText()).includes('노트 복습'))
  const panel = (kind: string) => p.locator(`.day-panel .task-section[data-kind="${kind}"]`)
  check('월: 이날 만든 노트', (await panel('made').locator('h3').innerText()).startsWith('이날 만든 노트') && (await panel('made').locator('.day-note').allInnerTexts()).some((t) => t.includes('디지털 시스템 3주차')))
  check(
    '월: 이날 마지막으로 고친 노트와 옮겨 간다는 안내',
    (await panel('last').locator('h3').innerText()).startsWith('이날 마지막으로 고친 노트') &&
      (await panel('last').locator('.day-note').allInnerTexts()).some((t) => t.includes('회로 정리')) &&
      (await panel('last').locator('.hint').innerText()).includes('다른 날 또 고치면 그날로 옮겨 갑니다')
  )
  const twoAgo = await p.evaluate(async () => {
    const { db } = await import('/src/storage/db.ts')
    return (await db.documents.toArray()).find((d) => d.title === '회로 정리')!.createdAt
  })
  check('준비: 회로 정리는 이틀 전에 만들었다', Date.now() - twoAgo > 86400_000)
  await p.locator('.cal-day.is-today').locator('xpath=following-sibling::button[1]').click()
  await sleep(200)
  check('월: 다른 날을 누르면 그날 칸 (내일 마감)', (await p.locator('.day-panel').innerText()).includes('단어 외우기'))
  await p.locator('.day-panel .day-task-main', { hasText: '단어 외우기' }).click()
  check('월: 그날 칸의 할 일을 누르면 자세히', (await p.locator('.task-detail-title').inputValue()) === '단어 외우기')

  // ── 다시 열어도 남는다 (보기도 기억) ──
  await p.reload()
  await p.waitForSelector('.plan')
  check('다시 열면 #/plan · 월 보기 · 할 일 그대로', (await p.locator('.cal-month').count()) === 1 && (await tasks(p)).filter((t) => !t.deleted).length === 4)

  // ── 휴대폰 폭: 달력은 날을 누를 때만 그날 칸 · 칩 줄 · 아래 새 할 일 · 자세히는 화면 위에 ──
  await p.setViewportSize({ width: 390, height: 844 })
  await sleep(300)
  check('휴대폰 달력: 그날 칸은 날을 누르기 전엔 덮지 않는다', (await p.locator('.plan-pane').count()) === 0 && (await p.locator('.cal-month').isVisible()))
  await p.locator('.cal-day.is-today').click()
  await p.waitForSelector('.day-panel')
  await p.locator('.day-panel').getByRole('button', { name: '닫기' }).click()
  check('…날을 누르면 그날 칸, 닫으면 달력으로', (await p.locator('.plan-pane').count()) === 0)
  await p.locator('.plan-view-seg').getByRole('radio', { name: '주' }).click()
  await p.waitForSelector('.cal-week')
  const tb = (await p.locator('.cal-week-day.is-today').boundingBox())!
  check('휴대폰 주: 옆으로 밀어 보는 주가 오늘 칸에서 시작한다', tb.x >= 0 && tb.x + tb.width <= 390, JSON.stringify(tb))
  await p.locator('.plan-view-seg').getByRole('radio', { name: '목록' }).click()
  await sleep(300)
  check('휴대폰: 사이드바는 닫히고 칩 줄이 보인다', (await p.locator('.plan-side').count()) === 0 && (await p.locator('.plan-chips').isVisible()))
  await p.locator('.plan-new-bottom').click()
  const focused = await p.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '할 일 추가', null, { timeout: 3000 }).then(() => true, () => false)
  check('휴대폰: 아래 「새 할 일」은 추가 칸으로', focused)
  await p.locator('.plan-chips .lib-chip', { hasText: '전체' }).click()
  await p.locator('.task-main', { hasText: '진리표 외우기' }).click()
  const pane = (await p.locator('.plan-pane').boundingBox())!
  check('휴대폰: 자세히는 화면 폭 전체로 위에 뜬다', Math.abs(pane.width - 390) < 1 && pane.x === 0, JSON.stringify(pane))
  await p.getByRole('button', { name: '닫기' }).click()
  check('…닫기', (await p.locator('.plan-pane').count()) === 0)

  const warn = logsOf(p).filter((t) => !/favicon|DevTools/.test(t))
  check('경고 없음', warn.length === 0, warn.join(' | '))
  await p.context().close()
  void base
}
