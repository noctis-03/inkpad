// 마감 알림 — 하루에 한 번, 앱을 열 때(또는 날이 바뀐 뒤 돌아올 때) 오늘 마감·지난 마감 할 일이 있으면
// 아래쪽 알림 카드에 '일정 보기' 버튼이 달린 알림을 띄운다. 이 기기 DB만 읽는다(네트워크 0).
// 앱을 닫았을 때 오는 알림(푸시)은 서버가 필요해서 없다. 일정 화면을 보고 있으면 띄우지 않는다.
import { useUI } from './store'
import { listTasks } from '../storage/tasks'
import { inFilter, isLate, todayKey } from '../ui/plan/planUtil'

const LS = 'inkpad.dueReminder.day'

const shownDay = () => {
  try {
    return localStorage.getItem(LS)
  } catch {
    return null
  }
}
const markShown = (day: string) => {
  try {
    localStorage.setItem(LS, day)
  } catch {
    /* 저장 못 하면 다음에 다시 알릴 뿐 */
  }
}

/** 알림 문구 — 오늘 마감 N개 · 지난 마감 M개. 알릴 게 없으면 null */
export function dueText(today: number, late: number): string | null {
  if (!today && !late) return null
  const parts = [today && `오늘 마감 할 일 ${today}개`, late && `지난 마감 ${late}개`].filter(Boolean)
  return parts.join(' · ')
}

/** 오늘 알릴 것이 있으면 알린다 — 띄웠으면 true */
export async function maybeRemindDue(): Promise<boolean> {
  const st = useUI.getState()
  if (!st.settings.dueReminder || st.route.name === 'plan') return false
  const day = todayKey()
  if (shownDay() === day) return false
  const open = (await listTasks()).filter((t) => !t.doneAt && inFilter(t, { kind: 'today' }, day))
  const late = open.filter((t) => isLate(t, day)).length
  const text = dueText(open.length - late, late)
  markShown(day) // 알릴 게 없던 날도 — 그날 나중에 생긴 할 일은 만든 사람이 안다
  if (!text) return false
  useUI.getState().toast(text, 'info', { label: '일정 보기', run: () => useUI.getState().navigate({ name: 'plan' }) })
  return true
}

/** App이 한 번 부른다 — 앱을 열고 잠깐 뒤, 그리고 앱으로 돌아올 때(날이 바뀌었으면) */
export function installDueReminder(): () => void {
  const t = window.setTimeout(() => void maybeRemindDue().catch(() => {}), 1500)
  const onVisible = () => {
    if (document.visibilityState === 'visible') void maybeRemindDue().catch(() => {})
  }
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    window.clearTimeout(t)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
