// 일반 파일: 파일 1개 = Drive 파일 1개 (Inkpad/files/<id><ext>).
// HTML 앱과 같은 방식(추가·업데이트·삭제가 곧바로 Drive에 반영, 실패하면 pending)이지만,
// 내용을 텍스트/Blob으로 보관하고 종류별 뷰어로 연다.
// 원본 바이트는 "받기"에서 받지 않는다 — 메타만 갱신하고, 열 때 지연 로딩한다(에셋과 같은 원칙).
// 노트 동기화와 분리한다: Drive의 Inkpad/files/ = 스토어, 각 기기는 원하는 파일만 설치/제거한다.
import {
  MAX_FILE_BYTES,
  MAX_FILE_TITLE_CHARS,
  extOf,
  fileKindOf,
  type FileKind,
  type ID,
  type StoredFile
} from '../shared/model'
import { ulid } from '../shared/ulid'
import { db, type FileRow } from '../storage/db'
import * as drive from './drive'
import { ensureFolders, getSync, putSync } from './folders'

export const FILES_EVENT = 'inkpad-files-changed'
const emit = () => window.dispatchEvent(new Event(FILES_EVENT))

// Drive appProperties 제한: 키+값 합쳐 UTF-8 124바이트
const PROP_MAX = 124
const bytes = (s: string) => new TextEncoder().encode(s).length
function fitProp(key: string, value: string) {
  let v = value
  while (v && bytes(key) + bytes(v) > PROP_MAX) v = Array.from(v).slice(0, -1).join('')
  return v
}

// ───────── 로컬 ─────────

export async function listFiles(): Promise<FileRow[]> {
  return (await db.files.toArray()).filter((f) => !f.deletedAt)
}
export const getFile = (id: ID) => db.files.get(id)

async function purgeLocal(id: ID) {
  await db.files.delete(id)
}

/** uploaded: 클라우드까지 저장됐으면 true */
export async function addFile(file: File, category: string | null): Promise<{ file: StoredFile; uploaded: boolean }> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name}: ${MAX_FILE_BYTES / 1024 / 1024}MB를 넘는 파일은 추가할 수 없습니다.`)
  const mime = file.type || 'application/octet-stream'
  const kind = fileKindOf(file.name, mime)
  const now = Date.now()
  const row: FileRow = {
    id: ulid(),
    title: (file.name.replace(/\.[^.]+$/, '') || file.name).slice(0, MAX_FILE_TITLE_CHARS),
    category,
    name: file.name,
    mime,
    size: file.size,
    kind,
    createdAt: now,
    updatedAt: now,
    pending: 'upsert'
  }
  if (kind === 'text') row.text = await file.text()
  else row.blob = file
  await db.files.add(row)
  emit()
  return { file: row, uploaded: await tryFlush(row.id) }
}

export async function updateFileMeta(id: ID, patch: { title?: string; category?: string | null }): Promise<boolean> {
  const p = { ...patch }
  if (p.title) p.title = p.title.slice(0, MAX_FILE_TITLE_CHARS)
  await db.files.update(id, { ...p, updatedAt: Date.now(), pending: 'upsert' })
  emit()
  return tryFlush(id)
}

/** 클라우드 삭제 = 이 기기 + Drive(휴지통). 기타 파일 메뉴의 "클라우드에서 삭제"에서 부른다 */
export async function deleteFileFromCloud(id: ID): Promise<boolean> {
  const f = await db.files.get(id)
  if (!f) {
    // 설치하지 않은(클라우드 전용) 파일 — Drive에서만 지운다
    const folder = await filesFolder()
    const r = (await drive.listFiles(folder)).find((x) => x.appProperties?.fileId === id)
    if (r) await drive.trash(r.id)
    emit()
    return true
  }
  if (!f.fileId) {
    await purgeLocal(id) // 클라우드에 올라간 적 없음
    emit()
    return true
  }
  await db.files.update(id, { deletedAt: Date.now(), pending: 'delete' })
  emit()
  return tryFlush(id)
}

/** 뷰어가 원본을 확보한다 (이 기기에 없으면 클라우드에서 받아 저장) */
export async function ensureFileLocal(id: ID): Promise<FileRow> {
  const row = await db.files.get(id)
  if (!row) throw new Error('파일을 찾을 수 없습니다.')
  if (row.text !== undefined || row.blob) return row
  if (!row.fileId) throw new Error('이 파일은 아직 클라우드에 없습니다. 원본이 있는 기기에서 "올리기"를 먼저 실행해 주세요.')
  if (!navigator.onLine) throw new Error('오프라인이라 원본을 받을 수 없습니다. 연결한 뒤 다시 열어 주세요.')
  const blob = await drive.downloadBlob(row.fileId)
  await db.files.update(id, row.kind === 'text' ? { text: await blob.text() } : { blob })
  return (await db.files.get(id))!
}

/** 내보내기용 Blob (없으면 받아온다) */
export async function fileToBlob(row: FileRow): Promise<Blob> {
  if (row.kind === 'text' && row.text !== undefined) return new Blob([row.text], { type: row.mime })
  if (row.blob) return row.blob
  const fresh = await ensureFileLocal(row.id)
  return fresh.blob ?? new Blob([fresh.text ?? ''], { type: fresh.mime })
}

// ───────── 클라우드 ─────────

async function filesFolder(): Promise<string> {
  const { root } = await ensureFolders()
  const saved = await getSync<string>('filesFolderId')
  if (saved) {
    const m = await drive.getMeta(saved)
    if (m && !m.trashed) return saved
  }
  const id = (await drive.findFolder('files', root)) ?? (await drive.createFolder('files', root))
  if (saved && saved !== id) {
    // 폴더가 통째로 사라졌다 — 로컬은 지우지 않고 전부 다시 올린다 (sync 규칙 5)
    await db.files.toCollection().modify((f) => {
      delete f.fileId
      if (f.pending !== 'delete') f.pending = 'upsert'
    })
  }
  await putSync('filesFolderId', id)
  return id
}

function propsOf(f: FileRow): Record<string, string> {
  const p: Record<string, string> = {
    fileId: f.id,
    updatedAt: String(f.updatedAt),
    title: fitProp('title', f.title),
    kind: f.kind,
    mime: fitProp('mime', f.mime),
    size: String(f.size),
    name: fitProp('name', f.name)
  }
  if (f.category && bytes('category') + bytes(f.category) <= PROP_MAX) p.category = f.category
  return p
}

async function flushOne(id: ID, folderId: string) {
  const f = await db.files.get(id)
  if (!f?.pending) return
  if (f.pending === 'delete') {
    if (f.fileId) await drive.trash(f.fileId) // Drive 휴지통 (복구 가능)
    await purgeLocal(id)
    return
  }
  let fileId = f.fileId
  if (fileId) {
    const m = await drive.getMeta(fileId)
    if (!m || m.trashed) fileId = undefined
  }
  const blob = await fileToBlob(f)
  const res = await drive.upload(blob, { name: `${f.id}${extOf(f.name) ? '.' + extOf(f.name) : ''}`, mimeType: f.mime, appProperties: propsOf(f) }, folderId, fileId)
  await db.transaction('rw', db.files, async () => {
    const cur = await db.files.get(id)
    if (!cur) return
    // 업로드 중에 또 바뀌었으면 pending을 남겨 다음에 다시 올린다
    await db.files.update(id, cur.updatedAt === f.updatedAt ? { fileId: res.id, pending: undefined } : { fileId: res.id })
  })
}

async function tryFlush(id: ID): Promise<boolean> {
  if (!navigator.onLine) return false
  try {
    await flushOne(id, await filesFolder())
    emit()
    return true
  } catch (e) {
    console.warn('[files] 클라우드 반영 실패 — 다음 올리기에서 재시도', e)
    return false
  }
}

/** 올리기에서 호출 */
export async function flushPendingFiles(): Promise<number> {
  const rows = (await db.files.toArray()).filter((f) => f.pending)
  if (!rows.length) return 0
  const folder = await filesFolder()
  for (const f of rows) await flushOne(f.id, folder)
  emit()
  return rows.length
}

export async function countPendingFiles() {
  return (await db.files.toArray()).filter((f) => f.pending).length
}

// ───────── 파일 전용 클라우드 관리 (기타 파일 메뉴) ─────────
// 파일은 원본을 지연 로딩하므로 상태가 다르다: 메타만 있는 행과 원본까지 있는 행을 구분한다.

export type CloudFileState =
  | 'local' // 메타 + 원본이 이 기기에 있음
  | 'meta-only' // 메타만 있음 (열면 원본을 받는다)
  | 'update' // 원격이 더 새로움
  | 'available' // 클라우드에만 있음
  | 'pending'
  | 'cloud-missing'
  | 'local-only'

export interface CloudFileInfo {
  id: ID
  title: string
  category: string | null
  name: string
  mime: string
  size: number
  kind: FileKind
  remoteUpdatedAt?: number
  localUpdatedAt?: number
  driveFileId?: string
  hasOriginal: boolean
  state: CloudFileState
}

const hasOriginalOf = (f: FileRow) => f.text !== undefined || !!f.blob

function baseInfo(f: FileRow): Omit<CloudFileInfo, 'state'> {
  return {
    id: f.id,
    title: f.title,
    category: f.category,
    name: f.name,
    mime: f.mime,
    size: f.size,
    kind: f.kind,
    localUpdatedAt: f.updatedAt,
    driveFileId: f.fileId,
    hasOriginal: hasOriginalOf(f)
  }
}

/** 로컬 행만으로 상태를 판정한다 (오프라인) */
function localStateOf(f: FileRow): CloudFileState {
  if (f.pending) return f.fileId ? 'pending' : 'local-only'
  if (!f.fileId) return 'local-only'
  return hasOriginalOf(f) ? 'local' : 'meta-only'
}

/** Drive 파일 메타(appProperties)에서 로컬 행을 만든다 — 원본은 있으면 유지한다 */
function rowFromRemote(r: drive.RemoteFile, local?: FileRow): FileRow {
  return {
    id: r.appProperties?.fileId || local?.id || '',
    title: r.appProperties?.title || local?.title || (r.name || '파일'),
    category: r.appProperties?.category ?? local?.category ?? null,
    name: r.appProperties?.name || r.name || local?.name || '파일',
    mime: r.appProperties?.mime || local?.mime || 'application/octet-stream',
    size: Number(r.appProperties?.size) || local?.size || 0,
    kind: (r.appProperties?.kind as FileKind) || fileKindOf(r.name || '', r.appProperties?.mime || ''),
    createdAt: local?.createdAt ?? (Date.parse(r.modifiedTime) || Date.now()),
    updatedAt: Number(r.appProperties?.updatedAt) || Date.parse(r.modifiedTime) || Date.now(),
    fileId: r.id,
    text: local?.text,
    blob: local?.blob
  }
}

async function findRemoteFile(id: ID): Promise<drive.RemoteFile | undefined> {
  const folder = await filesFolder()
  return (await drive.listFiles(folder)).find((x) => x.appProperties?.fileId === id)
}

/**
 * Drive에 올라가 있는 파일 목록 — 메타만으로 만든다(원본 내려받지 않음).
 * 로컬 db.files와 합쳐 상태를 계산한다. 원격에 없다고 로컬을 자동 삭제하지 않는다.
 */
export async function listCloudFiles(): Promise<CloudFileInfo[]> {
  const locals = await db.files.toArray()
  const out: CloudFileInfo[] = []
  const pushSorted = () => out.sort((a, b) => (b.remoteUpdatedAt ?? b.localUpdatedAt ?? 0) - (a.remoteUpdatedAt ?? a.localUpdatedAt ?? 0))

  if (!navigator.onLine) {
    for (const f of locals) if (!f.deletedAt) out.push({ ...baseInfo(f), state: localStateOf(f) })
    pushSorted()
    return out
  }

  const folder = await filesFolder()
  const remotes = await drive.listFiles(folder)
  const cloud = new Map<string, drive.RemoteFile>()
  for (const r of remotes) {
    const fid = r.appProperties?.fileId
    if (fid) cloud.set(fid, r)
  }
  for (const [fid, r] of cloud) {
    const local = locals.find((x) => x.id === fid)
    const remoteAt = Number(r.appProperties?.updatedAt) || Date.parse(r.modifiedTime) || 0
    const state: CloudFileState =
      local?.pending
        ? 'pending'
        : !local
          ? 'available'
          : !local.fileId
            ? 'local-only'
            : remoteAt > local.updatedAt
              ? 'update'
              : hasOriginalOf(local)
                ? 'local'
                : 'meta-only'
    out.push({
      id: fid,
      title: r.appProperties?.title || local?.title || (r.name || '파일'),
      category: r.appProperties?.category ?? local?.category ?? null,
      name: r.appProperties?.name || r.name || local?.name || '파일',
      mime: r.appProperties?.mime || local?.mime || 'application/octet-stream',
      size: Number(r.appProperties?.size) || local?.size || 0,
      kind: (r.appProperties?.kind as FileKind) || fileKindOf(r.name || '', r.appProperties?.mime || ''),
      remoteUpdatedAt: remoteAt || undefined,
      localUpdatedAt: local?.updatedAt,
      driveFileId: r.id,
      hasOriginal: !!local && hasOriginalOf(local),
      state
    })
  }
  // 클라우드 목록에 없는 이 기기 파일 — listFiles 인덱스 지연 대비 getMeta로 재확인한다
  for (const f of locals) {
    if (f.deletedAt || cloud.has(f.id)) continue
    let state: CloudFileState
    if (!f.fileId) state = 'local-only'
    else if (f.pending) state = 'pending'
    else {
      const m = await drive.getMeta(f.fileId).catch(() => undefined)
      state = m === null || m?.trashed ? 'cloud-missing' : hasOriginalOf(f) ? 'local' : 'meta-only'
    }
    out.push({ ...baseInfo(f), state })
  }
  pushSorted()
  return out
}

/** addFileFromCloud: 클라우드 파일의 메타 행을 만든다. withOriginal이면 원본까지 받는다 */
export async function addFileFromCloud(id: ID, opts?: { withOriginal?: boolean }): Promise<void> {
  const local = await db.files.get(id)
  if (local?.pending) throw new Error('이 기기의 변경을 먼저 올려 주세요.')
  const r = await findRemoteFile(id)
  if (!r) throw new Error('클라우드에서 파일을 찾지 못했습니다.')
  await db.files.put(rowFromRemote(r, local))
  emit()
  if (opts?.withOriginal) await ensureFileLocal(id)
}

/** updateFileFromCloud: 메타를 갱신한다. 원본은 원격이 더 새로우면 버리고 다음에 열 때 다시 받는다 */
export async function updateFileFromCloud(id: ID): Promise<void> {
  const local = await db.files.get(id)
  const r = await findRemoteFile(id)
  if (!r) throw new Error('클라우드에서 파일을 찾지 못했습니다.')
  const remoteAt = Number(r.appProperties?.updatedAt) || Date.parse(r.modifiedTime) || 0
  const row = rowFromRemote(r, local)
  if (local && remoteAt > local.updatedAt) {
    row.text = undefined
    row.blob = undefined
  }
  await db.files.put(row)
  emit()
}

/** dropFileOriginal: 메타는 두고 원본만 지운다 (용량 확보). 클라우드에 올라간 파일만 */
export async function dropFileOriginal(id: ID): Promise<void> {
  const f = await db.files.get(id)
  if (!f) return
  if (!f.fileId) throw new Error('클라우드에 없는 파일은 원본을 지울 수 없습니다. 먼저 올려 주세요.')
  await db.files.update(id, { text: undefined, blob: undefined })
  emit()
}

/** removeFileLocal: 이 기기에서 제거 — 로컬 행만 지운다 */
export async function removeFileLocal(id: ID): Promise<void> {
  await db.files.delete(id)
  emit()
}

/** reuploadFile: cloud-missing / local-only / pending 파일을 다시 올린다 */
export async function reuploadFile(id: ID): Promise<boolean> {
  await db.files.update(id, { fileId: undefined, deletedAt: undefined, pending: 'upsert' })
  emit()
  return tryFlush(id)
}
