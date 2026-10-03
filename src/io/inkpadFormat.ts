// 자체 포맷 (FR-IO-06/07): .inkpad = zip { manifest.json, documents/<id>/{document.json, pages.json, blocks.json, chunks/<pageId>/<key>.json}, assets/<id> }
// 전체 백업도 같은 구조에 문서가 여러 개 들어간다.
// blocks.json은 선택 파일이다(블록이 있을 때만 쓴다) — FORMAT_VERSION을 올리지 않고도 옛 버전 앱이 무시하고 가져올 수 있다.
import { unzip, zip, strFromU8, strToU8, type Unzipped, type Zippable } from 'fflate'
import { BLOCK_SCHEMA_VERSION, SCHEMA_VERSION, type Asset, type Block, type DocumentMeta, type Folder, type ID, type Page } from '../shared/model'
import { ulid } from '../shared/ulid'
import { normalizeBlockUrl } from '../engine/blocks'
import { db } from '../storage/db'
import { assertNotTooNew } from '../storage/migrate'
import { listFolders, loadDocument, putAsset, saveBatch, type ChunkData } from '../storage/repo'
import { tryEnsureAssetLocal } from '../sync/assets'

const FORMAT = 'inkpad'
const FORMAT_VERSION = 1

interface Manifest {
  format: typeof FORMAT
  formatVersion: number
  schemaVersion: number
  /** blocks.json의 스키마 버전 (BLOCK_SCHEMA_VERSION). 옛 파일엔 없다 */
  blockSchemaVersion?: number
  kind: 'document' | 'backup'
  createdAt: number
  app: string
  documents: ID[]
  assets: (Asset & { file: string })[]
  folders?: Folder[]
}

const zipAsync = (data: Zippable) =>
  new Promise<Uint8Array>((res, rej) => zip(data, { level: 6 }, (e, d) => (e ? rej(e) : res(d))))
const unzipAsync = (data: Uint8Array) => new Promise<Unzipped>((res, rej) => unzip(data, (e, d) => (e ? rej(e) : res(d))))
const json = (v: unknown) => strToU8(JSON.stringify(v))

export async function exportInkpad(documentIds: ID[], kind: 'document' | 'backup', onProgress?: (d: number, t: number) => void): Promise<Blob> {
  const files: Zippable = {}
  const assetIds = new Set<ID>()
  let i = 0
  for (const id of documentIds) {
    const { doc, pages, chunks, blocks } = await loadDocument(id)
    const base = `documents/${id}/`
    const { lastView: _lv, ...docOut } = doc
    void _lv
    files[base + 'document.json'] = json(docOut)
    files[base + 'pages.json'] = json(pages)
    // 살아 있는 블록만 담는다 (tombstone 제외). 블록이 1개 이상일 때만 파일을 쓴다
    if (blocks.length) files[base + 'blocks.json'] = json(blocks)
    for (const c of chunks) {
      if (!c.elements.length) continue
      files[`${base}chunks/${c.pageId}/${c.key}.json`] = json(c.elements)
    }
    for (const p of pages) if (p.pdf) assetIds.add(p.pdf.assetId)
    onProgress?.(++i, documentIds.length)
  }
  const assets: Manifest['assets'] = []
  for (const aid of assetIds) {
    const a = await db.assets.get(aid)
    if (!a) continue
    // 지연 로딩: 이 기기에 원본이 없으면 받아서 백업에 포함한다
    const src = a.blob ?? (await tryEnsureAssetLocal(a.id))
    if (!src) continue
    const file = `assets/${aid}`
    // PDF는 이미 압축되어 있으므로 zip 압축을 끈다
    files[file] = [new Uint8Array(await src.arrayBuffer()), { level: 0 }]
    const { blob: _b, ...meta } = a
    void _b
    assets.push({ ...meta, file })
  }
  const manifest: Manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    blockSchemaVersion: BLOCK_SCHEMA_VERSION,
    kind,
    createdAt: Date.now(),
    app: 'Inkpad web',
    documents: documentIds,
    assets,
    folders: kind === 'backup' ? await listFolders() : undefined
  }
  files['manifest.json'] = json(manifest)
  const bytes = await zipAsync(files)
  return new Blob([bytes as BlobPart], { type: 'application/zip' })
}

export interface ImportResult {
  documents: DocumentMeta[]
  skipped: number
  /** 스키마가 새 버전이거나 매핑되지 않아 건너뛴 블록 수 */
  skippedBlocks: number
}

/**
 * .inkpad / 백업 가져오기. 기존 데이터와 겹치지 않도록 항상 새 ID로 들여온다.
 * (같은 PDF는 SHA-256으로 기존 에셋을 재사용)
 */
export async function importInkpad(file: Blob, targetFolderId: ID | null, onProgress?: (d: number, t: number) => void): Promise<ImportResult> {
  const files = await unzipAsync(new Uint8Array(await file.arrayBuffer()))
  const mf = files['manifest.json']
  if (!mf) throw new Error('Inkpad 파일이 아닙니다 (manifest.json 없음).')
  const manifest = JSON.parse(strFromU8(mf)) as Manifest
  if (manifest.format !== FORMAT) throw new Error('Inkpad 파일이 아닙니다.')
  assertNotTooNew(manifest.schemaVersion)

  // 에셋: 해시가 같으면 기존 것 재사용
  const assetMap = new Map<ID, ID>()
  for (const a of manifest.assets) {
    const data = files[a.file]
    if (!data) continue
    const row = await putAsset(new Blob([data as BlobPart], { type: a.mime }), { kind: a.kind, mime: a.mime, name: a.name })
    assetMap.set(a.id, row.id)
  }

  // 폴더 (백업): 새 ID로 구조 복원
  const folderMap = new Map<ID, ID>()
  if (manifest.folders?.length) {
    const now = Date.now()
    const pending = [...manifest.folders]
    const rows: Folder[] = []
    for (const f of pending) folderMap.set(f.id, ulid())
    for (const f of pending) {
      rows.push({
        ...f,
        id: folderMap.get(f.id)!,
        parentId: f.parentId ? folderMap.get(f.parentId) ?? targetFolderId : targetFolderId,
        schemaVersion: SCHEMA_VERSION,
        categories: f.categories ?? [],
        createdAt: f.createdAt ?? now,
        updatedAt: now,
        version: 0,
        deletedAt: undefined
      })
    }
    // 폴더는 기기별 로컬 전용 — 동기화 큐에 넣지 않는다
    await db.transaction('rw', db.folders, async () => {
      await db.folders.bulkPut(rows)
    })
  }

  const out: DocumentMeta[] = []
  let skipped = 0
  let skippedBlocks = 0
  let i = 0
  for (const oldId of manifest.documents) {
    const base = `documents/${oldId}/`
    const dj = files[base + 'document.json']
    const pj = files[base + 'pages.json']
    if (!dj || !pj) {
      skipped++
      continue
    }
    const src = JSON.parse(strFromU8(dj)) as DocumentMeta
    const srcPages = JSON.parse(strFromU8(pj)) as Page[]
    assertNotTooNew(src.schemaVersion)
    const now = Date.now()
    const newId = ulid()
    const pageMap = new Map<ID, ID>()
    const pages: Page[] = srcPages.map((p) => {
      const id = ulid()
      pageMap.set(p.id, id)
      return {
        ...p,
        id,
        documentId: newId,
        pdf: p.pdf ? { ...p.pdf, assetId: assetMap.get(p.pdf.assetId) ?? p.pdf.assetId } : undefined,
        version: 0,
        updatedAt: now
      }
    })
    const doc: DocumentMeta = {
      ...src,
      id: newId,
      folderId: src.folderId && folderMap.has(src.folderId) ? folderMap.get(src.folderId)! : targetFolderId,
      category: src.category ?? null,
      schemaVersion: SCHEMA_VERSION,
      pageOrder: src.pageOrder.map((id) => pageMap.get(id)).filter((x): x is ID => !!x),
      version: 0,
      deletedAt: undefined,
      updatedAt: now
    }
    await db.transaction('rw', db.documents, db.pages, db.outbox, async () => {
      await db.documents.add(doc)
      await db.pages.bulkAdd(pages)
      await db.outbox.add({ entity: 'document', entityId: doc.id, op: 'upsert', createdAt: now, attempts: 0 })
      for (const p of pages) await db.outbox.add({ entity: 'page', entityId: p.id, op: 'upsert', createdAt: now, attempts: 0 })
    })
    const chunks: ChunkData[] = []
    const prefix = base + 'chunks/'
    for (const name of Object.keys(files)) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue
      const [oldPage, keyFile] = name.slice(prefix.length).split('/')
      const pageId = pageMap.get(oldPage)
      if (!pageId) continue
      chunks.push({ pageId, key: keyFile.replace(/\.json$/, ''), elements: JSON.parse(strFromU8(files[name])) })
    }
    // 블록: blocks.json이 없으면(블록 기능 이전 파일) 블록 없이 정상 처리한다
    const blocksFile = files[base + 'blocks.json']
    const blocks: Block[] = []
    if (blocksFile) {
      const rawBlocks = JSON.parse(strFromU8(blocksFile)) as Block[]
      if ((manifest.blockSchemaVersion ?? BLOCK_SCHEMA_VERSION) > BLOCK_SCHEMA_VERSION) {
        // 새 버전에서 만든 블록 — 문서는 가져오고 블록만 건너뛴다
        skippedBlocks += rawBlocks.filter((b) => !b.deletedAt).length
      } else {
        for (const b of rawBlocks) {
          if (b.deletedAt) continue
          const pageId = pageMap.get(b.pageId)
          if (!pageId) {
            skippedBlocks++
            continue
          }
          const nb = {
            ...b,
            id: ulid(),
            documentId: newId,
            pageId,
            schemaVersion: BLOCK_SCHEMA_VERSION,
            deletedAt: undefined,
            createdAt: b.createdAt ?? now,
            updatedAt: now
          } as Block
          if (nb.type === 'jump') nb.data = { ...nb.data, targetPageId: nb.data.targetPageId ? pageMap.get(nb.data.targetPageId) ?? null : null }
          if (nb.type === 'todo') nb.data = { items: nb.data.items.map((it) => ({ ...it, id: ulid() })) }
          if (nb.type === 'link') {
            const u = normalizeBlockUrl(nb.data.url)
            nb.data = { ...nb.data, url: u ?? '' } // 검증 실패 시 URL만 비운다(블록은 유지)
          }
          blocks.push(nb)
        }
      }
    }
    // 청크가 없고 블록만 있는 문서도 저장되도록 호출 조건을 넓힌다
    if (chunks.length || blocks.length) await saveBatch({ documentId: doc.id, chunks, blocksUpsert: blocks })
    out.push(doc)
    onProgress?.(++i, manifest.documents.length)
  }
  return { documents: out, skipped, skippedBlocks }
}
