// 버전 기록 — 커밋 이력을 그대로 쓴다.
//
// 이 동기화 방식에서는 문서를 올릴 때마다 그 시점의 스냅샷이 커밋으로 남는다.
// 그 문서를 건드린 커밋 목록 = 버전 기록이고, 아무 커밋이든 꺼내 되돌릴 수 있다.
// 커밋 메시지에는 올린 기기 이름이 들어간다. (오래된 스냅샷은 각 문서의 최신
// 스냅샷을 남기고 365일 뒤 정리된다 — 그때까지의 버전은 언제든 복구 가능)
//
// 순환 import를 피하려고 sync.ts의 커밋 캐시만 빌려 쓴다. 되돌리기 후 업로드는 UI가 syncNow()로 처리한다.
import type { ID } from '../shared/model'
import { db } from '../storage/db'
import { enqueue } from '../storage/repo'
import { applyDocFile } from './apply'
import * as drive from './drive'
import { getCommitCache } from './sync'
import type { DocFileV1 } from './pack'

export interface DocRevision {
  id: string // 커밋 ID
  modifiedTime: string // ISO 8601
  message: string
  author: string // 올린 기기 이름
  isHead: boolean
}

/** 이 문서의 버전 기록 (최신이 마지막) */
export async function listDocRevisions(docId: ID): Promise<DocRevision[]> {
  const cache = await getCommitCache()
  const list = Object.values(cache)
    .filter((c) => c.changes.some((ch) => ch.kind === 'doc' && ch.docId === docId))
    .sort((a, b) => a.id.localeCompare(b.id))
  return list.map((c, i) => ({
    id: c.id,
    modifiedTime: new Date(c.time).toISOString(),
    message: c.message,
    author: c.deviceName,
    isHead: i === list.length - 1
  }))
}

/**
 * 버전 되돌리기: 그 커밋 시점의 스냅샷을 이 기기에 적용하고 업로드 대기열에 올린다.
 * 실제 반영은 다음 올리기에서 일어나므로, 호출한 쪽에서 syncNow()를 이어서 부르면 된다.
 */
export async function restoreDocRevision(docId: ID, commitId: string): Promise<void> {
  const cache = await getCommitCache()
  const c = cache[commitId]
  if (!c) throw new Error('그 버전의 기록을 찾을 수 없습니다. 받기를 실행한 뒤 다시 시도해 주세요.')
  const ch = c.changes.find((x) => x.kind === 'doc' && x.docId === docId)
  if (!ch) throw new Error('그 커밋에는 이 문서의 기록이 없습니다.')
  if (ch.deleted) throw new Error('그 버전은 삭제된 시점입니다.')
  if (!ch.fileId) throw new Error('그 버전의 스냅샷이 정리되었습니다.')
  const meta = await drive.getMeta(ch.fileId)
  if (!meta || meta.trashed) throw new Error('그 버전의 스냅샷이 정리되었습니다. (365일 경과)')
  const file = await drive.downloadJson<DocFileV1>(ch.fileId, meta.appProperties?.enc)
  if (file?.kind !== 'inkpad-doc') throw new Error('그 버전을 읽을 수 없습니다.')
  // 문서 ID는 그대로 유지하고 수정 시각만 갱신한다 (사본을 만들지 않는다)
  const payload: DocFileV1 = { ...file, doc: { ...file.doc, id: docId, updatedAt: Date.now() } }
  await applyDocFile(payload, { force: true })
  await db.transaction('rw', db.outbox, async () => {
    await enqueue('document', docId)
  })
}
