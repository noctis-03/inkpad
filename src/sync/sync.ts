// 동기화 엔진 — GitHub을 허브로 쓰는 풀/푸시 방식.
// git을 흉내 낸다:
//  - 이 기기(브라우저 IndexedDB)가 "로컬 저장소", GitHub 저장소가 "원격 허브"다.
//  - 올리기(push) = 변경 파일을 모아 한 커밋으로 만들어 브랜치를 이동시킨다.
//    커밋에 뭐가 들어갈지는 올리기 전에 미리 보여준다 (planPush → UI 미리보기).
//  - 받기(pull) = 허브 트리와 로컬 기록(blob SHA)을 비교해 달라진 파일만 내려받는다.
//  - 머지 = 다른 기기가 먼저 올렸으면(push 전 head가 틀리면) 받기를 먼저 하고 push한다.
//    양쪽에서 같은 문서를 고쳤으면: 이 기기의 편집을 먼저 커밋해 이력에 남기고,
//    원격 버전을 현재 상태로 적용한다 → 둘 다 보존되고 버전 기록에서 되돌릴 수 있다.
// 규칙:
//  1. 받기/올리기 모두 버튼을 눌렀을 때만 실행된다 (자동 동기화 없음)
//  2. 원본 바이트(PDF·이미지)는 받기에서 내려받지 않는다 — 문서를 열 때 지연 로딩 (sync/assets.ts)
//  3. 문서/폴더 JSON은 gzip으로 올린다. 파일 내용의 gzip 마법 부호로 판정한다
//  4. 삭제는 outbox delete(tombstone) → 허브에서 파일 삭제(커밋) → 로컬 휴지통(30일 보관)
//  5. 탭이 여러 개여도 navigator.locks로 동시에 하나만 실행
import type { ID } from '../shared/model'
import { gzipJson } from '../storage/compress'
import { db } from '../storage/db'
import { applyDocFile } from './apply'
import * as gh from './github'
import { docPath, foldersPath, ROOT as HUB_ROOT } from './github'
import { indexAssets, cacheTree } from './assets'
import { enqueue, enqueueEverything, getSync, putSync, type FileRecord } from './folders'
import { assetFileName, packDocument, packFolders, type DocFileV1, type FoldersFileV1 } from './pack'
import { AuthRequiredError, SyncNotConfiguredError, getDeviceName, getConfig } from './token'

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

// 진행률 문장 (UI의 한 줄 표시)
const progressListeners = new Set<(t: string | null) => void>()
export const onSyncProgress = (fn: (t: string | null) => void) => {
  progressListeners.add(fn)
  fn(null)
  return () => {
    progressListeners.delete(fn)
  }
}
let progress: string | null = null
const setProgress = (t: string | null) => {
  progress = t
  progressListeners.forEach((f) => f(t))
}

// ───────────────── 원격 변경 알림 ─────────────────

export const REMOTE_EVENT = 'inkpad-remote-changed'
/** 충돌이 이력 보존으로 해소됐을 때 (UI가 "버전 기록 보기" 안내를 띄운다) */
export const CONFLICT_EVENT = 'inkpad-conflict-resolved'
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('inkpad-sync') : null
channel?.addEventListener('message', (ev: MessageEvent<string[]>) => {
  window.dispatchEvent(new CustomEvent(REMOTE_EVENT, { detail: new Set<string>(ev.data) }))
})
function emitRemoteChanged(ids: Set<string>) {
  window.dispatchEvent(new CustomEvent(REMOTE_EVENT, { detail: ids }))
  channel?.postMessage([...ids])
}

// ───────────────── 허브 트리 유틸 ─────────────────

function entriesMap(entries: gh.TreeEntry[]): Map<string, gh.TreeEntry> {
  return new Map(entries.map((e) => [e.path, e]))
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
  /** 받기 이후에도 양쪽에서 바뀐 문서 (올리기가 머지로 해소한다) */
  conflicts: { docId: ID; title: string }[]
  /** 올리는 시점에 허브가 우리가 아는 헤드와 다른지 (머지가 필요하다는 뜻) */
  remoteAhead: boolean
  connected: boolean
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

/** 올리기 전 미리보기: 이 커밋에 뭐가 들어갈지 계산한다 (헤드·트리 조회 2회) */
export async function planPush(): Promise<PushPlan> {
  const rows = await db.outbox.toArray()
  const docs = await pendingDocs()
  const folderSeqs = rows.filter((r) => r.entity === 'folder').length
  const assetRows = rows.filter((r) => r.entity === 'asset')

  const plan: PushPlan = {
    docs: [],
    folders: folderSeqs > 0,
    assets: { count: 0, bytes: 0 },
    conflicts: [],
    remoteAhead: false,
    connected: true
  }

  for (const [docId] of docs) {
    const doc = await db.documents.get(docId)
    if (!doc || doc.deletedAt) {
      plan.docs.push({ docId, title: doc?.title ?? docId, change: 'delete' })
      continue
    }
    const rec = await getSync<FileRecord>(`doc:${docId}`)
    plan.docs.push({ docId, title: doc.title, change: rec?.path ? 'modify' : 'add' })
  }

  for (const r of assetRows) {
    const a = await db.assets.get(r.entityId)
    if (!a?.blob) continue
    if (await getSync(`asset:${a.sha256}`)) continue
    plan.assets.count++
    plan.assets.bytes += a.size
  }

  // 허브 상태와 비교 (오프라인이면 비교를 건너뛴다)
  if (navigator.onLine) {
    const head = await gh.getHead()
    const lastHead = await getSync<string>('headSha')
    if (head && lastHead && head.sha !== lastHead) plan.remoteAhead = true
    if (head) {
      const entries = entriesMap(await gh.listTree(head))
      for (const d of plan.docs) {
        if (d.change !== 'modify') continue
        const rec = await getSync<FileRecord>(`doc:${d.docId}`)
        const entry = entries.get(docPath(d.docId))
        if (entry && rec && rec.blobSha !== entry.sha && !plan.conflicts.some((c) => c.docId === d.docId)) {
          plan.conflicts.push({ docId: d.docId, title: d.title })
        }
      }
    }
  } else {
    plan.connected = false
  }

  return plan
}

// ───────────────── 올리기 (push = 커밋 만들어 브랜치 이동) ─────────────────

interface CommitCtx {
  head: gh.Head | null
  tree: Map<string, gh.TreeEntry>
  /** 이번 커밋에 담을 변경 (path → blob SHA, 삭제는 null) */
  changes: Map<string, string | null>
  seqsByDoc: Map<ID, PendingDoc>
  uploadedAt: Map<ID, number>
  firstCommit: boolean // 빈 저장소의 첫 커밋인지
  stats: { add: number; modify: number; delete: number; assets: number; folders: number }
}

/** 올리기. 실행 시점의 outbox를 다시 계산한다. */
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

function handleSyncError(e: unknown) {
  if (e instanceof AuthRequiredError) setStatus('auth-required')
  else if (e instanceof SyncNotConfiguredError) setStatus('disabled')
  else {
    console.error('[sync]', e)
    setStatus(navigator.onLine ? 'error' : 'offline')
  }
}

async function doPush(): Promise<boolean> {
  setProgress('허브 상태 확인 중…')
  const head = await gh.getHead()
  const lastHead = await getSync<string>('headSha')

  // 다른 기기가 먼저 올렸다 → 먼저 받아서 머지한다 (git pull --rebase에 해당)
  if (head && lastHead && head.sha !== lastHead) {
    await doPull(head, true)
  }

  let cur = await gh.getHead()
  let tree = cur ? entriesMap(await gh.listTree(cur)) : new Map<string, gh.TreeEntry>()
  if (cur) cacheTree(cur.sha, [...tree.values()])

  // 첫 올리기: 기록이 없고 outbox가 비어 있으면 로컬 전체를 큐에 올린다 (기존 데이터가 있던 기기)
  if (!(await getSync('headSha')) && !(await db.outbox.count())) {
    const hasLocal = (await db.documents.count()) > 0
    if (hasLocal) await enqueueEverything()
  }

  const ctx: CommitCtx = {
    head: cur,
    tree,
    changes: new Map(),
    seqsByDoc: await pendingDocs(),
    uploadedAt: new Map(),
    firstCommit: !cur,
    stats: { add: 0, modify: 0, delete: 0, assets: 0, folders: 0 }
  }

  const outboxRows = await db.outbox.toArray()
  const folderSeqs = outboxRows.filter((r) => r.entity === 'folder').map((r) => r.seq!)
  const assetRows = outboxRows.filter((r) => r.entity === 'asset')

  // 1) 원본(에셋) 먼저 — 내용 주소로 중복 없이
  const device = await getDeviceName()
  let assetDone = 0
  for (const r of assetRows) {
    const row = await db.assets.get(r.entityId)
    if (!row?.blob) {
      await db.outbox.delete(r.seq!)
      continue // 원본이 아직 없다(다른 기기에서 받아와야 함)
    }
    assetDone++
    setProgress(`원본 올리는 중 ${assetDone}…`)
    const path = gh.assetsPrefix() + assetFileName(row.sha256, row.mime).slice('assets/'.length)
    const known = await getSync<FileRecord>(`asset:${row.sha256}`)
    const entry = ctx.tree.get(path)
    if (known?.blobSha === entry?.sha) {
      await db.outbox.delete(r.seq!)
      continue
    }
    if (!entry) {
      const sha = await gh.createBlob(row.blob)
      ctx.changes.set(path, sha)
      await putSync(`asset:${row.sha256}`, { path, blobSha: sha })
      ctx.stats.assets++
    } else {
      await putSync(`asset:${row.sha256}`, { path, blobSha: entry.sha })
    }
    await db.outbox.delete(r.seq!)
  }

  // 2) 폴더 트리
  if (folderSeqs.length) {
    setProgress('폴더 올리는 중…')
    const before = await packFolders()
    const blob = await gzipJson(before)
    const sha = await gh.createBlob(blob)
    ctx.changes.set(foldersPath(), sha)
    ctx.stats.folders = 1
    ctx.uploadedAt.set('__folders__', before.updatedAt)
  }

  // 3) 문서 (충돌 머지 포함)
  let docDone = 0
  for (const [docId, info] of ctx.seqsByDoc) {
    const doc = await db.documents.get(docId)
    docDone++
    setProgress(`문서 반영 중 ${docDone}/${ctx.seqsByDoc.size}…`)
    if (!doc || doc.deletedAt) {
      await pushTombstone(docId, info, ctx)
      continue
    }
    const rec = await getSync<FileRecord>(`doc:${docId}`)
    const entry = ctx.tree.get(docPath(docId))
    const remoteChanged = !!(entry && rec?.blobSha && entry.sha !== rec.blobSha)
    if (remoteChanged) {
      // 머지: 이 기기의 편집을 커밋해 이력에 남기고, 원격 버전을 현재로 적용한다
      await resolveConflict(docId, entry!, info, ctx)
      continue
    }
    await pushDoc(docId, info, ctx, device)
  }

  // 4) 커밋 & 브랜치 이동 — 이 커밋에 뭐가 들어갔는지 메시지로 남긴다
  if (ctx.changes.size || (ctx.head === null && ctx.firstCommit)) {
    const s = ctx.stats
    const bits = [
      s.add ? `추가 ${s.add}` : '',
      s.modify ? `수정 ${s.modify}` : '',
      s.delete ? `삭제 ${s.delete}` : '',
      s.folders ? '폴더' : '',
      s.assets ? `원본 ${s.assets}개` : ''
    ].filter(Boolean)
    const message = `InkPad: 기기 "${device}" — ${bits.join(', ') || '변경 없음'}`
    setProgress('커밋 만드는 중…')
    await commitAndMove(ctx, message)
  }

  // 성공한 커밋 기준으로 outbox·기록 정리
  await finalizeOutbox(ctx)
  if (folderSeqs.length) await db.outbox.bulkDelete(folderSeqs)
  setProgress(null)
  return true
}

async function commitAndMove(ctx: CommitCtx, message: string): Promise<void> {
  if (!ctx.changes.size && ctx.head) return
  const items: gh.TreeItem[] = [...ctx.changes].map(([path, sha]) => ({ path, sha }))
  const treeSha = await gh.createTree(ctx.head?.tree ?? null, items)
  const commitSha = await gh.createCommit(message, treeSha, ctx.head ? [ctx.head.sha] : [])
  if (ctx.head) await gh.updateRef(commitSha)
  else await gh.createBranchRef(commitSha)
  // 새 헤드 기준으로 트리 갱신 (이어지는 머지 커밋을 위해)
  const newHead: gh.Head = { sha: commitSha, tree: treeSha }
  ctx.head = newHead
  for (const [path, sha] of ctx.changes) {
    if (sha === null) ctx.tree.delete(path)
    else ctx.tree.set(path, { path, sha })
  }
  ctx.changes.clear()
  cacheTree(commitSha, [...ctx.tree.values()])
  await putSync('headSha', commitSha)
}

async function pushDoc(docId: ID, info: PendingDoc, ctx: CommitCtx, device: string) {
  const rec = await getSync<FileRecord>(`doc:${docId}`)
  const file = await packDocument(docId)
  // 참조 원본을 먼저 올린다 (outbox에 없는 것도)
  for (const am of file.assets) {
    const row = await db.assets.get(am.id)
    if (!row?.blob) continue
    const path = gh.assetsPrefix() + assetFileName(row.sha256, row.mime).slice('assets/'.length)
    if (ctx.tree.has(path) || (await getSync(`asset:${row.sha256}`))) continue
    const sha = await gh.createBlob(row.blob)
    ctx.changes.set(path, sha)
    await putSync(`asset:${row.sha256}`, { path, blobSha: sha })
  }
  const blob = await gzipJson(file)
  const sha = await gh.createBlob(blob)
  ctx.changes.set(docPath(docId), sha)
  await putSync(`doc:${docId}`, { path: docPath(docId), blobSha: sha })
  ctx.uploadedAt.set(docId, file.doc.updatedAt)
  if (rec?.path) ctx.stats.modify++
  else ctx.stats.add++
  void device
}

/** 로컬에서 삭제된 문서: 허브 커밋에서 파일을 지운다. 이력은 남으니 복구 가능 */
async function pushTombstone(docId: ID, info: PendingDoc, ctx: CommitCtx) {
  const rec = await getSync<FileRecord>(`doc:${docId}`)
  if (rec?.path) {
    ctx.changes.set(rec.path, null)
    ctx.stats.delete++
  }
  await db.syncState.delete(`doc:${docId}`)
  await db.outbox.bulkDelete(info.seqs)
}

async function finalizeOutbox(ctx: CommitCtx) {
  for (const [docId, info] of ctx.seqsByDoc) {
    const uploadedAt = ctx.uploadedAt.get(docId)
    if (uploadedAt === undefined) continue
    await db.transaction('rw', [db.documents, db.outbox], async () => {
      const cur = await db.documents.get(docId)
      if (!cur) return
      if (cur.updatedAt === uploadedAt) await db.outbox.bulkDelete(info.seqs)
      // 아니면 outbox가 남아 다음 올리기에서 다시 반영된다
    })
  }
}

// ───────────────── 충돌 머지 ─────────────────

/**
 * 양쪽에서 같은 문서를 고쳤을 때 (git의 머지 커밋에 해당):
 *  1. 이 기기의 편집을 먼저 커밋해 이력에 남긴다 → 나중에 버전 기록에서 되돌릴 수 있다
 *  2. 원격(다른 기기) 버전을 현재 상태로 적용하고 그것도 커밋한다
 *  문서가 복제되지 않고, 데이터도 잃지 않는다.
 */
async function resolveConflict(docId: ID, entry: gh.TreeEntry, info: PendingDoc, ctx: CommitCtx) {
  const device = await getDeviceName()
  const local = await packDocument(docId)
  const localSha = await gh.createBlob(await gzipJson(local))
  ctx.changes.set(docPath(docId), localSha)
  await commitAndMove(ctx, `InkPad 머지: 기기 "${device}" 편집 보존 — ${local.doc.title}`)
  await putSync(`doc:${docId}`, { path: docPath(docId), blobSha: localSha })

  // outbox를 비운 뒤 원격 내용을 적용한다 (적용 가드 통과용)
  await db.outbox.bulkDelete(info.seqs)
  const content = await gh.readGzipJson<DocFileV1>(entry.sha)
  await applyDocFile(content)
  const remoteSha = await gh.createBlob(await gzipJson(content))
  ctx.changes.set(docPath(docId), remoteSha)
  await commitAndMove(ctx, `InkPad 머지: 원격 버전 적용 — ${content.doc.title}`)
  await putSync(`doc:${docId}`, { path: docPath(docId), blobSha: remoteSha })
  ctx.uploadedAt.set(docId, content.doc.updatedAt)
  emitRemoteChanged(new Set<string>([docId]))
  window.dispatchEvent(new CustomEvent(CONFLICT_EVENT, { detail: { docId, revisionId: localSha } }))
}

// ───────────────── 받기 (pull) ─────────────────

export interface PullResult {
  docs: number
  folders: boolean
  conflicts: number
  indexedAssets: number
}

/** 받기. 허브에서 달라진 파일만 골라 내려받는다 */
export async function pullNow(): Promise<PullResult | null> {
  if (!navigator.onLine) {
    setStatus('offline')
    return null
  }
  return (await navigator.locks.request(SYNC_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) return null // 다른 탭에서 동기화 중
    setStatus('syncing')
    try {
      const head = await gh.getHead()
      if (!head) {
        setStatus('idle')
        return { docs: 0, folders: false, conflicts: 0, indexedAssets: 0 }
      }
      const r = await doPull(head, false)
      await db.syncState.put({ key: 'lastPullAt', value: Date.now() })
      setStatus('idle')
      return r
    } catch (e) {
      handleSyncError(e)
      return null
    } finally {
      setProgress(null)
    }
  })) as PullResult | null
}

async function doPull(head: gh.Head, insidePush: boolean): Promise<PullResult> {
  const result: PullResult = { docs: 0, folders: false, conflicts: 0, indexedAssets: 0 }
  setProgress('허브 목록 받는 중…')
  const entries = entriesMap(await gh.listTree(head))
  cacheTree(head.sha, [...entries.values()])
  await putSync('headSha', head.sha)

  const outboxRows = await db.outbox.toArray()
  const pending = new Set(outboxRows.filter((r) => r.entity === 'document').map((r) => r.entityId))
  for (const [docId] of await pendingDocs()) pending.add(docId)
  const changed = new Set<string>()

  // 폴더 트리
  const ff = entries.get(foldersPath())
  if (ff) {
    const rec = await getSync<FileRecord>('foldersFile')
    if (!rec || rec.blobSha !== ff.sha) {
      if (await mergeFolders(ff.sha, pending, changed)) {
        await putSync('foldersFile', { path: foldersPath(), blobSha: ff.sha })
        result.folders = true
      }
    }
  }

  // 문서
  const recs = new Map<string, FileRecord>()
  for (const kv of await db.syncState.toArray()) {
    if (kv.key.startsWith('doc:')) recs.set(kv.key.slice(4), kv.value as FileRecord)
  }
  let n = 0
  const docsPrefix = `${HUB_ROOT}/docs/`
  const remoteDocs = [...entries.keys()].filter((p) => p.startsWith(docsPrefix) && p.endsWith('.json'))
  for (const path of remoteDocs) {
    const docId = path.slice(docsPrefix.length, -'.json'.length)
    const local = await db.documents.get(docId)
    if (local?.deletedAt) continue // 로컬 삭제는 올리기에서 처리된다
    if (pending.has(docId)) {
      // 양쪽에서 바뀜 → 올리기가 머지로 해소한다
      const rec = recs.get(docId)
      const entry = entries.get(path)
      if (entry && rec && rec.blobSha !== entry.sha) {
        result.conflicts++
        if (!insidePush) continue
      }
      continue
    }
    const rec = recs.get(docId)
    const entry = entries.get(path)
    if (!entry) continue
    if (rec && rec.blobSha === entry.sha) continue // 이미 최신
    n++
    setProgress(`문서 받는 중 ${n}…`)
    const file = await gh.readGzipJson<DocFileV1>(entry.sha)
    if (await applyDocFile(file)) {
      await putSync(`doc:${docId}`, { path, blobSha: entry.sha })
      changed.add(docId)
      result.docs++
    }
  }

  // 허브에서 사라진 문서 → 로컬에서도 휴지통으로 (규칙 4)
  if (!insidePush) {
    for (const l of await db.documents.toArray()) {
      if (l.deletedAt || pending.has(l.id)) continue
      const rec = recs.get(l.id)
      if (!rec?.path || entries.has(rec.path)) continue
      const now = Date.now()
      await db.documents.update(l.id, { deletedAt: now, updatedAt: now })
      await enqueue('document', l.id, 'delete')
      changed.add(l.id)
    }
  }

  // 원본 바이트는 받지 않는다. 위치 기록만 채워 두고, 문서를 열 때 지연 로딩한다 (규칙 2)
  result.indexedAssets = await indexAssets(entries)

  if (changed.size) emitRemoteChanged(changed)
  return result
}

async function mergeFolders(blobSha: string, pending: Set<ID>, changed: Set<string>): Promise<boolean> {
  const data = await gh.readGzipJson<FoldersFileV1>(blobSha)
  if (data.kind !== 'inkpad-folders' || !Array.isArray(data.folders)) return false
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
  void pending
  return true
}

// ───────────────── 실행 (규칙 5) ─────────────────

/** 받고 올리기 — 버전 되돌리기 등 "둘 다 필요한" 곳에서 쓴다 */
export async function syncNow(): Promise<void> {
  if (!(await getConfig())) {
    setStatus('disabled')
    return
  }
  await pullNow()
  await pushNow()
}

// 받기/올리기는 사용자가 버튼을 눌렀을 때만 실행된다 (자동 동기화 없음).
// 여기서는 온라인/오프라인 상태 표시만 담당한다.
export function startSync() {
  window.addEventListener('online', () => setStatus(status === 'offline' ? 'idle' : status))
  window.addEventListener('offline', () => setStatus('offline'))
  void (async () => {
    setStatus((await getConfig()) ? 'idle' : 'disabled')
  })()
}

// ───────────────── 재초기화 (설정에서 사용) ─────────────────

/** 위치 기록을 모두 지우고 전체 재업로드를 예약한다 (저장소를 바꿨을 때) */
export async function forgetRemote() {
  const { resetRemoteRecords } = await import('./folders')
  await resetRemoteRecords()
  progress = null
}

