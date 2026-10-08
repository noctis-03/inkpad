// 편집을 되돌리기(실행 취소)했을 때 '올리기 필요'를 내리는 판정.
// 편집은 저장될 때마다 올리기 대기(outbox)를 남긴다 — 되돌리기도 같은 길을 타므로
// 내용이 마지막 동기화 시점으로 돌아왔으면 대기를 치워야 노트가 '수정함'으로 남지 않는다
// (git의 "작업 사본이 HEAD와 같으면 변경 없음"에 해당).
import type { ID } from '../shared/model'
import { db } from '../storage/db'
import { loadBase } from './base'
import { packDocument, type DocFileV1 } from './pack'

/** 이 노트에 걸린 올리기 대기(outbox) 행의 seq 목록 */
async function pendingSeqsFor(docId: ID): Promise<number[]> {
  const rows = await db.outbox.toArray()
  const pageIds = new Set<ID>((await db.pages.where('documentId').equals(docId).toArray()).map((p) => p.id))
  const out: number[] = []
  for (const r of rows) {
    if (r.entity === 'document') {
      if (r.entityId === docId) out.push(r.seq!)
    } else if (r.entity === 'page') {
      if (pageIds.has(r.entityId)) out.push(r.seq!)
    } else if (r.entity === 'chunk') {
      const i = r.entityId.indexOf('|')
      if (pageIds.has(r.entityId.slice(0, i))) out.push(r.seq!)
    }
  }
  return out
}

/**
 * 비교용 표준형 — 저장할 때마다 다시 찍히는 기록(updatedAt)만 비우고 내용은 그대로 둔다.
 * 청크 배열은 (pageId·key)로, 블록·에셋은 id로 정돈한다(보관 순서는 비교에서 제외).
 * 페이지 배열 순서와 획의 z(쌓임)는 내용의 일부라 그대로 비교한다.
 */
function canonical(file: DocFileV1): string {
  return JSON.stringify({
    doc: { ...file.doc, updatedAt: 0 },
    pages: file.pages.map((p) => ({ ...p, updatedAt: 0 })),
    chunks: [...file.chunks]
      .map((c) => ({ pageId: c.pageId, key: c.key, elements: c.elements }))
      .sort((a, b) => (a.pageId === b.pageId ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.pageId < b.pageId ? -1 : 1)),
    blocks: [...(file.blocks ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((b) => ({ ...b, updatedAt: 0 })),
    assets: [...file.assets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
}

/**
 * 되돌리기로 내용이 마지막 동기화 스냅샷(base)과 같아졌으면 이 노트의 올리기 대기를 내린다.
 * 저장 직후(되돌리기 힌트)와 올리기 직전(남아 있는 대기 정리)의 이중 안전망으로 쓴다.
 * 문서 updatedAt도 동기화 시점 값으로 되돌려 둔다 — 클라우드 목록이 이 값으로
 * '최신'을 판정하기 때문이다 (listCloudNotes의 sameByContent).
 * @returns 대기를 실제로 내렸으면 true (호출한 쪽은 올리기를 건너뛴다)
 */
export async function clearPendingIfUnchanged(docId: ID, seqs?: number[]): Promise<boolean> {
  const s = seqs ?? (await pendingSeqsFor(docId))
  if (!s.length) return false
  const base = await loadBase(docId)
  if (!base) return false // 한 번도 올린 적 없는 노트 — 올려야 한다
  let file: DocFileV1
  try {
    file = await packDocument(docId)
  } catch {
    return false // 문서가 지워졌거나 읽지 못한다 — 판정은 보수적으로 (대기 유지)
  }
  if (canonical(base) !== canonical(file)) return false
  await db.transaction('rw', [db.documents, db.outbox], async () => {
    await db.outbox.bulkDelete(s)
    await db.documents.update(docId, { updatedAt: base.doc.updatedAt })
  })
  return true
}
