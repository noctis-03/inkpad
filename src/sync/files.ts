// 일반 파일: 파일 1개 = Drive 파일 1개 (Inkpad/files/<id><ext>).
// HTML 앱과 같은 방식(추가·업데이트·삭제가 곧바로 Drive에 반영, 실패하면 pending)이지만,
// 내용을 텍스트/Blob으로 보관하고 종류별 뷰어로 연다.
// 원본 바이트는 "받기"에서 받지 않는다 — 메타만 갱신하고, 열 때 지연 로딩한다(에셋과 같은 원칙).
import {
  MAX_FILE_BYTES,
  MAX_FILE_TITLE_CHARS,
  extOf,
  fileKindOf,
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

/** 삭제 = 이 기기 + 클라우드 */
export async function deleteFile(id: ID): Promise<boolean> {
  const f = await db.files.get(id)
  if (!f) return true
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

/** 받기에서 호출: 다른 기기의 추가·업데이트·삭제 반영 (원본 바이트는 받지 않는다) */
export async function pullFiles(): Promise<number> {
  const folder = await filesFolder()
  const remotes = await drive.listFiles(folder)
  const seen = new Set<string>()
  let n = 0
  for (const r of remotes) {
    const fid = r.appProperties?.fileId
    if (!fid) continue
    seen.add(r.id)
    const local = await db.files.get(fid)
    if (local?.pending) continue // 이 기기의 변경이 우선
    const remoteAt = Number(r.appProperties?.updatedAt) || 0
    if (local && local.updatedAt >= remoteAt) {
      if (local.fileId !== r.id) await db.files.update(fid, { fileId: r.id })
      continue
    }
    const row: FileRow = {
      id: fid,
      title: r.appProperties?.title || local?.title || (r.name || '파일'),
      category: r.appProperties?.category ?? local?.category ?? null,
      name: r.appProperties?.name || r.name || local?.name || '파일',
      mime: r.appProperties?.mime || local?.mime || 'application/octet-stream',
      size: Number(r.appProperties?.size) || local?.size || 0,
      kind: (r.appProperties?.kind as FileRow['kind']) || fileKindOf(r.name || '', r.appProperties?.mime || ''),
      createdAt: local?.createdAt ?? (Date.parse(r.modifiedTime) || Date.now()),
      updatedAt: remoteAt || Date.now(),
      fileId: r.id,
      // 로컬에 받아 둔 원본은 유지한다 (없으면 열 때 지연 로딩)
      text: local?.text,
      blob: local?.blob
    }
    await db.files.put(row)
    n++
  }
  // 다른 기기에서 삭제한 파일. listFiles 인덱스 지연 대비로 getMeta 재확인
  for (const f of await db.files.toArray()) {
    if (!f.fileId || f.pending || seen.has(f.fileId)) continue
    const m = await drive.getMeta(f.fileId).catch(() => undefined)
    if (m === null || m?.trashed) {
      await purgeLocal(f.id)
      n++
    }
  }
  if (n) emit()
  return n
}
