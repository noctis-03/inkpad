// 할 일로 보내기와 마감 알림 — 올가미로 고른 부분이 그림으로 붙은 할 일(그 노트·쪽에 이어진다),
// 일정에서 그 그림·노트를 누르면 그 쪽으로 열린다. 마감 알림은 하루 한 번, 오늘·지난 마감이 있으면 '일정 보기' 버튼과 함께
import type { Page } from 'playwright'
import { createDoc, device, drawStroke, logsOf, openEditor, sleep, type Ctx } from './lib.ts'

const dayKey = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const tasks = (p: Page) => p.evaluate(async () => (await (await import('/src/storage/tasks.ts')).listTasks()).map((t) => ({ title: t.title, due: t.due, category: t.category, link: t.link, snippet: t.snippet ?? null, ts: t.ts })))
const currentPage = (p: Page) => p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().view.currentPage)
const scrollTo = (p: Page, i: number) => p.evaluate((i) => (window as unknown as { inkpad: { scrollToPage: (i: number) => void } }).inkpad.scrollToPage(i), i)

export default async function tasksend(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  const docId = await createDoc(p, '디지털 시스템 3주차', 3)
  const pageIds = await p.evaluate(async (docId) => {
    const { db } = await import('/src/storage/db.ts')
    await db.documents.update(docId, { category: '전자' })
    return (await db.pages.where('documentId').equals(docId).sortBy('index')).map((pg) => pg.id)
  }, docId)
  await openEditor(p, base, docId)
  await sleep(600)

  // ── 2쪽에 쓰고 올가미로 고른다 ──
  await scrollTo(p, 1)
  await sleep(400)
  check('준비: 2쪽으로 옮겼다', (await currentPage(p)) === 1)
  await drawStroke(p)
  await sleep(400)
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setTool('lasso'))
  const box = (await p.locator('#canvas-root').boundingBox())!
  const cx = box.x + box.width / 2 - 52
  const cy = box.y + 250
  const R = 130
  await p.mouse.move(cx - R, cy - R)
  await p.mouse.down()
  for (const [x, y] of [
    [cx + R, cy - R],
    [cx + R, cy + R],
    [cx - R, cy + R],
    [cx - R, cy - R + 3]
  ])
    await p.mouse.move(x, y, { steps: 10 })
  await p.mouse.up()
  await p.waitForSelector('.selection-bar')
  check('선택 도구 모음에 「할 일로 보내기」', (await p.locator('.selection-bar [aria-label="할 일로 보내기"]').count()) === 1)

  // ── 할 일로 보내기 창 ──
  await p.click('.selection-bar [aria-label="할 일로 보내기"]')
  const sheet = p.getByRole('dialog', { name: '할 일로 보내기' })
  await sheet.waitFor()
  await sheet.locator('.task-send-preview img').waitFor({ timeout: 8000 })
  const title = sheet.getByRole('textbox', { name: '할 일 이름' })
  check('제목은 노트 이름·쪽으로 채워 두고 전체 선택 (바로 고쳐 쓸 수 있게)', (await title.inputValue()) === '디지털 시스템 3주차 2쪽' && (await title.evaluate((el: HTMLInputElement) => el.selectionStart === 0 && el.selectionEnd === el.value.length && document.activeElement === el)))
  check('기본 마감은 오늘, 카테고리는 노트를 따른다', (await sheet.getByRole('button', { name: '오늘', exact: true }).getAttribute('aria-pressed')) === 'true' && (await sheet.getByRole('combobox', { name: '카테고리' }).inputValue()) === '전자')
  check('어느 노트·쪽에 이어지는지 알려 준다', (await sheet.locator('.modal-note').innerText()).includes('2쪽에 이어집니다'))
  await title.fill('3번 문제 다시 풀기')
  await sheet.getByRole('button', { name: '내일', exact: true }).click()
  await sheet.getByRole('button', { name: '할 일 만들기' }).click()
  await sheet.waitFor({ state: 'detached', timeout: 5000 })
  const toast = p.locator('.toast', { hasText: '할 일에 넣었습니다' })
  await toast.waitFor({ timeout: 5000 })
  const made = (await tasks(p))[0]
  check(
    '만든 할 일: 제목·마감·카테고리, 그 노트·2쪽에 이어지고 그림이 붙는다',
    !!made && made.title === '3번 문제 다시 풀기' && made.due === dayKey(1) && made.category === '전자' && made.link?.docId === docId && made.link?.pageId === pageIds[1] && !!made.snippet?.startsWith('data:image/png'),
    JSON.stringify({ ...made, snippet: made?.snippet?.slice(0, 30) })
  )
  check('그림 칸도 고친 시각을 남긴다 (동기화의 칸별 합치기)', typeof made?.ts.snippet === 'number')
  check('그림은 작게 (40만 자 이하)', (made?.snippet?.length ?? 0) > 100 && (made?.snippet?.length ?? 1e9) <= 400_000, String(made?.snippet?.length))
  check('보낸 뒤 선택을 푼다', (await p.locator('.selection-bar').count()) === 0)

  // ── 일정에서 그 쪽으로 연다 ──
  await scrollTo(p, 0)
  await sleep(300)
  await toast.getByRole('button', { name: '일정 보기' }).click()
  await p.waitForSelector('.plan')
  check('알림의 「일정 보기」로 일정을 연다', p.url().endsWith('#/plan'))
  await p.locator('.plan-side .tree-item', { hasText: '예정' }).click()
  const row = p.locator('.task-row', { hasText: '3번 문제 다시 풀기' })
  await row.waitFor()
  check('목록 줄에 보낸 부분의 그림', (await row.locator('img.task-snippet').count()) === 1)
  await row.locator('.task-main').click()
  const big = p.getByRole('button', { name: '노트에서 보낸 부분 — 그 자리 열기' })
  await big.waitFor()
  check('자세히: 「노트에서 보낸 부분」 그림과 노트 카드', (await p.locator('.task-section h3', { hasText: '노트에서 보낸 부분' }).count()) === 1 && (await p.locator('.task-note-card', { hasText: '디지털 시스템 3주차' }).count()) === 1)
  await big.click()
  await p.waitForFunction(() => !!(window as unknown as { inkpad?: unknown }).inkpad && location.hash.startsWith('#/doc/'), null, { timeout: 15000 })
  await sleep(500)
  check('그림을 누르면 그 노트의 2쪽으로 열린다 (마지막으로 본 1쪽이 아니라)', (await currentPage(p)) === 1, String(await currentPage(p)))

  // ── 획 없이 영역만 골라도 보낼 수 있다 (인쇄된 문제를 감쌌을 때) ──
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setTool('lasso'))
  await p.mouse.move(box.x + 40, box.y + 500)
  await p.mouse.down()
  for (const [x, y] of [
    [box.x + 140, box.y + 500],
    [box.x + 140, box.y + 600],
    [box.x + 40, box.y + 600],
    [box.x + 40, box.y + 503]
  ])
    await p.mouse.move(x, y, { steps: 8 })
  await p.mouse.up()
  await p.waitForSelector('.selection-bar')
  check('영역만 골랐을 때도 「할 일로 보내기」', (await p.locator('.selection-bar .sel-count').innerText()) === '영역' && (await p.locator('.selection-bar [aria-label="할 일로 보내기"]').count()) === 1)
  await p.click('.selection-bar [aria-label="할 일로 보내기"]')
  await sheet.waitFor()
  await p.keyboard.press('Escape')
  await sheet.waitFor({ state: 'detached', timeout: 3000 })
  check('Esc로 닫으면 할 일을 만들지 않는다', (await tasks(p)).length === 1)

  // ── 마감 알림: 하루 한 번, 오늘·지난 마감 ──
  await p.evaluate(
    async ({ today, late }) => {
      const t = await import('/src/storage/tasks.ts')
      await t.createTask({ title: '오늘 낼 것', due: today })
      await t.createTask({ title: '지난 것', due: late })
      const done = await t.createTask({ title: '끝낸 것', due: today })
      await t.setTaskDone(done!.id, true)
      localStorage.removeItem('inkpad.dueReminder.day')
    },
    { today: dayKey(0), late: dayKey(-2) }
  )
  await p.goto(`${base}/#/`)
  await p.reload()
  await p.waitForSelector('.lib-side')
  const due = p.locator('.toast', { hasText: '오늘 마감 할 일 1개 · 지난 마감 1개' })
  const shown = await due.waitFor({ timeout: 5000 }).then(
    () => true,
    () => false
  )
  check('마감 알림: 앱을 열면 오늘 마감·지난 마감 (끝낸 것은 빼고)', shown, (await p.locator('.toast').allInnerTexts()).join(' / '))
  if (shown) await due.getByRole('button', { name: '일정 보기' }).click()
  await p.waitForSelector('.plan', { timeout: 3000 }).catch(() => {})
  check('마감 알림의 「일정 보기」로 일정을 연다', p.url().endsWith('#/plan'))
  await p.goto(`${base}/#/`)
  await p.reload()
  await p.waitForSelector('.lib-side')
  await sleep(2500)
  check('같은 날 다시 열면 알리지 않는다', (await p.locator('.toast', { hasText: '오늘 마감' }).count()) === 0)
  await p.evaluate(async () => {
    localStorage.removeItem('inkpad.dueReminder.day')
    ;(await import('/src/app/store.ts')).useUI.getState().setSettings({ dueReminder: false })
  })
  await p.reload()
  await p.waitForSelector('.lib-side')
  await sleep(2500)
  check('설정에서 끄면 알리지 않는다', (await p.locator('.toast', { hasText: '오늘 마감' }).count()) === 0)

  check('콘솔 오류 없음', !logsOf(p).some((l) => /error|uncaught/i.test(l) && !/net::|Failed to load resource/.test(l)), logsOf(p).join('\n').slice(0, 400))
  await p.context().close()
}
