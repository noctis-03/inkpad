// 진행 중인 일(올리기·받기·가져오기·내보내기…)의 목록 — 탭 바 오른쪽 상태 칸(ui/dock)이 보여 준다.
// 화면을 막지 않는다: 일을 시작하는 쪽이 여기에 알리고, 사용자는 그동안 다른 일을 계속한다.
// 메모리에만 둔다(새로고침하면 비어 있다). 끝난 일은 최근 기록으로 몇 개만 남긴다.

export type ActivityKind = 'upload' | 'download' | 'import' | 'export' | 'work'
export type ActivityState = 'running' | 'done' | 'error'

export interface Activity {
  id: number
  kind: ActivityKind
  title: string
  /** 한 줄 설명 — "노트 2/5", 끝난 뒤 결과·오류 문구 */
  detail?: string
  /** 0~1. 모르면 undefined(막대 대신 흐르는 줄) */
  progress?: number
  state: ActivityState
  startedAt: number
  endedAt?: number
}

export interface ActivityHandle {
  update(patch: Partial<Pick<Activity, 'title' | 'detail' | 'progress'>>): void
  done(detail?: string): void
  fail(detail?: string): void
  /** 실제로 한 일이 없을 때 — 기록에 남기지 않고 지운다 */
  drop(): void
}

/** 끝난 일을 이만큼만 기억한다 */
const KEEP_FINISHED = 30

let seq = 0
let list: Activity[] = []
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((f) => f())

const patch = (id: number, p: Partial<Activity>) => {
  const i = list.findIndex((a) => a.id === id)
  if (i < 0) return
  const next = list.slice()
  next[i] = { ...list[i], ...p }
  list = next
  emit()
}

/** 끝난 일 중 오래된 것을 잘라 낸다 (진행 중인 일은 그대로) */
const trim = () => {
  const finished = list.filter((a) => a.state !== 'running')
  if (finished.length <= KEEP_FINISHED) return
  const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED).map((a) => a.id))
  list = list.filter((a) => !drop.has(a.id))
}

/** 오류를 사람이 읽는 한 줄로 */
export const errorText = (e: unknown, fallback = '하지 못했습니다.') => (e instanceof Error && e.message ? e.message : fallback)

export function startActivity(kind: ActivityKind, title: string, init?: { detail?: string; progress?: number }): ActivityHandle {
  const id = ++seq
  list = [...list, { id, kind, title, state: 'running', startedAt: Date.now(), ...init }]
  emit()
  let open = true
  const finish = (state: ActivityState, detail?: string) => {
    if (!open) return
    open = false
    const cur = list.find((a) => a.id === id)
    patch(id, { state, endedAt: Date.now(), progress: state === 'done' ? 1 : cur?.progress, detail: detail ?? (state === 'done' ? undefined : cur?.detail) })
    trim()
    emit()
  }
  return {
    update: (p) => open && patch(id, p),
    done: (detail) => finish('done', detail),
    fail: (detail) => finish('error', detail),
    drop: () => {
      if (!open) return
      open = false
      list = list.filter((a) => a.id !== id)
      emit()
    }
  }
}

/**
 * fn이 끝날 때까지 일을 목록에 둔다 — 성공하면 '끝', 던지면 '실패'(오류 문구)로 남기고 그대로 다시 던진다.
 * fn은 손잡이로 진행률·설명을 바꿀 수 있고, 끝난 뒤 문구는 doneText로 정한다.
 */
export async function trackActivity<T>(
  kind: ActivityKind,
  title: string,
  fn: (a: ActivityHandle) => Promise<T>,
  doneText?: (r: T) => string | undefined
): Promise<T> {
  const a = startActivity(kind, title)
  try {
    const r = await fn(a)
    a.done(doneText?.(r))
    return r
  } catch (e) {
    a.fail(errorText(e))
    throw e
  }
}

export const getActivities = () => list
export function onActivities(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 끝난 기록을 지운다 (진행 중인 일은 남는다) */
export function clearFinishedActivities() {
  list = list.filter((a) => a.state === 'running')
  emit()
}
