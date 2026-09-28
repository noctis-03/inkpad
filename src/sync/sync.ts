// 동기화 엔진 (SDF 가이드 7장을 inkpad 구조에 맞춘 것)
// 규칙:
//  1. push(업로드) 먼저, pull(다운로드) 나중에
//  2. 충돌 = 로컬이 변경 중인데 Drive version이 마지막 동기화 값과 다름 → 둘 다 보존
//     (원래 문서는 Drive 버전으로, 로컬 수정은 "(충돌 사본)" 문서로)
//  3. 업로드 중에 또 수정됐으면 outbox를 남겨 다음 라운드에서 다시 올린다
//  4. 삭제는 outbox delete(tombstone) → Drive 휴지통 → 로컬 휴지통(30일 보관)
//  5. Drive 폴더가 통째로 사라졌으면 로컬을 지우지 않고 전부 재업로드
//  6. 탭이 여러 개여도 navigator.locks로 동시에 하나만 실행
import type { ID } from '../shared/model'
import { SCHEMA_VERSION } from '../shared/model'
import { ulid } from '../shared/ulid'
import { gzipJson } from '../storage/compress'
import { db } from '../storage/db'
import { enqueue, setSyncHook } from '../storage/repo'
import * as drive from './drive'
import { assetFileName, packDocument, packFolders, type DocFileV1, type FoldersFileV1 } from './pack'
import { AuthRequiredError, SyncNotConfiguredError } from './token'

const ROOT_NAME = 'Inkpad'
const SYNC_LOCK = 'inkpad-sync'

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'auth-required' | 'error' | 'disabled'

let status: SyncStatus = 'idle'
const listeners = new Set<(s: SyncStatus) => void>()
export const onSyncStatus = (fn: (s: SyncStatus) => void) => {
  listeners.add(fn)
  fn(status)
  return () => {
    listeners.delete(fn)
  }
}
const setStatus = (s: SyncStatus) => {
  status = s
  listeners.forEach((f) => f(s))
}

// ───────────────── 원격 변경 알림 (가이드 8장 3) ─────────────────

export const REMOTE_EVENT = 'inkpad-remote-changed'
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('inkpad-sync') : null
channel?.addEventListener('message', (ev: MessageEvent<string[]>) => {
  window.dispatchEvent(new CustomEvent(REMOTE_EVENT, { detail: new Set<string>(ev.data) }))
})
function emitRemoteChanged(ids: Set<string>) {
  window.dispatchEvent(new CustomEvent(REMOTE_EVENT, { detail: ids }))
  channel?.postMessage([...ids])
}

// ───────────────── syncState 헬퍼 ─────────────────

interface FileRecord {
  fileId: string
  version: string
}

async function getSync<T = FileRecord | string>(key: string): Promise<T | undefined> {
  const row = await db.syncState.get(key)
  return row?.value as T | undefined
}
const putSync = (key: string, value: unknown) => db.syncState.put({ key, value })

// ───────────────── 폴더 / 첫 동기화 ─────────────────

/** 첫 동기화 또는 Drive 폴더가 통째로 사라진 경우: 로컬을 지우지 않고 전부 재업로드 큐에 올린다 (규칙 5) */
async function enqueueEverything() {
  await db.transaction('rw', [db.folders, db.documents, db.assets, db.outbox], async () => {
    for (const f of await db.folders.toArray()) await enqueue('folder', f.id)
    for (const d of await db.documents.toArray()) await enqueue('document', d.id)
    for (const a of await db.assets.toArray()) if (a.blob) await enqueue('asset', a.id)
  })
}

/** Drive 위치 기록(doc:/asset:/foldersFile)을 비우고 전체 재업로드를 예약한다 */
async function resetRemoteRecords() {
  await db.transaction('rw', db.syncState, async () => {
    const keys = (await db.syncState.toArray()).map((k) => k.key)
    await db.syncState.bulkDelete(keys.filter((k) => k.startsWith('doc:') || k.startsWith('asset:') || k === 'foldersFile'))
  })
  await enqueueEverything()
}

async function ensureFolders(): Promise<{ root: string; docs: string; assets: string }> {
  const cached = await getSync<string>('rootFolderId')
  let root: string | undefined
  if (cached) {
    const m = await drive.getMeta(cached)
    if (m && !m.trashed) root = cached
  }
  if (!root) {
    root = (await drive.findFolder(ROOT_NAME)) ?? (await drive.createFolder(ROOT_NAME))
    if (cached && cached !== root) await resetRemoteRecords()
    await putSync('rootFolderId', root)
  }
  const rootChanged = cached !== root
  const docs = await ensureSubFolder(root, 'docs', 'docsFolderId', rootChanged)
  const assets = await ensureSubFolder(root, 'assets', 'assetsFolderId', rootChanged)
  return { root, docs, assets }
}

async function ensureSubFolder(rootId: string, name: string, key: string, forceFind: boolean): Promise<string> {
  if (!forceFind) {
    const saved = await getSync<string>(key)
    if (saved) {
      const m = await drive.getMeta(saved)
      if (m && !m.trashed) return saved
    }
  }
  const id = (await drive.findFolder(name, rootId)) ?? (await drive.createFolder(name, rootId))
  const saved = await getSync<string>(key)
  if (saved && saved !== id) await resetRemoteRecords() // 하위 폴더가 새로 만들어졌다
  await putSync(key, id)
  return id
}

// ───────────────── push ─────────────────

interface PendingDoc {
  seqs: number[]
}

async function push(f: { root: string; docs: string; assets: string }) {
  const rows = await db.outbox.toArray()
  const folderSeqs = rows.filter((r) => r.entity === 'folder').map((r) => r.seq!)
  // page/chunk 단위 변경은 소속 문서 파일로 모은다 (문서 1개 = 파일 1개)
  const docs = new Map<ID, PendingDoc>()
  for (const r of rows) {
    if (r.entity === 'folder' || r.entity === 'asset') continue
    let docId: ID | undefined
    if (r.entity === 'document') docId = r.entityId
    else if (r.entity === 'page') docId = (await db.pages.get(r.entityId))?.documentId
    else {
      const i = r.entityId.indexOf('|')
      docId = (await db.chunks.get([r.entityId.slice(0, i), r.entityId.slice(i + 1)]))?.documentId
    }
    if (!docId) continue // 대상 행이 이미 정리됨(영구 삭제 등)
    const e = docs.get(docId) ?? { seqs: [] }
    e.seqs.push(r.seq!)
    docs.set(docId, e)
  }

  if (folderSeqs.length) await pushFolders(f.root, folderSeqs)

  for (const [docId, info] of docs) {
    const doc = await db.documents.get(docId)
    if (!doc || doc.deletedAt) await pushTombstone(docId, info)
    else await pushDoc(docId, info, f)
  }

  for (const r of rows.filter((r) => r.entity === 'asset')) {
    await ensureAssetUploaded(r.entityId, f.assets)
    await db.outbox.delete(r.seq!)
  }
}

async function pushDoc(docId: ID, info: PendingDoc, f: { root: string; docs: string; assets: string }) {
  const record = await getSync<FileRecord>(`doc:${docId}`)
  let remote: drive.RemoteFile | null = null
  if (record?.fileId) {
    remote = await drive.getMeta(record.fileId)
    if (remote?.trashed) remote = null
  }

  // 충돌: 다른 기기에서 먼저 수정했다 (규칙 2)
  if (remote && record?.version && remote.version !== record.version) {
    await resolveConflict(docId, remote)
    await db.outbox.bulkDelete(info.seqs)
    return
  }

  const file = await packDocument(docId)
  for (const am of file.assets) await ensureAssetUploaded(am.id, f.assets) // 참조 원본을 먼저 올린다
  const result = await drive.upload(
    JSON.stringify(file),
    { name: `docs/${docId}.json`, mimeType: 'application/json', appProperties: { docId, updatedAt: String(file.doc.updatedAt) } },
    f.docs,
    remote?.id
  )
  await markSynced(docId, file.doc.updatedAt, result, info.seqs)
}

/** 업로드가 끝난 뒤 로컬 상태 반영 (규칙 3) */
async function markSynced(docId: ID, uploadedAt: number, remote: drive.RemoteFile, seqs: number[]) {
  await db.transaction('rw', [db.documents, db.outbox, db.syncState], async () => {
    const cur = await db.documents.get(docId)
    if (!cur) return
    await putSync(`doc:${docId}`, { fileId: remote.id, version: remote.version })
    if (cur.updatedAt === uploadedAt) await db.outbox.bulkDelete(seqs)
    // 아니면 outbox가 남아 다음 라운드에서 다시 올려진다
  })
}

/** 로컬에서 삭제된 문서: Drive 파일을 휴지통으로 보내고 위치 기록만 정리. 로컬 휴지통 행은 30일 보관 */
async function pushTombstone(docId: ID, info: PendingDoc) {
  const record = await getSync<FileRecord>(`doc:${docId}`)
  if (record?.fileId) await drive.trash(record.fileId)
  await db.syncState.delete(`doc:${docId}`)
  await db.outbox.bulkDelete(info.seqs)
}

async function pushFolders(rootId: string, seqs: number[]) {
  const before = await packFolders()
  const record = await getSync<FileRecord>('foldersFile')
  const result = await drive.upload(
    JSON.stringify(before),
    { name: 'folders.json', mimeType: 'application/json', appProperties: { type: 'folders' } },
    rootId,
    record?.fileId
  )
  await db.transaction('rw', [db.folders, db.outbox, db.syncState], async () => {
    const after = await packFolders()
    if (after.updatedAt === before.updatedAt) {
      await db.outbox.bulkDelete(seqs)
      await putSync('foldersFile', { fileId: result.id, version: result.version })
    }
  })
}

/** 에셋(PDF·이미지 원본)은 sha256 내용 주소로 올린다 — 같은 내용이면 어느 기기에서든 파일 1개 */
async function ensureAssetUploaded(assetId: ID, assetsFolderId: string) {
  const row = await db.assets.get(assetId)
  if (!row?.blob) return // 원본이 아직 없다(다른 기기에서 받아와야 함)
  const key = `asset:${row.sha256}`
  if (await getSync(key)) return
  const name = assetFileName(row.sha256, row.mime)
  const found = await drive.findByName(name, assetsFolderId)
  if (found) {
    await putSync(key, { fileId: found.id, version: found.version })
    return
  }
  const res = await drive.upload(row.blob, { name, mimeType: row.mime, appProperties: { sha256: row.sha256 } }, assetsFolderId)
  await putSync(key, { fileId: res.id, version: res.version })
}

// ───────────────── 충돌 (규칙 2) ─────────────────

async function resolveConflict(docId: ID, remote: drive.RemoteFile) {
  const local = await packDocument(docId)
  const content = await drive.download<DocFileV1>(remote.id)
  const stamp = new Date().toLocaleString()

  // 1) 로컬에서 수정한 내용은 새 문서(사본)로 보존 → 다음 push 때 업로드된다
  const newId = ulid()
  const pageMap = new Map<ID, ID>(local.pages.map((p) => [p.id, ulid()]))
  const copy: DocFileV1 = {
    ...local,
    doc: { ...local.doc, id: newId, title: `${local.doc.title} (충돌 사본 ${stamp})`, updatedAt: Date.now() },
    pages: local.pages.map((p) => ({ ...p, id: pageMap.get(p.id)!, documentId: newId })),
    chunks: local.chunks.map((c) => ({ ...c, pageId: pageMap.get(c.pageId)! }))
  }
  await applyDocFile(copy)

  // 2) 원래 문서는 Drive 버전으로 교체
  await applyDocFile(content)
  await putSync(`doc:${docId}`, { fileId: remote.id, version: remote.version })
  emitRemoteChanged(new Set<string>([docId]))
}

// ───────────────── Drive 파일 → 로컬 ─────────────────

/** Drive 파일을 로컬에 적용. 그 사이에 로컬이 수정됐으면(dirty) 적용하지 않는다 */
async function applyDocFile(file: DocFileV1): Promise<boolean> {
  const docId = file.doc.id
  const encoded: { c: DocFileV1['chunks'][number]; blob: Blob }[] = []
  for (const c of file.chunks) if (c.elements.length) encoded.push({ c, blob: await gzipJson(c.elements) })
  let applied = true
  await db.transaction('rw', [db.documents, db.pages, db.chunks, db.assets, db.outbox], async () => {
    const pending = await db.outbox.where('[entity+entityId]').equals(['document', docId]).first()
    if (pending) {
      applied = false
      return
    }
    const prev = await db.documents.get(docId)
    await db.documents.put({
      ...file.doc,
      version: prev?.version ?? 0,
      ...(prev?.lastView ? { lastView: prev.lastView } : {}) // 마지막으로 보던 위치는 로컬 전용
    })
    await db.pages.where('documentId').equals(docId).delete()
    await db.pages.bulkAdd(file.pages)
    await db.chunks.where('documentId').equals(docId).delete()
    for (const { c, blob } of encoded) {
      await db.chunks.put({
        pageId: c.pageId,
        key: c.key,
        documentId: docId,
        schemaVersion: SCHEMA_VERSION,
        data: blob,
        count: c.elements.length,
        version: 0,
        localRev: 1,
        updatedAt: file.doc.updatedAt
      })
    }
    for (const am of file.assets) {
      if (!(await db.assets.get(am.id))) await db.assets.put({ ...am, version: 0 }) // 원본 blob은 pullAssets가 받는다
    }
  })
  return applied
}

// ───────────────── pull ─────────────────

async function pull(f: { root: string; docs: string; assets: string }) {
  const outboxRows = await db.outbox.toArray()
  const pendingDocs = new Set(outboxRows.filter((r) => r.entity === 'document').map((r) => r.entityId))
  const changed = new Set<string>()

  // 폴더 트리
  const ff = await getSync<FileRecord>('foldersFile')
  if (ff?.fileId) {
    const rf = await drive.getMeta(ff.fileId)
    if (rf && !rf.trashed && rf.version !== ff.version) {
      await mergeFolders(rf.id, changed)
      await putSync('foldersFile', { fileId: rf.id, version: rf.version })
    }
  }

  // 문서
  const remotes = await drive.listFiles(f.docs)
  const recs = new Map<string, FileRecord>()
  for (const kv of await db.syncState.toArray()) {
    if (kv.key.startsWith('doc:')) recs.set(kv.key.slice(4), kv.value as FileRecord)
  }
  for (const r of remotes) {
    const docId = r.appProperties?.docId
    if (!docId) continue
    const local = await db.documents.get(docId)
    if (local?.deletedAt) continue // 로컬 삭제는 push에서 처리된다
    if (pendingDocs.has(docId)) continue // 로컬 변경은 push에서 처리
    const rec = recs.get(docId)
    if (rec && rec.version === r.version) continue // 이미 최신
    const file = await drive.download<DocFileV1>(r.id)
    if (await applyDocFile(file)) {
      await putSync(`doc:${docId}`, { fileId: r.id, version: r.version })
      changed.add(docId)
    }
  }

  // Drive에서 사라진 문서 → 로컬에서도 휴지통으로 (규칙 4)
  const remoteIds = new Set(remotes.map((r) => r.id))
  for (const l of await db.documents.toArray()) {
    if (l.deletedAt || pendingDocs.has(l.id)) continue
    const rec = recs.get(l.id)
    if (!rec?.fileId || remoteIds.has(rec.fileId)) continue
    const now = Date.now()
    await db.documents.update(l.id, { deletedAt: now, updatedAt: now })
    await enqueue('document', l.id, 'delete')
    changed.add(l.id)
  }

  await pullAssets(f.assets)

  if (changed.size) emitRemoteChanged(changed)
}

async function mergeFolders(fileId: string, changed: Set<string>) {
  const data = await drive.download<FoldersFileV1>(fileId)
  if (data.kind !== 'inkpad-folders' || !Array.isArray(data.folders)) return
  const dirty = new Set((await db.outbox.toArray()).filter((r) => r.entity === 'folder').map((r) => r.entityId))
  for (const f of data.folders) {
    if (dirty.has(f.id)) continue
    const local = await db.folders.get(f.id)
    if (local && local.updatedAt >= f.updatedAt) continue
    await db.folders.put(f)
    changed.add('__folders__')
  }
  for (const local of await db.folders.toArray()) {
    if (dirty.has(local.id) || data.folders.some((x) => x.id === local.id)) continue
    if (!local.deletedAt) {
      const now = Date.now()
      await db.folders.update(local.id, { deletedAt: now, updatedAt: now })
      await enqueue('folder', local.id, 'delete')
      changed.add('__folders__')
    }
  }
}

/** 아직 원본이 없는 에셋(PDF·이미지)을 받아온다 */
async function pullAssets(assetsFolderId: string) {
  const missing = (await db.assets.toArray()).filter((a) => !a.blob)
  if (!missing.length) return
  const files = await drive.listFiles(assetsFolderId)
  const bySha = new Map<string, drive.RemoteFile>()
  for (const f of files) {
    const sha = f.appProperties?.sha256 ?? f.name.slice('assets/'.length).replace(/\..*$/, '')
    if (sha) bySha.set(sha, f)
  }
  for (const a of missing) {
    const f = bySha.get(a.sha256)
    if (!f) continue // 아직 업로드되지 않음 → 다음 동기화에서
    try {
      await db.assets.update(a.id, { blob: await drive.downloadBlob(f.id) })
    } catch (e) {
      console.warn('[sync] 에셋 다운로드 실패:', a.sha256, e)
    }
  }
}

// ───────────────── 실행 (규칙 6) ─────────────────

export async function syncNow(): Promise<void> {
  if (!navigator.onLine) {
    setStatus('offline')
    return
  }
  await navigator.locks.request(SYNC_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) return // 다른 탭에서 동기화 중
    setStatus('syncing')
    try {
      // 최초 동기화: 기존 로컬 데이터를 모두 업로드 큐에 올린다 (가이드 8장 5)
      if (!(await db.syncState.get('rootFolderId'))) await enqueueEverything()
      const folders = await ensureFolders()
      await push(folders)
      await pull(folders)
      await db.syncState.put({ key: 'lastSyncAt', value: Date.now() })
      setStatus('idle')
    } catch (e) {
      if (e instanceof AuthRequiredError) setStatus('auth-required')
      else if (e instanceof SyncNotConfiguredError) setStatus('disabled')
      else {
        console.error('[sync]', e)
        setStatus(navigator.onLine ? 'error' : 'offline')
      }
    }
  })
}

let timer: ReturnType<typeof setTimeout> | undefined
export function scheduleSync(delay = 3000) {
  clearTimeout(timer)
  timer = setTimeout(() => void syncNow(), delay) // 연속 입력 중에는 마지막 저장 후 3초 뒤 1회 실행
}

export function startSync() {
  setSyncHook(() => scheduleSync())
  window.addEventListener('online', () => void syncNow())
  window.addEventListener('offline', () => setStatus('offline'))
  // 화면에 돌아오면 받아오고, 숨기기 전에 올린다
  document.addEventListener('visibilitychange', () => void syncNow())
  setInterval(() => {
    if (status !== 'disabled') void syncNow()
  }, 60_000)
  void syncNow()
}
