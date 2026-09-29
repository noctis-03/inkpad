// 동기화 공통 기반: 허브 파일 위치 기록(syncState).
// sync.ts(동기화 엔진)와 assets.ts(원본 지연 로딩)가 함께 쓴다.
import { db } from '../storage/db'
import { enqueue } from '../storage/repo'

export { enqueue }

/** 허브 파일 위치 기록: git 경로와 blob SHA. SHA가 같으면 내용도 같다 */
export interface FileRecord {
  path: string
  blobSha: string
}

export async function getSync<T = FileRecord | string>(key: string): Promise<T | undefined> {
  const row = await db.syncState.get(key)
  return row?.value as T | undefined
}

export const putSync = (key: string, value: unknown) => db.syncState.put({ key, value })

/** 첫 올리기: 로컬 전체를 업로드 큐에 올린다 (빈 허브에 첫 기기를 연결할 때) */
export async function enqueueEverything() {
  await db.transaction('rw', [db.folders, db.documents, db.assets, db.outbox], async () => {
    for (const f of await db.folders.toArray()) await enqueue('folder', f.id)
    for (const d of await db.documents.toArray()) await enqueue('document', d.id)
    for (const a of await db.assets.toArray()) if (a.blob) await enqueue('asset', a.id)
  })
}

/** 위치 기록(doc:/asset:/foldersFile/헤드)을 비우고 전체 재업로드를 예약한다 */
export async function resetRemoteRecords() {
  await db.transaction('rw', db.syncState, async () => {
    const keys = (await db.syncState.toArray()).map((k) => k.key)
    await db.syncState.bulkDelete(
      keys.filter((k) => k.startsWith('doc:') || k.startsWith('asset:') || k === 'foldersFile' || k === 'headSha')
    )
  })
  await enqueueEverything()
}

