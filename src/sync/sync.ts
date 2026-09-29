// 동기화 엔진 — git의 풀/푸시 모델을 Google Drive 위에 구현한 것.
//
// 허브 레이아웃 (Drive의 앱 폴더 안):
//   Inkpad/docs/<docId>.<commitId>.json  문서 스냅샷 — 커밋이 가리키는 시점의 값 (gzip)
//   Inkpad/folders.json                  폴더 트리 헤드 (gzip)
//   Inkpad/assets/<sha256>.<ext>         원본 PDF·이미지 (내용 주소, 중복 없음)
//   Inkpad/commits/<commitId>.json       커밋: 부모·기기·변경 목록
//   Inkpad/devices/<deviceId>.json       각 기기의 헤드 포인터 — 자기 파일만 쓰므로 기기끼리 충돌하지 않는다
//
// git과의 대응:
//   로컬 저장소 = 이 기기의 IndexedDB (전체 사본 — 기기 데이터가 지워져도 받기로 복원)
//   허브        = Drive 폴더 / 커밋 = "스냅샷 업로드 + 커밋 파일 + 내 기기 헤드 전진"
//   받기        = 다른 기기 헤드에서 아직 못 받은 커밋을 걷아 스냅샷을 적용 (필요하면 머지)
//   올리기      = 먼저 받아 머지한 뒤 자기 커밋을 만들어 헤드를 전진 (pull → push)
//   충돌        = 공통 조상(base) 스냅샷으로 페이지·청크 단위 3-way 머지.
//                 같은 청크를 양쪽에서 고쳤으면 원격이 우선하고, 이 기기의 편집은
//                 커밋 이력(스냅샷)에 남아 버전 되돌리기로 복구할 수 있다.
// 규칙:
//  1. 받기/올리기는 버튼을 눌렀을 때만 실행 (자동 동기화 없음)
//  2. 원본 바이트는 받기에서 받지 않고, 문서를 열 때 지연 로딩 (sync/assets.ts)
//  3. 스냅샷·폴더 JSON은 gzip으로 올린다 (appProperties.enc 표식)
//  4. 탭이 여러 개여도 navigator.locks로 동시에 하나만 실행
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

// 진행률 문장 (UI 한 줄 표시)
const progressListeners = new Set<(t: string | null) => void>()
export const onSyncProgress = (fn: (t: string | null) => void) => {
  progressListeners.add(fn)
  fn(null)
  return () => {
    progressListeners.delete(fn)
  }
}
const setProgress = (t: string | null) => progressListeners.forEach((f) => f(t))

// ───────────────── 원격 변경 알림 ─────────────────

export const REMOTE_EVENT = 'inkpad-remote-changed'
/** 머지로 충돌이 해소됐을 때 (UI가 "버전 기록 보기" 안내를 띄운다) */
export const CONFLICT_EVENT = 'inkpad-conflict-resolved'
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('inkpad-sync') : null
channel?.addEventListener('message', (ev: MessageEvent<string[]>) => {
  window.dispatchEvent(new CustomEvent(REMOTE_EVENT, { detail: new Set<string>(ev.data) }))
})
function emitRemoteChanged(ids: Set<string>) {
  window.dispatchEvent(new CustomEvent(REMOTE_EVENT, { detail: ids }))
  channel?.postMessage([...ids])
}

// ───────────────── 커밋 기록 ─────────────────

export interface CommitChange {
  kind: 'doc' | 'folders'
  docId?: ID
  path: string
  fileId?: string
  deleted?: boolean
}

export interface CommitMeta {
  id: string
  parents: string[]
  deviceId: string
  deviceName: string
  time: number
  message: string
  changes: CommitChange[]
}

type CommitCache = Record<string, CommitMeta>

export async function getCommitCache(): Promise<CommitCache> {
  return ((await getSync<CommitCache>('commitCache')) ?? {}) as CommitCache
}
async function putCommitCache(c: CommitCache) {
  await putSync('commitCache', c)
}

interface DeviceRec {
  id: string
  name: string
  head: string
  updatedAt: number
  fileId?: string
}

async function deviceId(): Promise<string> {
  let id = await getSync<string>('deviceId')
  if (!id) {
    id = ulid()
    await putSync('deviceId', id)
  }
  return id
}

/** 허브의 커밋 목록을 캐시에 받아온다 (아직 없는 것만 내려받음) */
async function listHubCommits(commitsFolderId: string): Promise<CommitCache> {
  const cache = await getCommitCache()
  let dirty = false
  for (const file of await drive.listFiles(commitsFolderId)) {
    const id = file.name.slice('commits/'.length, -'.json'.length)
    if (!id || cache[id]) continue
    try {
      cache[id] = await drive.downloadJson<CommitMeta>(file.id, file.appProperties?.enc)
      dirty = true
    } catch (e) {
      console.warn('[sync] 커밋 기록을 읽지 못했습니다:', id, e)
    }
  }
  if (dirty) await putCommitCache(cache)
  return cache
}

async function otherHeads(devicesFolderId: string): Promise<DeviceRec[]> {
  const mine = await deviceId()
  const out: DeviceRec[] = []
  for (const file of await drive.listFiles(devicesFolderId)) {
    try {
      const rec = await drive.downloadJson<DeviceRec>(file.id)
      if (rec?.id && rec.head && rec.id !== mine) out.push(rec)
    } catch (e) {
      console.warn('[sync] 기기 기록을 읽지 못했습니다:', file.name, e)
    }
  }
  return out
}

// ───────────────── outbox → 문서 단위 정리 ─────────────────

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

/** 머지로 덮어쓰기 전에 그 문서의 대기 행을 비운다 (applyDocFile의 pending 가드 통과용) */
async function clearDocOutbox(docId: ID) {
  const p = await pendingDocs()
  const seqs = p.get(docId)?.seqs ?? []
  if (seqs.length) await db.outbox.bulkDelete(seqs)
}

// ───────────────── 올리기 계획 (git status에 해당) ─────────────────

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
  /** 다른 기기도 고친 문서 — 올리기가 머지로 해소한다 */
  conflicts: { docId: ID; title: string }[]
  /** 받지 않은 다른 기기의 커밋이 있는지 (머지가 필요하다는 뜻) */
  remoteAhead: boolean
  connected: boolean
}

export async function planPush(): Promise<PushPlan> {
  const rows = await db.outbox.toArray()
  const pending = await pendingDocs()
  const plan: PushPlan = {
    docs: [],
    folders: rows.some((r) => r.entity === 'folder'),
    assets: { count: 0, bytes: 0 },
    conflicts: [],
    remoteAhead: false,
    connected: true
  }

  for (const [docId] of pending) {
    const doc = await db.documents.get(docId)
    if (!doc) continue
    if (doc.deletedAt) plan.docs.push({ docId, title: doc.title, change: 'delete' })
    else plan.docs.push({ docId, title: doc.title, change: (await getSync(`base:${docId}`)) ? 'modify' : 'add' })
  }

  for (const r of rows.filter((x) => x.entity === 'asset')) {
    const a = await db.assets.get(r.entityId)
    if (!a?.blob) continue
    if (await getSync(`asset:${a.sha256}`)) continue
    plan.assets.count++
    plan.assets.bytes += a.size
  }

  // 허브 상태와 비교 (오프라인이면 비교를 건너뛴다)
  if (navigator.onLine) {
    try {
      const f = await ensureFolders()
      const before = new Set(Object.keys(await getCommitCache()))
      const cache = await listHubCommits(f.commits)
      const mine = await deviceId()
      const fresh = Object.values(cache).filter((c) => !before.has(c.id) && c.deviceId !== mine)
      plan.remoteAhead = fresh.length > 0
      for (const c of fresh) {
        for (const ch of c.changes) {
          if (ch.kind !== 'doc' || !ch.docId || !pending.has(ch.docId)) continue
          const d = plan.docs.find((x) => x.docId === ch.docId)
          if (d && !plan.conflicts.some((x) => x.docId === ch.docId)) plan.conflicts.push({ docId: ch.docId, title: d.title })
        }
      }
    } catch (e) {
      console.warn('[sync] 허브 상태 확인 실패 — 미리보기만 표시합니다:', e)
      plan.connected = false
    }
  } else {
    plan.connected = false
  }

  return plan
}

// ───────────────── 3-way 문서 머지 ─────────────────

const j = (v: unknown) => JSON.stringify(v)

function mergeDocs(base: DocFileV1 | null, ours: DocFileV1, theirs: DocFileV1): { file: DocFileV1; conflicts: number } {
  let conflicts = 0
  const b = base

  // 문서 메타: 이 기기가 안 바친 필드는 원격 값을 따른다
  const doc: DocFileV1['doc'] = { ...theirs.doc, id: ours.doc.id, updatedAt: Math.max(ours.doc.updatedAt, theirs.doc.updatedAt) }
  if (b) {
    if (ours.doc.title !== b.doc.title) doc.title = ours.doc.title
    if (ours.doc.folderId !== b.doc.folderId) doc.folderId = ours.doc.folderId
    if (ours.doc.mode !== b.doc.mode) doc.mode = ours.doc.mode
    if (j(ours.doc.pageOrder) !== j(b.doc.pageOrder)) doc.pageOrder = ours.doc.pageOrder
    else if (j(theirs.doc.pageOrder) !== j(b.doc.pageOrder)) doc.pageOrder = theirs.doc.pageOrder
  }

  // 페이지: id 기준 유니언. base에 있었는데 한쪽에만 없으면 그쪽의 삭제를 따른다
  const pageOf = (list: DocFileV1['pages'], id: ID) => list.find((p) => p.id === id)
  const pageIds = new Set<ID>([...ours.pages.map((p) => p.id), ...theirs.pages.map((p) => p.id)])
  const pages: DocFileV1['pages'] = []
  for (const id of pageIds) {
    const o = pageOf(ours.pages, id)
    const t = pageOf(theirs.pages, id)
    const bb = b ? pageOf(b.pages, id) : undefined
    if (o && t) pages.push(t) // 정의가 같은 페이지 — 원격 우선
    else if (o) {
      if (!bb) pages.push(o) // 원격에서 지운 페이지지만 base가 없어 판단 불가 — 유지
    } else if (t) {
      if (!bb) pages.push(t) // 원격이 새로 만든 페이지
    }
  }

  // 청크(필기 저장 단위): base와 비교해 한쪽만 바꿨으면 그쪽, 양쪽 다 바꿨으면 원격 우선
  const keyOf = (c: { pageId: ID; key: string }) => `${c.pageId}|${c.key}`
  const baseEls = new Map<string, string>((b?.chunks ?? []).map((c) => [keyOf(c), j(c.elements)]))
  const oursMap = new Map(ours.chunks.map((c) => [keyOf(c), c]))
  const theirsMap = new Map(theirs.chunks.map((c) => [keyOf(c), c]))
  const chunks: DocFileV1['chunks'] = []
  for (const k of new Set<string>([...oursMap.keys(), ...theirsMap.keys()])) {
    const o = oursMap.get(k)
    const t = theirsMap.get(k)
    const bb = baseEls.get(k)
    if (o && t) {
      if (j(o.elements) === j(t.elements)) chunks.push(t)
      else if (bb === undefined || j(o.elements) === bb) chunks.push(t)
      else if (j(t.elements) === bb) chunks.push(o)
      else {
        chunks.push(t) // 양쪽에서 다르게 고침 — 원격 우선, 이 기기 편집은 커밋 이력에 보존
        conflicts++
      }
    } else if (o) {
      if (bb === undefined) chunks.push(o) // 이 기기의 새 청크
      // base에 있었는데 원격에 없다 → 원격이 지움 (버림)
    } else if (t) {
      if (bb === undefined) chunks.push(t) // 원격의 새 청크
      // base에 있었는데 이 기기에 없다 → 이 기기가 지움 (버림)
    }
  }

  // 에셋: 유니언
  const assetIds = new Set<ID>([...ours.assets.map((a) => a.id), ...theirs.assets.map((a) => a.id)])
  const assets = [...assetIds].flatMap((id) => [theirs.assets.find((a) => a.id === id) ?? ours.assets.find((a) => a.id === id)!])

  return { file: { kind: 'inkpad-doc', schemaVersion: 1, doc, pages, chunks, assets }, conflicts }
}

/**
 * 충돌 머지: base(마지막으로 맞춘 시점)·이 기기·원격 스냅샷으로 3-way.
 * 결과를 이 기기에 적용하고 발행 큐에 올린다 — 실제 허브 반영은 올리기가 한다.
 */
async function mergeDoc(
  docId: ID,
  change: CommitChange,
  commit: CommitMeta,
  docFiles: { byId: Map<string, drive.RemoteFile>; byName: Map<string, drive.RemoteFile> }
) {
  const ours = await packDocument(docId)
  let base: DocFileV1 | null = null
  const baseRec = await getSync<{ path: string }>(`base:${docId}`)
  const baseFile = baseRec ? docFiles.byName.get(baseRec.path) : undefined
  if (baseFile) {
    try {
      base = await drive.downloadJson<DocFileV1>(baseFile.id, baseFile.appProperties?.enc)
    } catch (e) {
      console.warn('[sync] base 스냅샷을 읽지 못해 원격 우선으로 대체합니다:', e)
    }
  }
  const remoteFile = change.fileId ? docFiles.byId.get(change.fileId) : undefined
  if (!remoteFile) return
  const theirs = await drive.downloadJson<DocFileV1>(remoteFile.id, remoteFile.appProperties?.enc)
  if (theirs?.kind !== 'inkpad-doc') return

  await clearDocOutbox(docId)
  const merged = mergeDocs(base, ours, theirs)
  await applyDocFile(merged.file)
  await db.transaction('rw', db.outbox, async () => {
    await enqueue('document', docId)
  })
  await putSync(`base:${docId}`, { path: change.path, commitId: commit.id })
  emitRemoteChanged(new Set<string>([docId]))
  window.dispatchEvent(new CustomEvent(CONFLICT_EVENT, { detail: { docId, revisionId: commit.id } }))
}

// ───────────────── 받기 (pull) ─────────────────

export interface PullResult {
  docs: number
  folders: boolean
  conflicts: number
}

/** 받기. 허브의 커밋을 걷아 아직 적용하지 않은 것만 골라 내려받는다 */
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
      const r = await mergeIntoLocal(f)
      await db.syncState.put({ key: 'lastPullAt', value: Date.now() })
      setStatus('idle')
      return { docs: r.docs, folders: r.folders, conflicts: r.conflicts }
    } catch (e) {
      handleSyncError(e)
      return null
    } finally {
      setProgress(null)
    }
  }) as Promise<PullResult | null>
}

async function mergeIntoLocal(f: { docs: string; assets: string; commits: string; devices: string; root: string }) {
  const result = { docs: 0, folders: false, conflicts: 0, appliedHeads: [] as string[] }
  setProgress('허브 커밋 확인 중…')
  const before = new Set(Object.keys(await getCommitCache()))
  const cache = await listHubCommits(f.commits)
  const newCommits = Object.values(cache)
    .filter((c) => !before.has(c.id))
    .sort((a, b) => a.id.localeCompare(b.id)) // ULID라 시각순
  if (!newCommits.length) return result

  result.appliedHeads = (await otherHeads(f.devices)).map((h) => h.head).filter((h) => newCommits.some((c) => c.id === h))

  // 스냅샷 메타 (파일 ID → enc, 이름 → 메타)
  const docsFiles = await drive.listFiles(f.docs)
  const byId = new Map(docsFiles.map((x) => [x.id, x]))
  const byName = new Map(docsFiles.map((x) => [x.name, x]))

  const pending = new Set(await pendingDocs().then((m) => [...m.keys()]))
  const changed = new Set<string>()

  for (const c of newCommits) {
    for (const ch of c.changes) {
      if (ch.kind === 'folders') {
        if (!ch.fileId) continue
        try {
          const meta = byId.get(ch.fileId)
          const data = await drive.downloadJson<FoldersFileV1>(ch.fileId, meta?.appProperties?.enc)
          if (await mergeFolders(data, pending)) {
            await putSync('foldersFile', { fileId: ch.fileId, version: '0' })
            result.folders = true
            changed.add('__folders__')
          }
        } catch (e) {
          console.warn('[sync] 폴더 트리를 읽지 못했습니다:', e)
        }
        continue
      }
      if (ch.kind !== 'doc' || !ch.docId) continue
      if (ch.deleted) {
        if (pending.has(ch.docId)) continue // 이 기기의 삭제·수정은 올리기에서 처리
        const local = await db.documents.get(ch.docId)
        if (local && !local.deletedAt) {
          const now = Date.now()
          await db.documents.update(ch.docId, { deletedAt: now, updatedAt: now })
          await putSync(`base:${ch.docId}`, { path: ch.path, commitId: c.id })
          changed.add(ch.docId)
          result.docs++
        }
        continue
      }
      if (!ch.fileId) continue
      if (pending.has(ch.docId)) {
        // 양쪽에서 고침 → 3-way 머지 (결과는 다음 올리기에서 발행)
        result.conflicts++
        await mergeDoc(ch.docId, ch, c, { byId, byName })
        pending.add(ch.docId)
        continue
      }
      const meta = byId.get(ch.fileId)
      let file: DocFileV1
      try {
        file = await drive.downloadJson<DocFileV1>(ch.fileId, meta?.appProperties?.enc)
      } catch (e) {
        console.warn('[sync] 스냅샷을 읽지 못했습니다 (정리됨):', ch.path, e)
        continue
      }
      if (file?.kind !== 'inkpad-doc') continue
      if (await applyDocFile(file)) {
        await putSync(`base:${ch.docId}`, { path: ch.path, commitId: c.id })
        changed.add(ch.docId)
        result.docs++
      }
    }
  }

  // 원본 바이트는 받지 않는다. 위치 기록만 채워 두고, 문서를 열 때 지연 로딩한다 (규칙 2)
  await indexAssets(f.assets)

  if (changed.size) emitRemoteChanged(changed)
  return result
}

async function mergeFolders(data: FoldersFileV1, pending: Set<ID>): Promise<boolean> {
  if (data.kind !== 'inkpad-folders' || !Array.isArray(data.folders)) return false
  const dirty = new Set((await db.outbox.toArray()).filter((r) => r.entity === 'folder').map((r) => r.entityId))
  let any = false
  for (const fo of data.folders) {
    if (dirty.has(fo.id) || pending.has(fo.id)) continue
    const local = await db.folders.get(fo.id)
    if (local && local.updatedAt >= fo.updatedAt) continue
    await db.folders.put(fo)
    any = true
  }
  for (const local of await db.folders.toArray()) {
    if (dirty.has(local.id) || pending.has(local.id) || data.folders.some((x) => x.id === local.id)) continue
    if (!local.deletedAt) {
      const now = Date.now()
      await db.folders.update(local.id, { deletedAt: now, updatedAt: now })
      await enqueue('folder', local.id, 'delete')
      any = true
    }
  }
  return any
}

// ───────────────── 올리기 (push = 커밋 만들어 헤드 전진) ─────────────────

/** 올리기. 버튼을 누르면 먼저 받아 머지한 뒤, 이 기기의 변경을 한 커밋으로 올린다. */
export async function pushNow(): Promise<void> {
  if (!navigator.onLine) {
    setStatus('offline')
    return
  }
  await navigator.locks.request(SYNC_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) return // 다른 탭에서 동기화 중
    setStatus('syncing')
    try {
      await doPush()
      await db.syncState.put({ key: 'lastPushAt', value: Date.now() })
      setStatus('idle')
    } catch (e) {
      handleSyncError(e)
    } finally {
      setProgress(null)
    }
  })
}

async function doPush() {
  const f = await ensureFolders()

  // 0) 허브가 비었고 이 기기에 데이터가 있으면 전부 올릴 준비 (첫 올리기 / 업그레이드)
  const cache = await listHubCommits(f.commits)
  if (!Object.keys(cache).length && !(await getSync<DeviceRec>('deviceRec'))) {
    if ((await db.documents.count()) > 0) await enqueueEverything()
  }

  // 1) 먼저 받아 머지 (git pull before push)
  const pulled = await mergeIntoLocal(f)

  const ourId = await deviceId()
  const deviceName = await getDeviceName()
  const prev = await getSync<DeviceRec>('deviceRec')
  const commitId = ulid()
  const changes: CommitChange[] = []
  const rows = await db.outbox.toArray()
  const seqsByDoc = await pendingDocs()
  const folderSeqs = rows.filter((r) => r.entity === 'folder').map((r) => r.seq!)
  const stats = { add: 0, modify: 0, del: 0 }

  // 2) 원본(PDF·이미지) — 내용 주소로 중복 없이
  const assetRows = rows.filter((r) => r.entity === 'asset')
  let done = 0
  for (const r of assetRows) {
    const row = await db.assets.get(r.entityId)
    if (!row?.blob) {
      await db.outbox.delete(r.seq!) // 원본이 아직 없다(다른 기기에서 받아와야 함)
      continue
    }
    if (!(await getSync(`asset:${row.sha256}`))) {
      done++
      setProgress(`원본 올리는 중 ${done}…`)
      const name = assetFileName(row.sha256, row.mime)
      const found = await drive.findByName(name, f.assets)
      if (found) {
        await putSync(`asset:${row.sha256}`, { fileId: found.id, version: found.version })
      } else {
        const res = await drive.upload(row.blob, { name, mimeType: row.mime, appProperties: { sha256: row.sha256 } }, f.assets)
        await putSync(`asset:${row.sha256}`, { fileId: res.id, version: res.version })
      }
    }
    await db.outbox.delete(r.seq!)
  }

  // 3) 폴더 트리
  if (folderSeqs.length) {
    setProgress('폴더 올리는 중…')
    const before = await packFolders()
    const rec = await getSync<FileRecord>('foldersFile')
    const res = await drive.upload(
      await gzipJson(before),
      { name: 'folders.json', mimeType: 'application/json', appProperties: { type: 'folders', enc: drive.ENC_GZIP } },
      f.root,
      rec?.fileId
    )
    changes.push({ kind: 'folders', path: 'folders.json', fileId: res.id })
    await db.transaction('rw', [db.folders, db.outbox], async () => {
      const after = await packFolders()
      if (after.updatedAt === before.updatedAt) await db.outbox.bulkDelete(folderSeqs)
      // 아니면 outbox가 남아 다음 올리기에서 다시 올려진다
    })
  }

  // 4) 문서 스냅샷 — 커밋당 파일 하나 (docs/<docId>.<commitId>.json)
  let n = 0
  for (const [docId, info] of seqsByDoc) {
    n++
    setProgress(`문서 올리는 중 ${n}/${seqsByDoc.size}…`)
    const doc = await db.documents.get(docId)
    const path = `docs/${docId}.${commitId}.json`
    if (!doc || doc.deletedAt) {
      // 휴지통 이동·휴지통 비우기(영구 삭제) 모두 "삭제 커밋"으로 기록한다 —
      // 안 그러면 허브에 노트가 남아 다른 기기의 받기에서 되살아난다
      changes.push({ kind: 'doc', docId, path, deleted: true })
      stats.del++
      await db.syncState.delete(`base:${docId}`)
      await db.outbox.bulkDelete(info.seqs)
      continue
    }
    const file = await packDocument(docId)
    const res = await drive.upload(file, {
      name: path,
      mimeType: 'application/json',
      appProperties: { docId, updatedAt: String(file.doc.updatedAt), enc: drive.ENC_GZIP }
    }, f.docs)
    changes.push({ kind: 'doc', docId, path, fileId: res.id })
    if (await getSync(`base:${docId}`)) stats.modify++
    else stats.add++
    await putSync(`base:${docId}`, { path, commitId })
    // 업로드 중에 또 수정됐으면 outbox가 남아 다음 올리기에서 다시 반영된다
    await db.transaction('rw', [db.documents, db.outbox], async () => {
      const cur = await db.documents.get(docId)
      if (cur && cur.updatedAt === file.doc.updatedAt) await db.outbox.bulkDelete(info.seqs)
    })
  }

  // 5) 커밋 파일 + 내 기기 헤드 전진
  const bits = [
    stats.add ? `추가 ${stats.add}` : '',
    stats.modify ? `수정 ${stats.modify}` : '',
    stats.del ? `삭제 ${stats.del}` : '',
    folderSeqs.length ? '폴더' : '',
    assetRows.length ? `원본 ${assetRows.length}개` : '',
    pulled.appliedHeads.length ? '다른 기기 변경 머지' : ''
  ].filter(Boolean)
  const message = `InkPad: 기기 "${deviceName}" — ${bits.join(', ') || '변경 없음'}`
  const parents = [...new Set([prev?.head, ...pulled.appliedHeads].filter((x): x is string => !!x))]
  const meta: CommitMeta = { id: commitId, parents, deviceId: ourId, deviceName, time: Date.now(), message, changes }
  setProgress('커밋 만드는 중…')
  await drive.upload(meta, { name: `commits/${commitId}.json`, mimeType: 'application/json' }, f.commits)
  cache[commitId] = meta
  await putCommitCache(cache)

  const rec: DeviceRec = { id: ourId, name: deviceName, head: commitId, updatedAt: Date.now(), ...(prev?.fileId ? { fileId: prev.fileId } : {}) }
  const dres = await drive.upload(rec, { name: `devices/${ourId}.json`, mimeType: 'application/json' }, f.devices, prev?.fileId)
  rec.fileId = dres.id
  await putSync('deviceRec', rec)

  // 6) 오래된 스냅샷 정리 — 각 문서의 최신 스냅샷은 남기고 365일 지난 옛날 것만
  try {
    const cutoff = Date.now() - 365 * 24 * 3600 * 1000
    const files = await drive.listFiles(f.docs)
    const latest = new Map<string, number>()
    for (const file of files) {
      const id = file.appProperties?.docId ?? ''
      const t = file.modifiedTime ? Date.parse(file.modifiedTime) : 0
      if (!latest.has(id) || latest.get(id)! < t) latest.set(id, t)
    }
    for (const file of files) {
      const id = file.appProperties?.docId ?? ''
      const t = file.modifiedTime ? Date.parse(file.modifiedTime) : 0
      if (t < cutoff && t < (latest.get(id) ?? 0)) await drive.trash(file.id)
    }
  } catch (e) {
    console.warn('[sync] 오래된 스냅샷 정리 실패:', e)
  }
}

// ───────────────── 실행 (규칙 4) ─────────────────

/** 받고 올리기 — 버전 되돌리기 등 "둘 다 필요한" 곳에서 쓴다 */
export async function syncNow(): Promise<void> {
  try {
    await getAccessToken()
  } catch (e) {
    handleSyncError(e)
    return
  }
  await pullNow()
  await pushNow()
}

// 받기/올리기는 사용자가 버튼을 눌렀을 때만 실행된다 (자동 백그라운드 동기화 없음).
// 여기서는 온라인/오프라인 상태 표시와 세션 확인(네트워크 확인만, Drive 호출 없음)만 한다.
export function startSync() {
  window.addEventListener('online', () => setStatus('idle'))
  window.addEventListener('offline', () => setStatus('offline'))
  getAccessToken().catch((e) => {
    if (e instanceof AuthRequiredError) setStatus('auth-required')
    else if (e instanceof SyncNotConfiguredError) setStatus('disabled')
  })
}
