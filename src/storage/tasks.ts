// 할 일 저장 (일정 화면, ui/plan) — 이 기기 DB의 tasks 표.
// 고칠 때마다 그 칸의 고친 시각(ts)을 남긴다 — 동기화가 칸별로 나중에 고친 쪽을 남기는 데 쓴다.
// 지우기는 휴지통(deletedAt)으로 — TRASH_RETENTION_DAYS 뒤 purgeExpiredTasks가 지운다.
import { TRASH_RETENTION_DAYS, type ID, type Task, type TaskField } from '../shared/model'
import { ulid } from '../shared/ulid'
import { db } from './db'

export const TASKS_EVENT = 'inkpad-tasks-changed'
const emit = () => window.dispatchEvent(new Event(TASKS_EVENT))

/** 제목 최대 길이 — 한 줄 할 일 */
export const TASK_TITLE_MAX = 200

const cleanTitle = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, TASK_TITLE_MAX)

export const listTasks = () => db.tasks.toArray()
export const getTask = (id: ID) => db.tasks.get(id)

export async function createTask(init: Partial<Pick<Task, 'memo' | 'due' | 'time' | 'category' | 'link'>> & { title: string }): Promise<Task | null> {
  const title = cleanTitle(init.title)
  if (!title) return null
  const now = Date.now()
  const task: Task = {
    id: ulid(),
    title,
    memo: init.memo ?? '',
    due: init.due ?? null,
    time: init.time ?? null,
    category: init.category ?? null,
    doneAt: null,
    deletedAt: null,
    link: init.link ?? null,
    createdAt: now,
    updatedAt: now,
    ts: { title: now, memo: now, due: now, time: now, category: now, doneAt: now, deletedAt: now, link: now }
  }
  await db.tasks.add(task)
  emit()
  return task
}

export type TaskPatch = Partial<Pick<Task, TaskField>>

/** 칸을 고친다 — 실제로 바뀐 칸만 고친 시각을 남긴다. 바뀐 게 없으면 아무것도 하지 않는다 */
export async function updateTask(id: ID, patch: TaskPatch): Promise<boolean> {
  const changed = await db.transaction('rw', db.tasks, async () => {
    const cur = await db.tasks.get(id)
    if (!cur) return false
    const now = Date.now()
    const next: Partial<Task> = {}
    const ts = { ...cur.ts }
    for (const [k, v] of Object.entries(patch) as [TaskField, Task[TaskField]][]) {
      const value = k === 'title' ? cleanTitle(String(v ?? '')) || cur.title : v
      if (JSON.stringify(value) === JSON.stringify(cur[k])) continue
      ;(next as Record<string, unknown>)[k] = value
      ts[k] = now
    }
    if (!Object.keys(next).length) return false
    await db.tasks.update(id, { ...next, ts, updatedAt: now })
    return true
  })
  if (changed) emit()
  return changed
}

export const setTaskDone = (id: ID, done: boolean) => updateTask(id, { doneAt: done ? Date.now() : null })
export const trashTask = (id: ID) => updateTask(id, { deletedAt: Date.now() })
export const restoreTask = (id: ID) => updateTask(id, { deletedAt: null })

/** 휴지통에서 바로 지우기 */
export async function purgeTask(id: ID) {
  await db.tasks.delete(id)
  emit()
}

/** 휴지통에서 TRASH_RETENTION_DAYS가 지난 할 일을 지운다 (앱을 열 때) */
export async function purgeExpiredTasks(): Promise<number> {
  const limit = Date.now() - TRASH_RETENTION_DAYS * 86400_000
  const n = await db.tasks.where('deletedAt').below(limit).delete()
  if (n) emit()
  return n
}
