// 일정 — 날짜를 골라 넣기와 꾹 눌러 옮기기.
//  - 빠른 추가의 마감: 오늘·내일·이번 주·없음 + 달력 버튼(아무 날)
//  - 날짜 칩을 누르면 기기의 달력(showPicker)이 뜬다 — 투명 입력만 덮으면 데스크톱 크롬은 달력을 띄우지 않던 버그
//  - 월의 그날 칸 상자 맨 아래, 주의 칸마다 「+ 추가」에서 그날 마감으로 넣는다
//  - 할 일을 꾹 눌러(0.35초) 다른 날로 끌어 놓으면 마감이 바뀐다 — 주·월·목록. 되돌리기, 짧게 누르고 움직이면 옮기지 않는다
import type { Page } from 'playwright'
import { device, logsOf, sleep, type Ctx } from './lib.ts'

const dayKey = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** 이번 주 일요일 (주는 월요일부터) */
const sundayKey = () => {
  const d = new Date()
  return dayKey(6 - ((d.getDay() + 6) % 7))
}
const tasks = (p: Page) => p.evaluate(async () => (await (await import('/src/storage/tasks.ts')).listTasks()).map((t) => ({ id: t.id, title: t.title, due: t.due })))
const dueOf = async (p: Page, title: string) => (await tasks(p)).find((t) => t.title === title)?.due
const add = (p: Page, title: string, due: string | null) => p.evaluate(async ({ title, due }) => (await (await import('/src/storage/tasks.ts')).createTask({ title, due }))!.id, { title, due })

/** 꾹 눌렀다가(hold ms) 끌어서 놓는다 */
async function longDrag(p: Page, from: { x: number; y: number }, to: { x: number; y: number }, hold = 550) {
  await p.mouse.move(from.x, from.y)
  await p.mouse.down()
  await sleep(hold)
  await p.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 })
  await p.mouse.move(to.x, to.y, { steps: 6 })
  await sleep(80)
  await p.mouse.up()
  await sleep(250)
}
const center = async (p: Page, sel: ReturnType<Page['locator']>) => {
  const b = (await sel.boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + Math.min(b.height / 2, 20) }
}

export default async function plandrag(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  // showPicker 부름을 센다 (헤드리스 크롬은 실제 달력을 그리지 않는다)
  await p.addInitScript(() => {
    const w = window as unknown as { __pickers: number }
    w.__pickers = 0
    HTMLInputElement.prototype.showPicker = function () {
      w.__pickers++
    }
  })
  await p.goto(`${base}/#/plan`)
  await p.reload() // 해시만 바뀌면 새로 읽지 않는다 — 위의 스크립트가 들어가게
  await p.waitForSelector('.plan')
  const pickers = () => p.evaluate(() => (window as unknown as { __pickers: number }).__pickers)

  // ── 빠른 추가: 이번 주 · 달력에서 고른 날 ──
  const input = p.getByRole('textbox', { name: '할 일 추가' })
  const due = p.getByRole('combobox', { name: '마감' })
  check('빠른 추가 마감: 오늘·내일·이번 주·없음', JSON.stringify(await due.locator('option').allInnerTexts()) === JSON.stringify(['마감: 오늘', '마감: 내일', '마감: 이번 주', '마감 없음']))
  await due.selectOption('week')
  await input.fill('주간 정리')
  await input.press('Enter')
  await sleep(200)
  check('이번 주로 넣으면 그 주 일요일 마감', (await dueOf(p, '주간 정리')) === sundayKey(), String(await dueOf(p, '주간 정리')))
  const datePick = p.locator('.plan-add .plan-add-date input[type="date"]')
  await datePick.click()
  check('빠른 추가의 달력 버튼을 누르면 달력이 뜬다 (showPicker)', (await pickers()) === 1, String(await pickers()))
  await p.keyboard.press('Escape') // 헤드리스 크롬은 날짜 입력을 누르면 제 달력 창도 띄운다 — 닫고 날짜는 아래에서 넣는다
  await datePick.fill(dayKey(9))
  await sleep(100)
  check('달력에서 고른 날이 마감 칸에 보인다', (await due.inputValue()) === dayKey(9) && (await p.locator('.plan-add .plan-add-date').getAttribute('class'))!.includes('is-on'))
  await input.fill('먼 날 할 일')
  await input.press('Enter')
  await sleep(200)
  check('고른 날로 넣는다', (await dueOf(p, '먼 날 할 일')) === dayKey(9))

  // ── 자세히의 「날짜…」도 달력이 뜬다 ──
  await p.locator('.plan-side .tree-item', { hasText: '전체' }).click()
  await p.locator('.task-row', { hasText: '주간 정리' }).locator('.task-main').click()
  await p.locator('.task-detail').waitFor()
  const before = await pickers()
  await p.locator('.task-detail .task-date input').click()
  check('자세히의 「날짜…」를 누르면 달력이 뜬다 (예전에는 크롬에서 안 뜸)', (await pickers()) === before + 1)
  await p.keyboard.press('Escape')
  check('자세히 마감에도 「이번 주」', (await p.locator('.task-detail .task-due').getByRole('button', { name: '이번 주' }).getAttribute('aria-pressed')) === 'true')
  await p.locator('.task-detail').getByRole('button', { name: '닫기' }).click()

  // ── 월의 그날 칸에서 넣기 ──
  await p.locator('.plan-view-seg').getByRole('radio', { name: '월' }).click()
  await p.waitForSelector('.cal-month')
  const empty = p.locator('.cal-day:not(.is-out)[aria-label*="할 일 0개"]').first()
  const emptyDay = (await empty.getAttribute('data-day'))!
  await empty.click()
  await sleep(200)
  const dayAdd = p.locator('.day-panel .day-task-box .day-add input')
  check('월의 그날 칸: 상자 맨 아래에 「이날 할 일 추가」', (await dayAdd.getAttribute('placeholder')) === '이날 할 일 추가')
  await dayAdd.fill('그날 넣은 할 일')
  await dayAdd.press('Enter')
  await sleep(250)
  check('그날 칸에서 넣으면 그날 마감, 상자 안에 생기고 칸은 비워진다', (await dueOf(p, '그날 넣은 할 일')) === emptyDay && (await p.locator('.day-panel .day-task-box .day-task', { hasText: '그날 넣은 할 일' }).count()) === 1 && (await dayAdd.inputValue()) === '')

  // ── 월: 칸의 할 일을 꾹 눌러 다른 칸으로 ──
  const src = p.locator(`.cal-day[data-day="${emptyDay}"] .cal-day-task`, { hasText: '그날 넣은 할 일' })
  const destDay = (await p.locator(`.cal-day:not(.is-out):not([data-day="${emptyDay}"])[aria-label*="할 일 0개"]`).first().getAttribute('data-day'))!
  await longDrag(p, await center(p, src), await center(p, p.locator(`.cal-day[data-day="${destDay}"]`)))
  check('월: 꾹 눌러 다른 날 칸에 놓으면 마감이 그날로', (await dueOf(p, '그날 넣은 할 일')) === destDay, `${await dueOf(p, '그날 넣은 할 일')} / ${destDay}`)
  const moved = p.locator('.toast', { hasText: '마감을' })
  check('옮기면 알림 (되돌리기)', (await moved.count()) >= 1 && (await moved.last().getByRole('button', { name: '되돌리기' }).count()) === 1)
  check('놓은 뒤 그 칸이 골라지지 않는다 (놓기의 click은 삼킨다)', (await p.locator(`.cal-day[data-day="${destDay}"]`).getAttribute('aria-pressed')) === 'false')
  await moved.last().getByRole('button', { name: '되돌리기' }).click()
  await sleep(200)
  check('되돌리기로 원래 날로', (await dueOf(p, '그날 넣은 할 일')) === emptyDay)

  // ── 주: 「+ 추가」와 꾹 눌러 옮기기 ──
  await p.locator('.plan-view-seg').getByRole('radio', { name: '주' }).click()
  await p.waitForSelector('.cal-week')
  await p.locator('.plan-nav-btn.is-text', { hasText: '오늘' }).click()
  const todayCol = p.locator('.cal-week-day.is-today')
  const today = (await todayCol.getAttribute('data-day'))!
  await todayCol.locator('.cal-week-add').click()
  const weekAdd = todayCol.locator('.day-add input')
  check('주: 「+ 추가」를 누르면 그 칸에 입력 칸', (await weekAdd.count()) === 1 && (await weekAdd.evaluate((el) => el === document.activeElement)))
  await weekAdd.fill('주 칸에서 넣음')
  await weekAdd.press('Enter')
  await sleep(250)
  check('주 칸에서 넣으면 그날 마감', (await dueOf(p, '주 칸에서 넣음')) === today)
  await weekAdd.press('Escape')
  await sleep(100)
  check('Esc로 입력 칸을 닫는다', (await todayCol.locator('.day-add').count()) === 0)

  const chip = todayCol.locator('.cal-task', { hasText: '주 칸에서 넣음' })
  const other = p.locator('.cal-week-day:not(.is-today)').first()
  const otherDay = (await other.getAttribute('data-day'))!
  // 짧게 누르고 바로 움직이면 옮기지 않는다 (스크롤·누르기)
  const c = await center(p, chip.locator('.cal-task-main'))
  await longDrag(p, c, await center(p, other.locator('.cal-week-head')), 60)
  check('짧게 누르고 움직이면 옮기지 않는다', (await dueOf(p, '주 칸에서 넣음')) === today)
  await p.keyboard.press('Escape')
  await longDrag(p, c, await center(p, other.locator('.cal-week-head')))
  check('주: 꾹 눌러 다른 날 칸에 놓으면 마감이 그날로', (await dueOf(p, '주 칸에서 넣음')) === otherDay, `${await dueOf(p, '주 칸에서 넣음')} / ${otherDay}`)
  check('놓은 뒤 자세히가 열리지 않는다', (await p.locator('.task-detail').count()) === 0)

  // ── 목록: 오늘 묶음에서 내일 묶음으로 ──
  await add(p, '목록에서 옮길 것', dayKey(0))
  await add(p, '내일 것', dayKey(1))
  await p.locator('.plan-view-seg').getByRole('radio', { name: '목록' }).click()
  await p.locator('.plan-side .tree-item', { hasText: '전체' }).click()
  await p.locator('.task-row', { hasText: '목록에서 옮길 것' }).waitFor()
  const row = p.locator('.task-row', { hasText: '목록에서 옮길 것' }).locator('.task-title')
  const tomorrowGroup = p.locator(`.plan-group[data-day="${dayKey(1)}"]`)
  await longDrag(p, await center(p, row), await center(p, tomorrowGroup.locator('.task-row').first()))
  check('목록: 꾹 눌러 내일 묶음에 놓으면 내일 마감', (await dueOf(p, '목록에서 옮길 것')) === dayKey(1))
  const noneGroup = p.locator('.plan-group[data-day="none"]')
  if (!(await noneGroup.count())) await add(p, '날짜 없는 것', null)
  await sleep(200)
  await longDrag(p, await center(p, p.locator('.task-row', { hasText: '목록에서 옮길 것' }).locator('.task-title')), await center(p, p.locator('.plan-group[data-day="none"] .plan-group-head')))
  check('목록: 날짜 없음 묶음에 놓으면 마감 없음', (await dueOf(p, '목록에서 옮길 것')) === null)
  check('지난 마감 묶음은 놓을 곳이 아니다', (await p.locator('.plan-group[data-day="late"]').count()) === 0)

  check('콘솔 오류 없음', !logsOf(p).some((l) => /error|uncaught/i.test(l) && !/net::|Failed to load resource/.test(l)), logsOf(p).join('\n').slice(0, 400))
  await p.context().close()
}
