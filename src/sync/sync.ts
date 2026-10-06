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
//  8. 문서 JSON은 gzip으로 올린다(appProperties.enc 표식). appProperties에 제목·기기·
//     카테고리를 함께 넣어, 클라우드 노트 목록을 메타만으로 그린다
//  9. 폴더·카테고리 매핑·숨김은 기기별 로컬 전용 — Drive로 주고받지 않는다.
//     카테고리는 문서 파일의 category 필드로 동기화하고, 숨긴 카테고리의 노트는 받기에서 건너뛴다
//     앱·기타 파일은 노트 동기화와 분리 — 각 메뉴(sync/apps.ts, sync/files.ts)에서 관리
// 10. 문서 위치 기록(doc:)의 version은 앞으로만 간다. Drive version은 실제보다 뒤처져 보일 수 있고
//     (listFiles 인덱스 지연, 리비전 고정·해제 같은 메타데이터 전용 쓰기도 값을 올린다),
//     뒤처진 값으로 덮으면 방금 올린 노트가 "받을 것"으로 오판된다
import type { ID } from '../shared/model'
import { gzipJson, gunzipJson } from '../storage/compress'
import { db } from '../storage/db'
import { getHiddenCategories } from '../storage/repo'
import { applyDocFile } from './apply'
import * as drive from './drive'
import { indexAssets } from './assets'
import { ensureFolders, enqueueEverything, getSync, putSync, type FileRecord } from './folders'
import { assetFileName, packDocument, type DocFileV1, type RevMarker } from './pack'
import { mergeDocs } from './merge'
import { rememberRevTag } from './revTags'
import { AuthRequiredError, SyncNotConfiguredError, getAccessToken, getDeviceName } from './token'

const SYNC_LOCK = 'inkpad-sync'
/** appProperties에 담을 수 있는 값의 상한 (Google Drive 제한: UTF-8 124바이트) */
const APP_PROPERTY_MAX_BYTES = 124

/** appProperties 값 상한(키+값 합계)에 맞춰 뒤에서부터 잘라낸다 */
function fitProp(key: string, value: string): string {
  const enc = new TextEncoder()
  let v = value
  while (v && enc.encode(key).length + enc.encode(v).length > APP_PROPERTY_MAX_BYTES) v = Array.from(v).slice(0, -1).join('')
  return v
}

/** appProperties용 title 표식 — 키 길이를 포함한 상한을 넘으면 잘라 넣는다(본문에는 항상 온전히 들어간다) */
function titleProp(title: string | null | undefined): Record<string, string> {
  if (!title) return {}
  return { title: fitProp('title', title) }
}

/**
 * appProperties용 category 표식 — 키+값 합계 상한을 넘으면 생략한다(본문에는 항상 들어간다).
 * 값만 124바이트로 검사하면 한글 40자(≈120바이트)에 키 'category'(8바이트)가 붙어 128바이트가 되고,
 * Drive가 업로드 전체를 거부한다. 키 길이를 포함해 검사해야 한다.
 */
function categoryProp(category: string | null | undefined): Record<string, string> {
  if (!category) return {}
  const enc = new TextEncoder()
  if (enc.encode('category').length + enc.encode(category).length > APP_PROPERTY_MAX_BYTES) return {}
  return { category }
}

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

// ───────────────── 진행 표시 ─────────────────

/** 받기·올리기의 노트 단위 진행 — 상태 카드의 "노트 2/5 올리는 중" 문구용 (구현 메모 ④) */
export interface SyncProgress {
  phase: 'push' | 'pull'
  done: number
  total: number
}
const progressListeners = new Set<(p: SyncProgress) => void>()
export const onSyncProgress = (fn: (p: SyncProgress) => void) => {
  progressListeners.add(fn)
  return () => {
    progressListeners.delete(fn)
  }
}
const emitProgress = (phase: SyncProgress['phase'], done: number, total: number) => {
  if (total <= 0 || progressListeners.size === 0) return
  const p: SyncProgress = { phase, done, total }
  progressListeners.forEach((f) => f(p))
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

/** Drive version 비교용 — int64 문자열이라 Number로는 정밀도를 잃는다. 없거나 깨졌으면 0으로 본다 */
function verNum(v: string | undefined): bigint {
  try {
    return BigInt(v ?? 0)
  } catch {
    return 0n
  }
}

/**
 * 문서 위치 기록(doc:)을 앞으로만 갱신한다 (규칙 10).
 * Drive version은 실제보다 뒤처져 보일 수 있어(인덱스 지연, 메타데이터 전용 쓰기),
 * 뒤처진 값으로 덮으면 방금 올린 노트가 "받을 것"으로 오판된다.
 */
async function putDocRecord(docId: ID, fileId: string, version: string): Promise<void> {
  const rec = await getSync<FileRecord>(`doc:${docId}`)
  if (rec && verNum(rec.version) >= verNum(version)) return
  await putSync(`doc:${docId}`, { fileId, version })
}

interface PendingDoc {
  seqs: number[]
}

async function pendingDocs(): Promise<Map<ID, PendingDoc>> {
  const rows = await db.outbox.toArray()
  const docs = new Map<ID, PendingDoc>()
  for (const r of rows) {
    if (r.entity === 'asset') continue
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

// ───────────────── 라이브러리 카드 동기화 상태 점 ─────────────────

export const CLOUD_STATES_EVENT = 'inkpad-cloud-states-changed'
const cloudStatesChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('inkpad-cloud-states') : null
if (cloudStatesChannel) cloudStatesChannel.onmessage = () => window.dispatchEvent(new Event(CLOUD_STATES_EVENT))

/** 라이브러리 카드 점의 상태 — cloud-deleted·deleted-local은 'new'(회색)로 뭉갠다 */
export type CardSyncState = 'new' | 'pending' | 'same' | 'remote-new'

/** 동기화창이 클라우드 노트 목록을 새로고침하면 그 판정을 캐시해 둔다 — 라이브러리 점이 함께 읽는다 */
async function cacheCloudStates(infos: CloudNoteInfo[]): Promise<void> {
  const states: Record<string, CloudNoteState> = {}
  const versions: Record<string, string> = {}
  for (const i of infos) {
    states[i.docId] = i.state
    if (i.version) versions[i.docId] = i.version
  }
  await putSync('cloudStates', { at: Date.now(), states, versions })
  window.dispatchEvent(new Event(CLOUD_STATES_EVENT))
  cloudStatesChannel?.postMessage(Date.now())
}

/**
 * 라이브러리 카드의 점 상태 — 네트워크 없이 DB만 읽는다.
 * remote-new는 동기화창에서 클라우드 목록을 새로고침했을 때만 알 수 있고(자동 통신 없음),
 * 캐시가 낡았어도 위치 기록(doc:)의 version이 캐시 이상으로 올라갔으면(받기·올리기 완료) 파란 점을 푼다
 */
export async function cardSyncStates(): Promise<Map<ID, CardSyncState>> {
  const [docs, pending, cache] = await Promise.all([
    db.documents.toArray(),
    pendingDocs(),
    getSync<{ at: number; states: Record<string, CloudNoteState>; versions: Record<string, string> }>('cloudStates')
  ])
  const out = new Map<ID, CardSyncState>()
  for (const d of docs) {
    if (d.deletedAt) continue // 휴지통 노트는 점을 달지 않는다
    let s: CardSyncState
    if (pending.has(d.id)) s = 'pending' // 이 기기 변경이 올리기 대기
    else {
      const rec = await getSync<FileRecord>(`doc:${d.id}`)
      const cached = cache?.states[d.id]
      if (cached === 'remote-new' && (!rec || verNum(rec.version) < verNum(cache?.versions?.[d.id]))) s = 'remote-new'
      else if (!rec || cached === 'cloud-deleted') s = 'new' // 클라우드에 없음
      else s = 'same' // 위치 기록이 있고 대기도 없음 — 최신
    }
    out.set(d.id, s)
  }
  return out
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

async function push(f: { docs: string; assets: string }) {
  const rows = await db.outbox.toArray()
  const docs = await pendingDocs()

  let n = 0
  for (const [docId, info] of docs) {
    emitProgress('push', ++n, docs.size) // 쓰이지 않던 카운터로 진행을 내보낸다 (구현 메모 ④)
    const doc = await db.documents.get(docId)
    if (!doc || doc.deletedAt) await pushTombstone(docId, info)
    // 클라우드에서 삭제된 노트는 일괄 올리기에서 뺀다 — 목록의 행을 직접 눌렀을 때만 다시 올린다 (지시서 3번)
    else if (await getSync(`clouddel:${docId}`)) continue
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
  // 되돌리기로 큐에 들어갔으면 이 업로드는 '되돌림' 리비전이 된다 — 기록에서 찾기 쉽게 고정까지 한다
  const restored = (await getSync<string>(`revKind:${docId}`)) === 'restore'
  const rev: RevMarker = { kind: restored ? 'restore' : 'push', device, at: Date.now() }
  const result = await drive.upload(
    await gzipJson({ ...file, rev }),
    {
      name: `docs/${docId}.json`,
      mimeType: 'application/json',
      appProperties: { docId, updatedAt: String(file.doc.updatedAt), ...titleProp(file.doc.title), device, enc: drive.ENC_GZIP, revKind: rev.kind, ...categoryProp(file.doc.category) }
    },
    f.docs,
    remote?.id
  )
  await rememberRevTag(result.id, { device, revKind: rev.kind }, restored)
  // 업로드 직후의 메타 쓰기(리비전 고정 등)도 Drive version을 올린다. 업로드 응답의 version을
  // 그대로 저장하면 기록이 한 발 뒤처져, 목록이 방금 올린 노트를 "받을 것"으로 오판한다.
  // 그래서 헤드를 다시 읽어 저장한다 (규칙 10)
  const head = (await drive.getMeta(result.id).catch(() => null)) ?? result
  await markSynced(docId, file, head, info.seqs)
}

/** 업로드가 끝난 뒤 로컬 상태 반영 (규칙 3) — base 스냅샷도 함께 갱신 */
async function markSynced(docId: ID, file: DocFileV1, remote: drive.RemoteFile, seqs: number[]) {
  const base = await gzipJson(file)
  await db.transaction('rw', [db.documents, db.outbox, db.syncState], async () => {
    const cur = await db.documents.get(docId)
    if (!cur) return
    await putDocRecord(docId, remote.id, remote.version) // 앞으로만 (규칙 10)
    await putSync(`base:${docId}`, { blob: base })
    await db.syncState.delete(`gone:${docId}`) // 휴지통에서 살아나서 다시 올렸다
    await db.syncState.delete(`clouddel:${docId}`) // 클라우드에서 삭제됐던 노트를 다시 올렸다 (지시서 3번)
    await db.syncState.delete(`curRev:${docId}`) // 되돌림 표식 해제 — 이제 헤드가 곧 이 기기의 현재
    await db.syncState.delete(`revKind:${docId}`)
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
  await db.syncState.delete(`curRev:${docId}`)
  await db.syncState.delete(`revKind:${docId}`)
  await db.outbox.bulkDelete(info.seqs)
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
  const { file: merged, conflicts } = mergeDocs(base, local, theirs)
  const device = await getDeviceName()

  // 머지 전 이 기기 상태를 리비전으로 남긴다 — 머지에서 밀린 편집의 백업('버려짐').
  // 고정해 두어야 버전 기록에서 내려받아 표식(기기명)을 읽을 수 있고 30일 자동 삭제도 피한다.
  const backupRev: RevMarker = { kind: 'merge-backup', device, at: Date.now(), conflicts }
  const backup = await drive.upload(
    await gzipJson({ ...local, rev: backupRev }),
    { name: `docs/${docId}.json`, mimeType: 'application/json', appProperties: { docId, enc: drive.ENC_GZIP, revKind: backupRev.kind } },
    docsFolderId,
    remote.id
  )
  await rememberRevTag(backup.id, { device, revKind: backupRev.kind, conflicts }, true)

  await applyDocFile(merged, { force: true })
  const mergedRev: RevMarker = { kind: 'merge', device, at: Date.now(), conflicts }
  const result = await drive.upload(
    await gzipJson({ ...merged, rev: mergedRev }),
    {
      name: `docs/${docId}.json`,
      mimeType: 'application/json',
      appProperties: { docId, updatedAt: String(merged.doc.updatedAt), ...titleProp(merged.doc.title), device, enc: drive.ENC_GZIP, revKind: mergedRev.kind, ...(conflicts ? { revConflicts: String(conflicts) } : {}), ...categoryProp(merged.doc.category) }
    },
    docsFolderId,
    remote.id
  )
  await rememberRevTag(result.id, { device, revKind: mergedRev.kind, conflicts })
  await putDocRecord(docId, result.id, result.version) // 앞으로만 (규칙 10)
  await saveBase(docId, merged)
  await db.syncState.delete(`curRev:${docId}`) // 머지 결과가 곧 이 기기의 현재
  await db.syncState.delete(`revKind:${docId}`)
  emitRemoteChanged(new Set<string>([docId]))
  window.dispatchEvent(new CustomEvent(CONFLICT_EVENT, { detail: { docId, revisionId: result.version } }))
}

// ───────────────── Drive 파일 → 로컬 ─────────────────
// applyDocFile은 sync/apply.ts

// ───────────────── pull ─────────────────

export interface PullResult {
  docs: number
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
      return { docs: r.docs }
    } catch (e) {
      handleSyncError(e)
      return null
    } finally {
    }
  }) as Promise<PullResult | null>
}

async function pull(f: { docs: string; assets: string }) {
  const r = { docs: 0 }
  const outboxRows = await db.outbox.toArray()
  const pendingDocs_ = new Set(outboxRows.filter((x) => x.entity === 'document').map((x) => x.entityId))
  const changed = new Set<string>()
  const hidden = new Set(await getHiddenCategories())

  // 문서
  const remotes = await drive.listFiles(f.docs)
  const recs = new Map<string, FileRecord>()
  for (const kv of await db.syncState.toArray()) {
    if (kv.key.startsWith('doc:')) recs.set(kv.key.slice(4), kv.value as FileRecord)
  }
  // 받아올 대상을 먼저 골라 총수를 확정한다 — "노트 n/N 받는 중" 진행 표시용 (구현 메모 ④)
  const eligible: typeof remotes = []
  for (const remote of remotes) {
    const docId = remote.appProperties?.docId
    if (!docId) continue
    if (await getSync(`gone:${docId}`)) continue // 이 기기에서 지운 노트 — 받기로 되살리지 않는다 (목록에서 개별 받기)
    const remoteCat = remote.appProperties?.category
    if (remoteCat && hidden.has(remoteCat)) continue // 숨긴 카테고리 — 이 기기는 받지 않는다 (클라우드 목록에는 표시)
    const local = await db.documents.get(docId)
    if (local?.deletedAt) continue // 휴지통에 있는 노트도 되살리지 않는다
    if (pendingDocs_.has(docId)) continue // 로컬 변경은 push의 머지에서 처리
    const rec = recs.get(docId)
    // 이미 맞춰진 노트는 건너뛴다. Drive version은 실제보다 뒤처져 보일 수 있으므로
    // '같거나 내 기록이 더 새로우면'(>=) 최신으로 본다. 그렇지 않으면 방금 올린 노트를
    // 남의 변경으로 오판해 되받고, 기록까지 뒤로 밀린다 (규칙 10)
    if (rec && verNum(rec.version) >= verNum(remote.version)) continue
    eligible.push(remote)
  }

  let n = 0
  for (const remote of eligible) {
    emitProgress('pull', ++n, eligible.length)
    const docId = remote.appProperties?.docId
    if (!docId) continue
    const file = await drive.downloadJson<DocFileV1>(remote.id, remote.appProperties?.enc)
    if (file?.kind !== 'inkpad-doc') continue
    if (await applyDocFile(file)) {
      await putDocRecord(docId, remote.id, remote.version)
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

// ───────────────── 클라우드 노트 목록 ─────────────────

export type CloudNoteState = 'same' | 'remote-new' | 'new' | 'pending' | 'cloud-deleted' | 'deleted-local'

export interface CloudNoteInfo {
  docId: ID
  title: string
  device?: string
  category?: string | null
  updatedAt: number
  /** Drive 파일 위치. 아직 올리지 않았거나 클라우드에서 사라진 노트('new'·'cloud-deleted')는 빈 문자열 */
  fileId: string
  version: string
  enc?: string
  state: CloudNoteState
}

/**
 * 클라우드 노트 목록 — Drive 메타와 이 기기의 로컬 전용 상태를 합쳐 그린다(본문 내려받지 않음).
 * 상태: same(최신) / remote-new(받을 업데이트·새 노트, 파란 점) /
 *       new(한 번도 올리지 않은 새 노트, 올릴 것) / pending(이 기기 변경이 올리기 대기) /
 *       cloud-deleted(클라우드에서만 삭제됨 — 행을 눌러 다시 올린다) /
 *       deleted-local(이 기기에서 지운 노트, 빨간 점)
 */
export async function listCloudNotes(): Promise<CloudNoteInfo[]> {
  const f = await ensureFolders()
  const remotes = await drive.listFiles(f.docs)

  // 오판 방지 (지시서 3번): 방금 올린 파일은 listFiles 인덱스에 늦게 반영될 수 있다 (규칙 10).
  // 위치 기록이 있는데 목록에 없는 파일은 getMeta로 그 파일만 한 번 더 확인하고,
  // 실제로 살아 있으면(=trashed가 아니면) 목록에 끼워 넣어 "클라우드에서 삭제됨" 오분류를 막는다.
  const listed = new Set(remotes.map((r) => r.id))
  for (const kv of await db.syncState.toArray()) {
    if (!kv.key.startsWith('doc:')) continue
    const rec = kv.value as FileRecord
    if (listed.has(rec.fileId)) continue
    const m = await drive.getMeta(rec.fileId).catch(() => null)
    if (m && !m.trashed) remotes.push(m)
  }

  const pending = await pendingDocs()
  const hidden = new Set(await getHiddenCategories())
  const byDoc = new Set(remotes.flatMap((r) => (r.appProperties?.docId ? [r.appProperties.docId] : [])))
  const out: CloudNoteInfo[] = []
  for (const remote of remotes) {
    const docId = remote.appProperties?.docId
    if (!docId) continue
    const local = await db.documents.get(docId)
    const rec = await getSync<FileRecord>(`doc:${docId}`)
    // 1) 위치 기록의 version으로 판정 — 받기(pull)와 같은 규칙. 내 기록이 '같거나 새로우면' 최신 (규칙 10)
    const sameByVersion = !!rec && verNum(rec.version) >= verNum(remote.version)
    // 2) 내용 표식으로도 판정. Drive version은 뒤처져 보일 수 있고, 기록이 한 번 낡으면
    //    목록은 읽기만 하므로 스스로 못 고쳐 방금 올린 노트가 영영 "받을 것"으로 남는다.
    //    appProperties.updatedAt은 이 앱이 올릴 때 직접 쓴 값이라 그런 지연·불일치에 흔들리지
    //    않는다. 둘 중 하나라도 맞으면 이미 맞춰진 것으로 본다
    const remoteUpdatedAt = Number(remote.appProperties?.updatedAt) || 0
    const sameByContent = !!local && remoteUpdatedAt > 0 && local.updatedAt === remoteUpdatedAt
    const same = sameByVersion || sameByContent
    // 이 기기에서 지운 노트인지는 표식으로 판정한다 — 휴지통(deletedAt), gone 표식,
    // 영구 삭제(위치 기록은 남고 로컬 행만 없음). 로컬 행이 없다는 이유만으로 삭제됨으로
    // 보면 다른 기기에서 새로 만들어 아직 받지 않은 노트가 "이 기기에서 삭제됨"으로 오판된다
    const gone = !!local?.deletedAt || !!(await getSync(`gone:${docId}`)) || (!local && !!rec)
    out.push({
      docId,
      title: remote.appProperties?.title || local?.title || docId,
      device: remote.appProperties?.device,
      category: remote.appProperties?.category ?? local?.category ?? null,
      updatedAt: Number(remote.appProperties?.updatedAt) || Date.parse(remote.modifiedTime),
      fileId: remote.id,
      version: remote.version,
      enc: remote.appProperties?.enc,
      state: gone ? 'deleted-local' : pending.has(docId) ? 'pending' : same ? 'same' : 'remote-new'
    })
  }

  // 로컬에만 있는 노트 — Drive 목록만으로는 보이지 않는다 (지시서 2·3번)
  for (const doc of await db.documents.toArray()) {
    if (byDoc.has(doc.id)) continue // Drive에 있다 — 위에서 판정했다
    if (doc.deletedAt) continue // 휴지통에 있는 노트는 목록에 내지 않는다
    if (doc.category && hidden.has(doc.category)) continue // 숨긴 카테고리 — 받기 규칙과 같게 (규칙 9)
    const rec = await getSync<FileRecord>(`doc:${doc.id}`)
    if (!rec && !(await getSync(`clouddel:${doc.id}`))) {
      // 한 번도 올린 적 없는 새 노트 → 올릴 것("새 파일"). outbox에 이미 들어 있어 올리기에 함께 올라간다
      out.push({ docId: doc.id, title: doc.title, category: doc.category ?? null, updatedAt: doc.updatedAt, fileId: '', version: '', state: 'new' })
    } else {
      // 올린 적이 있는데 Drive 목록에 없다 → 클라우드에서 삭제됨. 위치 기록이 살아 있으면
      // 위에서 getMeta로 실제 부재를 확인했으므로(지시서 3번 오판 방지) 여기서는 목록만 본다
      out.push({ docId: doc.id, title: doc.title, category: doc.category ?? null, updatedAt: doc.updatedAt, fileId: '', version: '', state: 'cloud-deleted' })
    }
  }
  await cacheCloudStates(out) // 동기화창 새로고침의 판정을 라이브러리 점이 함께 쓴다
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
  await putDocRecord(info.docId, info.fileId, info.version) // 앞으로만 (규칙 10)
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
  // "클라우드에서 삭제함" 표식 — 위치 기록이 지워져도 이 기기는 노트를 'cloud-deleted'로
  // 분류하고 일괄 올리기에서 뺀다 (지시서 3번). 행을 눌러 다시 올리면 지운다.
  await putSync(`clouddel:${info.docId}`, Date.now())
}

/**
 * 새 노트를 일괄 올리기에서 뺀다 — clouddel 표식만 남기고 Drive 호출은 없다.
 * 제외된 노트는 목록에서 "클라우드에 없음"(일괄 올리기에서 제외)으로 보이고,
 * 행의 "다시 올리기"(pushOneNote)로 다시 올리면 표식이 지워진다.
 * 클라우드에 올라간 적 없는 노트(new)만 이렇게 뺀다 — 이미 올라간 노트는 deleteCloudNote를 쓴다.
 */
export async function excludeFromPush(docId: ID): Promise<void> {
  await putSync(`clouddel:${docId}`, Date.now())
}

// ───────────────── 올리기 계획 (미리보기) ─────────────────

export interface PushDoc {
  docId: ID
  title: string
  change: 'add' | 'modify'
  /** 이 노트 업로드 예상 용량 — 저장된 gzip 청크 합계 (미리보기 표시용) */
  bytes: number
}

export interface PushPlan {
  docs: PushDoc[]
  /** 새로 올릴 원본(PDF·이미지) 수와 총 바이트 */
  assets: { count: number; bytes: number }
}

/** 올리기 전 미리보기: 이번 올리기에 뭐가 들어가는지 계산한다 (Drive 호출 없음) */
export async function planPush(): Promise<PushPlan> {
  const rows = await db.outbox.toArray()
  const pending = await pendingDocs()
  const plan: PushPlan = {
    docs: [],
    assets: { count: 0, bytes: 0 }
  }
  for (const [docId] of pending) {
    if (await getSync(`clouddel:${docId}`)) continue // 클라우드에서 삭제됨 — 일괄 올리기에서 제외 (지시서 3번)
    const doc = await db.documents.get(docId)
    // 삭제(휴지통·영구)는 Drive에 올라가는 게 없다 — 미리보기에 세지 않고 pushTombstone이 조용히 처리한다 (지시서 4번)
    if (!doc || doc.deletedAt) continue
    // 예상 용량: 이 노트의 gzip 청크 합계 — 올릴 때 gzipJson으로 다시 압축하지만 크기는 이와 거의 같다
    const chunks = await db.chunks.where('documentId').equals(docId).toArray()
    const bytes = chunks.filter((c) => !c.deletedAt).reduce((n, c) => n + c.data.size, 0)
    plan.docs.push({ docId, title: doc.title, change: (await getSync(`base:${docId}`)) ? 'modify' : 'add', bytes })
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
