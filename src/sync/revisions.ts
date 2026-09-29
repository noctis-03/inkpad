// 버전 기록(리비전) 관리 — 충돌 사본 대신 Drive의 리비전을 쓴다.
//
// 충돌 해소 규칙(사용자 결정):
//   - 원격(다른 기기) 버전이 그 문서의 헤드가 된다.
//   - 이 기기의 편집은 "고정 리비전(keepForever)"으로 보존한다 → 문서가 복제되지 않는다.
//   - 리비전 고정에 실패하면(200개 한도 등) 예전 방식대로 "(충돌 사본)" 문서를 만든다. 데이터를 잃지 않기 위한 안전망.
//
// 순환 import를 피하려고 sync.ts를 import하지 않는다. 되돌리기 후 업로드는 UI가 syncNow()로 처리한다.
import type { ID } from '../shared/model'
import { gzipJson } from '../storage/compress'
import { db } from '../storage/db'
import { enqueue } from '../storage/repo'
import { applyDocFile } from './apply'
import * as drive from './drive'
import { ensureFolders, getSync, putSync, type FileRecord } from './folders'
import type { DocFileV1 } from './pack'

export interface DocRevision {
  id: string
  modifiedTime: string
  size: number
  keepForever: boolean
  isHead: boolean
}

/** 이 문서의 클라우드 파일 위치 */
async function fileRecordOf(docId: ID): Promise<FileRecord> {
  const rec = await getSync<FileRecord>(`doc:${docId}`)
  if (!rec?.fileId) {
    throw new Error('이 문서의 클라우드 위치를 아직 모릅니다. 먼저 "동기화"를 실행해 주세요.')
  }
  return rec
}

/** 이 문서의 버전 기록 (최신이 마지막) */
export async function listDocRevisions(docId: ID): Promise<DocRevision[]> {
  const rec = await fileRecordOf(docId)
  const revs = await drive.listRevisions(rec.fileId)
  return revs.map((r, i) => ({
    id: r.id,
    modifiedTime: r.modifiedTime,
    size: Number(r.size ?? 0) || 0,
    keepForever: !!r.keepForever,
    isHead: i === revs.length - 1
  }))
}

export async function pinDocRevision(docId: ID, revisionId: string): Promise<void> {
  const rec = await fileRecordOf(docId)
  await drive.setKeepForever(rec.fileId, revisionId, true)
}

/**
 * 고정 해제 — Drive는 keepForever를 false로 되돌리는 것을 허용하지 않는다(400
 * illegalKeepForeverModification). 그래서 그 버전 내용을 새 헤드 리비전으로 다시
 * 올린 뒤(내용은 그대로 남는다) 고정 리비전을 삭제하는 방식으로 흉내 낸다.
 */
export async function unpinDocRevision(docId: ID, revisionId: string): Promise<void> {
  const rec = await fileRecordOf(docId)
  const file = await drive.downloadRevision<DocFileV1>(rec.fileId, revisionId)
  if (file?.kind !== 'inkpad-doc') throw new Error('그 버전을 읽을 수 없습니다.')
  // 파일의 표식(제목·기기 등)은 그대로 유지한다
  const meta = await drive.getMeta(rec.fileId)
  const appProperties = { ...(meta?.appProperties ?? {}), docId, enc: drive.ENC_GZIP }
  const { docs } = await ensureFolders()
  const result = await drive.upload(
    await gzipJson(file),
    { name: `docs/${docId}.json`, mimeType: 'application/json', appProperties },
    docs,
    rec.fileId
  )
  await putSync(`doc:${docId}`, { fileId: result.id, version: result.version })
  try {
    await drive.deleteRevision(rec.fileId, revisionId) // 이제 마지막 리비전이 아니므로 삭제 가능
  } catch (e) {
    console.warn('[sync] 고정 리비전 삭제 실패 — 해제는 됐지만 고정이 남아 있다:', e)
  }
}

export async function deleteDocRevision(docId: ID, revisionId: string): Promise<void> {
  const rec = await fileRecordOf(docId)
  await drive.deleteRevision(rec.fileId, revisionId)
}

/**
 * 버전 되돌리기: 그 시점 내용을 이 기기에 적용하고 업로드 대기열에 올린다.
 * 실제 반영은 다음 동기화에서 일어나므로, 호출한 쪽에서 syncNow()를 이어서 부르면 된다.
 */
export async function restoreDocRevision(docId: ID, revisionId: string): Promise<void> {
  const rec = await fileRecordOf(docId)
  // 내려받으려면 먼저 "영구 보존"으로 표시해야 한다 (Drive 규칙)
  const revs = await drive.listRevisions(rec.fileId)
  const target = revs.find((r) => r.id === revisionId)
  if (!target) throw new Error('그 버전을 찾을 수 없습니다. 목록을 새로 고쳐 주세요.')
  if (!target.keepForever) await drive.setKeepForever(rec.fileId, revisionId, true)

  const file = await drive.downloadRevision<DocFileV1>(rec.fileId, revisionId)
  if (file?.kind !== 'inkpad-doc') throw new Error('그 버전을 읽을 수 없습니다.')
  // 문서 ID는 그대로 유지하고 수정 시각만 갱신한다 (사본을 만들지 않는다)
  const payload: DocFileV1 = { ...file, doc: { ...file.doc, id: docId, updatedAt: Date.now() } }
  await applyDocFile(payload, { force: true })
  await db.transaction('rw', db.outbox, async () => {
    await enqueue('document', docId)
  })
}

/**
 * 충돌 해소: 이 기기의 편집을 먼저 헤드로 올려 고정 리비전으로 만들고,
 * 그다음 원격(다른 기기) 버전을 다시 헤드로 되돌린다.
 * @returns 고정된 리비전 ID. 실패하면 null (호출한 쪽에서 예전 방식으로 대체)
 */
export async function preserveAsRevision(
  docId: ID,
  local: DocFileV1,
  remote: drive.RemoteFile,
  docsFolderId: string
): Promise<string | null> {
  const uploaded = await drive.upload(
    await gzipJson(local),
    {
      name: `docs/${docId}.json`,
      mimeType: 'application/json',
      appProperties: { docId, updatedAt: String(local.doc.updatedAt), enc: drive.ENC_GZIP }
    },
    docsFolderId,
    remote.id
  )
  const revs = await drive.listRevisions(uploaded.id)
  const newest = revs[revs.length - 1]
  if (!newest) return null
  try {
    await drive.setKeepForever(uploaded.id, newest.id, true)
    return newest.id
  } catch (e) {
    console.warn('[sync] 리비전 고정 실패 — 충돌 사본으로 대체합니다:', e)
    return null
  }
}
