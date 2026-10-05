// Drive 파일 → 로컬 적용. sync.ts(동기화 엔진)와 revisions.ts(버전 되돌리기)가 함께 쓴다.
// 순환 import를 피하려고 분리했다.
import { SCHEMA_VERSION, type Block } from '../shared/model'
import { normalizeBlockUrl } from '../engine/blocks'
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
  await db.transaction('rw', [db.documents, db.pages, db.chunks, db.blocks, db.assets, db.outbox], async () => {
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
      // folderId는 로컬 전용 — 받은 파일에서 오지 않는다(옛 파일이 실어 보내도 무시)
      folderId: prev?.folderId ?? null,
      // category 없는 옛 파일이라면 이 기기의 값을 유지한다
      ...((file.doc as { category?: string | null }).category === undefined ? { category: prev?.category ?? null } : {}),
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
    // 편집 블록 — 파일에 blocks 필드가 있을 때만 교체한다(없으면 블록 기능 이전 클라이언트이므로 유지).
    // 원격에서 들어온 link URL도 직접 입력과 같은 검증을 거친다.
    if (file.blocks) {
      const pageIds = new Set(file.pages.map((pg) => pg.id))
      const blocks: Block[] = []
      for (const b of file.blocks) {
        if (!pageIds.has(b.pageId)) continue
        if (b.type === 'link') {
          const u = normalizeBlockUrl(b.data.url)
          blocks.push(u === null ? { ...b, data: { ...b.data, url: '' } } : { ...b, data: { ...b.data, url: u } })
        } else blocks.push(b)
      }
      await db.blocks.where('documentId').equals(docId).delete()
      if (blocks.length) await db.blocks.bulkPut(blocks)
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
