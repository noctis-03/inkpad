// 동기화 공통 기반: Drive 위치 기록(syncState)과 Drive 폴더(root·docs·assets) 확보.
// sync.ts(동기화 엔진)와 assets.ts(원본 지연 로딩)가 함께 쓴다.
// 순환 import를 피하려고 여기로 분리했다.
import type { ID } from '../shared/model'
import { db } from '../storage/db'
import { enqueue } from '../storage/repo'
import * as drive from './drive'

export const ROOT_NAME = 'Inkpad'

/** Drive 파일 위치/버전 기록 */
export interface FileRecord {
  fileId: string
  version: string
}

export async function getSync<T = FileRecord | string>(key: string): Promise<T | undefined> {
  const row = await db.syncState.get(key)
  return row?.value as T | undefined
}

export const putSync = (key: string, value: unknown) => db.syncState.put({ key, value })

/** 첫 동기화 또는 Drive 폴더가 통째로 사라진 경우: 로컬을 지우지 않고 전부 재업로드 큐에 올린다 (규칙 5).
 *  폴더는 기기별 로컬 전용이라 큐에 넣지 않는다. */
export async function enqueueEverything() {
  await db.transaction('rw', [db.documents, db.assets, db.outbox], async () => {
    for (const d of await db.documents.toArray()) await enqueue('document', d.id)
    for (const a of await db.assets.toArray()) if (a.blob) await enqueue('asset', a.id)
  })
}

/** Drive 위치 기록(doc:/asset:/base:)을 비우고 전체 재업로드를 예약한다 */
export async function resetRemoteRecords() {
  invalidateFolders()
  await db.transaction('rw', db.syncState, async () => {
    const keys = (await db.syncState.toArray()).map((k) => k.key)
    await db.syncState.bulkDelete(
      keys.filter((k) => k.startsWith('doc:') || k.startsWith('asset:') || k.startsWith('base:'))
    )
  })
  await enqueueEverything()
}

/** 폴더 ID는 한 번 검증하면 잠깐 재사용한다.
 *  예전에는 ensureFolders()가 호출될 때마다 root·docs·assets를 getMeta로 다시 확인해
 *  올리기 1회에 12~18건의 중복 메타 요청이 나갔다. */
const FOLDER_VERIFY_TTL_MS = 60_000
let verifiedFolders: { root: string; docs: string; assets: string } | null = null
let verifiedAt = 0

/** 폴더 검증 캐시를 버린다 — 폴더가 사라졌다는 응답을 받았을 때 등 */
export function invalidateFolders() {
  verifiedFolders = null
  verifiedAt = 0
}

export async function ensureFolders(): Promise<{ root: string; docs: string; assets: string }> {
  if (verifiedFolders && Date.now() - verifiedAt < FOLDER_VERIFY_TTL_MS) return verifiedFolders
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
  verifiedFolders = { root, docs, assets }
  verifiedAt = Date.now()
  return verifiedFolders
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

/**
 * Inkpad/ 아래 하위 폴더(apps·files·boards·backups)를 확보한다 — 기록해 둔 폴더가 살아 있으면 그대로,
 * 없으면 이름으로 찾거나 만든다. 기록과 다른 폴더가 되면(통째로 지워져 새로 만든 경우)
 * onRecreated로 알린다 — 그 폴더를 쓰는 쪽이 로컬 항목을 지우지 않고 '다시 올릴 것'으로 돌린다 (규칙 5).
 */
export async function ensureStoreFolder(name: string, key: string, onRecreated?: () => Promise<unknown>): Promise<string> {
  const { root } = await ensureFolders()
  const saved = await getSync<string>(key)
  if (saved) {
    const m = await drive.getMeta(saved)
    if (m && !m.trashed) return saved
  }
  const id = (await drive.findFolder(name, root)) ?? (await drive.createFolder(name, root))
  if (saved && saved !== id) await onRecreated?.()
  await putSync(key, id)
  return id
}

/**
 * 머지 백업 폴더 (Inkpad/backups/) — 처음 쓸 때 만든다.
 * 머지 전 이 기기 상태를 노트 파일과 별도로 보관한다 (sync.ts finishMerge, 버전 기록이 함께 보여 준다).
 * 폴더가 사라졌어도 다시 올릴 것은 없다 — 백업은 그때그때 새로 만든다.
 */
export const ensureBackupsFolder = () => ensureStoreFolder('backups', 'backupsFolderId')

/**
 * 항목 하나를 지금 클라우드에 반영해 본다 (앱·기타 파일·보드 프리셋을 추가·수정한 직후).
 * 오프라인이거나 실패하면 false — 항목의 pending 표식이 남아 시트의 '모두 올리기'로 다시 올린다.
 */
export async function tryUpload(tag: string, run: () => Promise<void>): Promise<boolean> {
  if (!navigator.onLine) return false
  try {
    await run()
    return true
  } catch (e) {
    console.warn(`[${tag}] 클라우드 반영 실패 — 올리기 대기로 남는다`, e)
    return false
  }
}

/** 다른 곳에서 참조하지 않도록 ID 재수출 */
export type { ID }
