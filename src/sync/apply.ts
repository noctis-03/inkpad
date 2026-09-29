// Drive 파일 → 로컬 적용. sync.ts(동기화 엔진)와 revisions.ts(버전 되돌리기)가 함께 쓴다.
// 순환 import를 피하려고 분리했다.
import { SCHEMA_VERSION } from '../shared/model'
import { gunzipJson, gzipJson } from '../storage/compress'
import { db } from '../storage/db'
import type { DocFileV1 } from './pack'

/**
 * Drive 파일을 로컬에 적용한다.
 * 그 사이에 로컬이 수정됐으면(outbox에 대기 중이면) 적용하지 않고 false를 돌려준다.
 * force = true면 대기 중이어도 덮어쓴다 (버전 되돌리기처럼 사용자가 명시적으로 요청한 경우).
 */
export async function applyDocFile(file: DocFileV1, opts: { force?: boolean } = {}): Promise<boolean> {
  const docId = file.doc.id
  const encoded: { c: DocFileV1['chunks'][number]; blob: Blob }[] = []
  for (const c of file.chunks) if (c.elements.length) encoded.push({ c, blob: await gzipJson(c.elements) })
  let applied = true
  await db.transaction('rw', [db.documents, db.pages, db.chunks, db.assets, db.outbox], async () => {
    if (!opts.force) {
      const pending = await db.outbox.where('[entity+entityId]').equals(['document', docId]).first()
      if (pending) {
        applied = false
        return
      }
    }
    const prev = await db.documents.get(docId)
    await db.documents.put({
      ...file.doc,
      version: prev?.version ?? 0,
      ...(prev?.lastView ? { lastView: prev.lastView } : {}) // 마지막으로 보던 위치는 로컬 전용
    })
    await db.pages.where('documentId').equals(docId).delete()
    await db.pages.bulkAdd(file.pages)
    await db.chunks.where('documentId').equals(docId).delete()
    for (const { c, blob } of encoded) {
      await db.chunks.put({
        pageId: c.pageId,
        key: c.key,
        documentId: docId,
        schemaVersion: SCHEMA_VERSION,
        data: blob,
        count: c.elements.length,
        version: 0,
        localRev: 1,
        updatedAt: file.doc.updatedAt
      })
    }
    for (const am of file.assets) {
      if (!(await db.assets.get(am.id))) await db.assets.put({ ...am, version: 0 }) // 원본 blob은 지연 로딩이 받는다
    }
  })
  // 되돌리기로 덮어쓴 뒤에는 참조가 사라진 에셋을 정리한다
  if (applied && opts.force) await gcUnusedAssets()
  return applied
}

async function gcUnusedAssets() {
  const used = new Set<string>()
  await db.pages.each((p) => {
    if (p.pdf) used.add(p.pdf.assetId)
  })
  const all = await db.assets.toCollection().primaryKeys()
  const orphan = all.filter((id) => !used.has(id))
  if (orphan.length) await db.assets.bulkDelete(orphan)
}

export { gunzipJson }
