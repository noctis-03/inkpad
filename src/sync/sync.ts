// 동기화 엔진 — 노트 1개 = Drive 파일 1개, git의 풀/푸시/머지를 노트 단위로.
// 규칙:
//  1. push(업로드) 먼저, pull(다운로드) 나중에
//  2. 충돌 = 로컬도 고쳤고 다른 기기도 올렸음(Drive 버전이 마지막 동기화 값과 다름)
//     → 마지막 동기화 스냅샷(base)으로 획(요소) 단위 3-way 머지 (sync/merge.ts).
//       양쪽이 새로 그린 획은 모두 살고, 같은 획을 양쪽에서 다르게 고쳤을 때만 충돌.
//       머지 전 이 기기 상태는 Drive 리비전으로 남겨 버전 기록에서 복구할 수 있다.
//       충돌이 있거나 base가 없으면 적용 전에 확인 창으로 방향(원격 우선·이 기기 우선·나중에)을 묻는다.
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
// 11. 이 기기 DB의 노트 내용을 바꾸는 일(머지 적용·받기·맞추기)은 노트 보호(storage/docGuard) 안에서 한다.
//     이 탭의 편집 화면은 먼저 메모리의 변경을 기록하고 멈췄다가 바뀐 내용으로 다시 열리고,
//     다른 탭이 편집 중인 노트는 건드리지 않고 건너뛴다(DocBusyError).
import type { DocumentMeta, ID } from '../shared/model'
import { gzipJson } from '../storage/compress'
import { db } from '../storage/db'
import { DocBusyError, flushOpenDocs, withDocExclusive } from '../storage/docGuard'
import { getHiddenCategories } from '../storage/repo'
import { applyDocFile } from './apply'
import * as drive from './drive'
import { indexAssets } from './assets'
import { loadBase, saveBase } from './base'
import { ensureBackupsFolder, ensureFolders, enqueueEverything, getSync, putSync, type FileRecord } from './folders'
import { assetFileName, packDocument, type DocFileV1, type RevMarker } from './pack'
import { mergeDocs, type MergeConflictDetail } from './merge'
import { isUpToDate, mergedUpdatedAt, newestPerDoc, pullSkipReason, verNum } from './judge'
import { rememberRevTag } from './revTags'
import { AuthRequiredError, SyncNotConfiguredError, getAccessToken, getDeviceName } from './token'
import { clearPendingIfUnchanged, pendingSeqsFor } from './unchanged'
import { refreshMissingThumbnailsWithToast } from '../io/docThumb'

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

/** 동기화 창이 닫힌 뒤에 끝나도 사용자가 알 수 있게 — 토스트는 전역 상태로 띄운다 */
function notifyToast(text: string, kind: 'info' | 'success' | 'error' = 'success') {
  void import('../app/store').then(({ useUI }) => useUI.getState().toast(text, kind))
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
/** 머지가 일어났을 때 (UI가 "버전 기록 보기" 안내를 띄운다) — detail: MergeEventDetail */
export const CONFLICT_EVENT = 'inkpad-conflict-resolved'

export interface MergeEventDetail {
  docId: ID
  revisionId: string
  decision: 'theirs' | 'ours'
  conflicts: number
  baseless: boolean
}

// ───────── 머지 확인 게이트 ─────────
// 충돌이 있는 머지는 적용 전에 사용자에게 방향을 묻는다. UI(App)가 setMergeConfirmHook으로
// 응답자를 등록하고, 등록 전이면(테스트 등) 기존 규칙대로 원격 우선으로 진행한다.
export type MergeDecision = 'theirs' | 'ours' | 'later'

export interface MergeConfirmInfo {
  docId: ID
  title: string
  /** 겹쳐 덮이는 부분의 수 */
  conflicts: number
  details: MergeConflictDetail[]
  /** 마지막 동기화 기록(base)이 없어 양쪽을 모두 남겨 합친다 — 지운 획이 되살아날 수 있다 */
  baseless: boolean
}

let mergeConfirmHook: ((info: MergeConfirmInfo) => Promise<MergeDecision>) | null = null

/** 머지 확인 창의 응답자를 등록한다 — App이 뜰 때 한 번 등록한다 */
export function setMergeConfirmHook(hook: ((info: MergeConfirmInfo) => Promise<MergeDecision>) | null): void {
  mergeConfirmHook = hook
}

// ───────── 머지 기록 (기기 로컬 전용) ─────────
// 이 기기에서 일어난 머지의 이력 — 동기화 패널의 "머지 기록"이 읽는다.
// syncState에만 남기므로 다른 기기의 기록은 그 기기의 목록이 가진다.
export interface MergeLogEntry {
  docId: ID
  title: string
  device: string
  at: number
  conflicts: number
  /** 원격 우선 · 이 기기 우선 (충돌 없이 자동으로 합쳐졌으면 conflicts가 0) */
  decision: 'theirs' | 'ours'
  details: MergeConflictDetail[]
  /** base 없이 양쪽을 모두 남겨 합쳤다 (옛 기록엔 없다) */
  baseless?: boolean
}

const MERGE_LOG_KEY = 'mergeLog'

/** 머지 기록이 바뀌었을 때 — UI(배지 등)가 즉시 다시 읽도록 알린다 */
export const MERGE_LOG_EVENT = 'inkpad-mergelog-changed'
const emitMergeLogChanged = () => window.dispatchEvent(new Event(MERGE_LOG_EVENT))

export async function listMergeLog(): Promise<MergeLogEntry[]> {
  return (await getSync<MergeLogEntry[]>(MERGE_LOG_KEY)) ?? []
}

export async function clearMergeLog(): Promise<void> {
  await putSync(MERGE_LOG_KEY, [])
  emitMergeLogChanged()
}

const MERGE_LOG_SEEN_KEY = 'mergeLogSeenAt'

/** 이 기기에서 마지막으로 머지 기록 서랍을 확인한 시각 — 그 뒤에 일어난 머지가 '확인하지 않은 머지'다 */
export async function getMergeLogSeenAt(): Promise<number> {
  return (await getSync<number>(MERGE_LOG_SEEN_KEY)) ?? 0
}

export async function markMergeLogSeen(at: number): Promise<void> {
  await putSync(MERGE_LOG_SEEN_KEY, at)
}

async function logMerge(entry: MergeLogEntry): Promise<void> {
  try {
    const log = await listMergeLog()
    log.unshift(entry)
    await putSync(MERGE_LOG_KEY, log.slice(0, 50)) // 최근 50건만 — 무한히 남기지 않는다
    emitMergeLogChanged()
  } catch (e) {
    console.warn('[sync] 머지 기록 남기기 실패 — 동기화는 계속됩니다:', e)
  }
}
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('inkpad-sync') : null
channel?.addEventListener('message', (ev: MessageEvent<string[]>) => {
  window.dispatchEvent(new CustomEvent(REMOTE_EVENT, { detail: new Set<string>(ev.data) }))
})
function emitRemoteChanged(ids: Set<string>) {
  window.dispatchEvent(new CustomEvent(REMOTE_EVENT, { detail: ids }))
  channel?.postMessage([...ids])
}

// ───────────────── 공통 ─────────────────
// base 스냅샷(saveBase·loadBase)은 sync/base.ts — 되돌림 판정(unchanged.ts)이 함께 쓴다

// verNum·isUpToDate·newestPerDoc 등 "받아야 하나" 판정은 sync/judge.ts (테스트: npm run test:sync)

/**
 * 받기 대상 — 받기(pull)와 받기 미리보기(planPull)가 같은 목록을 쓴다 (예전에는 따로 골라 서로 어긋났다).
 * 같은 노트의 중복 파일은 최신 하나만, 건너뛸 이유(지움·숨긴 카테고리·휴지통·올리기 대기·이미 맞춤)가 있으면 뺀다.
 */
async function pullCandidates(remotes: drive.RemoteFile[]): Promise<{ docId: ID; remote: drive.RemoteFile; local: DocumentMeta | undefined }[]> {
  const outboxRows = await db.outbox.toArray()
  const pendingIds = new Set(outboxRows.filter((x) => x.entity === 'document').map((x) => x.entityId))
  const hidden = new Set(await getHiddenCategories())
  const out: { docId: ID; remote: drive.RemoteFile; local: DocumentMeta | undefined }[] = []
  for (const remote of newestPerDoc(remotes)) {
    const docId = remote.appProperties!.docId
    const remoteCat = remote.appProperties?.category
    const local = await db.documents.get(docId)
    const skip = pullSkipReason({
      gone: !!(await getSync(`gone:${docId}`)),
      hidden: !!remoteCat && hidden.has(remoteCat),
      local,
      pending: pendingIds.has(docId),
      rec: await getSync<FileRecord>(`doc:${docId}`),
      remote
    })
    if (!skip) out.push({ docId, remote, local })
  }
  return out
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
      const { uploaded, busy } = await push(f)
      const pulled = await pull(f)
      await db.syncState.put({ key: 'lastPushAt', value: Date.now() })
      setStatus('idle')
      if (uploaded > 0) {
        // 동기화 창을 닫고 나서 끝났어도 알 수 있게 한다 — 토스트는 전역으로 뜨고,
        // 라이브러리 카드의 동기화 표시는 DB만 다시 읽어 최신으로 칠한다 (다른 탭에도 브로드캐스트)
        notifyToast(`노트 ${uploaded}개를 올렸습니다.`)
        window.dispatchEvent(new Event(CLOUD_STATES_EVENT))
        cloudStatesChannel?.postMessage(Date.now())
      }
      const skipped = busy + pulled.busy
      if (skipped > 0) notifyToast(`다른 탭에서 편집 중인 노트 ${skipped}개는 건너뛰었습니다. 그 탭을 닫은 뒤 다시 올려 주세요.`, 'info')
    } catch (e) {
      handleSyncError(e)
    } finally {
    }
  })
}

/** 실제로 Drive에 올라가는 노트만 돌려 실행한다. 삭제(묘비)·클라우드 삭제 제외 노트는 올라가는 게 없어
 * "노트 n/n 올리는 중"의 n에 끼면 표시가 실제와 어긋난다 — 집계에서도 뺀다.
 * busy: 다른 탭에서 편집 중이라 머지하지 못하고 남겨 둔 노트 수 (대기는 그대로 남아 다음에 다시 올린다) */
async function push(f: { docs: string; assets: string }): Promise<{ uploaded: number; busy: number }> {
  // 이 탭의 편집 화면이 메모리에만 들고 있는 변경(저장 대기 0.5초)도 이번 올리기에 싣는다
  await flushOpenDocs()
  const rows = await db.outbox.toArray()
  const docs = await pendingDocs()

  const uploadable = new Set<ID>()
  for (const [docId] of docs) {
    const doc = await db.documents.get(docId)
    if (!doc || doc.deletedAt) continue
    // 클라우드에서 삭제된 노트는 일괄 올리기에서 뺀다 — 목록의 행을 직접 눌렀을 때만 다시 올린다 (지시서 3번)
    if (await getSync(`clouddel:${docId}`)) continue
    uploadable.add(docId)
  }

  let n = 0
  let uploaded = 0
  let busy = 0
  for (const [docId, info] of docs) {
    if (!uploadable.has(docId)) {
      const doc = await db.documents.get(docId)
      if (!doc || doc.deletedAt) await pushTombstone(docId, info) // 삭제는 묘비만 남긴다 — Drive에 올라가는 게 없다
      continue
    }
    emitProgress('push', ++n, uploadable.size)
    try {
      if (await pushDoc(docId, info, f)) uploaded++ // 되돌리기로 내용이 같아진 노트는 올리지 않고 뺀다
    } catch (e) {
      if (!(e instanceof DocBusyError)) throw e
      busy++ // 다른 탭에서 편집 중 — 머지를 미루고 대기를 남긴다
    }
  }

  for (const r of rows.filter((r) => r.entity === 'asset')) {
    await ensureAssetUploaded(r.entityId, f.assets)
    await db.outbox.delete(r.seq!)
  }

  return { uploaded, busy }
}

async function pushDoc(docId: ID, info: PendingDoc, f: { docs: string; assets: string }): Promise<boolean> {
  // 되돌리기(실행 취소)로 내용이 마지막 동기화 시점과 같아졌으면 올리지 않고 대기를 내린다 —
  // 바뀐 게 없는데 리비전을 하나 더 만드는 일이 없게 한다.
  // '되돌림' 리비전(버전 기록 복원)은 내용이 같아도 사용자가 명시적으로 요청한 반영이므로 그대로 올린다.
  const restored = (await getSync<string>(`revKind:${docId}`)) === 'restore'
  if (!restored && info.seqs.length > 0 && (await clearPendingIfUnchanged(docId, info.seqs))) return false

  const record = await getSync<FileRecord>(`doc:${docId}`)
  let remote: drive.RemoteFile | null = null
  if (record?.fileId) {
    remote = await drive.getMeta(record.fileId)
    if (remote?.trashed) remote = null
  }
  if (!remote) {
    // 기록이 없거나 기록한 파일이 사라졌다(폴더가 통째로 지워져 다른 기기가 먼저 재올린 경우 등).
    // 같은 이름의 살아 있는 파일이 있으면 그 파일을 이어 쓴다 — 새 파일로 올리면 같은 docId가
    // 파일 2개로 분기하고, 폴더 재생성 뒤에는 Drive version이 재시작돼 받기의 버전 비교로
    // 분기를 구분하지 못해 두 기기가 발산한다.
    const same = await drive.findByName(`docs/${docId}.json`, f.docs)
    if (same) remote = same
  }

  // 머지: 다른 기기가 먼저 올렸거나(규칙 2), 기록과 다른 파일을 이어 쓰는 경우.
  // 재생성된 파일의 Drive version은 재시작했으므로 버전이 같든 다르든 파일 신원이 바뀌었으면
  // 머지로 합친다. 기록이 통째로 지워진 뒤(resetRemoteRecords)에도 마찬가지다 — 머지 없이
  // 덮어쓰면 다른 기기가 방금 올린 상태를 흘린다. base가 없으면 무base 머지 규칙을 따른다.
  if (remote && (!record?.version || remote.version !== record.version || remote.id !== record.fileId)) {
    // 올리기 대기는 mergePush가 노트 보호 안에서 직접 내린다 — 편집 화면이 멈추며 막 기록한 변경까지
    return mergePush(docId, remote, f.docs) // false = 확인 창에서 '나중에' — 대기를 남겨 다음 올리기 때 다시 묻는다
  }

  const file = await packDocument(docId)
  // 참조 원본을 먼저 올린다 — 노트 하나만 올릴 때도(올리기 버튼) 그 노트의 에셋 대기 항목을 치운다.
  // 바이트가 없는 원본(다른 기기에서 받아올 것)은 건드리지 않고 대기를 남긴다.
  for (const am of file.assets) {
    const arow = await db.assets.get(am.id)
    if (!arow?.blob) continue
    await ensureAssetUploaded(am.id, f.assets)
    await db.outbox.where('[entity+entityId]').equals(['asset', am.id]).delete()
  }
  const device = await getDeviceName()
  // 되돌리기로 큐에 들어갔으면 이 업로드는 '되돌림' 리비전이 된다 — 기록에서 찾기 쉽게 고정까지 한다
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
  return true
}

/** 업로드가 끝난 뒤 로컬 상태 반영 (규칙 3) — base 스냅샷도 함께 갱신 */
async function markSynced(docId: ID, file: DocFileV1, remote: drive.RemoteFile, seqs: number[]) {
  const base = await gzipJson(file)
  await db.transaction('rw', [db.documents, db.outbox, db.syncState], async () => {
    const cur = await db.documents.get(docId)
    if (!cur) return
    await putDocRecord(docId, remote.id, remote.version) // 앞으로만 (규칙 10)
    // 방금 올린 파일 표식 — 클라우드 목록이 이 파일 하나만 개별 확인하게 한다 (listCloudNotes)
    await putSync(`fresh:${docId}`, remote.id)
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
/**
 * @returns 머지를 끝까지 진행했는지 — 확인 창에서 '나중에'를 고르면 false (outbox가 남는다).
 * 다른 탭에서 편집 중인 노트면 DocBusyError (push가 건너뛴다).
 */
async function mergePush(docId: ID, remote: drive.RemoteFile, docsFolderId: string): Promise<boolean> {
  const theirs = await drive.downloadJson<DocFileV1>(remote.id, remote.appProperties?.enc)
  if (theirs?.kind !== 'inkpad-doc') {
    // 읽을 수 없는 원격 파일 위에 덮어쓰거나 대기를 버리지 않는다 — 이 기기 변경은 그대로 남긴다
    console.warn('[sync] 원격 노트 파일을 읽지 못해 머지를 건너뜁니다:', docId, remote.id)
    notifyToast(`클라우드의 "${remote.appProperties?.title || docId}" 파일을 읽지 못해 이 노트는 올리지 않았습니다.`, 'error')
    return false
  }
  // 이 기기 상태를 읽어 머지하고 적용할 때까지 편집 화면을 멈춘다 (규칙 11) — 그 사이에 그린 획이
  // 머지 결과에 덮여 사라지거나, 옛 화면이 머지 결과 위에 옛 청크를 다시 쓰는 일이 없게 한다
  return withDocExclusive(docId, async () => {
    const local = await packDocument(docId)
    const base = await loadBase(docId)
    const remoteFirst = mergeDocs(base, local, theirs)
    const device = await getDeviceName()
    const title = (await db.documents.get(docId))?.title || remote.appProperties?.title || '제목 없음'

    // 충돌이 있거나 base가 없어 양쪽을 모두 남기는 경우는 적용 전에 묻는다 — 겹치지 않은 편집은 어느 쪽을 고르든 모두 산다.
    // '나중에'면 아무것도 적용·올리지 않고 돌아간다(outbox가 남아 다음 올리기 때 다시 묻는다).
    let decision: 'theirs' | 'ours' = 'theirs'
    if (remoteFirst.conflicts > 0 || remoteFirst.baseless) {
      const answer: MergeDecision = mergeConfirmHook
        ? await mergeConfirmHook({ docId, title, conflicts: remoteFirst.conflicts, details: remoteFirst.details, baseless: remoteFirst.baseless }).catch(
            () => 'later' as const // 창이 실패하면 아무것도 적용하지 않는다 — 다음에 다시
          )
        : 'theirs'
      if (answer === 'later') return false
      decision = answer
    }
    // '이 기기 우선' — 같은 3-way 머지에서 양쪽 인자를 바꿔 부르면 겹친 부분을 이 기기 것이 이긴다.
    const outcome = decision === 'ours' ? mergeDocs(base, theirs, local) : remoteFirst
    return finishMerge({ docId, title, device, decision, outcome, local, remote, docsFolderId })
  })
}

/** 머지 결과를 기록·백업·적용·업로드한다 (mergePush의 노트 보호 구간 안에서만 부른다) */
async function finishMerge(a: {
  docId: ID
  title: string
  device: string
  decision: 'theirs' | 'ours'
  outcome: ReturnType<typeof mergeDocs>
  local: DocFileV1
  remote: drive.RemoteFile
  docsFolderId: string
}): Promise<boolean> {
  const { docId, title, device, decision, outcome, local, remote, docsFolderId } = a
  // 머지 결과는 양쪽 어느 것과도 다른 내용이므로 새 updatedAt을 단다 — 같은 값을 쓰면 먼저 올린 기기가
  // 내용 표식(isUpToDate) 때문에 머지 결과를 '이미 맞춰짐'으로 보고 받지 못한다 (sync/judge.ts)
  const merged: DocFileV1 = {
    ...outcome.file,
    doc: { ...outcome.file.doc, updatedAt: mergedUpdatedAt(local.doc.updatedAt, outcome.file.doc.updatedAt, Date.now()) }
  }
  const conflicts = outcome.conflicts

  await logMerge({ docId, title, device, at: Date.now(), conflicts, decision, details: outcome.details, baseless: outcome.baseless })

  // 머지 전 이 기기 상태를 남긴다 — 머지에서 밀린 편집의 백업('버려짐').
  // 노트 파일이 아니라 별도 백업 파일(Inkpad/backups/)로 올린다. 예전에는 노트 파일에 먼저 올려
  // 리비전으로 남겼는데, 그러면 머지 결과를 올리기 전까지 클라우드의 '현재'가 다른 기기 변경이 빠진
  // 이 기기 상태가 된다 — 그 사이 업로드가 실패하면 그대로 남고, 다른 기기는 그걸 받아 자기 변경을 잃었다.
  // 버전 기록은 이 백업 파일도 함께 보여 준다 (sync/revisions.ts).
  const backupRev: RevMarker = { kind: 'merge-backup', device, at: Date.now(), conflicts }
  await drive.upload(
    await gzipJson({ ...local, rev: backupRev }),
    {
      name: `backups/${docId}-${backupRev.at}.json`,
      mimeType: 'application/json',
      appProperties: { docId, enc: drive.ENC_GZIP, revKind: backupRev.kind, device, at: String(backupRev.at), ...(conflicts ? { revConflicts: String(conflicts) } : {}) }
    },
    await ensureBackupsFolder()
  )

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
  await putSync(`fresh:${docId}`, result.id) // 방금 올린 파일 표식
  await saveBase(docId, merged)
  await db.syncState.delete(`curRev:${docId}`) // 머지 결과가 곧 이 기기의 현재
  await db.syncState.delete(`revKind:${docId}`)
  // 올리기 대기를 내린다 — 편집 화면이 멈춰 있어 그 뒤 새 변경은 없으므로, 머지에 실린 대기 전부다
  await db.outbox.bulkDelete(await pendingSeqsFor(docId))
  const detail: MergeEventDetail = { docId, revisionId: result.version, decision, conflicts, baseless: outcome.baseless }
  window.dispatchEvent(new CustomEvent(CONFLICT_EVENT, { detail }))
  emitRemoteChanged(new Set<string>([docId]))
  return true
}

// ───────────────── Drive 파일 → 로컬 ─────────────────
// applyDocFile은 sync/apply.ts

// ───────────────── pull ─────────────────

export interface PullResult {
  docs: number
  /** 다른 탭에서 편집 중이라 받지 않고 남겨 둔 노트 수 */
  busy: number
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
      return r
    } catch (e) {
      handleSyncError(e)
      return null
    } finally {
    }
  }) as Promise<PullResult | null>
}

async function pull(f: { docs: string; assets: string }): Promise<PullResult> {
  const r: PullResult = { docs: 0, busy: 0 }
  const changed = new Set<string>()

  // 받아올 대상을 먼저 골라 총수를 확정한다 — "노트 n/N 받는 중" 진행 표시용 (구현 메모 ④).
  // 받기 미리보기(planPull)와 같은 함수로 고른다 — 미리보기에 뜬 목록이 곧 실제로 받는 목록이다
  const eligible = (await pullCandidates(await drive.listFiles(f.docs))).map((c) => c.remote)

  let n = 0
  for (const remote of eligible) {
    emitProgress('pull', ++n, eligible.length)
    const docId = remote.appProperties?.docId
    if (!docId) continue
    const file = await drive.downloadJson<DocFileV1>(remote.id, remote.appProperties?.enc)
    if (file?.kind !== 'inkpad-doc') continue
    let applied = false
    try {
      // 규칙 11 — 이 탭에서 열려 있으면 편집 화면이 먼저 기록하고 멈춘다. 그때 막 기록된 변경이
      // 있으면 applyDocFile이 적용하지 않는다(대기 중인 노트는 올리기의 머지가 맡는다)
      applied = await withDocExclusive(docId, () => applyDocFile(file))
    } catch (e) {
      if (!(e instanceof DocBusyError)) throw e
      r.busy++ // 다른 탭에서 편집 중 — 다음 받기 때 다시
      continue
    }
    if (applied) {
      await putDocRecord(docId, remote.id, remote.version)
      await saveBase(docId, file)
      changed.add(docId)
      r.docs++
    }
  }

  // 원본 바이트는 받지 않는다. 위치 기록만 채워 두고, 문서를 열 때 지연 로딩한다 (규칙 7)
  await indexAssets(f.assets)

  if (changed.size) emitRemoteChanged(changed)
  // 받은 노트의 카드 미리보기를 이 기기에서 복구한다(미리보기는 동기화 대상이 아니다).
  // 원본(PDF)이 이 기기에 이미 있으면 여기서 바로 그려지고, 없으면 다음에 열 때 채워진다.
  if (changed.size) void refreshMissingThumbnailsWithToast([...changed])
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
  // 방금 올린 파일(fresh: 표식)만 개별 확인한다. 예전에는 'doc:' 기록이 있는 모든 노트를
  // "목록에 안 보인다"는 이유로 하나씩 getMeta 했다 — 노트가 많으면 새로고침 1회가
  // 노트 수만큼 요청을 낳았다(색인 지연이 없어도 매번). 표식은 업로드 직후에만 생기므로
  // 이 루프는 보통 0~1건이다 (지시서 3번 오판 방지는 그대로 유지).
  for (const kv of await db.syncState.toArray()) {
    if (!kv.key.startsWith('fresh:')) continue
    const fileId = kv.value as string
    if (listed.has(fileId)) {
      await db.syncState.delete(kv.key) // 목록에 보였으니 표식은 임무를 마쳤다
      continue
    }
    const m = await drive.getMeta(fileId).catch(() => null)
    if (m && !m.trashed) remotes.push(m)
    else if (m) await db.syncState.delete(kv.key) // 휴지통/삭제 — 표식 정리
  }

  const pending = await pendingDocs()
  const hidden = new Set(await getHiddenCategories())
  // 같은 노트의 중복 파일은 최신 하나만 — 받기와 같은 규칙 (예전에는 목록에 두 번 뜰 수 있었다)
  const newest = newestPerDoc(remotes)
  const byDoc = new Set(newest.map((r) => r.appProperties!.docId))
  const out: CloudNoteInfo[] = []
  for (const remote of newest) {
    const docId = remote.appProperties!.docId
    const local = await db.documents.get(docId)
    const rec = await getSync<FileRecord>(`doc:${docId}`)
    // 받기와 같은 판정 (sync/judge.ts) — 위치 기록 version 또는 내용 표식(updatedAt)이 맞으면 최신
    const same = isUpToDate(rec, local, remote)
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

/** 받아올 변경 한 개 — 받기 미리보기와 올리기 미리보기의 "받을 것" 목록이 쓴다 */
export interface PullDoc {
  docId: ID
  title: string
  device?: string
  updatedAt: number
  /** Drive 파일 크기 (메타만 읽어 알 수 있는 예상 용량) */
  bytes: number
  /** 이 기기에 없는 노트(새 노트)인지, 이미 있는 노트의 새 버전인지 */
  change: 'add' | 'remote-new'
}

export interface PullPlan {
  docs: PullDoc[]
  bytes: number
}

/**
 * 받아올(풀에서 내려받을) 변경의 목록과 예상 용량 — 클라우드 목록만 읽고 본문은 받지 않는다.
 * 받기 미리보기와, 올리기 미리보기의 "올린 뒤 다른 기기의 변경" 목록이 쓴다.
 * 판정 규칙은 받기(pull)의 대상 선정과 같다 — 숨긴 카테고리·삭제·로컬 변경 대기 노트도 뺀다 (규칙 9·10).
 */
export async function planPull(): Promise<PullPlan> {
  const f = await ensureFolders()
  const docs: PullDoc[] = []
  let bytes = 0
  // 받기(pull)와 같은 함수로 고른다 — 미리보기 목록 = 실제로 받는 목록
  for (const { docId, remote, local } of await pullCandidates(await drive.listFiles(f.docs))) {
    const remoteUpdatedAt = Number(remote.appProperties?.updatedAt) || 0
    const size = Math.max(0, Number(remote.size ?? 0) || 0)
    bytes += size
    docs.push({
      docId,
      title: remote.appProperties?.title || local?.title || docId,
      device: remote.appProperties?.device,
      updatedAt: remoteUpdatedAt || Date.parse(remote.modifiedTime) || 0,
      bytes: size,
      change: local ? 'remote-new' : 'add'
    })
  }
  return { docs, bytes }
}

/**
 * 클라우드 노트 한 개를 이 기기로 내려받는다. 삭제 대기 중이던 노트면 대기를 지우고 되살린다.
 * 다른 탭에서 편집 중인 노트면 DocBusyError(메시지는 그대로 화면에 보여도 된다).
 */
export async function downloadCloudNote(
  info: Pick<CloudNoteInfo, 'docId' | 'fileId' | 'version' | 'enc'>
): Promise<'applied' | 'skipped' | 'notfound'> {
  const file = await drive.downloadJson<DocFileV1>(info.fileId, info.enc)
  if (file?.kind !== 'inkpad-doc') return 'notfound'
  // 규칙 11 — 열린 편집 화면을 먼저 멈추고 기록하게 한 뒤에 대기를 지운다(그래야 방금 기록된 대기도 함께 치운다)
  const applied = await withDocExclusive(info.docId, async () => {
    const p = (await pendingDocs()).get(info.docId)
    if (p) await db.outbox.bulkDelete(p.seqs) // 삭제 대기였다면 사용자가 명시적으로 받은 것이 우선
    return applyDocFile(file)
  })
  if (!applied) return 'skipped'
  await putDocRecord(info.docId, info.fileId, info.version) // 앞으로만 (규칙 10)
  await saveBase(info.docId, file)
  await db.syncState.delete(`gone:${info.docId}`) // 명시적으로 받았으니 되살린 것
  emitRemoteChanged(new Set<string>([info.docId]))
  return 'applied'
}

/**
 * 보드의 연결 끊긴 노트 바로가기를 클라우드에서 찾아 받는다.
 * 이 기기에 위치 기록(fileId)이 없어도 파일 이름이 docId.json 이므로 이름으로 찾을 수 있다.
 * 보드 카드의 "받기"를 사용자가 눌렀을 때만 호출된다 — 자동 네트워크 사용은 없다.
 */
export async function downloadMissingDoc(docId: ID): Promise<'applied' | 'skipped' | 'notfound'> {
  const f = await ensureFolders()
  const remote = await drive.findByName(`docs/${docId}.json`, f.docs)
  if (!remote) return 'notfound'
  return downloadCloudNote({ docId, fileId: remote.id, version: remote.version, enc: remote.appProperties?.enc })
}

/**
 * 클라우드에 맞추기 — 이 기기의 올리기 대기를 내리고 클라우드 버전으로 덮어쓴다.
 * 일반 '받기'는 이 기기에 수정 대기가 있으면 사양하지만, 이 함수는 메뉴에서 명시적으로
 * 골랐으므로 대기를 치우고 덮어쓴다 — 로컬의 바뀜은 버려진다 (확인 창을 한 번 거친다).
 */
export async function alignWithCloud(docId: ID): Promise<'applied' | 'skipped' | 'notfound'> {
  const f = await ensureFolders()
  const remote = await drive.findByName(`docs/${docId}.json`, f.docs)
  if (!remote) return 'notfound'
  // 덮어쓸 것이므로 이 기기의 올리기 대기는 downloadCloudNote가 노트 보호 안에서 내린다
  // (편집 화면이 멈추며 막 기록한 변경의 대기까지 함께 — 밖에서 먼저 지우면 그 대기가 남아 '건너뜀'이 된다)
  return downloadCloudNote({ docId, fileId: remote.id, version: remote.version, enc: remote.appProperties?.enc })
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
  await flushOpenDocs() // 열린 편집 화면의 저장 대기 중인 변경도 싣는다
  const info = (await pendingDocs()).get(docId) ?? { seqs: [] }
  await pushDoc(docId, info, f) // 다른 탭에서 편집 중이라 머지할 수 없으면 DocBusyError — 화면에 그대로 알린다
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
