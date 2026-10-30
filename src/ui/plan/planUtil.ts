// 일정 화면의 날짜·묶음 계산 — 화면과 떨어진 순수 함수 (날짜는 이 기기 시간대의 'YYYY-MM-DD')
import type { Task } from '../../shared/model'

const pad = (n: number) => String(n).padStart(2, '0')

/** Date → 'YYYY-MM-DD' (이 기기 시간대) */
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
/** 'YYYY-MM-DD' → 그날 0시 */
export const fromKey = (k: string) => {
  const [y, m, d] = k.split('-').map(Number)
  return new Date(y, m - 1, d)
}
export const addDays = (k: string, n: number) => {
  const d = fromKey(k)
  d.setDate(d.getDate() + n)
  return dayKey(d)
}
export const todayKey = () => dayKey(new Date())
/** 그 주 월요일 */
export const weekStart = (k: string) => {
  const d = fromKey(k)
  return addDays(k, -((d.getDay() + 6) % 7))
}
/** 그 달 1일 */
export const monthStart = (k: string) => `${k.slice(0, 7)}-01`
export const addMonths = (k: string, n: number) => {
  const d = fromKey(monthStart(k))
  d.setMonth(d.getMonth() + n)
  return dayKey(d)
}
/** 달력 칸 — 그 달을 덮는 월요일부터 일요일까지(5주 또는 6주) */
export function monthCells(k: string): string[] {
  const first = monthStart(k)
  const start = weekStart(first)
  const next = addMonths(first, 1)
  const out: string[] = []
  for (let d = start; d < next || out.length % 7; d = addDays(d, 1)) out.push(d)
  return out
}

export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']
export const weekdayOf = (k: string) => WEEKDAYS[fromKey(k).getDay()]

/** 마감 글자 — 어제·오늘·내일, 이번 주면 요일, 아니면 날짜 */
export function dueLabel(due: string, today = todayKey()): string {
  if (due === today) return '오늘'
  if (due === addDays(today, 1)) return '내일'
  if (due === addDays(today, -1)) return '어제'
  const d = fromKey(due)
  const t = fromKey(today)
  const days = Math.round((d.getTime() - t.getTime()) / 86400_000)
  const md = `${d.getMonth() + 1}월 ${d.getDate()}일`
  if (days > 0 && days < 7) return `${weekdayOf(due)}요일`
  return d.getFullYear() === t.getFullYear() ? `${md} (${weekdayOf(due)})` : `${d.getFullYear()}년 ${md}`
}
/** 'HH:MM' → '오후 9:00' */
export function timeLabel(t: string): string {
  const [h, m] = t.split(':').map(Number)
  return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${pad(m)}`
}
/** 큰 날짜 제목 — '10월 30일 금요일' */
export const longDay = (k: string) => {
  const d = fromKey(k)
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${weekdayOf(k)}요일`
}

// ───────── 보기(사이드바 항목) ─────────

export type PlanFilter = { kind: 'today' } | { kind: 'upcoming' } | { kind: 'all' } | { kind: 'done' } | { kind: 'trash' } | { kind: 'category'; name: string | null }

export const isLate = (t: Task, today: string) => !t.doneAt && !!t.due && t.due < today

/** 보기에 드는 할 일 */
export function inFilter(t: Task, f: PlanFilter, today: string): boolean {
  if (f.kind === 'trash') return !!t.deletedAt
  if (t.deletedAt) return false
  switch (f.kind) {
    case 'today':
      // 지난 마감(안 끝낸 것) + 오늘 마감(끝낸 것도 — 오늘 한 일이 보이게)
      return (!!t.due && t.due === today) || isLate(t, today)
    case 'upcoming':
      return !t.doneAt && !!t.due && t.due > today
    case 'all':
      return !t.doneAt
    case 'done':
      return !!t.doneAt
    case 'category':
      return !t.doneAt && t.category === f.name
  }
}

export interface TaskGroup {
  key: string
  label: string
  late?: boolean
  items: Task[]
}

const byDue = (a: Task, b: Task) =>
  (a.due ?? '9999') < (b.due ?? '9999') ? -1 : (a.due ?? '9999') > (b.due ?? '9999') ? 1 : (a.time ?? '99') < (b.time ?? '99') ? -1 : (a.time ?? '99') > (b.time ?? '99') ? 1 : a.createdAt - b.createdAt

/** 목록 묶음 — 지난 마감 / 오늘 / 내일 / 날마다 / 날짜 없음. 완료·휴지통은 그 날짜별 */
export function groupTasks(list: Task[], f: PlanFilter, today: string): TaskGroup[] {
  if (f.kind === 'done' || f.kind === 'trash') {
    const at = (t: Task) => (f.kind === 'done' ? t.doneAt! : t.deletedAt!)
    const sorted = list.slice().sort((a, b) => at(b) - at(a))
    const groups = new Map<string, TaskGroup>()
    for (const t of sorted) {
      const k = dayKey(new Date(at(t)))
      const label = (k === today ? '오늘 ' : k === addDays(today, -1) ? '어제 ' : '') + (f.kind === 'done' ? '끝냄' : '지움') + (k === today || k === addDays(today, -1) ? '' : ` · ${dueLabel(k, today)}`)
      if (!groups.has(k)) groups.set(k, { key: k, label, items: [] })
      groups.get(k)!.items.push(t)
    }
    return [...groups.values()]
  }
  const sorted = list.slice().sort(byDue)
  const late: Task[] = []
  const noDue: Task[] = []
  const days = new Map<string, Task[]>()
  for (const t of sorted) {
    if (isLate(t, today)) late.push(t)
    else if (!t.due) noDue.push(t)
    else {
      if (!days.has(t.due)) days.set(t.due, [])
      days.get(t.due)!.push(t)
    }
  }
  const out: TaskGroup[] = []
  if (late.length) out.push({ key: 'late', label: '지난 마감', late: true, items: late })
  for (const [k, items] of days) {
    // 오늘 묶음에서는 끝낸 것을 아래로
    if (k === today) items.sort((a, b) => Number(!!a.doneAt) - Number(!!b.doneAt))
    out.push({ key: k, label: dueLabel(k, today), items })
  }
  if (noDue.length) out.push({ key: 'none', label: '날짜 없음', items: noDue })
  return out
}
