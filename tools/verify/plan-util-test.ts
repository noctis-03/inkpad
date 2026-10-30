// 일정 — 날짜 계산과 목록 묶음(src/ui/plan/planUtil.ts). 이 기기 시간대의 'YYYY-MM-DD' 기준
import { addDays, addMonths, dueLabel, groupTasks, inFilter, monthCells, weekStart, type PlanFilter } from '../../src/ui/plan/planUtil.ts'
import type { Task } from '../../src/shared/model.ts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else fail++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${!cond && detail ? ' — ' + detail : ''}`)
}

// 1) 날짜
check('하루 더하기 — 달·해 넘김', addDays('2026-10-31', 1) === '2026-11-01' && addDays('2026-12-31', 1) === '2027-01-01' && addDays('2026-03-01', -1) === '2026-02-28')
check('주의 시작은 월요일', weekStart('2026-10-30') === '2026-10-26' && weekStart('2026-11-01') === '2026-10-26' && weekStart('2026-10-26') === '2026-10-26')
check('달 더하기 — 1일로', addMonths('2026-10-30', 1) === '2026-11-01' && addMonths('2026-01-31', -1) === '2025-12-01')
const oct = monthCells('2026-10-15')
check('달력 칸 — 월요일부터 일요일까지, 그 달을 덮는다', oct.length === 35 && oct[0] === '2026-09-28' && oct.at(-1) === '2026-11-01', `${oct.length} ${oct[0]} ${oct.at(-1)}`)
const feb = monthCells('2027-02-01') // 2027-02-01은 월요일, 28일까지 — 딱 4주
check('달력 칸 — 꽉 찬 4주 달', feb.length === 28 && feb[0] === '2027-02-01' && feb.at(-1) === '2027-02-28', `${feb.length}`)
check('달력 칸 — 6주 달', monthCells('2026-08-01').length === 42)

// 2) 마감 글자
const T = '2026-10-30'
check('어제·오늘·내일', dueLabel('2026-10-29', T) === '어제' && dueLabel(T, T) === '오늘' && dueLabel('2026-10-31', T) === '내일')
check('이번 주 안은 요일', dueLabel('2026-11-02', T) === '월요일', dueLabel('2026-11-02', T))
check('그 밖은 날짜 (요일)', dueLabel('2026-11-20', T) === '11월 20일 (금)' && dueLabel('2027-01-05', T) === '2027년 1월 5일', `${dueLabel('2026-11-20', T)} / ${dueLabel('2027-01-05', T)}`)

// 3) 보기와 묶음
let seq = 0
const task = (p: Partial<Task>): Task => ({
  id: `t${++seq}`,
  title: `할 일 ${seq}`,
  memo: '',
  due: null,
  time: null,
  category: null,
  doneAt: null,
  deletedAt: null,
  link: null,
  createdAt: seq,
  updatedAt: seq,
  ts: {},
  ...p
})
const late = task({ due: '2026-10-28', title: '지난' })
const lateDone = task({ due: '2026-10-28', doneAt: 1, title: '지난 끝냄' })
const today = task({ due: T, title: '오늘' })
const todayTimed = task({ due: T, time: '09:00', title: '오늘 9시' })
const todayDone = task({ due: T, doneAt: 1, title: '오늘 끝냄' })
const tomorrow = task({ due: '2026-10-31', category: '어학', title: '내일' })
const none = task({ title: '날짜 없음', category: '어학' })
const trashed = task({ due: T, deletedAt: 5, title: '지움' })
const all = [late, lateDone, today, todayTimed, todayDone, tomorrow, none, trashed]
const names = (f: PlanFilter) => all.filter((t) => inFilter(t, f, T)).map((t) => t.title)
check('오늘 — 지난 마감(안 끝낸 것) + 오늘(끝낸 것도)', names({ kind: 'today' }).join() === '지난,오늘,오늘 9시,오늘 끝냄', names({ kind: 'today' }).join())
check('예정 — 내일부터, 안 끝낸 것', names({ kind: 'upcoming' }).join() === '내일')
check('전체 — 안 끝낸 것 모두', names({ kind: 'all' }).join() === '지난,오늘,오늘 9시,내일,날짜 없음')
check('완료 — 끝낸 것', names({ kind: 'done' }).join() === '지난 끝냄,오늘 끝냄')
check('휴지통 — 지운 것만, 다른 보기에는 없다', names({ kind: 'trash' }).join() === '지움' && !names({ kind: 'all' }).includes('지움'))
check('카테고리', names({ kind: 'category', name: '어학' }).join() === '내일,날짜 없음' && names({ kind: 'category', name: null }).join() === '지난,오늘,오늘 9시')

const g = groupTasks(
  all.filter((t) => inFilter(t, { kind: 'all' }, T)),
  { kind: 'all' },
  T
)
check(
  '묶음 — 지난 마감 · 오늘(시각 있는 것 먼저) · 내일 · 날짜 없음',
  g.map((x) => `${x.label}:${x.items.map((t) => t.title).join('/')}`).join(' | ') === '지난 마감:지난 | 오늘:오늘 9시/오늘 | 내일:내일 | 날짜 없음:날짜 없음',
  g.map((x) => `${x.label}:${x.items.map((t) => t.title).join('/')}`).join(' | ')
)
const gt = groupTasks(
  all.filter((t) => inFilter(t, { kind: 'today' }, T)),
  { kind: 'today' },
  T
)
check('오늘 묶음 — 끝낸 것은 아래로', gt[1].items.at(-1)!.title === '오늘 끝냄', gt[1].items.map((t) => t.title).join())

console.log(`\n일정 계산: ${pass}개 통과, ${fail}개 실패`)
if (fail) process.exitCode = 1
else console.log('모든 일정 계산 검사 통과 ✓')
