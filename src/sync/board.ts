// 작업보드 프리셋: 프리셋 1개 = Drive 파일 1개 (Inkpad/boards/<id>.json).
// 앱·기타 파일과 같은 규칙 — 프리셋은 작은 JSON이라 gzip 없이 평문으로 올린다.
// 여기 담기는 것은 "바로가기의 위치"뿐이고 실제 노트/앱/파일 바이트는 각각의 경로로 동기화된다.
import { BOARD_PRESET_NAME_MAX, normalizeBoard, type Board, type BoardPreset } from '../shared/board'
import type { ID } from '../shared/model'
import { ulid } from '../shared/ulid'
import { db } from '../storage/db'
import * as drive from './drive'
import { ensureFolders, getSync, putSync } from './folders'

export const BOARDS_EVENT = 'inkpad-boards-changed'
const emit = () => window.dispatchEvent(new Event(BOARDS_EVENT))

// Drive appProperties 제한: 키+값 합쳐 UTF-8 124바이트
const PROP_MAX = 124
const bytes = (s: string) => new TextEncoder().encode(s).length
function fitProp(key: string, value: string) {
  let v = value
  while (v && bytes(key) + bytes(v) > PROP_MAX) v = Array.from(v).slice(0, -1).join('')
  return v
}

const cleanName = (name: string) => (name.trim() || '이름 없는 프리셋').slice(0, BOARD_PRESET_NAME_MAX)

// ───────── 로컬 ─────────

export async function listPresets(): Promise<BoardPreset[]> {
  return (await db.boardPresets.toArray()).sort((a, b) => b.updatedAt - a.updatedAt)
}
export const getPreset = (id: ID) => db.boardPresets.get(id)

/** 지금 보드를 새 프리셋으로 저장 */
export async function createPreset(name: string, board: Board): Promise<BoardPreset> {
  const now = Date.now()
  const preset: BoardPreset = {
    id: ulid(),
    name: cleanName(name),
    wallpaper: board.wallpaper,
    snap: board.snap,
    shortcuts: normalizeBoard(board).shortcuts,
    createdAt: now,
    updatedAt: now,
    pending: 'upsert'
  }
  await db.boardPresets.add(preset)
  emit()
  return preset
}

/** 기존 프리셋을 지금 보드로 덮어쓰기 */
export async function overwritePreset(id: ID, board: Board): Promise<boolean> {
  const b = normalizeBoard(board)
  await db.boardPresets.update(id, {
    wallpaper: b.wallpaper,
    snap: b.snap,
    shortcuts: b.shortcuts,
    updatedAt: Date.now(),
    pending: 'upsert',
    cloudDetachedAt: undefined
  })
  emit()
  return tryFlush(id)
}

export async function renamePreset(id: ID, name: string): Promise<boolean> {
  await db.boardPresets.update(id, { name: cleanName(name), updatedAt: Date.now(), pending: 'upsert' })
  emit()
  return tryFlush(id)
}

/** 이 기기에서만 지운다 (클라우드 사본은 남김) */
export async function removePresetLocal(id: ID): Promise<void> {
  await db.boardPresets.delete(id)
  emit()
}

// ───────── 클라우드 ─────────

async function boardsFolder(): Promise<string> {
  const { root } = await ensureFolders()
  const saved = await getSync<string>('boardsFolderId')
  if (saved) {
    const m = await drive.getMeta(saved)
    if (m && !m.trashed) return saved
  }
  const id = (await drive.findFolder('boards', root)) ?? (await drive.createFolder('boards', root))
  if (saved && saved !== id) {
    // 폴더가 통째로 사라졌다 — 로컬은 지우지 않고 전부 다시 올린다
    await db.boardPresets.toCollection().modify((p) => {
      if (p.cloudDetachedAt) return
      delete p.fileId
      if (p.pending !== 'delete') p.pending = 'upsert'
    })
  }
  await putSync('boardsFolderId', id)
  return id
}

const presetProps = (p: BoardPreset) => ({
  presetId: p.id,
  updatedAt: String(p.updatedAt),
  title: fitProp('title', p.name)
})

async function flushOne(id: ID, folderId: string) {
  const p = await db.boardPresets.get(id)
  if (!p?.pending) return
  if (p.pending === 'delete') {
    if (p.fileId) await drive.trash(p.fileId)
    await db.boardPresets.delete(id)
    return
  }
  let fileId = p.fileId
  if (fileId) {
    const m = await drive.getMeta(fileId)
    if (!m || m.trashed) fileId = undefined
  }
  const payload = { id: p.id, name: p.name, wallpaper: p.wallpaper, snap: p.snap, shortcuts: p.shortcuts, createdAt: p.createdAt, updatedAt: p.updatedAt }
  const res = await drive.upload(
    new Blob([JSON.stringify(payload)], { type: 'application/json' }),
    { name: `${p.id}.json`, mimeType: 'application/json', appProperties: presetProps(p) },
    folderId,
    fileId
  )
  await db.transaction('rw', db.boardPresets, async () => {
    const cur = await db.boardPresets.get(id)
    if (!cur) return
    await db.boardPresets.update(id, cur.updatedAt === p.updatedAt ? { fileId: res.id, pending: undefined } : { fileId: res.id })
  })
}

/** 클라우드까지 저장됐으면 true */
async function tryFlush(id: ID): Promise<boolean> {
  if (!navigator.onLine) return false
  try {
    await flushOne(id, await boardsFolder())
    emit()
    return true
  } catch (e) {
    console.warn('[boards] 클라우드 반영 실패 — 재업로드가 필요하다', e)
    return false
  }
}

/** 프리셋 저장 직후 호출 — 실패해도 로컬에는 남는다 */
export const uploadPreset = (id: ID) => tryFlush(id)

export async function countPendingPresets(): Promise<number> {
  return (await db.boardPresets.toArray()).filter((p) => p.pending).length
}

/** 시트의 "모두 업로드" */
export async function flushPendingPresets(): Promise<number> {
  const rows = (await db.boardPresets.toArray()).filter((p) => p.pending)
  if (!rows.length) return 0
  const folder = await boardsFolder()
  for (const p of rows) await flushOne(p.id, folder)
  emit()
  return rows.length
}

export type CloudPresetState = 'installed' | 'update' | 'available' | 'pending' | 'cloud-missing' | 'local-only' | 'detached'

export interface CloudPresetInfo {
  presetId: ID
  name: string
  shortcutCount: number
  remoteUpdatedAt?: number
  localUpdatedAt?: number
  driveFileId?: string
  state: CloudPresetState
}

/** 오프라인 — 이 기기에 있는 프리셋만으로 목록을 만든다 */
async function localCloudPresets(): Promise<CloudPresetInfo[]> {
  return (await db.boardPresets.toArray())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((p) => ({
      presetId: p.id,
      name: p.name,
      shortcutCount: p.shortcuts.length,
      localUpdatedAt: p.updatedAt,
      driveFileId: p.fileId,
      state: (p.cloudDetachedAt && !p.fileId
        ? 'detached'
        : p.pending || !p.fileId
          ? p.fileId
            ? 'pending'
            : 'local-only'
          : 'installed') as CloudPresetState
    }))
}

/** Drive 프리셋 목록 — 메타(appProperties)만으로 만든다(본문은 받지 않음) */
export async function listCloudPresets(): Promise<CloudPresetInfo[]> {
  if (!navigator.onLine) return localCloudPresets()
  const folder = await boardsFolder()
  const remotes = await drive.listFiles(folder)
  const cloud = new Map<string, drive.RemoteFile>()
  for (const r of remotes) {
    const presetId = r.appProperties?.presetId
    if (presetId) cloud.set(presetId, r)
  }
  const out: CloudPresetInfo[] = []
  for (const [presetId, r] of cloud) {
    const local = await db.boardPresets.get(presetId)
    const remoteAt = Number(r.appProperties?.updatedAt) || Date.parse(r.modifiedTime) || 0
    const state: CloudPresetState =
      local?.pending ? 'pending' : !local ? 'available' : !local.fileId ? 'local-only' : remoteAt > local.updatedAt ? 'update' : 'installed'
    out.push({
      presetId,
      name: r.appProperties?.title || local?.name || '작업보드 프리셋',
      shortcutCount: local?.shortcuts.length ?? 0,
      remoteUpdatedAt: remoteAt || undefined,
      localUpdatedAt: local?.updatedAt,
      driveFileId: r.id,
      state
    })
  }
  for (const p of await db.boardPresets.toArray()) {
    if (cloud.has(p.id)) continue
    let state: CloudPresetState
    if (p.cloudDetachedAt && !p.fileId) state = 'detached'
    else if (!p.fileId) state = 'local-only'
    else if (p.pending) state = 'pending'
    else {
      const m = await drive.getMeta(p.fileId).catch(() => undefined)
      state = m === null || m?.trashed ? 'cloud-missing' : 'installed'
    }
    out.push({
      presetId: p.id,
      name: p.name,
      shortcutCount: p.shortcuts.length,
      localUpdatedAt: p.updatedAt,
      driveFileId: p.fileId,
      state
    })
  }
  return out.sort((a, b) => (b.remoteUpdatedAt ?? b.localUpdatedAt ?? 0) - (a.remoteUpdatedAt ?? a.localUpdatedAt ?? 0))
}

/** 클라우드 프리셋을 이 기기로 내려받는다 (덮어쓰기 포함) */
export async function downloadPreset(presetId: ID): Promise<BoardPreset> {
  const local = await db.boardPresets.get(presetId)
  if (local?.pending) throw new Error('이 기기의 변경을 먼저 업로드해 주세요.')
  const folder = await boardsFolder()
  const r = (await drive.listFiles(folder)).find((x) => x.appProperties?.presetId === presetId)
  if (!r) throw new Error('클라우드에서 프리셋을 찾지 못했습니다.')
  const raw = await drive.download<Record<string, unknown>>(r.id)
  const remoteAt = Number(r.appProperties?.updatedAt) || Date.parse(r.modifiedTime) || Date.now()
  const board = normalizeBoard(raw)
  const preset: BoardPreset = {
    id: presetId,
    name: typeof raw.name === 'string' && raw.name.trim() ? cleanName(String(raw.name)) : r.appProperties?.title || '작업보드 프리셋',
    wallpaper: board.wallpaper,
    snap: board.snap,
    shortcuts: board.shortcuts,
    createdAt: Number(raw.createdAt) || local?.createdAt || remoteAt,
    updatedAt: remoteAt,
    fileId: r.id
  }
  await db.boardPresets.put(preset)
  emit()
  return preset
}

/** 이 기기에서 제거 — 로컬 행만 지운다 */
export async function uninstallPreset(presetId: ID): Promise<void> {
  await db.boardPresets.delete(presetId)
  emit()
}

/** Drive 사본 삭제 (휴지통) — 이 기기의 프리셋은 "이 기기에만 있음"으로 남는다 */
export async function deletePresetFromCloud(presetId: ID): Promise<boolean> {
  const p = await db.boardPresets.get(presetId)
  if (!navigator.onLine) throw new Error('오프라인에서는 클라우드에서 삭제할 수 없습니다.')
  if (!p) {
    const folder = await boardsFolder()
    const r = (await drive.listFiles(folder)).find((x) => x.appProperties?.presetId === presetId)
    if (r) await drive.trash(r.id)
    emit()
    return true
  }
  if (!p.fileId) return true
  await drive.trash(p.fileId)
  await db.boardPresets.update(presetId, { fileId: undefined, pending: undefined, cloudDetachedAt: Date.now() })
  emit()
  return true
}

/** local-only / detached / cloud-missing / pending 을 다시 올린다 */
export async function reuploadPreset(presetId: ID): Promise<boolean> {
  await db.boardPresets.update(presetId, { fileId: undefined, pending: 'upsert', cloudDetachedAt: undefined })
  emit()
  return tryFlush(presetId)
}
