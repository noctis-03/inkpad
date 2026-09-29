// 동기화 엔진 — 노트 1개 = Drive 파일 1개, git의 풀/푸시/머지를 노트 단위로.
// 규칙:
//  1. push(업로드) 먼저, pull(다운로드) 나중에
//  2. 충돌 = 로컬도 고쳤고 다른 기기도 올렸음(Drive 버전이 마지막 동기화 값과 다름)
//     → 마지막 동기화 스냅샷(base)으로 페이지·청크 단위 3-way 머지.
//       겹치지 않은 편집은 양쪽 다 살고, 겹친 청크는 원격 우선.
//       머지 전 이 기기 상태는 Drive 리비전으로 남겨 버전 기록에서 복구할 수 있다.
//  3. 업로드 중에 또 수정됐으면 outbox를 남겨 다음 라운드에서 다시 올린다
//  4. 삭제는 그 기기의 일 — 클라우드 사본은 남는다. 기기가 지운 노트는 gone 표식으로
//     받기에서 제외되고(되살리지 않음), 클라우드 목록에는 빨간 점으로 표시되며
//     목록의 노트별 "받기"로 명시적으로 되살릴 수 있다
//  5. Drive 폴더가 통째로 사라졌으면 로컬을 지우지 않고 전부 재업로드
//  6. 탭이 여러 개여도 navigator.locks로 동시에 하나만 실행
//  7. 원본 바이트(PDF·이미지)는 pull에서 내려받지 않는다 — 문서를 열 때 지연 로딩 (sync/assets.ts)
//  8. 문서/폴더 JSON은 gzip으로 올린다(appProperties.enc 표식).
//     appProperties에 제목·기기 이름을 함께 넣어, 클라우드 노트 목록을 메타만으로 그린다
import type { ID } from '../shared/model'
import { gzipJson, gunzipJson } from '../storage/compress'
import { db } from '../storage/db'
import { enqueue } from '../storage/repo'
import { applyDocFile } from './apply'
import * as drive from './drive'
import { indexAssets } from './assets'
import { ensureFolders, enqueueEverything, getSync, putSync, type FileRecord } from './folders'
import { assetFileName, packDocument, packFolders, type DocFileV1, type FoldersFileV1 } from './pack'
import { mergeDocs } from './merge'
import { AuthRequiredError, SyncNotConfiguredError, getAccessToken, getDeviceName } from './token'

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

function handleSyncError(e: unknown) {
  if (e instanceof AuthRequiredError) setStatus('auth-required')
  else if (e instanceof SyncNotConfiguredError) setStatus('disabled')
  else {
    console.error('[sync]', e)
    setStatus(navigator.onLine ? 'error' : 'offline')
  }
}

// ───────────────── 원격 변경 알림 ─────────────────

export const REMOTE_EVENT = 'inkpad-remote-changed'
/** 머지가 일어났을 때 (UI가 "버전 기록 보기" 안내를 띄운다) */
export const CONFLICT_EVENT = 'inkpad-conflict-resolved'
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('inkpad-sync') : null
channel?.addEventListener('message', (ev: MessageEvent<string[]>) => {
  window.dispatchEvent(new CustomEvent(REMOTE_EVENT, { detail: new Set<string>(ev.data) }))
})
function emitRemoteChanged(ids: Set<string>) {
  window.dispatchEvent(new CustomEvent(REMOTE_EVENT, { detail: ids }))
  channel?.postMessage([...ids])
}

// ───────────────── 공통 ─────────────────

/** 마지막으로 맞춘 시점의 문서 스냅샷(머지의 base). gzip JSON blob을 syncState에 보관 */
async function saveBase(docId: ID, file: DocFileV1) {
  await putSync(`base:${docId}`, { blob: await gzipJson(file) })
}
async function loadBase(docId: ID): Promise<DocFileV1 | null> {
  const rec = await getSync<{ blob: Blob }>(`base:${docId}`)
  if (!rec?.blob) return null
  try {
    const file = await gunzipJson<DocFileV1>(rec.blob)
    return file?.kind === 'inkpad-doc' ? file : null
  } catch {
    return null
  }
}

interface PendingDoc {
  seqs: number[]
}

async function pendingDocs(): Promise<Map<ID, PendingDoc>> {
  const rows = await db.outbox.toArray()
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
  return docs
}

// ───────────────── push ─────────────────

/** 올리기. 이 기기의 변경을 노트 단위로 올리고, 이어서 다른 기기의 변경을 받아온다. */
export async function pushNow(): Promise<void> {
  if (!navigator.onLine) {
    setStatus('offline')
    return
  }
  await navigator.locks.request(SYNC_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) return // 다른 탭에서 동기화 중
    setStatus('syncing')
    try {
      // 최초 동기화: 기존 로컬 데이터를 모두 업로드 큐에 올린다
      if (!(await db.syncState.get('rootFolderId'))) await enqueueEverything()
      const f = await ensureFolders()
      await push(f)
      await pull(f)
      await db.syncState.put({ key: 'lastPushAt', value: Date.now() })
      setStatus('idle')
    } catch (e) {
      handleSyncError(e)
    } finally {
    }
  })
}

async function push(f: { root: string; docs: string; assets: string }) {
  const rows = await db.outbox.toArray()
  const folderSeqs = rows.filter((r) => r.entity === 'folder').map((r) => r.seq!)
  const docs = await pendingDocs()

  if (folderSeqs.length) await pushFolders(f.root, folderSeqs)

  let n = 0
  for (const [docId, info] of docs) {
    n++
    const doc = await db.documents.get(docId)
    if (!doc || doc.deletedAt) await pushTombstone(docId, info)
    else await pushDoc(docId, info, f)
  }

  for (const r of rows.filter((r) => r.entity === 'asset')) {
    await ensureAssetUploaded(r.entityId, f.assets)
    await db.outbox.delete(r.seq!)
  }
}

async function pushDoc(docId: ID, info: PendingDoc, f: { docs: string; assets: string }) {
  const record = await getSync<FileRecord>(`doc:${docId}`)
  let remote: drive.RemoteFile | null = null
  if (record?.fileId) {
    remote = await drive.getMeta(record.fileId)
    if (remote?.trashed) remote = null
  }

  // 머지: 다른 기기가 먼저 올렸다 (규칙 2)
  if (remote && record?.version && remote.version !== record.version) {
    await mergePush(docId, remote, f.docs)
    await db.outbox.bulkDelete(info.seqs)
    return
  }

  const file = await packDocument(docId)
  for (const am of file.assets) await ensureAssetUploaded(am.id, f.assets) // 참조 원본을 먼저 올린다
  const device = await getDeviceName()
  const result = await drive.upload(
    await gzipJson(file),
    {
      name: `docs/${docId}.json`,
      mimeType: 'application/json',
      appProperties: { docId, updatedAt: String(file.doc.updatedAt), title: file.doc.title, device, enc: drive.ENC_GZIP }
    },
    f.docs,
    remote?.id
  )
  await markSynced(docId, file, result, info.seqs)
}

/** 업로드가 끝난 뒤 로컬 상태 반영 (규칙 3) — base 스냅샷도 함께 갱신 */
async function markSynced(docId: ID, file: DocFileV1, remote: drive.RemoteFile, seqs: number[]) {
  const base = await gzipJson(file)
  await db.transaction('rw', [db.documents, db.outbox, db.syncState], async () => {
    const cur = await db.documents.get(docId)
    if (!cur) return
    await putSync(`doc:${docId}`, { fileId: remote.id, version: remote.version })
    await putSync(`base:${docId}`, { blob: base })
    await db.syncState.delete(`gone:${docId}`) // 휴지통에서 살아나서 다시 올렸다
    if (cur.updatedAt === file.doc.updatedAt) await db.outbox.bulkDelete(seqs)
    // 아니면 outbox가 남아 다음 라운드에서 다시 올려진다
  })
}

/**
 * 로컬 삭제(휴지통 이동·비우기)는 이 기기의 일이다 — 클라우드 사본은 그대로 남겨
 * 다른 기기와 클라우드 목록에서 계속 쓴다. 대신 gone 표식을 남겨 이 기기의
 * "받기"가 그 노트를 되살리지 않게 하고, 목록에는 빨간 점으로 보여준다.
 */
async function pushTombstone(docId: ID, info: PendingDoc) {
  await putSync(`gone:${docId}`, Date.now())
  await db.syncState.delete(`base:${docId}`)
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

// ───────────────── 머지 (규칙 2) ─────────────────

/**
 * 노트 단위 머지: 다른 기기가 올린 노트에 이 기기의 편집이 얹혀 있을 때.
 *  1. 이 기기의 현재 상태를 먼저 올려 Drive 리비전으로 남긴다 (머지 전 모습 복구용)
 *  2. base(마지막 동기화 스냅샷)로 3-way 머지 → 이 기기에 적용하고 허브로 올린다
 */
async function mergePush(docId: ID, remote: drive.RemoteFile, docsFolderId: string) {
  const local = await packDocument(docId)
  const theirs = await drive.downloadJson<DocFileV1>(remote.id, remote.appProperties?.enc)
  if (theirs?.kind !== 'inkpad-doc') return
  const base = await loadBase(docId)

  // 머지 전 이 기기 상태를 리비전으로 남긴다 (고정하지 않으면 Drive가 약 30일 보관)
  await drive.upload(
    await gzipJson(local),
    { name: `docs/${docId}.json`, mimeType: 'application/json', appProperties: { docId, enc: drive.ENC_GZIP } },
    docsFolderId,
    remote.id
  )

  const { file: merged } = mergeDocs(base, local, theirs)
  await applyDocFile(merged, { force: true })
  const device = await getDeviceName()
  const result = await drive.upload(
    await gzipJson(merged),
    {
      name: `docs/${docId}.json`,
      mimeType: 'application/json',
      appProperties: { docId, updatedAt: String(merged.doc.updatedAt), title: merged.doc.title, device, enc: drive.ENC_GZIP }
    },
    docsFolderId,
    remote.id
  )
  await putSync(`doc:${docId}`, { fileId: result.id, version: result.version })
  await saveBase(docId, merged)
  emitRemoteChanged(new Set<string>([docId]))
  window.dispatchEvent(new CustomEvent(CONFLICT_EVENT, { detail: { docId, revisionId: result.version } }))
}

// ───────────────── Drive 파일 → 로컬 ─────────────────
// applyDocFile은 sync/apply.ts

// ───────────────── pull ─────────────────

export interface PullResult {
  docs: number
  folders: boolean
}

/** 받기. 허브에서 다른 기기가 올린 변경을 가져온다 */
export async function pullNow(): Promise<PullResult | null> {
  if (!navigator.onLine) {
    setStatus('offline')
    return null
  }
  return navigator.locks.request(SYNC_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) return null // 다른 탭에서 동기화 중
    setStatus('syncing')
    try {
      const f = await ensureFolders()
      const r = await pull(f)
      await db.syncState.put({ key: 'lastPullAt', value: Date.now() })
      setStatus('idle')
      return { docs: r.docs, folders: r.folders }
    } catch (e) {
      handleSyncError(e)
      return null
    } finally {
    }
  }) as Promise<PullResult | null>
}

async function pull(f: { root: string; docs: string; assets: string }) {
  const r = { docs: 0, folders: false }
  const outboxRows = await db.outbox.toArray()
  const pendingDocs_ = new Set(outboxRows.filter((x) => x.entity === 'document').map((x) => x.entityId))
  const changed = new Set<string>()

  // 폴더 트리
  const ff = await getSync<FileRecord>('foldersFile')
  if (ff?.fileId) {
    const rf = await drive.getMeta(ff.fileId)
    if (rf && !rf.trashed && rf.version !== ff.version) {
      if (await mergeFolders(rf.id, rf.appProperties?.enc)) {
        await putSync('foldersFile', { fileId: rf.id, version: rf.version })
        r.folders = true
        changed.add('__folders__')
      }
    }
  }

  // 문서
  const remotes = await drive.listFiles(f.docs)
  const recs = new Map<string, FileRecord>()
  for (const kv of await db.syncState.toArray()) {
    if (kv.key.startsWith('doc:')) recs.set(kv.key.slice(4), kv.value as FileRecord)
  }
  let n = 0
  for (const remote of remotes) {
    const docId = remote.appProperties?.docId
    if (!docId) continue
    if (await getSync(`gone:${docId}`)) continue // 이 기기에서 지운 노트 — 받기로 되살리지 않는다 (목록에서 개별 받기)
    const local = await db.documents.get(docId)
    if (local?.deletedAt) continue // 휴지통에 있는 노트도 되살리지 않는다
    if (pendingDocs_.has(docId)) continue // 로컬 변경은 push의 머지에서 처리
    const rec = recs.get(docId)
    if (rec && rec.version === remote.version) continue // 이미 최신
    n++
    const file = await drive.downloadJson<DocFileV1>(remote.id, remote.appProperties?.enc)
    if (file?.kind !== 'inkpad-doc') continue
    if (await applyDocFile(file)) {
      await putSync(`doc:${docId}`, { fileId: remote.id, version: remote.version })
      await saveBase(docId, file)
      changed.add(docId)
      r.docs++
    }
  }

  // 원본 바이트는 받지 않는다. 위치 기록만 채워 두고, 문서를 열 때 지연 로딩한다 (규칙 7)
  await indexAssets(f.assets)

  if (changed.size) emitRemoteChanged(changed)
  return r
}

async function mergeFolders(fileId: string, enc: string | undefined): Promise<boolean> {
  const data = await drive.downloadJson<FoldersFileV1>(fileId, enc)
  if (data.kind !== 'inkpad-folders' || !Array.isArray(data.folders)) return false
  const dirty = new Set((await db.outbox.toArray()).filter((r) => r.entity === 'folder').map((r) => r.entityId))
  let any = false
  for (const fo of data.folders) {
    if (dirty.has(fo.id)) continue
    const local = await db.folders.get(fo.id)
    if (local && local.updatedAt >= fo.updatedAt) continue
    await db.folders.put(fo)
    any = true
  }
  for (const local of await db.folders.toArray()) {
    if (dirty.has(local.id) || data.folders.some((x) => x.id === local.id)) continue
    if (!local.deletedAt) {
      const now = Date.now()
      await db.folders.update(local.id, { deletedAt: now, updatedAt: now })
      await enqueue('folder', local.id, 'delete')
      any = true
    }
  }
  return any
}

// ───────────────── 클라우드 노트 목록 ─────────────────

export type CloudNoteState = 'same' | 'remote-new' | 'pending' | 'deleted-local'

export interface CloudNoteInfo {
  docId: ID
  title: string
  device?: string
  updatedAt: number
  fileId: string
  version: string
  enc?: string
  state: CloudNoteState
}

/**
 * Drive에 올라가 있는 노트 목록 — 메타만으로 만든다(본문 내려받지 않음).
 * 상태: same(최신) / remote-new(받을 업데이트·새 노트, 파란 점) /
 *       pending(이 기기 변경이 올리기 대기) / deleted-local(이 기기에서 지운 노트, 빨간 점)
 */
export async function listCloudNotes(): Promise<CloudNoteInfo[]> {
  const f = await ensureFolders()
  const remotes = await drive.listFiles(f.docs)
  const pending = await pendingDocs()
  const out: CloudNoteInfo[] = []
  for (const remote of remotes) {
    const docId = remote.appProperties?.docId
    if (!docId) continue
    const local = await db.documents.get(docId)
    const rec = await getSync<FileRecord>(`doc:${docId}`)
    // Drive 인덱스 지연으로 listFiles의 version이 잠깐 stale해질 수 있다.
    // 내 기록이 클라우드 version보다 '같거나 새로우면'(>=) 이미 맞춰진 것으로 본다.
    const same = !!rec && BigInt(rec.version) >= BigInt(remote.version)
    const localGone = !local || !!local.deletedAt
    const gone = localGone || !!(await getSync(`gone:${docId}`))
    out.push({
      docId,
      title: remote.appProperties?.title || local?.title || docId,
      device: remote.appProperties?.device,
      updatedAt: Number(remote.appProperties?.updatedAt) || Date.parse(remote.modifiedTime),
      fileId: remote.id,
      version: remote.version,
      enc: remote.appProperties?.enc,
      state: gone ? 'deleted-local' : pending.has(docId) ? 'pending' : same ? 'same' : 'remote-new'
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 클라우드 노트 한 개를 이 기기로 내려받는다. 삭제 대기 중이던 노트면 대기를 지우고 되살린다 */
export async function downloadCloudNote(
  info: Pick<CloudNoteInfo, 'docId' | 'fileId' | 'version' | 'enc'>
): Promise<'applied' | 'skipped' | 'notfound'> {
  const file = await drive.downloadJson<DocFileV1>(info.fileId, info.enc)
  if (file?.kind !== 'inkpad-doc') return 'notfound'
  const pending = await pendingDocs()
  const p = pending.get(info.docId)
  if (p) await db.outbox.bulkDelete(p.seqs) // 삭제 대기였다면 사용자가 명시적으로 받은 것이 우선
  if (!(await applyDocFile(file))) return 'skipped'
  await putSync(`doc:${info.docId}`, { fileId: info.fileId, version: info.version })
  await saveBase(info.docId, file)
  await db.syncState.delete(`gone:${info.docId}`) // 명시적으로 받았으니 되살린 것
  emitRemoteChanged(new Set<string>([info.docId]))
  return 'applied'
}

/**
 * 클라우드 노트 삭제 — Drive 파일을 휴지통으로 옮긴다(30일 보관, 복구 가능).
 * 공용 보관소에서 치우는 것일 뿐이라 각 기기의 로컬 사본은 그대로다.
 * 이후 이 기기에서 그 노트를 다시 고쳐 올리면 새 파일로 올라간다.
 */
export async function deleteCloudNote(info: Pick<CloudNoteInfo, 'docId' | 'fileId'>): Promise<void> {
  await drive.trash(info.fileId)
  await db.syncState.delete(`doc:${info.docId}`)
  await db.syncState.delete(`base:${info.docId}`)
  await db.syncState.delete(`gone:${info.docId}`)
}

// ───────────────── 올리기 계획 (미리보기) ─────────────────

export interface PushDoc {
  docId: ID
  title: string
  change: 'add' | 'modify' | 'delete'
}

export interface PushPlan {
  docs: PushDoc[]
  folders: boolean
  /** 새로 올릴 원본(PDF·이미지) 수와 총 바이트 */
  assets: { count: number; bytes: number }
}

/** 올리기 전 미리보기: 이번 올리기에 뭐가 들어가는지 계산한다 (Drive 호출 없음) */
export async function planPush(): Promise<PushPlan> {
  const rows = await db.outbox.toArray()
  const pending = await pendingDocs()
  const plan: PushPlan = {
    docs: [],
    folders: rows.some((r) => r.entity === 'folder'),
    assets: { count: 0, bytes: 0 }
  }
  for (const [docId] of pending) {
    const doc = await db.documents.get(docId)
    if (!doc) plan.docs.push({ docId, title: docId, change: 'delete' })
    else if (doc.deletedAt) plan.docs.push({ docId, title: doc.title, change: 'delete' })
    else plan.docs.push({ docId, title: doc.title, change: (await getSync(`base:${docId}`)) ? 'modify' : 'add' })
  }
  for (const r of rows.filter((x) => x.entity === 'asset')) {
    const a = await db.assets.get(r.entityId)
    if (!a?.blob) continue
    if (await getSync(`asset:${a.sha256}`)) continue
    plan.assets.count++
    plan.assets.bytes += a.size
  }
  return plan
}

/** 이 노트 하나만 클라우드에 올린다 (노트 메뉴의 "클라우드에 올리기") */
export async function pushOneNote(docId: ID): Promise<void> {
  const doc = await db.documents.get(docId)
  if (!doc || doc.deletedAt) throw new Error('이 기기에서 삭제된 노트입니다.')
  const f = await ensureFolders()
  const info = (await pendingDocs()).get(docId) ?? { seqs: [] }
  await pushDoc(docId, info, f)
}

// ───────────────── 실행 (규칙 6) ─────────────────

/** 받고 올리기 — 버전 되돌리기 등 "둘 다 필요한" 곳에서 쓴다 */
export async function syncNow(): Promise<void> {
  try {
    await getAccessToken()
  } catch (e) {
    handleSyncError(e)
    return
  }
  await pushNow()
}

// 동기화는 사용자가 "받기"/"올리기" 버튼을 눌렀을 때만 실행된다 (자동 백그라운드 동기화 없음).
// 여기서는 온라인/오프라인 상태 표시와 세션 확인(네트워크 확인만, Drive 호출 없음)만 한다.
export function startSync() {
  window.addEventListener('online', () => setStatus('idle'))
  window.addEventListener('offline', () => setStatus('offline'))
  getAccessToken().catch((e) => {
    if (e instanceof AuthRequiredError) setStatus('auth-required')
    else if (e instanceof SyncNotConfiguredError) setStatus('disabled')
  })
}
