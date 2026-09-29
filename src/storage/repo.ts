// 로컬 저장소 (설계 8장). 모든 쓰기는 같은 트랜잭션에서 outbox에 기록한다 (Phase 2 동기화용).
import {
  PAGE_CHUNK_KEY,
  SCHEMA_VERSION,
  TRASH_RETENTION_DAYS,
  makeBackground,
  type Asset,
  type Background,
  type DocumentMeta,
  type Element,
  type Folder,
  type ID,
  type Page
} from '../shared/model'
import { ulid } from '../shared/ulid'
import { sha256Hex } from '../shared/util'
import { gunzipJson, gzipJson } from './compress'
import { db, type AssetRow, type ChunkRow, type OutboxEntity } from './db'
import { assertNotTooNew, migrateElements, needsMigration } from './migrate'

// ───────────────────────── outbox ─────────────────────────

/** 같은 엔티티가 이미 대기 중이면 하나로 합친다 (설계 8장 3). 반드시 트랜잭션 안에서 호출. */
export async function enqueue(entity: OutboxEntity, entityId: string, op: 'upsert' | 'delete' = 'upsert') {
  const existing = await db.outbox.where('[entity+entityId]').equals([entity, entityId]).first()
  if (existing) {
    if (existing.op !== op) await db.outbox.update(existing.seq!, { op, createdAt: Date.now() })
  } else {
    await db.outbox.add({ entity, entityId, op, createdAt: Date.now(), attempts: 0 })
  }
}

export async function outboxCount() {
  return db.outbox.count()
}

// ───────────────────────── folders ─────────────────────────

export async function listFolders(): Promise<Folder[]> {
  const all = await db.folders.toArray()
  return all.filter((f) => !f.deletedAt).sort((a, b) => a.name.localeCompare(b.name, 'ko'))
}

export async function createFolder(name: string, parentId: ID | null): Promise<Folder> {
  const now = Date.now()
  const f: Folder = { id: ulid(), schemaVersion: SCHEMA_VERSION, name, parentId, createdAt: now, updatedAt: now, version: 0 }
  await db.transaction('rw', db.folders, db.outbox, async () => {
    await db.folders.add(f)
    await enqueue('folder', f.id)
  })
  return f
}

export async function updateFolder(id: ID, patch: Partial<Pick<Folder, 'name' | 'parentId'>>) {
  await db.transaction('rw', db.folders, db.outbox, async () => {
    await db.folders.update(id, { ...patch, updatedAt: Date.now() })
    await enqueue('folder', id)
  })
}

/** 폴더 삭제: 하위 폴더도 삭제하고, 안에 있던 문서는 휴지통으로 보낸다 */
export async function deleteFolder(id: ID) {
  const all = await db.folders.toArray()
  const ids = new Set<ID>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const f of all) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) (ids.add(f.id), (grew = true))
  }
  const now = Date.now()
  await db.transaction('rw', db.folders, db.documents, db.outbox, async () => {
    for (const fid of ids) {
      await db.folders.update(fid, { deletedAt: now, updatedAt: now })
      await enqueue('folder', fid, 'delete')
    }
    const docs = await db.documents.where('folderId').anyOf([...ids]).toArray()
    for (const d of docs) {
      if (d.deletedAt) continue
      await db.documents.update(d.id, { deletedAt: now, folderId: null, updatedAt: now })
      await enqueue('document', d.id, 'delete')
    }
  })
}

// ───────────────────────── documents ─────────────────────────

export async function listDocuments(opts: { trash?: boolean } = {}): Promise<DocumentMeta[]> {
  const all = await db.documents.toArray()
  return all.filter((d) => (opts.trash ? !!d.deletedAt : !d.deletedAt))
}

export async function getDocument(id: ID) {
  return db.documents.get(id)
}

export interface NewPageSpec {
  size: { w: number; h: number } | null
  background: Background
  pdf?: Page['pdf']
}

export function makePage(documentId: ID, spec: NewPageSpec): Page {
  const now = Date.now()
  return {
    id: ulid(),
    documentId,
    schemaVersion: SCHEMA_VERSION,
    size: spec.size,
    background: spec.background,
    pdf: spec.pdf,
    createdAt: now,
    updatedAt: now,
    version: 0
  }
}

export async function createDocument(opts: {
  title: string
  mode: 'infinite' | 'paged'
  folderId: ID | null
  pages: NewPageSpec[]
}): Promise<DocumentMeta> {
  const now = Date.now()
  const id = ulid()
  const specs = opts.mode === 'infinite' ? [{ size: null, background: opts.pages[0]?.background ?? makeBackground('dot') }] : opts.pages
  const pages = specs.map((s) => makePage(id, s))
  const doc: DocumentMeta = {
    id,
    schemaVersion: SCHEMA_VERSION,
    title: opts.title,
    mode: opts.mode,
    folderId: opts.folderId,
    pageOrder: pages.map((p) => p.id),
    createdAt: now,
    updatedAt: now,
    version: 0
  }
  await db.transaction('rw', db.documents, db.pages, db.outbox, async () => {
    await db.documents.add(doc)
    await db.pages.bulkAdd(pages)
    await enqueue('document', id)
    for (const p of pages) await enqueue('page', p.id)
  })
  return doc
}

export async function updateDocument(id: ID, patch: Partial<Omit<DocumentMeta, 'id'>>, opts: { touch?: boolean; sync?: boolean } = {}) {
  const { touch = true, sync = true } = opts
  await db.transaction('rw', db.documents, db.outbox, async () => {
    await db.documents.update(id, touch ? { ...patch, updatedAt: Date.now() } : patch)
    if (sync) await enqueue('document', id)
  })
}

/** 마지막으로 보던 위치 (로컬 전용, 동기화 안 함) */
export async function saveLastView(id: ID, view: DocumentMeta['lastView']) {
  await db.documents.update(id, { lastView: view })
}

export async function trashDocument(id: ID) {
  await db.transaction('rw', db.documents, db.outbox, async () => {
    const now = Date.now()
    await db.documents.update(id, { deletedAt: now, updatedAt: now })
    await enqueue('document', id, 'delete')
  })
}

export async function restoreDocument(id: ID) {
  const folders = new Set((await listFolders()).map((f) => f.id))
  await db.transaction('rw', db.documents, db.outbox, async () => {
    const d = await db.documents.get(id)
    if (!d) return
    // 원래 폴더가 없어졌으면 최상위로
    const folderId = d.folderId && folders.has(d.folderId) ? d.folderId : null
    await db.documents.update(id, { deletedAt: undefined, folderId, updatedAt: Date.now() })
    await enqueue('document', id)
  })
}

/** 영구 삭제 (로컬). 어떤 문서도 참조하지 않는 에셋도 함께 지운다 */
export async function purgeDocument(id: ID) {
  await db.transaction('rw', [db.documents, db.pages, db.chunks, db.thumbnails, db.outbox], async () => {
    await db.documents.delete(id)
    await db.pages.where('documentId').equals(id).delete()
    await db.chunks.where('documentId').equals(id).delete()
    await db.thumbnails.delete(id)
    await enqueue('document', id, 'delete')
  })
  await gcAssets()
}

export async function purgeExpiredTrash() {
  const limit = Date.now() - TRASH_RETENTION_DAYS * 86400_000
  const expired = (await db.documents.toArray()).filter((d) => d.deletedAt && d.deletedAt < limit)
  for (const d of expired) await purgeDocument(d.id)
  return expired.length
}

async function gcAssets() {
  const used = new Set<ID>()
  await db.pages.each((p) => {
    if (p.pdf) used.add(p.pdf.assetId)
  })
  const all = await db.assets.toCollection().primaryKeys()
  const orphan = all.filter((id) => !used.has(id))
  if (orphan.length) await db.assets.bulkDelete(orphan)
}

// ───────────────────────── pages ─────────────────────────

export async function getPages(documentId: ID): Promise<Page[]> {
  return db.pages.where('documentId').equals(documentId).toArray()
}

// ───────────────────────── chunks ─────────────────────────

export interface ChunkData {
  pageId: ID
  key: string
  elements: Element[]
}

async function decodeChunk(row: ChunkRow): Promise<Element[]> {
  assertNotTooNew(row.schemaVersion)
  const raw = await gunzipJson<unknown[]>(row.data)
  return needsMigration(row.schemaVersion) ? migrateElements(raw, row.schemaVersion) : (raw as Element[])
}

export interface LoadedDocument {
  doc: DocumentMeta
  pages: Page[] // pageOrder 순서, 삭제된 페이지 제외
  chunks: ChunkData[]
}

export async function loadDocument(id: ID): Promise<LoadedDocument> {
  const doc = await db.documents.get(id)
  if (!doc) throw new Error('문서를 찾을 수 없습니다.')
  assertNotTooNew(doc.schemaVersion)
  const pagesAll = await getPages(id)
  const byId = new Map(pagesAll.map((p) => [p.id, p]))
  const pages: Page[] = []
  for (const pid of doc.pageOrder) {
    const p = byId.get(pid)
    if (p && !p.deletedAt) pages.push(p)
  }
  const live = new Set(pages.map((p) => p.id))
  const rows = (await db.chunks.where('documentId').equals(id).toArray()).filter((r) => live.has(r.pageId) && !r.deletedAt)
  // 오래된 스키마는 마이그레이션 전에 원본을 백업한다 (16.4)
  const old = rows.filter((r) => needsMigration(r.schemaVersion))
  if (old.length) await backupRows(id, old)
  const chunks: ChunkData[] = []
  for (const r of rows) chunks.push({ pageId: r.pageId, key: r.key, elements: await decodeChunk(r) })
  return { doc, pages, chunks }
}

async function backupRows(documentId: ID, rows: ChunkRow[]) {
  const payload = rows.map((r) => ({ ...r, data: undefined }))
  const blob = new Blob([JSON.stringify(payload)])
  await db.backups.put({ id: `${documentId}:${Date.now()}`, createdAt: Date.now(), reason: 'pre-migration', data: blob })
}

export async function loadPageChunks(pageId: ID): Promise<ChunkData[]> {
  const rows = (await db.chunks.where('pageId').equals(pageId).toArray()).filter((r) => !r.deletedAt)
  const out: ChunkData[] = []
  for (const r of rows) out.push({ pageId: r.pageId, key: r.key, elements: await decodeChunk(r) })
  return out
}

export interface SaveBatch {
  documentId: ID
  doc?: Partial<DocumentMeta> // pageOrder 등
  pagesUpsert?: Page[]
  pagesDelete?: ID[] // soft delete
  chunks?: ChunkData[] // 빈 elements = 청크 삭제
}

/** 문서 편집 결과를 한 트랜잭션으로 기록 (반쯤 쓰인 데이터가 남지 않는다, 16.4) */
export async function saveBatch(b: SaveBatch) {
  // 압축은 트랜잭션 밖에서 (IndexedDB 트랜잭션은 await 중 비동기 작업이 끼면 자동 커밋될 수 있다)
  const encoded: { c: ChunkData; blob: Blob | null }[] = []
  for (const c of b.chunks ?? []) encoded.push({ c, blob: c.elements.length ? await gzipJson(c.elements) : null })
  const now = Date.now()
  await db.transaction('rw', [db.documents, db.pages, db.chunks, db.outbox], async () => {
    if (b.pagesUpsert) {
      for (const p of b.pagesUpsert) {
        await db.pages.put({ ...p, deletedAt: undefined, updatedAt: now })
        await enqueue('page', p.id)
      }
    }
    if (b.pagesDelete) {
      for (const id of b.pagesDelete) {
        await db.pages.update(id, { deletedAt: now, updatedAt: now })
        await enqueue('page', id, 'delete')
      }
    }
    for (const { c, blob } of encoded) {
      const key: [ID, string] = [c.pageId, c.key]
      const prev = await db.chunks.get(key)
      const entityId = `${c.pageId}|${c.key}`
      if (!blob) {
        if (prev && !prev.deletedAt) {
          await db.chunks.update(key, { deletedAt: now, updatedAt: now, count: 0, localRev: prev.localRev + 1 })
          await enqueue('chunk', entityId, 'delete')
        }
        continue
      }
      await db.chunks.put({
        pageId: c.pageId,
        key: c.key,
        documentId: b.documentId,
        schemaVersion: SCHEMA_VERSION,
        data: blob,
        count: c.elements.length,
        version: prev?.version ?? 0,
        localRev: (prev?.localRev ?? 0) + 1,
        updatedAt: now
      })
      await enqueue('chunk', entityId)
    }
    await db.documents.update(b.documentId, { ...(b.doc ?? {}), updatedAt: now })
    await enqueue('document', b.documentId)
  })
}

// ───────────────────────── assets ─────────────────────────

/** 같은 내용(SHA-256)이면 기존 에셋을 재사용한다 (14.1) */
export async function putAsset(blob: Blob, meta: { kind: Asset['kind']; mime: string; name?: string }): Promise<AssetRow> {
  const buf = await blob.arrayBuffer()
  const sha256 = await sha256Hex(buf)
  const existing = await db.assets.where('sha256').equals(sha256).first()
  if (existing) {
    if (!existing.blob) await db.assets.update(existing.id, { blob })
    return { ...existing, blob }
  }
  const row: AssetRow = {
    id: ulid(),
    kind: meta.kind,
    mime: meta.mime,
    size: blob.size,
    sha256,
    name: meta.name,
    createdAt: Date.now(),
    version: 0,
    blob
  }
  await db.transaction('rw', db.assets, db.outbox, async () => {
    await db.assets.add(row)
    await enqueue('asset', row.id)
  })
  return row
}

export async function getAsset(id: ID) {
  return db.assets.get(id)
}

// ───────────────────────── thumbnails ─────────────────────────

export async function putThumbnail(documentId: ID, blob: Blob) {
  await db.thumbnails.put({ documentId, blob, updatedAt: Date.now() })
}

export async function getThumbnails(): Promise<Map<ID, Blob>> {
  const rows = await db.thumbnails.toArray()
  return new Map(rows.map((r) => [r.documentId, r.blob]))
}

// ───────────────────────── 복제 / 통계 ─────────────────────────

export async function duplicateDocument(id: ID): Promise<DocumentMeta> {
  const src = await loadDocument(id)
  const now = Date.now()
  const newId = ulid()
  const pageMap = new Map<ID, ID>()
  const pages = src.pages.map((p) => {
    const np = { ...p, id: ulid(), documentId: newId, createdAt: now, updatedAt: now, version: 0 }
    pageMap.set(p.id, np.id)
    return np
  })
  const doc: DocumentMeta = {
    ...src.doc,
    id: newId,
    title: `${src.doc.title} 사본`,
    pageOrder: pages.map((p) => p.id),
    createdAt: now,
    updatedAt: now,
    version: 0,
    deletedAt: undefined
  }
  await db.transaction('rw', db.documents, db.pages, db.outbox, async () => {
    await db.documents.add(doc)
    await db.pages.bulkAdd(pages)
    await enqueue('document', doc.id)
    for (const p of pages) await enqueue('page', p.id)
  })
  const chunks = src.chunks.map((c) => ({
    pageId: pageMap.get(c.pageId)!,
    key: c.key,
    elements: c.elements.map((e) => ({ ...e, id: ulid() }))
  }))
  await saveBatch({ documentId: doc.id, chunks })
  return doc
}

export async function storageStats() {
  const est = (await navigator.storage?.estimate?.()) ?? {}
  const persisted = (await navigator.storage?.persisted?.()) ?? false
  const [docs, pages, chunks, assets, pending] = await Promise.all([
    db.documents.count(),
    db.pages.count(),
    db.chunks.count(),
    db.assets.toArray(),
    db.outbox.count()
  ])
  const assetBytes = assets.reduce((s, a) => s + (a.blob ? a.size : 0), 0)
  return { usage: est.usage ?? 0, quota: est.quota ?? 0, persisted, docs, pages, chunks, assets: assets.length, assetBytes, pending }
}

export { PAGE_CHUNK_KEY }
