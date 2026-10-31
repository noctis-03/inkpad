// 할 일 동기화 — 할 일 1개 = Drive 파일 1개 (Inkpad/tasks/<id>.json, 작은 평문 JSON).
// 규칙:
//  1. 올리기: 할 일을 추가·수정하면(pending) 바로 올린다 — 앱·기타 파일·보드 프리셋처럼 고치는 그 동작이 곧 올리기(sync.ts 규칙 12).
//     오프라인·실패면 이 기기에 대기로 남고, 다음에 고칠 때나 일정 화면의 동기화 버튼이 함께 올린다
//  2. 올리기 전에 Drive 파일이 마지막으로 맞춘 것(rev)과 다르면 받아서 합친 뒤 올린다 — 다른 기기가 고친 칸을 덮지 않게
//  3. 합치기는 칸마다 나중에 고친 쪽 (sync/taskMerge.ts). 노트와 달리 머지 화면이 없다
//  4. 받기: 일정 화면의 동기화 버튼, 또는 '앱을 열 때 클라우드 확인'을 켰으면 일정 화면을 열 때(30분 간격).
//     목록 메타(version)로 바뀐 할 일만 본문을 받는다
//  5. 지우기는 모든 기기로 퍼진다 — 휴지통(deletedAt)도 영구 삭제(purgedAt)도 칸으로 올라간다.
//     휴지통에 30일 넘게 있던 할 일의 파일은 받기 때 Drive 휴지통으로 보낸다(Drive가 30일 뒤 비운다).
//     기록해 둔 파일이 Drive에서 사라졌으면(다른 기기가 정리했다) 이 기기에서도 지운다 — 이 기기에서 고쳐 둔 할 일이면 다시 올린다
//  6. Inkpad/tasks 폴더가 통째로 사라졌으면 로컬을 지우지 않고 전부 다시 올린다
//  7. 할 일 파일을 읽고 쓰는 일은 탭이 여러 개여도 한 번에 하나만 (TASKS_LOCK)
import type { ID, Task } from '../shared/model'
import { db } from '../storage/db'
import { TASKS_EVENT, emitTasksChanged, pendingTaskCount } from '../storage/tasks'
import * as drive from './drive'
import { ensureStoreFolder, getSync, putSync, tryUpload } from './folders'
import { fromTaskFile, isExpired, mergeTask, sameContent, toTaskFile, type TaskContent } from './taskMerge'

const TASKS_LOCK = 'inkpad-tasks'
const withTasksLock = <T>(fn: () => Promise<T>) => navigator.locks.request(TASKS_LOCK, fn) as Promise<T>

/** 마지막으로 받은 시각 — 열 때 확인의 간격 */
const LAST_KEY = 'tasksSyncedAt'
export const TASKS_CHECK_INTERVAL_MS = 30 * 60_000

const fileName = (id: ID) => `${id}.json`

const tasksFolder = () =>
  ensureStoreFolder('tasks', 'tasksFolderId', () =>
    db.tasks.toCollection().modify((t) => {
      delete t.fileId
      delete t.rev
      t.pending = true
    })
  )

/** 목록을 본문 없이 판정할 수 있게 — 지운 시각(기한 정리)과 영구 삭제 표식.
 *  Drive는 덮어 올려도 예전 appProperties를 남기므로, 되살려 없어진 지운 시각은 null로 보내 지운다 */
const taskProps = (t: TaskContent): Record<string, string> =>
  ({
    taskId: t.id,
    updatedAt: String(t.updatedAt),
    title: drive.fitAppProperty('title', t.title),
    deletedAt: t.deletedAt ? String(t.deletedAt) : null,
    ...(t.purgedAt ? { purged: '1' } : {})
  }) as Record<string, string>

/**
 * 받은 내용을 이 기기 할 일과 합쳐 저장한다 — 트랜잭션 안에서 지금 행과 합치므로 그 사이의 편집도 남는다.
 * 합친 결과가 Drive 내용과 다르면(이 기기에만 있는 변경) pending으로 남아 다시 올라간다.
 */
async function mergeIntoLocal(id: ID, remote: TaskContent, fileId: string, rev: string): Promise<{ row: Task; changed: boolean }> {
  return db.transaction('rw', db.tasks, async () => {
    const cur = await db.tasks.get(id)
    const merged = cur ? mergeTask(cur, remote) : remote
    const row: Task = { ...merged, fileId, rev }
    if (!sameContent(merged, remote)) row.pending = true
    await db.tasks.put(row)
    return { row, changed: !cur || !sameContent(cur, merged) }
  })
}

/** 할 일 하나를 올린다 (규칙 2: Drive 쪽이 바뀌었으면 먼저 합친다) */
async function pushOne(id: ID, folder: string): Promise<boolean> {
  let t = await db.tasks.get(id)
  if (!t?.pending) return false
  let fileId = t.fileId
  if (fileId) {
    const m = await drive.getMeta(fileId)
    if (!m || m.trashed) {
      // 다른 기기가 기한 지난 휴지통을 정리했다 — 지운 할 일이면 여기서도 지우고, 살아 있는 할 일이면 새 파일로 다시 올린다
      if (t.deletedAt || t.purgedAt) {
        await db.tasks.delete(id)
        return true
      }
      fileId = undefined
    } else if (m.version !== t.rev) {
      const remote = fromTaskFile(await drive.download(fileId), id)
      if (remote) t = (await mergeIntoLocal(id, remote, fileId, m.version)).row
    }
  } else {
    // 올렸지만 위치를 기록하기 전에 멈췄던 경우 — 이름으로 찾아 합친다
    const found = await drive.findByName(fileName(id), folder)
    if (found && !found.trashed) {
      fileId = found.id
      const remote = fromTaskFile(await drive.download(found.id), id)
      if (remote) t = (await mergeIntoLocal(id, remote, found.id, found.version)).row
    }
  }
  if (!t.pending) return true // Drive에 이미 다 있다
  const sent = t
  const res = await drive.upload(toTaskFile(sent), { name: fileName(id), mimeType: 'application/json', appProperties: taskProps(sent) }, folder, fileId)
  await db.transaction('rw', db.tasks, async () => {
    const cur = await db.tasks.get(id)
    if (!cur) return
    // 올리는 사이에 또 고쳤으면 pending을 남긴다 — rev도 그대로 두어 다음 올리기가 방금 올린 것과 합친다
    const same = cur.updatedAt === sent.updatedAt && sameContent(cur, sent)
    await db.tasks.update(id, same ? { fileId: res.id, rev: res.version, pending: undefined } : { fileId: res.id })
  })
  return true
}

async function pushAll(folder: string): Promise<number> {
  const ids = (await db.tasks.toArray()).filter((t) => t.pending).map((t) => t.id)
  let n = 0
  for (const id of ids) if (await pushOne(id, folder)) n++
  return n
}

export interface TaskSyncResult {
  /** 올린 할 일 */
  up: number
  /** 받아서 바뀐 할 일 */
  down: number
  /** 휴지통 기한이 지나 Drive 휴지통으로 보낸 파일 */
  cleaned: number
}

async function pull(folder: string): Promise<Omit<TaskSyncResult, 'up'>> {
  const remotes = await drive.listFiles(folder)
  const seen = new Set<ID>()
  let down = 0
  let cleaned = 0
  for (const r of remotes) {
    const id = r.appProperties?.taskId
    if (!id) continue
    seen.add(id)
    const local = await db.tasks.get(id)
    // 규칙 5: 휴지통 기한이 지났다 — 이 기기에서 되살리지 않았으면 Drive 휴지통으로
    if (isExpired(Number(r.appProperties?.deletedAt)) && (!local || isExpired(local.deletedAt))) {
      await drive.trash(r.id)
      if (local) await db.tasks.delete(id)
      cleaned++
      continue
    }
    if (local?.fileId === r.id && local.rev === r.version) continue
    if (!local && r.appProperties?.purged) continue // 다른 기기가 영구 삭제한 할 일 — 이 기기에는 없다
    const remote = fromTaskFile(await drive.download(r.id), id)
    if (!remote) continue
    const { row, changed } = await mergeIntoLocal(id, remote, r.id, r.version)
    if (isExpired(row.deletedAt)) {
      // 합치고 보니 기한이 지난 휴지통 — 이 기기에 남았던 옛 사본이었다
      await drive.trash(r.id)
      await db.tasks.delete(id)
      cleaned++
    } else if (changed) down++
  }
  // 기록해 둔 파일이 목록에 없다 — 목록은 늦게 반영될 수 있으니 메타로 확인한 뒤에만 지운다
  for (const t of await db.tasks.toArray()) {
    if (!t.fileId || seen.has(t.id)) continue
    const m = await drive.getMeta(t.fileId)
    if (m && !m.trashed) continue
    if (t.pending && !t.deletedAt && !t.purgedAt) await db.tasks.update(t.id, { fileId: undefined, rev: undefined })
    else {
      await db.tasks.delete(t.id)
      if (!t.purgedAt) down++
    }
  }
  return { down, cleaned }
}

/** 올리기 → 받기 → (합쳐서 생긴) 올리기. 일정 화면의 동기화 버튼 */
export function syncTasks(): Promise<TaskSyncResult> {
  return withTasksLock(async () => {
    const folder = await tasksFolder()
    let up = await pushAll(folder)
    const { down, cleaned } = await pull(folder)
    up += await pushAll(folder)
    await putSync(LAST_KEY, Date.now())
    emitTasksChanged()
    return { up, down, cleaned }
  })
}

/** 일정 화면을 열 때 — '앱을 열 때 클라우드 확인'을 켰고, 동기화를 설정했고, 30분이 지났을 때만 */
export async function shouldCheckTasksOnOpen(enabled: boolean): Promise<boolean> {
  if (!enabled || !navigator.onLine || !(await getSync('rootFolderId'))) return false
  const last = await getSync<number>(LAST_KEY)
  return !last || Date.now() - last >= TASKS_CHECK_INTERVAL_MS
}

// ───────── 고치면 바로 올리기 (규칙 1) ─────────

let timer = 0
let flushing = false

/** 대기 중인 할 일을 올린다 — 동기화를 설정한 기기에서만(로그인하지 않은 기기는 네트워크를 쓰지 않는다) */
export async function flushPendingTasks(): Promise<boolean> {
  if (flushing || !navigator.onLine || !(await getSync('rootFolderId'))) return false
  const n = await pendingTaskCount()
  if (!n) return false
  flushing = true
  try {
    return await tryUpload(
      'tasks',
      () =>
        withTasksLock(async () => {
          if (await pushAll(await tasksFolder())) emitTasksChanged()
        }),
      async () => (n === 1 ? '할 일' : `할 일 ${n}개`)
    )
  } finally {
    flushing = false
  }
}

/** App이 한 번 부른다 — 할 일이 바뀌면 잠깐 기다렸다가(연달아 체크해도 한 번에) 올린다 */
export function installTaskUpload(): () => void {
  const on = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void flushPendingTasks(), 700)
  }
  window.addEventListener(TASKS_EVENT, on)
  return () => {
    window.clearTimeout(timer)
    window.removeEventListener(TASKS_EVENT, on)
  }
}
