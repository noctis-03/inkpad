// 동기화 엔진 (SDF 가이드 7장을 inkpad 구조에 맞춘 것)
// 규칙:
//  1. push(업로드) 먼저, pull(다운로드) 나중에
//  2. 충돌 = 로컬이 변경 중인데 Drive version이 마지막 동기화 값과 다름 → 둘 다 보존
//     (원래 문서는 Drive 버전으로, 로컬 수정은 "(충돌 사본)" 문서로)
//  3. 업로드 중에 또 수정됐으면 outbox를 남겨 다음 라운드에서 다시 올린다
//  4. 삭제는 outbox delete(tombstone) → Drive 휴지통 → 로컬 휴지통(30일 보관)
//  5. Drive 폴더가 통째로 사라졌으면 로컬을 지우지 않고 전부 재업로드
//  6. 탭이 여러 개여도 navigator.locks로 동시에 하나만 실행
//  7. 원본 바이트(PDF·이미지)는 pull에서 내려받지 않는다.
//     그 원본을 쓰는 문서를 처음 열 때 지연 로딩한다 (sync/assets.ts)
//  8. 문서/폴더 JSON은 gzip으로 올린다. appProperties.enc='gzip'이 표식이고,
//     표식이 없는(도입 전) 평문 파일도 그대로 읽는다 (drive.downloadJson)
import type { ID } from '../shared/model'
import { ulid } from '../shared/ulid'
import { gzipJson } from '../storage/compress'
import { db } from '../storage/db'
import { enqueue } from '../storage/repo'
import { applyDocFile } from './apply'
import * as drive from './drive'
import { indexAssets } from './assets'
import { ensureFolders, enqueueEverything, getSync, putSync, type FileRecord } from './folders'
import { assetFileName, packDocument, packFolders, type DocFileV1, type FoldersFileV1 } from './pack'
import { preserveAsRevision } from './revisions'
import { AuthRequiredError, getAccessToken, SyncNotConfiguredError } from './token'

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
/** 충돌이 리비전 보존으로 해소됐을 때 (UI가 "버전 기록 보기" 안내를 띄운다) */
export const CONFLICT_EVENT = 'inkpad-conflict-resolved'
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('inkpad-sync') : null
channel?.addEventListener('message', (ev: MessageEvent<string[]>) => {
  window.dispatchEvent(new CustomEvent(REMOTE_EVENT, { detail: new Set<string>(ev.data) }))
})
function emitRemoteChanged(ids: Set<string>) {
  window.dispatchEvent(new CustomEvent(REMOTE_EVENT, { detail: ids }))
  channel?.postMessage([...ids])
}

// syncState 헬퍼와 폴더 확보 로직은 sync/folders.ts로 분리했다
// (원본 지연 로딩 모듈 sync/assets.ts와 공유하기 위해)

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
    await resolveConflict(docId, remote, f.docs)
    await db.outbox.bulkDelete(info.seqs)
    return
  }

  const file = await packDocument(docId)
  for (const am of file.assets) await ensureAssetUploaded(am.id, f.assets) // 참조 원본을 먼저 올린다
  const result = await drive.upload(
    await gzipJson(file),
    {
      name: `docs/${docId}.json`,
      mimeType: 'application/json',
      appProperties: { docId, updatedAt: String(file.doc.updatedAt), enc: drive.ENC_GZIP }
    },
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
    await gzipJson(before),
    { name: 'folders.json', mimeType: 'application/json', appProperties: { type: 'folders', enc: drive.ENC_GZIP } },
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

/**
 * 충돌 해소 — 버전 기록 방식 (충돌 사본 대신 리비전 사용)
 *  1. 이 기기의 편집을 먼저 헤드로 올려 "고정 리비전(keepForever)"으로 만든다
 *  2. 원격(다른 기기) 버전을 다시 헤드로 되돌린다 → 문서가 복제되지 않는다
 *  3. 리비전 고정에 실패하면(200개 한도 등) 예전 방식으로 대체해 데이터를 지킨다
 */
async function resolveConflict(docId: ID, remote: drive.RemoteFile, docsFolderId: string) {
  const local = await packDocument(docId)
  const content = await drive.downloadJson<DocFileV1>(remote.id, remote.appProperties?.enc)

  const pinnedId = await preserveAsRevision(docId, local, remote, docsFolderId)
  if (!pinnedId) {
    await legacyConflictCopy(docId, local, content, remote)
    return
  }

  // 원격 버전을 헤드로 되돌린다
  const result = await drive.upload(
    await gzipJson(content),
    {
      name: `docs/${docId}.json`,
      mimeType: 'application/json',
      appProperties: { docId, updatedAt: String(content.doc.updatedAt), enc: drive.ENC_GZIP }
    },
    docsFolderId,
    remote.id
  )
  await applyDocFile(content)
  await putSync(`doc:${docId}`, { fileId: result.id, version: result.version })
  emitRemoteChanged(new Set<string>([docId]))
  window.dispatchEvent(new CustomEvent(CONFLICT_EVENT, { detail: { docId, revisionId: pinnedId } }))
}

/** 리비전을 쓸 수 없을 때의 예전 방식: 이 기기 편집을 별도 문서로 복사해 남긴다 */
async function legacyConflictCopy(docId: ID, local: DocFileV1, content: DocFileV1, remote: drive.RemoteFile) {
  const stamp = new Date().toLocaleString()
  const newId = ulid()
  const pageMap = new Map<ID, ID>(local.pages.map((p) => [p.id, ulid()]))
  const copy: DocFileV1 = {
    ...local,
    doc: { ...local.doc, id: newId, title: `${local.doc.title} (충돌 사본 ${stamp})`, updatedAt: Date.now() },
    pages: local.pages.map((p) => ({ ...p, id: pageMap.get(p.id)!, documentId: newId })),
    chunks: local.chunks.map((c) => ({ ...c, pageId: pageMap.get(c.pageId)! }))
  }
  await applyDocFile(copy)
  // 원래 문서는 Drive 버전으로 교체
  await applyDocFile(content)
  await putSync(`doc:${docId}`, { fileId: remote.id, version: remote.version })
  emitRemoteChanged(new Set<string>([docId, newId]))
}

// ───────────────── Drive 파일 → 로컬 ─────────────────
// applyDocFile은 sync/apply.ts로 옮겼다 (revisions.ts와 공유하기 위해)

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
      await mergeFolders(rf.id, rf.appProperties?.enc, changed)
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
    const file = await drive.downloadJson<DocFileV1>(r.id, r.appProperties?.enc)
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

  // 원본 바이트는 받지 않는다. 위치 기록만 채워 두고, 문서를 열 때 지연 로딩한다 (규칙 7)
  await indexAssets(f.assets)

  if (changed.size) emitRemoteChanged(changed)
}

async function mergeFolders(fileId: string, enc: string | undefined, changed: Set<string>) {
  const data = await drive.downloadJson<FoldersFileV1>(fileId, enc)
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

// 원본 다운로드(pullAssets)는 sync/assets.ts의 indexAssets + 지연 로딩으로 대체되었다.
// pull은 원격 목록만 보고 위치 기록을 채우므로 바이트를 받지 않는다.

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

// 동기화는 사용자가 "지금 동기화" 버튼을 눌렀을 때만 실행된다 (자동 백그라운드 동기화 없음).
// 여기서는 온라인/오프라인 상태 표시와, 올바른 버튼을 보여주기 위한 세션 확인(네트워크 확인만, Drive 호출 없음)만 한다.
export function startSync() {
  window.addEventListener('online', () => setStatus('idle'))
  window.addEventListener('offline', () => setStatus('offline'))
  getAccessToken().catch((e) => {
    if (e instanceof AuthRequiredError) setStatus('auth-required')
    else if (e instanceof SyncNotConfiguredError) setStatus('disabled')
  })
}
