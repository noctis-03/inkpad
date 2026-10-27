// 동기화 엔진 — 기기별 브랜치 + main (설계: docs/branch-merge.md). git의 브랜치·fast-forward를 노트 단위로.
// 규칙:
//  1. push(업로드) 먼저, pull(다운로드) 나중에
//  2. 올리기 = 내 브랜치(branches/{docId}@{deviceId}.json)를 올리고, main(docs/{docId}.json)이 내 출발점 그대로면
//     main도 이 내용으로 바꾼다(fast-forward). 브랜치는 그 기기만 쓰므로 업로드끼리 서로 덮는 일이 없다.
//     main이 그 사이 바뀌었으면 main은 건드리지 않는다 → 갈라짐. 자동 머지는 없다 — 머지 관리에서 사용자가 합친다.
//     main을 두 기기가 동시에 따라가 한쪽이 덮여도, 진 쪽 내용은 그 기기 브랜치에 있고 main의 '반영된 브랜치'(m.{기기})에
//     그 seq가 없으므로 갈라짐으로 다시 보인다 — 필기는 사라지지 않는다.
//  3. 받기 = main으로 따라가기. 갈라진 노트(이 기기 변경 또는 main에 아직 안 들어간 내 브랜치가 있는데 main도 바뀜)는 덮지 않는다
//     판정은 sync/judge.ts noteSync 하나 — 받기·받기 미리보기·클라우드 목록이 같은 판정을 쓴다
//  4. 삭제는 그 기기의 일 — 클라우드 사본은 남는다. 기기가 지운 노트는 gone 표식으로
//     받기에서 제외되고(되살리지 않음), 클라우드 목록에는 빨간 점으로 표시되며
//     목록의 노트별 "받기"로 명시적으로 되살릴 수 있다
//  5. Drive 폴더가 통째로 사라졌으면 로컬을 지우지 않고 전부 재업로드
//  6. 노트 파일을 쓰는 일은 탭이 여러 개여도 동기화 잠금(sync/lock.ts) 안에서 한 번에 하나만
//  7. 원본 바이트(PDF·이미지)는 pull에서 내려받지 않는다 — 문서를 열 때 지연 로딩 (sync/assets.ts)
//  8. 노트는 조각(바뀐 페이지만)과 매니페스트로 올린다 (sync/objects.ts) — main·브랜치 본문은 조각 목록뿐이다.
//     문서 JSON은 gzip으로 올린다(appProperties.enc 표식). appProperties에 제목·기기·카테고리와 main 표식
//     (gen·mid·m.{기기}, sync/branch.ts)을 함께 넣어, 클라우드 노트 목록과 상태를 메타만으로 그린다
//  9. 폴더·카테고리 매핑·숨김은 기기별 로컬 전용 — Drive로 주고받지 않는다.
//     카테고리는 문서 파일의 category 필드로 동기화하고, 숨긴 카테고리의 노트는 받기에서 건너뛴다
//     앱·기타 파일은 노트 동기화와 분리 — 각 메뉴(sync/apps.ts, sync/files.ts)에서 관리
// 10. 문서 위치 기록(doc:)의 version은 앞으로만 간다. Drive version은 실제보다 뒤처져 보일 수 있고
//     (listFiles 인덱스 지연, 리비전 고정·해제 같은 메타데이터 전용 쓰기도 값을 올린다),
//     뒤처진 값으로 덮으면 방금 올린 노트가 "받을 것"으로 오판된다. 출발점 판정은 version이 아니라 main 신원(mid)으로 한다
// 11. 이 기기 DB의 노트 내용을 바꾸는 일(받기·맞추기)은 노트 보호(storage/docGuard) 안에서 한다.
//     이 탭의 편집 화면은 먼저 메모리의 변경을 기록하고 멈췄다가 바뀐 내용으로 다시 열리고,
//     다른 탭이 편집 중인 노트는 건드리지 않고 건너뛴다(DocBusyError).
// 12. 자동 동기화는 없다 — 네트워크는 사용자가 누른 동작이 직접 일으킬 때만 쓴다 (tools/e2e/stores.ts가 지킨다).
//     노트: 필기·이름 바꾸기 같은 편집은 이 기기에만 저장되고, "받기"/"올리기"를 누를 때 오간다(편집은 잦고 저절로 생기므로).
//     앱·기타 파일·보드 프리셋(sync/apps·files·board): 추가·교체·이름/카테고리 변경 자체가 클라우드 스토어에
//     올리는 동작이라 그 항목만 바로 올린다. 오프라인·실패면 대기로 남고, 각 메뉴의 업로드 버튼으로 다시 올린다.
//     노트의 "올리기"는 이 대기를 올리지 않는다.
import { errorText, startActivity, trackActivity, type ActivityHandle } from '../shared/activity'
import type { DocumentMeta, ID } from '../shared/model'
import { gzipJson } from '../storage/compress'
import { db } from '../storage/db'
import { DocBusyError, flushOpenDocs, withDocExclusive } from '../storage/docGuard'
import { getHiddenCategories } from '../storage/repo'
import { applyDocFile } from './apply'
import * as drive from './drive'
import { indexAssets } from './assets'
import { loadBase, putBaseBlob, saveBase } from './base'
import {
  branchFileName,
  computeModified,
  genOf,
  isUnmerged,
  mainFileName,
  mainMidOf,
  mainProps,
  mergedOf,
  midOfFile,
  newMid,
  type BranchFile,
  type BranchMarker,
  type BranchState,
  type MainFile,
  type MainMarker
} from './branch'
import { classify, compose, type MergeDraft, type MergePlan, type Side } from './merge'
import { ensureBranchesFolder, ensureFolders, enqueueEverything, findBranchesFolder, getSync, putSync, type FileRecord } from './folders'
import { assetFileName, packDocument, type DocFileV1, type RevMarker } from './pack'
import { isUpToDate, knownBaseMid, newestPerDoc, noteSync, pullSkipReason, verNum, type NoteSync } from './judge'
import { SYNC_LOCK, withSyncLock } from './lock'
import { rememberRevTag } from './revTags'
import { takeSnapshot } from './snapshots'
import { localChanges } from './localChanges'
import { downloadNote, knownRefs, objsOf, rememberRefs, toManifest, type KnownRefs, type ObjRef } from './objects'
import { AuthRequiredError, SyncNotConfiguredError, getAccessToken, getDeviceId, getDeviceName } from './token'
import { clearPendingIfUnchanged, pendingSeqsFor } from './unchanged'
import { refreshMissingThumbnailsWithToast } from '../io/docThumb'


type MainFileExtra = Omit<MainFile, keyof DocFileV1>
type BranchFileExtra = Omit<BranchFile, keyof DocFileV1>

// appProperties 표식 — 크기 제한은 drive.ts (키+값 124바이트). 본문에는 늘 온전한 값이 들어간다
/** 제목은 넘치면 잘라서 넣는다 */
const titleProp = (title: string | null | undefined): Record<string, string> => (title ? { title: drive.fitAppProperty('title', title) } : {})
/** 카테고리는 넘치면 뺀다 — 잘린 이름은 다른 카테고리가 된다 */
const categoryProp = (category: string | null | undefined) => drive.appPropertyIfFits('category', category)

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

/** 받기·올리기의 노트 단위 진행 — 상태 카드의 "노트 2/5 올리는 중" 문구용 */
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
/** 지금 도는 받기·올리기의 상태 칸(전송) 항목 — 노트 단위 진행을 함께 옮긴다 */
let syncActivity: ActivityHandle | null = null
const emitProgress = (phase: SyncProgress['phase'], done: number, total: number) => {
  if (total <= 0) return
  syncActivity?.update({ detail: `노트 ${done}/${total} ${phase === 'push' ? '올리는' : '받는'} 중`, progress: (done - 1) / total })
  if (progressListeners.size === 0) return
  const p: SyncProgress = { phase, done, total }
  progressListeners.forEach((f) => f(p))
}

// ───────────────── 원격 변경 알림 ─────────────────

export const REMOTE_EVENT = 'inkpad-remote-changed'

// 옛 머지 기록 — 자동 머지를 쓰던 때 이 기기에 남긴 이력. 브랜치 방식에서는 쌓이지 않고(머지 결과는 main의 made 표식과
// 버전 기록에, 덮기 전 내용은 스냅샷에), 보여 주던 목록도 없앴다. 남은 기록은 앱을 열 때 지운다
const OLD_MERGE_LOG_KEYS = ['mergeLog', 'mergeLogSeenAt']

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

// ───────── 브랜치 상태 (기기 로컬, br:{docId}) ─────────

const brKey = (docId: ID) => `br:${docId}`
const getBranchState = (docId: ID) => getSync<BranchState>(brKey(docId))
async function putBranchState(docId: ID, patch: Partial<BranchState>): Promise<void> {
  const cur = await getBranchState(docId)
  await putSync(brKey(docId), { seq: 0, baseMid: null, baseGen: 0, ...cur, ...patch } satisfies BranchState)
}

/** 본문에서 동기화 표식을 뺀 노트 내용 — 출발점(base) 스냅샷으로 보관한다 */
function plainDoc(file: DocFileV1 & { main?: unknown; branch?: unknown }): DocFileV1 {
  const { main: _main, branch: _branch, rev: _rev, ...plain } = file
  return plain
}

interface Judged {
  sync: NoteSync
  baseMid: string | null
  mainMid: string
}

/** 노트 하나의 상태 — 받기·받기 미리보기·클라우드 목록이 같은 판정을 쓴다 (sync/judge.ts noteSync) */
async function judgeNote(docId: ID, remote: drive.RemoteFile, local: DocumentMeta | undefined, pending: boolean, deviceId: string): Promise<Judged> {
  const props = remote.appProperties
  const mainMid = mainMidOf(props)
  const st = await getBranchState(docId)
  // 브랜치 이전에 맞춘 노트는 예전 판정(위치 기록 version·내용 표식)으로 출발점을 정한다
  const legacy = isUpToDate(await getSync<FileRecord>(`doc:${docId}`), local, remote)
  const baseMid = knownBaseMid(st?.baseMid, legacy, mainMid)
  const unmerged = isUnmerged(st, mergedOf(props), deviceId)
  return { sync: noteSync({ pending, unmerged, baseMid, mainMid }), baseMid, mainMid }
}

interface Candidate {
  docId: ID
  remote: drive.RemoteFile
  local: DocumentMeta | undefined
}

/**
 * 받기 대상 — 받기(pull)와 받기 미리보기(planPull)가 같은 목록을 쓴다 (예전에는 따로 골라 서로 어긋났다).
 * 같은 노트의 중복 파일은 최신 하나만, 건너뛸 이유(지움·숨긴 카테고리·휴지통·이미 맞춤)가 있으면 뺀다.
 * 이 기기 변경이 있는 노트(올릴 것·갈라짐)는 따로 돌려준다 — 그대로 받지 않고, 받기 미리보기에서
 * 비교한 뒤 덮기·올리기·건너뛰기를 고른다 (받기 = 클라우드로 완전 동기화).
 */
async function pullCandidates(remotes: drive.RemoteFile[]): Promise<{ eligible: Candidate[]; local: (Candidate & { sync: 'push' | 'diverged'; remoteChanged: boolean })[] }> {
  const outboxRows = await db.outbox.toArray()
  const pendingIds = new Set(outboxRows.filter((x) => x.entity === 'document').map((x) => x.entityId))
  const hidden = new Set(await getHiddenCategories())
  const deviceId = await getDeviceId()
  const eligible: Candidate[] = []
  const local: (Candidate & { sync: 'push' | 'diverged'; remoteChanged: boolean })[] = []
  for (const remote of newestPerDoc(remotes)) {
    const docId = remote.appProperties!.docId
    const remoteCat = remote.appProperties?.category
    const doc = await db.documents.get(docId)
    const j = await judgeNote(docId, remote, doc, pendingIds.has(docId), deviceId)
    const skip = pullSkipReason({ gone: !!(await getSync(`gone:${docId}`)), hidden: !!remoteCat && hidden.has(remoteCat), local: doc, sync: j.sync })
    if (!skip) eligible.push({ docId, remote, local: doc })
    else if (skip === 'pending' || skip === 'diverged') local.push({ docId, remote, local: doc, sync: j.sync as 'push' | 'diverged', remoteChanged: j.baseMid !== j.mainMid })
  }
  return { eligible, local }
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

/** 라이브러리 카드 점의 상태 — cloud-deleted·deleted-local은 'new'(회색)로 뭉갠다. diverged는 갈라짐(머지 필요) */
export type CardSyncState = 'new' | 'pending' | 'same' | 'remote-new' | 'diverged'

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
  const [docs, pending, cache] = await Promise.all([db.documents.toArray(), pendingDocs(), getCloudStatesCache()])
  const out = new Map<ID, CardSyncState>()
  for (const d of docs) {
    if (d.deletedAt) continue // 휴지통 노트는 점을 달지 않는다
    out.set(d.id, await cardStateOf(d.id, pending.has(d.id), cache))
  }
  return out
}

type CloudStatesCache = { at: number; states: Record<string, CloudNoteState>; versions: Record<string, string> }
const getCloudStatesCache = () => getSync<CloudStatesCache>('cloudStates')

/** 노트 하나의 카드 상태 (편집 화면의 노트 칩) — 네트워크 없음 */
export async function noteCardState(docId: ID): Promise<CardSyncState | null> {
  const d = await db.documents.get(docId)
  if (!d || d.deletedAt) return null
  return cardStateOf(docId, (await pendingSeqsFor(docId)).length > 0, await getCloudStatesCache())
}

/** 일괄 받기·올리기가 잠금에 막혔을 때 — 아무 일 없이 끝나지 않게 알린다 */
function notifyBusyElsewhere() {
  notifyToast('다른 곳에서 동기화가 진행 중입니다. 끝난 뒤 다시 눌러 주세요.', 'info')
}

async function cardStateOf(docId: ID, pending: boolean, cache: CloudStatesCache | undefined): Promise<CardSyncState> {
  const rec = await getSync<FileRecord>(`doc:${docId}`)
  const cached = cache?.states[docId]
  // 캐시가 낡았는지 — 위치 기록이 캐시 이후로 앞서 나갔으면(받기·따라가기 완료) 캐시 판정을 버린다
  const cacheFresh = !rec || verNum(rec.version) < verNum(cache?.versions?.[docId])
  if (cached === 'diverged' && cacheFresh) return 'diverged' // 갈라짐 — 머지 관리에서 합칠 때까지
  if (pending) return 'pending' // 이 기기 변경이 올리기 대기
  if (cached === 'remote-new' && cacheFresh) return 'remote-new'
  if (!rec || cached === 'cloud-deleted') return 'new' // 클라우드에 없음
  return 'same' // 위치 기록이 있고 대기도 없음 — 최신
}

// ───────────────── push ─────────────────

/** 올리기. 이 기기의 변경을 노트 단위로 올리고, 이어서 다른 기기의 변경을 받아온다. */
export async function pushNow(): Promise<void> {
  if (!navigator.onLine) {
    setStatus('offline')
    return
  }
  await navigator.locks.request(SYNC_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) {
      notifyBusyElsewhere() // 다른 곳(노트 칩·다른 탭)에서 동기화 중
      return
    }
    setStatus('syncing')
    const act = (syncActivity = startActivity('upload', '올리기'))
    try {
      // 최초 동기화: 기존 로컬 데이터를 모두 업로드 큐에 올린다
      if (!(await db.syncState.get('rootFolderId'))) await enqueueEverything()
      const f = await ensureFolders()
      const { uploaded, diverged, busy } = await push(f)
      const pulled = await pull(f)
      await db.syncState.put({ key: 'lastPushAt', value: Date.now() })
      setStatus('idle')
      act.done(syncDoneText(uploaded + diverged, pulled.docs))
      if (uploaded > 0) {
        // 동기화 창을 닫고 나서 끝났어도 알 수 있게 한다 — 토스트는 전역으로 뜨고,
        // 라이브러리 카드의 동기화 표시는 DB만 다시 읽어 최신으로 칠한다 (다른 탭에도 브로드캐스트)
        notifyToast(`노트 ${uploaded}개를 올렸습니다.`)
        window.dispatchEvent(new Event(CLOUD_STATES_EVENT))
        cloudStatesChannel?.postMessage(Date.now())
      }
      if (diverged > 0)
        notifyToast(`다른 기기에서도 바뀐 노트 ${diverged}개는 이 기기 브랜치에만 올렸습니다(갈라짐). 필기는 그대로 남아 있습니다.`, 'info')
      notifySyncChanged() // 라이브러리 배지·편집 화면 칩이 다시 계산한다
      const skipped = busy + pulled.busy
      if (skipped > 0) notifyToast(`다른 탭에서 편집 중인 노트 ${skipped}개는 건너뛰었습니다. 그 탭을 닫은 뒤 다시 올려 주세요.`, 'info')
    } catch (e) {
      act.fail(errorText(e, '올리지 못했습니다.'))
      handleSyncError(e)
    } finally {
      if (syncActivity === act) syncActivity = null
    }
  })
}

/** 받기·올리기가 끝난 뒤 상태 칸 문구 */
function syncDoneText(up: number, down: number): string {
  const parts = [up > 0 && `${up}개 올림`, down > 0 && `${down}개 받음`].filter(Boolean)
  return parts.length ? `노트 ${parts.join(' · ')}` : '바뀐 노트 없음'
}

/** 실제로 Drive에 올라가는 노트만 돌려 실행한다. 삭제(묘비)·클라우드 삭제 제외 노트는 올라가는 게 없어
 * "노트 n/n 올리는 중"의 n에 끼면 표시가 실제와 어긋난다 — 집계에서도 뺀다.
 * uploaded: main까지 따라간 노트 / diverged: 갈라져 브랜치에만 올린 노트 /
 * busy: 다른 탭에서 편집 중이라 남겨 둔 노트 수 (대기는 그대로 남아 다음에 다시 올린다) */
async function push(f: { docs: string; assets: string }): Promise<{ uploaded: number; diverged: number; busy: number }> {
  // 이 탭의 편집 화면이 메모리에만 들고 있는 변경(저장 대기 0.5초)도 이번 올리기에 싣는다
  await flushOpenDocs()
  const rows = await db.outbox.toArray()
  const docs = await pendingDocs()

  const uploadable = new Set<ID>()
  for (const [docId] of docs) {
    const doc = await db.documents.get(docId)
    if (!doc || doc.deletedAt) continue
    // 클라우드에서 삭제된 노트는 일괄 올리기에서 뺀다 — 목록의 행을 직접 눌렀을 때만 다시 올린다
    if (await getSync(`clouddel:${docId}`)) continue
    uploadable.add(docId)
  }

  let n = 0
  let uploaded = 0
  let diverged = 0
  let busy = 0
  for (const [docId, info] of docs) {
    if (!uploadable.has(docId)) {
      const doc = await db.documents.get(docId)
      if (!doc || doc.deletedAt) await pushTombstone(docId, info) // 삭제는 묘비만 남긴다 — Drive에 올라가는 게 없다
      continue
    }
    emitProgress('push', ++n, uploadable.size)
    try {
      const r = await pushDoc(docId, info, f) // 되돌리기로 내용이 같아진 노트는 올리지 않고 뺀다('skipped')
      if (r === 'ff') uploaded++
      else if (r === 'diverged') diverged++
    } catch (e) {
      if (!(e instanceof DocBusyError)) throw e
      busy++ // 다른 탭에서 편집 중 — 대기를 남긴다
    }
  }

  for (const r of rows.filter((r) => r.entity === 'asset')) {
    await ensureAssetUploaded(r.entityId, f.assets)
    await db.outbox.delete(r.seq!)
  }

  return { uploaded, diverged, busy }
}

// ───────── 노트 목록 (받기) ─────────
// 받기·받기 미리보기는 마지막으로 본 목록에 그 뒤 바뀐 파일만 더한다 — 노트가 많아도 목록 요청이 거의 비어 있다.
// main은 본문을 올릴 때만 바뀌므로(표식도 업로드와 함께) '바뀐 시각'으로 충분하다. 휴지통으로 간 파일은 보이지 않으므로
// 하루에 한 번, 그리고 동기화 패널 목록·머지 관리 목록(전체를 읽는다)이 목록을 새로 채운다.

interface DocsListCache {
  folder: string
  /** 이 시각 뒤에 바뀐 파일만 묻는다 — 목록에 본 가장 늦은 시각에서 한 시간 앞(색인 지연 여유) */
  since: string
  /** 전체를 마지막으로 읽은 시각(이 기기 시계) */
  fullAt: number
  files: drive.RemoteFile[]
}
const DOCS_LIST_KEY = 'docsList'
const LIST_OVERLAP_MS = 60 * 60_000
const LIST_FULL_MS = 24 * 3600_000

async function saveDocsList(folder: string, files: drive.RemoteFile[], fullAt: number) {
  const latest = files.reduce((t, f) => Math.max(t, Date.parse(f.modifiedTime) || 0), 0)
  const since = new Date(Math.max(0, latest - LIST_OVERLAP_MS)).toISOString()
  await putSync(DOCS_LIST_KEY, { folder, since, fullAt, files } satisfies DocsListCache)
}

/** 노트 main 목록 — full이면 전체를 읽고 기억한다. 아니면 기억한 목록 + 그 뒤 바뀐 파일 */
async function listDocs(folder: string, full = false): Promise<drive.RemoteFile[]> {
  const c = await getSync<DocsListCache>(DOCS_LIST_KEY)
  if (full || !c || c.folder !== folder || Date.now() - c.fullAt > LIST_FULL_MS) {
    const files = await drive.listFiles(folder)
    await saveDocsList(folder, files, Date.now())
    return files
  }
  const byId = new Map(c.files.map((f) => [f.id, f]))
  for (const f of await drive.listFiles(folder, undefined, c.since)) byId.set(f.id, f)
  const files = [...byId.values()]
  await saveDocsList(folder, files, c.fullAt)
  return files
}

/** 이 기기가 main을 쓰거나 지운 직후 — 기억한 목록을 바로 고친다(목록 색인이 늦어도 방금 쓴 것을 '받을 것'으로 오판하지 않게) */
async function noteListed(meta: drive.RemoteFile | null, removeId?: string) {
  const c = await getSync<DocsListCache>(DOCS_LIST_KEY)
  if (!c) return
  const files = c.files.filter((f) => f.id !== (meta?.id ?? removeId))
  if (meta && !meta.trashed) files.push(meta)
  await putSync(DOCS_LIST_KEY, { ...c, files } satisfies DocsListCache)
}

/** 노트의 main 파일 — 기록한 위치가 살아 있으면 그것, 아니면 같은 이름의 살아 있는 파일(다른 기기가 만든 것) */
async function findMain(docId: ID, docsFolderId: string): Promise<drive.RemoteFile | null> {
  const rec = await getSync<FileRecord>(`doc:${docId}`)
  let m = rec?.fileId ? await drive.getMeta(rec.fileId) : null
  if (m?.trashed) m = null
  // 같은 이름의 살아 있는 파일이 있으면 그 파일을 이어 쓴다 — 새 파일로 올리면 같은 docId가 main 2개로 분기한다
  return m ?? (await drive.findByName(mainFileName(docId), docsFolderId))
}

/**
 * 노트 하나 올리기 (규칙 2):
 *  1. 내 브랜치를 올린다 — seq + 1, 출발점 대비 고친 목록(머지 관리가 '누가 고쳤나'를 가리는 데 쓴다)
 *  2. main이 내 출발점 그대로면 main을 이 내용으로 바꾼다(ff). 쓰기 직전에 main을 다시 보고, 쓴 뒤에도 내가 쓴 것인지 확인한다
 *  3. main이 그 사이 바뀌었으면 main은 건드리지 않는다 → 'diverged'
 * 올리기 대기는 2·3이 끝난 뒤에 내린다 — main 쓰기가 실패하면 대기가 남아 다음 올리기에서 다시 따라간다.
 */
async function pushDoc(docId: ID, info: PendingDoc, f: { docs: string; assets: string }): Promise<'ff' | 'diverged' | 'skipped'> {
  // 되돌리기(실행 취소)로 내용이 마지막 동기화 시점과 같아졌으면 올리지 않고 대기를 내린다 —
  // 바뀐 게 없는데 리비전을 하나 더 만드는 일이 없게 한다.
  // '되돌림' 리비전(버전 기록 복원)은 내용이 같아도 사용자가 명시적으로 요청한 반영이므로 그대로 올린다.
  const restored = (await getSync<string>(`revKind:${docId}`)) === 'restore'
  if (!restored && info.seqs.length > 0 && (await clearPendingIfUnchanged(docId, info.seqs))) return 'skipped'

  const file = await packDocument(docId)
  // 참조 원본을 먼저 올린다 — 노트 하나만 올릴 때도(올리기 버튼) 그 노트의 에셋 대기 항목을 치운다.
  // 바이트가 없는 원본(다른 기기에서 받아올 것)은 건드리지 않고 대기를 남긴다.
  for (const am of file.assets) {
    const arow = await db.assets.get(am.id)
    if (!arow?.blob) continue
    await ensureAssetUploaded(am.id, f.assets)
    await db.outbox.where('[entity+entityId]').equals(['asset', am.id]).delete()
  }
  const kind: RevMarker['kind'] = restored ? 'restore' : 'push'
  // 1. 내 브랜치 — 이 기기만 쓰므로 다른 기기의 업로드와 서로 덮지 않는다
  const { device, deviceId, at, seq, baseMid, known } = await uploadBranch(docId, file, kind, f.docs)
  const updatedAt = String(file.doc.updatedAt)

  // 2. main 따라가기 — 브랜치를 올리는 사이에 바뀌었을 수 있으므로 쓰기 직전에 다시 본다
  const main = await findMain(docId, f.docs)
  if (main && (!baseMid || mainMidOf(main.appProperties) !== baseMid)) {
    // 3. 갈라짐 — main은 건드리지 않는다. 이 기기 변경은 브랜치에 있으므로 올리기 대기는 내린다
    await settleBranchOnly(docId, file, info.seqs)
    return 'diverged'
  }
  const props = main?.appProperties
  const gen = genOf(props) + 1
  const mid = newMid()
  const merged = { ...mergedOf(props), [deviceId]: seq }
  const marker: MainMarker = { gen, mid, merged, made: { kind: restored ? 'restore' : 'ff', deviceId, device, at } }
  // 조각은 방금 브랜치가 올렸다 — main은 매니페스트만 (새로 올리는 조각 0)
  const { manifest, stats } = await toManifest({ ...file, rev: { kind, device, at }, main: marker }, known)
  const result = await drive.upload(
    await gzipJson(manifest),
    {
      name: mainFileName(docId),
      mimeType: 'application/json',
      appProperties: {
        docId,
        updatedAt,
        ...titleProp(file.doc.title),
        device,
        enc: drive.ENC_GZIP,
        revKind: kind,
        nb: String(stats.totalBytes),
        ...categoryProp(file.doc.category),
        ...mainProps({ gen, mid, merged, updatedAt: file.doc.updatedAt })
      }
    },
    f.docs,
    main?.id
  )
  // 되돌리기로 큐에 들어갔으면 이 업로드는 '되돌림' 리비전이 된다 — 표식만 남기고 고정은 하지 않는다
  // (고정은 사용자가 버전 기록에서 직접 한 것만 — 자동 고정은 쌓이기만 하고 정리하기 어렵다)
  await rememberRevTag(result.id, { device, revKind: kind })
  // 업로드 직후의 메타 쓰기(리비전 고정 등)도 Drive version을 올린다 — 헤드를 다시 읽어 저장한다 (규칙 10).
  // 그 사이 다른 기기가 main을 덮었으면 내 내용은 브랜치에만 있는 것이다 → 갈라짐 (규칙 2)
  const head = (await drive.getMeta(result.id).catch(() => null)) ?? result
  if (mainMidOf(head.appProperties) !== mid) {
    await settleBranchOnly(docId, file, info.seqs)
    return 'diverged'
  }
  await markSynced(docId, file, head, info.seqs, { mid, gen })
  await rememberRefs(docId, 'main', manifest.objs)
  await noteListed(head)
  return 'ff'
}

/**
 * 내 브랜치를 올린다 — seq + 1, 출발점 대비 고친 목록(머지 관리가 '누가 고쳤나'를 가리는 데 쓴다).
 * 출발점은 브랜치 상태에 있으면 그것, 없으면(브랜치 이전에 맞춘 노트) 예전 판정으로 지금 main과 맞춰져 있을 때만 그 main.
 */
async function uploadBranch(docId: ID, file: DocFileV1, kind: RevMarker['kind'], docsFolderId: string) {
  const [device, deviceId] = await Promise.all([getDeviceName(), getDeviceId()])
  const at = Date.now()
  const st = await getBranchState(docId)
  const before = await findMain(docId, docsFolderId)
  const baseMid = before
    ? knownBaseMid(st?.baseMid, isUpToDate(await getSync<FileRecord>(`doc:${docId}`), undefined, before), mainMidOf(before.appProperties))
    : (st?.baseMid ?? null)
  const baseGen = st?.baseMid ? st.baseGen : before && baseMid ? genOf(before.appProperties) : 0
  const base = baseMid ? await loadBase(docId) : null
  const bFolder = await ensureBranchesFolder()
  const bName = branchFileName(docId, deviceId)
  const target = await drive.liveFileIdFor(st?.fileId, bName, bFolder)
  // seq는 앞으로만 — 이 기기 기록이 지워졌어도 클라우드 브랜치·main 표식에 남은 번호 다음부터 잇는다.
  // 다시 1부터 세면 main에 이미 반영된 번호와 겹쳐, 이번 업로드가 '머지 안 됨'으로 보이지 않는다
  const cloudSeq = !st?.seq && target ? Number((await drive.getMeta(target))?.appProperties?.seq) || 0 : 0
  const seq = Math.max(st?.seq ?? 0, cloudSeq, mergedOf(before?.appProperties)[deviceId] ?? 0) + 1
  const branch: BranchMarker = { deviceId, device, seq, baseGen, baseMid, modified: base ? computeModified(base, file) : {} }
  // 바뀐 페이지의 조각만 올린다 — 이 기기가 아는 조각(마지막 main·내 브랜치)은 가리키기만 한다
  const known = await knownRefs(docId)
  const { manifest, stats } = await toManifest({ ...file, rev: { kind, device, at }, branch }, known)
  const res = await drive.upload(
    await gzipJson(manifest),
    {
      name: bName,
      mimeType: 'application/json',
      appProperties: {
        docId,
        kind: 'branch',
        dev: deviceId,
        device,
        seq: String(seq),
        baseGen: String(baseGen),
        updatedAt: String(file.doc.updatedAt),
        enc: drive.ENC_GZIP,
        nb: String(stats.totalBytes),
        ...titleProp(file.doc.title)
      }
    },
    bFolder,
    target
  )
  await putBranchState(docId, { fileId: res.id, seq, baseMid, baseGen })
  await rememberRefs(docId, 'mine', manifest.objs)
  return { device, deviceId, at, seq, baseMid, known }
}

/** main까지 따라간 뒤 로컬 상태 반영 — 출발점(base)을 이 내용으로 옮긴다 */
async function markSynced(docId: ID, file: DocFileV1, remote: drive.RemoteFile, seqs: number[], main: { mid: string; gen: number }) {
  const base = await gzipJson(file)
  await db.transaction('rw', [db.documents, db.outbox, db.syncState], async () => {
    const cur = await db.documents.get(docId)
    if (!cur) return
    await putDocRecord(docId, remote.id, remote.version) // 앞으로만 (규칙 10)
    // 방금 올린 파일 표식 — 클라우드 목록이 이 파일 하나만 개별 확인하게 한다 (listCloudNotes)
    await putSync(`fresh:${docId}`, remote.id)
    await putBaseBlob(docId, base) // 저장 시각을 함께 남겨 되돌리기 판정의 요약 캐시가 새 base를 알아본다
    await putBranchState(docId, { baseMid: main.mid, baseGen: main.gen })
    await db.syncState.delete(`gone:${docId}`) // 휴지통에서 살아나서 다시 올렸다
    await db.syncState.delete(`clouddel:${docId}`) // 클라우드에서 삭제됐던 노트를 다시 올렸다
    await db.syncState.delete(`curRev:${docId}`) // 되돌림 표식 해제 — 이제 헤드가 곧 이 기기의 현재
    await db.syncState.delete(`revKind:${docId}`)
    if (cur.updatedAt === file.doc.updatedAt) await db.outbox.bulkDelete(seqs)
    // 아니면 outbox가 남아 다음 라운드에서 다시 올려진다 (규칙 3)
  })
}

/** 브랜치에만 올리고 끝났을 때(갈라짐) — 출발점은 그대로 두고, 브랜치에 실린 변경의 올리기 대기만 내린다 */
async function settleBranchOnly(docId: ID, file: DocFileV1, seqs: number[]) {
  await db.transaction('rw', [db.documents, db.outbox, db.syncState], async () => {
    const cur = await db.documents.get(docId)
    if (!cur) return
    await db.syncState.delete(`gone:${docId}`)
    await db.syncState.delete(`revKind:${docId}`) // 되돌림은 브랜치에 실렸다 — 머지에서 합쳐진다
    if (cur.updatedAt === file.doc.updatedAt) await db.outbox.bulkDelete(seqs)
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

// ───────────────── Drive 파일 → 로컬 ─────────────────
// applyDocFile은 sync/apply.ts

// ───────────────── pull ─────────────────

export interface PullResult {
  docs: number
  /** 받기 미리보기에서 덮기로 고른 노트 중 덮은 수 */
  overwritten?: number
  /** 받기 미리보기에서 올리기로 고른 노트 중 올린 수 */
  pushed?: number
  /** 다른 탭에서 편집 중이라 받지 않고 남겨 둔 노트 수 */
  busy: number
}

/** 받기에서 이 기기 변경이 있는 노트를 어떻게 할지 — 받기 미리보기에서 고른다. 고르지 않은 노트는 건너뛴다 */
export interface PullChoices {
  /** 클라우드로 덮는다(이 기기 변경은 스냅샷으로만 남는다) */
  overwrite?: ID[]
  /** 이 기기 것을 올린다 */
  push?: ID[]
}

/**
 * 받기 = 클라우드로 완전 동기화. 다른 기기가 올린 변경을 가져오고, 이 기기 변경이 있는 노트는 choices대로 —
 * 덮거나(스냅샷만 남기고 브랜치에는 올리지 않는다) 올리거나 건너뛴다.
 */
export async function pullNow(choices: PullChoices = {}): Promise<PullResult | null> {
  if (!navigator.onLine) {
    setStatus('offline')
    return null
  }
  return navigator.locks.request(SYNC_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) {
      notifyBusyElsewhere() // 다른 곳(노트 칩·다른 탭)에서 동기화 중
      return null
    }
    setStatus('syncing')
    const act = (syncActivity = startActivity('download', '받기'))
    try {
      const f = await ensureFolders()
      let pushed = 0
      let overwritten = 0
      let busy = 0
      for (const docId of choices.push ?? []) {
        try {
          if ((await pushDoc(docId, (await pendingDocs()).get(docId) ?? { seqs: [] }, f)) !== 'skipped') pushed++
        } catch (e) {
          if (!(e instanceof DocBusyError)) throw e
          busy++
        }
      }
      for (const docId of choices.overwrite ?? []) {
        try {
          if ((await overwriteWithCloud(docId, f.docs)) === 'applied') overwritten++
        } catch (e) {
          if (!(e instanceof DocBusyError)) throw e
          busy++
        }
      }
      const r = await pull(f)
      await db.syncState.put({ key: 'lastPullAt', value: Date.now() })
      setStatus('idle')
      act.done(syncDoneText(pushed, r.docs + overwritten))
      notifySyncChanged()
      return { ...r, busy: r.busy + busy, pushed, overwritten }
    } catch (e) {
      act.fail(errorText(e, '받지 못했습니다.'))
      handleSyncError(e)
      return null
    } finally {
      if (syncActivity === act) syncActivity = null
    }
  }) as Promise<PullResult | null>
}

/**
 * 이 기기 노트를 클라우드(main)로 덮는다 (잠금 안에서). 이 기기 변경은 스냅샷으로만 남긴다 — 브랜치에 올리지 않는다.
 * main이 이 기기 출발점 그대로면 기준본으로 되돌리면 같은 내용이라 내려받지 않는다(데이터 0).
 */
async function overwriteWithCloud(docId: ID, docsFolderId: string): Promise<'applied' | 'skipped' | 'notfound'> {
  const remote = await findMain(docId, docsFolderId)
  if (!remote) return 'notfound'
  const st = await getBranchState(docId)
  if (st?.baseMid && st.baseMid === mainMidOf(remote.appProperties) && (await loadBase(docId))) {
    const r = await revertToBase(docId, 'align')
    await resolveMyBranch(docId, mergedOf(remote.appProperties))
    return r === 'reverted' ? 'applied' : 'skipped'
  }
  return takeMain({ docId, fileId: remote.id, version: remote.version, enc: remote.appProperties?.enc }, 'align')
}

/**
 * 변경 버리기 — 이 기기 노트를 마지막으로 맞춘 시점(기준본)으로 되돌린다. 네트워크를 쓰지 않는다.
 * 써 보며 공부한 뒤 원래대로 돌릴 때. 지금 내용은 스냅샷으로 남는다(버전 기록에서 되돌릴 수 있다).
 * 기준본이 없으면(한 번도 맞춘 적 없는 노트) 'nobase'.
 */
export function discardLocalChanges(docId: ID): Promise<'reverted' | 'nobase'> {
  return withSyncLock(async () => {
    const r = await revertToBase(docId, 'discard')
    if (r === 'reverted') notifySyncChanged()
    return r
  })
}

async function revertToBase(docId: ID, why: 'discard' | 'align'): Promise<'reverted' | 'nobase'> {
  const base = await loadBase(docId)
  if (!base) return 'nobase'
  await withDocExclusive(docId, async () => {
    const seqs = await pendingSeqsFor(docId) // 되돌리기 전 페이지 기준으로 대기를 모은다(이 기기에서 더한 페이지의 대기까지)
    await takeSnapshot(docId, why)
    await applyDocFile(base, { force: true })
    await db.outbox.bulkDelete(seqs)
  })
  await db.syncState.delete(`revKind:${docId}`) // 올릴 되돌림도 함께 버린다
  await db.syncState.delete(`curRev:${docId}`)
  emitRemoteChanged(new Set<string>([docId]))
  return 'reverted'
}

async function pull(f: { docs: string; assets: string }): Promise<PullResult> {
  const r: PullResult = { docs: 0, busy: 0 }
  const changed = new Set<string>()

  // 받아올 대상을 먼저 골라 총수를 확정한다 — "노트 n/N 받는 중" 진행 표시용.
  // 받기 미리보기(planPull)와 같은 함수로 고른다 — 미리보기에 뜬 목록이 곧 실제로 받는 목록이다
  const eligible = (await pullCandidates(await listDocs(f.docs))).eligible.map((c) => c.remote)

  let n = 0
  for (const remote of eligible) {
    emitProgress('pull', ++n, eligible.length)
    const docId = remote.appProperties?.docId
    if (!docId) continue
    const got = await downloadNote<MainFileExtra>(remote.id, remote.appProperties?.enc, docId)
    if (!got) continue
    const file = got.file
    let applied = false
    try {
      // 규칙 11 — 이 탭에서 열려 있으면 편집 화면이 먼저 기록하고 멈춘다. 그때 막 기록된 변경이
      // 있으면 applyDocFile이 적용하지 않는다(대기 중인 노트는 올리기가 맡는다)
      applied = await withDocExclusive(docId, async () => {
        await takeSnapshot(docId, 'pull') // 덮기 직전 이 기기 내용 (네트워크 없이 되돌릴 수 있게)
        return applyDocFile(plainDoc(file))
      })
    } catch (e) {
      if (!(e instanceof DocBusyError)) throw e
      r.busy++ // 다른 탭에서 편집 중 — 다음 받기 때 다시
      continue
    }
    if (applied) {
      await putDocRecord(docId, remote.id, remote.version)
      await followedMain(docId, file, remote.appProperties, objsOf(got.raw))
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

/** main을 받아 적용한 뒤 — 출발점(base)을 그 main으로 옮긴다. 신원은 받은 본문 기준(목록 표식과 어긋나도 내용과 맞게) */
async function followedMain(docId: ID, file: MainFile, props: Record<string, string> | undefined, objs: ObjRef[]) {
  await saveBase(docId, plainDoc(file))
  await putBranchState(docId, { baseMid: midOfFile(file), baseGen: file.main?.gen ?? genOf(props) })
  await rememberRefs(docId, 'main', objs) // 다음 올리기가 이 조각들을 다시 올리지 않는다
}

// ───────────────── 클라우드 노트 목록 ─────────────────

export type CloudNoteState = 'same' | 'remote-new' | 'new' | 'pending' | 'diverged' | 'cloud-deleted' | 'deleted-local'

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

const SYNC_TO_STATE: Record<NoteSync, CloudNoteState> = { same: 'same', pull: 'remote-new', push: 'pending', diverged: 'diverged' }

/**
 * 클라우드 노트 목록 — Drive 메타와 이 기기의 로컬 전용 상태를 합쳐 그린다(본문 내려받지 않음).
 * 상태: same(최신) / remote-new(받을 업데이트·새 노트, 파란 점) /
 *       new(한 번도 올리지 않은 새 노트, 올릴 것) / pending(이 기기 변경이 올리기 대기 — 올리면 main도 따라간다) /
 *       diverged(갈라짐 — 이 기기도 바뀌었고 main도 바뀌었다. 덮지 않고 머지 관리에서 합친다) /
 *       cloud-deleted(클라우드에서만 삭제됨 — 행을 눌러 다시 올린다) /
 *       deleted-local(이 기기에서 지운 노트, 빨간 점)
 */
export async function listCloudNotes(): Promise<CloudNoteInfo[]> {
  const f = await ensureFolders()
  const remotes = await listDocs(f.docs, true) // 동기화 패널 목록은 늘 전체 — 클라우드에서 지워진 노트도 보이게

  // 오판 방지: 방금 올린 파일은 listFiles 인덱스에 늦게 반영될 수 있다 (규칙 10).
  // 위치 기록이 있는데 목록에 없는 파일은 getMeta로 그 파일만 한 번 더 확인하고,
  // 실제로 살아 있으면(=trashed가 아니면) 목록에 끼워 넣어 "클라우드에서 삭제됨" 오분류를 막는다.
  const listed = new Set(remotes.map((r) => r.id))
  // 방금 올린 파일(fresh: 표식)만 개별 확인한다. 예전에는 'doc:' 기록이 있는 모든 노트를
  // "목록에 안 보인다"는 이유로 하나씩 getMeta 했다 — 노트가 많으면 새로고침 1회가
  // 노트 수만큼 요청을 낳았다(색인 지연이 없어도 매번). 표식은 업로드 직후에만 생기므로
  // 이 루프는 보통 0~1건이다 (오판 방지는 그대로 유지).
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
  const deviceId = await getDeviceId()
  // 같은 노트의 중복 파일은 최신 하나만 — 받기와 같은 규칙 (예전에는 목록에 두 번 뜰 수 있었다)
  const newest = newestPerDoc(remotes)
  const byDoc = new Set(newest.map((r) => r.appProperties!.docId))
  const out: CloudNoteInfo[] = []
  for (const remote of newest) {
    const docId = remote.appProperties!.docId
    const local = await db.documents.get(docId)
    const rec = await getSync<FileRecord>(`doc:${docId}`)
    // 받기와 같은 판정 (sync/judge.ts noteSync)
    const { sync } = await judgeNote(docId, remote, local, pending.has(docId), deviceId)
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
      state: gone ? 'deleted-local' : SYNC_TO_STATE[sync]
    })
  }

  // 로컬에만 있는 노트 — Drive 목록만으로는 보이지 않는다
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
      // 위에서 getMeta로 실제 부재를 확인했으므로 여기서는 목록만 본다
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

/** 받기 미리보기의 '이 기기에서 바꾼 노트' 한 행 */
export interface LocalChangedDoc {
  docId: ID
  title: string
  /** push: 이 기기만 바뀜 · diverged: 클라우드도 바뀜(또는 머지 안 된 이 기기 브랜치가 있음) */
  sync: 'push' | 'diverged'
  /** 클라우드가 이 기기 출발점 이후 바뀌었나 — 아니면 덮어도 내려받지 않는다 */
  remoteChanged: boolean
  /** 이 기기에서 바꾼 것 (기준본이 없으면 null) */
  changes: { added: number; removed: number; modified: number; other: number; total: number } | null
}

export interface PullPlan {
  docs: PullDoc[]
  bytes: number
  /** 이 기기 변경이 있는 노트 — 받기 미리보기에서 덮기·올리기·건너뛰기(기본)를 고른다 */
  local: LocalChangedDoc[]
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
  await flushOpenDocs() // 열린 편집 화면의 저장 대기 중인 변경도 판정·비교에 넣는다
  const { eligible, local: changed } = await pullCandidates(await listDocs(f.docs))
  for (const { docId, remote, local } of eligible) {
    const remoteUpdatedAt = Number(remote.appProperties?.updatedAt) || 0
    // 매니페스트면 노트 전체 조각 크기(nb) — 이 기기에 있는 페이지는 받지 않으므로 실제로는 이보다 적다
    const size = Math.max(0, Number(remote.appProperties?.nb ?? remote.size ?? 0) || 0)
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
  const local: LocalChangedDoc[] = []
  for (const c of changed) {
    const lc = await localChanges(c.docId).catch(() => null)
    local.push({
      docId: c.docId,
      title: c.local?.title || c.remote.appProperties?.title || c.docId,
      sync: c.sync,
      remoteChanged: c.remoteChanged,
      changes: lc ? { added: lc.added, removed: lc.removed, modified: lc.modified, other: lc.other, total: lc.total } : null
    })
  }
  return { docs, bytes, local }
}

/**
 * 클라우드 노트 한 개를 이 기기로 내려받는다(main으로 맞춘다). 삭제 대기 중이던 노트면 대기를 지우고 되살린다.
 * 다른 탭에서 편집 중인 노트면 DocBusyError(메시지는 그대로 화면에 보여도 된다).
 */
export function downloadCloudNote(info: Pick<CloudNoteInfo, 'docId' | 'fileId' | 'version' | 'enc'> & { title?: string }): Promise<'applied' | 'skipped' | 'notfound'> {
  return noteActivity('download', info.docId, () => withSyncLock(() => takeMain(info, 'pull')), TAKE_TEXT, info.title)
}

/** 노트 하나를 주고받는 일 — 탭 바 상태 칸(전송)에 노트 제목으로 보인다. doneText는 결과별 끝 문구 */
async function noteActivity<T extends string>(kind: 'upload' | 'download', docId: ID, fn: () => Promise<T>, doneText: Partial<Record<T, string>>, title?: string): Promise<T> {
  const name = (await db.documents.get(docId))?.title || title || '노트'
  return trackActivity(
    kind,
    name,
    (a) => {
      a.update({ detail: kind === 'upload' ? '올리는 중' : '받는 중' })
      return fn()
    },
    (r) => doneText[r]
  )
}
const TAKE_TEXT = { skipped: '바뀐 내용 없음', notfound: '클라우드에 없음' } as const

/**
 * main을 받아 이 기기 노트를 덮는다 (동기화 잠금 안에서). 덮기 직전 이 기기 내용은 스냅샷으로만 남긴다 —
 * 브랜치에 올리지 않는다(써 보며 공부한 것을 매번 올리면 데이터와 브랜치 기록만 쌓인다).
 * 이 기기가 main을 받기로 했으므로, 내 브랜치에서 main에 아직 안 들어간 내용은 버린 것(resolved)으로 표시한다 —
 * 그 노트가 계속 갈라짐으로 남지 않는다. 브랜치 파일 자체는 지우지 않는다.
 */
async function takeMain(info: Pick<CloudNoteInfo, 'docId' | 'fileId' | 'version' | 'enc'>, why: 'pull' | 'align'): Promise<'applied' | 'skipped' | 'notfound'> {
  const got = await downloadNote<MainFileExtra>(info.fileId, info.enc, info.docId)
  if (!got) return 'notfound'
  const file = got.file
  // 규칙 11 — 열린 편집 화면을 먼저 멈추고 기록하게 한 뒤에 대기를 지운다(그래야 방금 기록된 대기도 함께 치운다)
  const applied = await withDocExclusive(info.docId, async () => {
    const p = (await pendingDocs()).get(info.docId)
    if (p) await db.outbox.bulkDelete(p.seqs) // 사용자가 명시적으로 받은 것이 우선
    await takeSnapshot(info.docId, why) // 덮기 직전 이 기기 내용
    return applyDocFile(plainDoc(file))
  })
  if (!applied) return 'skipped'
  await putDocRecord(info.docId, info.fileId, info.version) // 앞으로만 (규칙 10)
  await followedMain(info.docId, file, undefined, objsOf(got.raw))
  await resolveMyBranch(info.docId, file.main?.merged)
  await db.syncState.delete(`gone:${info.docId}`) // 명시적으로 받았으니 되살린 것
  await db.syncState.delete(`revKind:${info.docId}`)
  await db.syncState.delete(`curRev:${info.docId}`)
  emitRemoteChanged(new Set<string>([info.docId]))
  return 'applied'
}

/** 내 브랜치의 지금까지 내용은 버린 것으로 표시한다 — 이 기기와 (브랜치 파일 표식으로) 다른 기기가 함께 본다 */
async function resolveMyBranch(docId: ID, merged?: Record<string, number>): Promise<void> {
  const st = await getBranchState(docId)
  if (!st?.seq || st.seq <= (st.resolved ?? 0)) return
  if (merged && st.seq <= (merged[await getDeviceId()] ?? 0)) return // 이미 main에 들어간 브랜치 — 표식을 쓸 것이 없다(쓰기 0)
  await putBranchState(docId, { resolved: st.seq })
  if (st.fileId) {
    await drive.updateMeta(st.fileId, { appProperties: { resolved: String(st.seq) } }).catch((e) => console.warn('[sync] 브랜치 표식(resolved) 쓰기 실패 — 이 기기 판정은 그대로다:', e))
  }
}

/**
 * 보드의 연결 끊긴 노트 바로가기를 클라우드에서 찾아 받는다.
 * 이 기기에 위치 기록(fileId)이 없어도 파일 이름이 docId.json 이므로 이름으로 찾을 수 있다.
 * 보드 카드의 "받기"를 사용자가 눌렀을 때만 호출된다 — 자동 네트워크 사용은 없다.
 */
export function downloadMissingDoc(docId: ID): Promise<'applied' | 'skipped' | 'notfound'> {
  const run = () =>
    withSyncLock(async () => {
      const f = await ensureFolders()
      const remote = await drive.findByName(mainFileName(docId), f.docs)
      if (!remote) return 'notfound' as const
      return takeMain({ docId, fileId: remote.id, version: remote.version, enc: remote.appProperties?.enc }, 'pull')
    })
  return noteActivity('download', docId, run, TAKE_TEXT)
}

/**
 * 클라우드에 맞추기 — 이 기기 노트를 클라우드 main으로 덮는다(비교 화면을 거친 뒤 부른다).
 * 받기 미리보기의 '덮기'와 같다: 이 기기 변경은 스냅샷으로만 남고, main이 그대로면 내려받지 않는다.
 */
export function alignWithCloud(docId: ID): Promise<'applied' | 'skipped' | 'notfound'> {
  const run = () =>
    withSyncLock(async () => {
      const r = await overwriteWithCloud(docId, (await ensureFolders()).docs)
      notifySyncChanged()
      return r
    })
  return noteActivity('download', docId, run, { ...TAKE_TEXT, applied: '클라우드에 맞춤' })
}

/**
 * 클라우드 노트 삭제 — main과 모든 기기의 브랜치 파일을 휴지통으로 옮긴다(30일 보관, 복구 가능).
 * 공용 보관소에서 치우는 것일 뿐이라 각 기기의 로컬 사본은 그대로다.
 * 이후 이 기기에서 그 노트를 다시 고쳐 올리면 새 파일로 올라간다.
 */
export function deleteCloudNote(info: Pick<CloudNoteInfo, 'docId' | 'fileId'>): Promise<void> {
  return withSyncLock(async () => {
    await drive.trash(info.fileId)
    await noteListed(null, info.fileId)
    const branches = await getSync<string>('branchesFolderId')
    if (branches) for (const b of await drive.listFiles(branches, { docId: info.docId })) await drive.trash(b.id)
    await db.syncState.delete(`doc:${info.docId}`)
    await db.syncState.delete(`base:${info.docId}`)
    await db.syncState.delete(`gone:${info.docId}`)
    await db.syncState.delete(brKey(info.docId))
    // "클라우드에서 삭제함" 표식 — 위치 기록이 지워져도 이 기기는 노트를 'cloud-deleted'로
    // 분류하고 일괄 올리기에서 뺀다. 행을 눌러 다시 올리면 지운다.
    await putSync(`clouddel:${info.docId}`, Date.now())
  })
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
    if (await getSync(`clouddel:${docId}`)) continue // 클라우드에서 삭제됨 — 일괄 올리기에서 제외
    const doc = await db.documents.get(docId)
    // 삭제(휴지통·영구)는 Drive에 올라가는 게 없다 — 미리보기에 세지 않고 pushTombstone이 조용히 처리한다 (삭제는 이 기기의 일 — 규칙 4)
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

/**
 * 이 노트 하나만 클라우드에 올린다 (노트 메뉴의 "클라우드에 올리기").
 * 'diverged'면 main이 이 기기 출발점 이후 바뀌어 내 브랜치에만 올렸다 — 머지 관리에서 합친다.
 */
export function pushOneNote(docId: ID): Promise<'ff' | 'diverged' | 'skipped'> {
  const run = () =>
    withSyncLock(async () => {
      const doc = await db.documents.get(docId)
      if (!doc || doc.deletedAt) throw new Error('이 기기에서 삭제된 노트입니다.')
      const f = await ensureFolders()
      await flushOpenDocs() // 열린 편집 화면의 저장 대기 중인 변경도 싣는다
      const info = (await pendingDocs()).get(docId) ?? { seqs: [] }
      const r = await pushDoc(docId, info, f)
      notifySyncChanged() // 라이브러리 점·배지·편집 화면 칩이 다시 계산한다 (알림의 '올리기'처럼 화면 밖에서 불러도)
      return r
    })
  return noteActivity('upload', docId, run, { diverged: '갈라짐 — 이 기기 브랜치에만 올림', skipped: '바뀐 내용 없음' })
}

// ───────────────── 머지 관리 (docs/branch-merge.md §3.4·§5.4) ─────────────────
// 갈라진 브랜치를 main에 하나씩 합친다. 머지 화면이 목록을 받아(listMergeQueue) 한 건을 열고(openMerge),
// 사용자가 작업본을 정하면 최종 머지(commitMerge)로 main을 쓴다. 자동으로 일어나는 머지는 없다.

/** 머지할 것 하나 = main에 아직 들어가지 않은 기기 브랜치 하나 */
export interface MergeQueueEntry {
  docId: ID
  title: string
  branchFileId: string
  deviceId: string
  device: string
  seq: number
  /** 브랜치 내용의 수정 시각 */
  branchAt: number
  /** 이 기기의 브랜치인가 */
  mine: boolean
  mainFileId: string
  mainEnc?: string
  /** main을 마지막으로 쓴 기기 */
  mainDevice?: string
  mainAt: number
}

/**
 * 머지할 것 목록 — Drive 목록 두 번(main·브랜치)으로 메타만 읽는다.
 * 브랜치 seq가 main의 '반영된 브랜치'(m.{기기})보다 크고 버리지도 않았으면(resolved) 머지할 것이다.
 */
export async function listMergeQueue(): Promise<MergeQueueEntry[]> {
  const f = await ensureFolders()
  const folder = await findBranchesFolder()
  if (!folder) return []
  const [mains, branches, me] = await Promise.all([listDocs(f.docs, true), drive.listFiles(folder), getDeviceId()])
  const mainByDoc = new Map(newestPerDoc(mains).map((r) => [r.appProperties!.docId, r]))
  const out: MergeQueueEntry[] = []
  for (const b of branches) {
    const p = b.appProperties
    if (p?.kind !== 'branch' || !p.docId || !p.dev) continue
    const main = mainByDoc.get(p.docId)
    if (!main) continue // main이 없으면 합칠 곳이 없다 — 그 기기가 다시 올리면 main이 새로 생긴다
    const seq = Number(p.seq) || 0
    let resolved = Number(p.resolved) || 0
    if (p.dev === me) resolved = Math.max(resolved, (await getBranchState(p.docId))?.resolved ?? 0) // 이 기기 기록이 더 빠를 수 있다
    if (seq <= Math.max(mergedOf(main.appProperties)[p.dev] ?? 0, resolved)) continue
    out.push({
      docId: p.docId,
      title: main.appProperties?.title || p.title || (await db.documents.get(p.docId))?.title || p.docId,
      branchFileId: b.id,
      deviceId: p.dev,
      device: p.device || p.dev,
      seq,
      branchAt: Number(p.updatedAt) || Date.parse(b.modifiedTime) || 0,
      mine: p.dev === me,
      mainFileId: main.id,
      mainEnc: main.appProperties?.enc,
      mainDevice: main.appProperties?.device,
      mainAt: Number(main.appProperties?.updatedAt) || Date.parse(main.modifiedTime) || 0
    })
  }
  out.sort((a, b) => b.branchAt - a.branchAt)
  await cacheMergeQueue(out.map((e) => ({ docId: e.docId, deviceId: e.deviceId, mine: e.mine })))
  return out
}

/**
 * 머지 화면을 열기 전에 — 이 기기의 올리지 않은 변경을 먼저 올린다. 이 기기의 최신 상태가 브랜치(또는 따라간 main)에
 * 있어야 머지에 들어가고, 최종 머지가 이 기기 노트를 덮어도 잃는 것이 없다. 올렸으면 그 결과, 올릴 게 없으면 null.
 */
export async function pushBeforeMerge(docId: ID): Promise<'ff' | 'diverged' | 'skipped' | null> {
  await flushOpenDocs()
  if (!(await pendingDocs()).has(docId)) return null
  return pushOneNote(docId)
}

export interface MergeSession {
  entry: MergeQueueEntry
  /** 연 순간의 main·브랜치 내용 (동기화 표식 포함) */
  main: MainFile
  branch: BranchFile
  /** 연 순간의 main 신원 — 최종 머지 직전에 그 사이 main이 바뀌었는지 본다 */
  mainMid: string
  /** 양쪽이 다 고친 것을 어느 쪽으로 — 머지하는 기기가 그 브랜치 기기면 브랜치, 아니면 main */
  prefer: Side
  plan: MergePlan
  /** main·브랜치가 가리키는 조각 */
  known: KnownRefs
}

/** 머지할 것 하나를 연다 — main과 브랜치를 내려받아 분류한다(읽기만 한다) */
export async function openMerge(entry: MergeQueueEntry): Promise<MergeSession> {
  const [m, b, me] = await Promise.all([
    downloadNote<MainFileExtra>(entry.mainFileId, entry.mainEnc, entry.docId),
    downloadNote<BranchFileExtra>(entry.branchFileId, drive.ENC_GZIP, entry.docId),
    getDeviceId()
  ])
  if (!m || !b?.file.branch) throw new Error('클라우드의 노트 파일을 읽지 못했습니다.')
  const main = m.file as MainFile
  const branch = b.file as BranchFile
  // 두 파일이 가리키는 조각 — 최종 머지가 결과를 올릴 때 같은 조각은 다시 올리지 않는다
  const known: KnownRefs = new Map()
  for (const o of [...objsOf(m.raw), ...objsOf(b.raw)]) known.set(o.h, { f: o.f, s: o.s })
  const prefer: Side = entry.deviceId === me ? 'branch' : 'main'
  const plan = classify(plainDoc(main), plainDoc(branch), { modified: branch.branch.modified ?? {}, hasBase: !!branch.branch.baseMid, prefer })
  return { entry, main, branch, mainMid: midOfFile(main), prefer, plan, known }
}

/** 머지 화면을 연 뒤 그 사이 main이나 그 브랜치가 바뀌었다 — 다시 열어 작업본을 새 내용에 얹어야 한다 */
export class MergeStaleError extends Error {
  constructor() {
    super('머지 화면을 연 뒤에 다른 기기가 이 노트를 올렸습니다. 새 내용으로 다시 불러왔으니 확인한 뒤 다시 머지해 주세요.')
    this.name = 'MergeStaleError'
  }
}

export interface MergeCommitResult {
  /** 이 기기 노트에도 결과를 적용했나 */
  applied: boolean
  /** 이 기기 브랜치에 아직 머지 안 된 내용이 있어 이 기기 노트는 그대로 두었다 (그 브랜치도 머지 관리에 남는다) */
  keptLocal: boolean
}

/**
 * 최종 머지 — 작업본을 얹은 결과로 main을 쓴다(세대 + 1, 그 브랜치를 '반영됨'으로).
 * 쓰기 직전에 main과 브랜치가 연 순간 그대로인지 확인하고, 바뀌었으면 MergeStaleError(아무것도 쓰지 않는다).
 * 이 기기 노트에는 결과를 적용한다 — 단, 이 기기에 아직 머지 안 된 자기 브랜치가 있으면 적용하지 않는다
 * (덮으면 화면에서 그 변경이 사라지고, 다음 올리기가 결과를 '이 기기 변경'으로 올려 그 브랜치를 묻어 버린다).
 */
export function commitMerge(session: MergeSession, draft: MergeDraft): Promise<MergeCommitResult> {
  return trackActivity('upload', '머지 올리기', (a) => {
    void db.documents.get(session.entry.docId).then((d) => d?.title && a.update({ title: `${d.title} 머지` }))
    return commitMergeLocked(session, draft)
  })
}
function commitMergeLocked(session: MergeSession, draft: MergeDraft): Promise<MergeCommitResult> {
  return withSyncLock(async () => {
    const { entry } = session
    const docId = entry.docId
    const [head, bHead] = await Promise.all([drive.getMeta(entry.mainFileId), drive.getMeta(entry.branchFileId)])
    if (!head || head.trashed || mainMidOf(head.appProperties) !== session.mainMid) throw new MergeStaleError()
    if (!bHead || bHead.trashed || (Number(bHead.appProperties?.seq) || 0) !== session.branch.branch.seq) throw new MergeStaleError()

    const result = compose(plainDoc(session.main), plainDoc(session.branch), session.plan, draft)
    const f = await ensureFolders()
    const [device, me] = await Promise.all([getDeviceName(), getDeviceId()])
    const at = Date.now()
    const gen = genOf(head.appProperties) + 1
    const mid = newMid()
    const prev = mergedOf(head.appProperties)
    const merged = { ...prev, [entry.deviceId]: Math.max(prev[entry.deviceId] ?? 0, session.branch.branch.seq) }
    const marker: MainMarker = { gen, mid, merged, made: { kind: 'merge', deviceId: me, device, at } }
    const known = new Map([...(await knownRefs(docId)), ...session.known])
    const { manifest, stats } = await toManifest({ ...result, rev: { kind: 'merge', device, at }, main: marker }, known)
    const res = await drive.upload(
      await gzipJson(manifest),
      {
        name: mainFileName(docId),
        mimeType: 'application/json',
        appProperties: {
          docId,
          updatedAt: String(result.doc.updatedAt),
          ...titleProp(result.doc.title),
          device,
          enc: drive.ENC_GZIP,
          revKind: 'merge',
          nb: String(stats.totalBytes),
          ...categoryProp(result.doc.category),
          ...mainProps({ gen, mid, merged, updatedAt: result.doc.updatedAt })
        }
      },
      f.docs,
      head.id
    )
    await rememberRevTag(res.id, { device, revKind: 'merge' })
    const after = (await drive.getMeta(res.id).catch(() => null)) ?? res
    if (mainMidOf(after.appProperties) !== mid) throw new MergeStaleError() // 쓰는 순간 다른 기기가 덮었다 — 그 브랜치는 머지 관리에 남는다
    await rememberRefs(docId, 'main', manifest.objs)
    await noteListed(after)

    // 이 기기 노트에 적용 (규칙 11 — 노트 보호 안에서, 그 사이 이 기기에서 고쳤으면 applyDocFile이 적용하지 않는다)
    const keptLocal = isUnmerged(await getBranchState(docId), merged, me)
    const local = await db.documents.get(docId)
    let applied = false
    if (!keptLocal && local && !local.deletedAt && !(await getSync(`gone:${docId}`))) {
      try {
        applied = await withDocExclusive(docId, async () => {
          await takeSnapshot(docId, 'merge') // 덮기 직전 이 기기 내용
          return applyDocFile(result)
        })
      } catch (e) {
        if (!(e instanceof DocBusyError)) throw e // 다른 탭에서 편집 중 — 다음 받기 때 따라온다
      }
      if (applied) {
        await putDocRecord(docId, after.id, after.version)
        await saveBase(docId, result)
        await putBranchState(docId, { baseMid: mid, baseGen: gen })
      }
    }
    emitRemoteChanged(new Set<string>([docId]))
    await forgetQueued([{ docId, deviceId: entry.deviceId }]) // 상태 변경 알림도 함께
    return { applied, keptLocal }
  })
}

// ───────────────── 동기화 요약 (네트워크 없이) ─────────────────
// 라이브러리 배지·편집 화면의 노트 칩·앱 아이콘 배지가 읽는다. 이 기기 DB와 마지막으로 본 캐시만 읽는다 —
// '받을 것'과 '머지 대기'는 사용자가 목록을 새로 고쳤을 때(또는 켜 둔 '앱 열 때 확인') 알게 된 것까지만이다.

/** 동기화 상태가 바뀌었다 — 이 탭과 다른 탭에 알린다 (카드 점·배지·칩이 다시 계산) */
export function notifySyncChanged(): void {
  window.dispatchEvent(new Event(CLOUD_STATES_EVENT))
  cloudStatesChannel?.postMessage(Date.now())
}

const MERGE_QUEUE_CACHE = 'mergeQueueCache'
interface QueuedRef {
  docId: ID
  deviceId: string
  mine: boolean
}

async function cacheMergeQueue(items: QueuedRef[]): Promise<void> {
  await putSync(MERGE_QUEUE_CACHE, { at: Date.now(), items })
  notifySyncChanged()
}

/** 마지막으로 본 머지 대기 목록 (네트워크 없음) */
export async function cachedMergeQueue(): Promise<QueuedRef[]> {
  return (await getSync<{ items: QueuedRef[] }>(MERGE_QUEUE_CACHE))?.items ?? []
}

/** 머지했거나 지운 브랜치를 캐시에서 뺀다 */
export async function forgetQueued(refs: { docId: ID; deviceId: string }[]): Promise<void> {
  const drop = new Set(refs.map((r) => `${r.docId}@${r.deviceId}`))
  await cacheMergeQueue((await cachedMergeQueue()).filter((i) => !drop.has(`${i.docId}@${i.deviceId}`)))
}

/** 올리지 않은 변경이 있는 노트 — 휴지통·클라우드에서 지운 노트(일괄 올리기 제외)는 뺀다 */
export async function unsyncedNoteIds(): Promise<ID[]> {
  const out: ID[] = []
  for (const docId of (await pendingDocs()).keys()) {
    const doc = await db.documents.get(docId)
    if (!doc || doc.deletedAt || (await getSync(`clouddel:${docId}`))) continue
    out.push(docId)
  }
  return out
}

export interface SyncSummary {
  /** 올리지 않은 변경이 있는 노트 */
  pending: ID[]
  /** 갈라진 이 기기 노트 (마지막으로 본 판정) */
  diverged: ID[]
  /** 머지 대기 브랜치 수 (다른 기기 것 포함, 마지막으로 본 목록) */
  merge: number
}

export async function syncSummary(): Promise<SyncSummary> {
  const [pending, states, queue] = await Promise.all([unsyncedNoteIds(), cardSyncStates(), cachedMergeQueue()])
  return { pending, diverged: [...states].filter(([, s]) => s === 'diverged').map(([id]) => id), merge: queue.length }
}

/** 클라우드 목록 판정 캐시에서 노트 하나만 고친다 (노트 하나 받기·확인 뒤) */
async function setCachedState(docId: ID, state: CloudNoteState, version: string): Promise<void> {
  const cache = (await getSync<{ at: number; states: Record<string, CloudNoteState>; versions: Record<string, string> }>('cloudStates')) ?? { at: 0, states: {}, versions: {} }
  cache.states[docId] = state
  cache.versions[docId] = version
  await putSync('cloudStates', cache)
}

export type PullOneResult = 'applied' | 'same' | 'pending' | 'diverged' | 'notfound'

/**
 * 이 노트 하나만 받는다 (편집 화면의 노트 칩). 받기와 같은 판정 — 올리지 않은 변경이 있으면 'pending'(올리기가 맡는다),
 * 갈라졌으면 'diverged'(머지 관리) 로 돌려주고 덮지 않는다. 받을 것이면 main으로 따라간다(덮기 직전 스냅샷).
 */
export function pullOneNote(docId: ID): Promise<PullOneResult> {
  return noteActivity('download', docId, () => pullOneLocked(docId), {
    same: '이미 최신',
    pending: '올리지 않은 변경이 있어 받지 않음',
    diverged: '갈라짐 — 머지가 필요',
    notfound: '클라우드에 없음'
  })
}
function pullOneLocked(docId: ID): Promise<PullOneResult> {
  return withSyncLock(async () => {
    const f = await ensureFolders()
    await flushOpenDocs() // 열린 편집 화면의 저장 대기 중인 변경도 판정에 넣는다
    const remote = await findMain(docId, f.docs)
    if (!remote) return 'notfound'
    const local = await db.documents.get(docId)
    const { sync } = await judgeNote(docId, remote, local, (await pendingDocs()).has(docId), await getDeviceId())
    await setCachedState(docId, SYNC_TO_STATE[sync], remote.version)
    if (sync !== 'pull') {
      notifySyncChanged()
      return sync === 'same' ? 'same' : sync === 'push' ? 'pending' : 'diverged'
    }
    const got = await downloadNote<MainFileExtra>(remote.id, remote.appProperties?.enc, docId)
    if (!got) return 'notfound'
    const file = got.file
    const applied = await withDocExclusive(docId, async () => {
      await takeSnapshot(docId, 'pull')
      return applyDocFile(plainDoc(file))
    })
    if (!applied) return 'pending'
    await putDocRecord(docId, remote.id, remote.version)
    await followedMain(docId, file, remote.appProperties, objsOf(got.raw))
    emitRemoteChanged(new Set<string>([docId]))
    notifySyncChanged()
    return 'applied'
  })
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
  void db.syncState.bulkDelete(OLD_MERGE_LOG_KEYS).catch(() => {})
  window.addEventListener('online', () => setStatus('idle'))
  window.addEventListener('offline', () => setStatus('offline'))
  getAccessToken().catch((e) => {
    if (e instanceof AuthRequiredError) setStatus('auth-required')
    else if (e instanceof SyncNotConfiguredError) setStatus('disabled')
  })
}
