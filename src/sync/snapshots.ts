// 로컬 스냅샷 — 이 기기의 노트 내용이 덮이기 직전(받기·맞추기·최종 머지·되돌리기)에 자동으로 남기는 안전망.
// 네트워크 없이 되돌릴 수 있다(버전 기록 패널). 기기 로컬 전용 — 다른 기기로 가지 않는다.
//
//  - 저장: backups 테이블(reason `snapshot:{docId}`)에 노트 파일(DocFileV1) gzip.
//  - 같은 내용이 연달아 남지 않게 마지막 스냅샷과 내용 해시가 같으면 건너뛴다.
//  - 보존: 노트당 최근 SNAP_PER_DOC개, 전체 SNAP_TOTAL_BYTES를 넘으면 오래된 것부터 지운다.
//  - 실패해도 덮는 일을 막지 않는다 — 스냅샷은 덤이다(올린 내용은 브랜치·main 기록에도 있다).
import type { ID } from '../shared/model'
import { gunzipJson, gzipJson } from '../storage/compress'
import { db, type BackupRow } from '../storage/db'
import { shortHash } from './branch'
import { packDocument, type DocFileV1 } from './pack'
import { canonical } from './unchanged'

export const SNAP_PER_DOC = 20
export const SNAP_TOTAL_BYTES = 200 * 1024 * 1024

/** 무엇을 하기 직전에 남겼나 */
export type SnapshotWhy = 'pull' | 'align' | 'merge' | 'restore' | 'discard'

export interface SnapshotInfo {
  id: string
  docId: ID
  at: number
  why: SnapshotWhy
  title: string
  strokes: number
  size: number
}

const PREFIX = 'snapshot:'
const reasonOf = (docId: ID) => PREFIX + docId

const infoOf = (r: BackupRow): SnapshotInfo => ({
  id: r.id,
  docId: r.docId ?? r.reason.slice(PREFIX.length),
  at: r.createdAt,
  why: (r.why as SnapshotWhy) ?? 'pull',
  title: r.title ?? '',
  strokes: r.strokes ?? 0,
  size: r.data?.size ?? 0
})

/** 이 기기 노트의 지금 내용을 남긴다. 노트가 없거나 휴지통이면, 또는 마지막 스냅샷과 같으면 남기지 않는다 */
export async function takeSnapshot(docId: ID, why: SnapshotWhy): Promise<void> {
  try {
    const doc = await db.documents.get(docId)
    if (!doc || doc.deletedAt) return
    const file = await packDocument(docId)
    const hash = shortHash(canonical(file))
    const last = (await db.backups.where('reason').equals(reasonOf(docId)).sortBy('createdAt')).at(-1)
    if (last?.hash === hash) return
    const at = Math.max(Date.now(), (last?.createdAt ?? 0) + 1)
    await db.backups.put({
      id: `snap:${docId}:${at}`,
      createdAt: at,
      reason: reasonOf(docId),
      data: await gzipJson(file),
      docId,
      why,
      title: doc.title,
      strokes: file.chunks.reduce((n, c) => n + c.elements.length, 0),
      hash
    })
    await pruneSnapshots(docId)
  } catch (e) {
    console.warn('[snapshot] 스냅샷을 남기지 못했습니다 — 하던 일은 계속합니다:', docId, e)
  }
}

/** 보존 규칙대로 지운다 — 그 노트는 최근 keep개, 전체는 용량 상한까지 */
export async function pruneSnapshots(docId?: ID, keep = SNAP_PER_DOC): Promise<number> {
  let removed = 0
  const ids = docId ? [docId] : [...new Set((await allSnapshotRows()).map((r) => infoOf(r).docId))]
  for (const id of ids) {
    const rows = await db.backups.where('reason').equals(reasonOf(id)).sortBy('createdAt')
    if (rows.length > keep) {
      await db.backups.bulkDelete(rows.slice(0, rows.length - keep).map((r) => r.id))
      removed += rows.length - keep
    }
  }
  const all = (await allSnapshotRows()).sort((a, b) => a.createdAt - b.createdAt)
  let total = all.reduce((n, r) => n + (r.data?.size ?? 0), 0)
  const drop: string[] = []
  for (const r of all) {
    if (total <= SNAP_TOTAL_BYTES) break
    total -= r.data?.size ?? 0
    drop.push(r.id)
  }
  if (drop.length) await db.backups.bulkDelete(drop)
  return removed + drop.length
}

const allSnapshotRows = () => db.backups.where('reason').startsWith(PREFIX).toArray()

/** 그 노트의 스냅샷 (최신이 먼저) */
export async function listSnapshots(docId: ID): Promise<SnapshotInfo[]> {
  const rows = await db.backups.where('reason').equals(reasonOf(docId)).toArray()
  return rows.map(infoOf).sort((a, b) => b.at - a.at)
}

export async function loadSnapshot(id: string): Promise<DocFileV1> {
  const row = await db.backups.get(id)
  if (!row) throw new Error('그 스냅샷을 찾을 수 없습니다.')
  return gunzipJson<DocFileV1>(row.data)
}

export async function deleteSnapshots(ids: string[]): Promise<void> {
  await db.backups.bulkDelete(ids)
}

/** 스냅샷 사용량 — 보관함 관리 화면 */
export async function snapshotUsage(): Promise<{ count: number; bytes: number; docs: number }> {
  const rows = await allSnapshotRows()
  return { count: rows.length, bytes: rows.reduce((n, r) => n + (r.data?.size ?? 0), 0), docs: new Set(rows.map((r) => infoOf(r).docId)).size }
}

export async function clearSnapshots(): Promise<number> {
  const ids = (await allSnapshotRows()).map((r) => r.id)
  await db.backups.bulkDelete(ids)
  return ids.length
}
