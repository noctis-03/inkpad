// 알림(토스트)의 기록 — 탭 바 오른쪽 상태 칸(ui/dock)의 '알림' 쪽이 보여 준다.
// 토스트는 몇 초 뒤 사라지지만 여기에는 남아, 칸을 펼쳐 지난 알림을 다시 볼 수 있다.
// 메모리에만 둔다(새로고침하면 비어 있다) — activity.ts와 같은 방식.

export type NoticeKind = 'info' | 'error' | 'success'

export interface Notice {
  /** 토스트 id와 같다 */
  id: number
  text: string
  kind: NoticeKind
  at: number
}

/** 이만큼만 기억한다 */
const KEEP = 50

let list: Notice[] = []
/** 이 시각까지의 알림은 읽었다(펼친 창에서 본 것) */
let readAt = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((f) => f())

export function pushNotice(id: number, text: string, kind: NoticeKind) {
  list = [...list, { id, text, kind, at: Date.now() }].slice(-KEEP)
  emit()
}

export const getNotices = () => list
export const onNotices = (f: () => void) => {
  listeners.add(f)
  return () => void listeners.delete(f)
}
/** 읽지 않은 알림 수 — 펼친 창에서 본 뒤로 온 것 */
export const unreadNotices = () => list.filter((n) => n.at > readAt).length
export function markNoticesRead() {
  if (!list.length || list[list.length - 1].at <= readAt) return
  readAt = list[list.length - 1].at
  list = list.slice() // 구독하는 쪽이 다시 그리게
  emit()
}
/** 상태 칸이 떠 있는가 — 떠 있으면 알림(토스트)은 칸이 알림창으로 커져 보여 주고, 아니면 App이 예전 자리(아래 가운데)에 띄운다 */
let docks = 0
export const dockPresent = () => docks > 0
export function registerDock() {
  docks++
  emit()
  return () => {
    docks--
    emit()
  }
}
export function clearNotices() {
  list = []
  emit()
}
