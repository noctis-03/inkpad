import { SCHEMA_VERSION, type Asset, type DocumentMeta, type Element, type Folder, type ID, type Page } from '../shared/model'
import { db } from '../storage/db'
import { loadDocument } from '../storage/repo'

// 문서 ↔ Drive JSON 파일 변환 (SDF 가이드의 "노트 1개 = 파일 1개"를
// inkpad에 맞춰 "문서 1개 = 파일 1개"로 적용한 것)
// - 문서 파일: 문서 메타 + 페이지 + 청크(획 = 디코드된 좌표 배열) + 참조 에셋 메타
// - 폴더 파일: 폴더 트리 전체 (tombstone 포함) — 다른 기기의 폴더 삭제 전파용
// - 에셋(PDF·이미지 원본): 문서 파일과 별도 바이너리 파일 (sha256 내용 주소)

export interface AssetMeta {
  id: ID
  kind: Asset['kind']
  mime: string
  size: number
  sha256: string
  name?: string
  createdAt: number
}

export interface DocFileV1 {
  kind: 'inkpad-doc'
  schemaVersion: 1
  doc: Omit<DocumentMeta, 'lastView' | 'version'>
  pages: Page[]
  chunks: { pageId: ID; key: string; elements: Element[] }[]
  assets: AssetMeta[]
}

export interface FoldersFileV1 {
  kind: 'inkpad-folders'
  schemaVersion: 1
  updatedAt: number // 가장 최근에 바뀐 폴더의 시각 (업로드 중 변경 감지용)
  folders: Folder[]
}

/** 문서를 Drive 파일로 직렬화. 문서가 없으면 예외. */
export async function packDocument(id: ID): Promise<DocFileV1> {
  const { doc, pages, chunks } = await loadDocument(id)
  const assetIds = new Set<ID>()
  for (const p of pages) if (p.pdf) assetIds.add(p.pdf.assetId)
  for (const c of chunks) {
    for (const e of c.elements) {
      if (e.type === 'image') assetIds.add(e.assetId)
    }
  }
  const assets: AssetMeta[] = []
  for (const aid of assetIds) {
    const row = await db.assets.get(aid)
    if (!row) continue // 에셋 행이 아직 없다 → 받아온 뒤 다음 동기화에서 올라간다
    const meta: AssetMeta = { id: row.id, kind: row.kind, mime: row.mime, size: row.size, sha256: row.sha256, name: row.name, createdAt: row.createdAt }
    assets.push(meta)
  }
  return {
    kind: 'inkpad-doc',
    schemaVersion: 1,
    doc: {
      id: doc.id,
      schemaVersion: doc.schemaVersion,
      title: doc.title,
      mode: doc.mode,
      folderId: doc.folderId,
      pageOrder: doc.pageOrder,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      ...(doc.deletedAt ? { deletedAt: doc.deletedAt } : {})
    },
    pages,
    chunks,
    assets
  }
}

/** 폴더 트리 전체 (삭제 tombstone 포함) */
export async function packFolders(): Promise<FoldersFileV1> {
  const folders = await db.folders.toArray()
  return {
    kind: 'inkpad-folders',
    schemaVersion: SCHEMA_VERSION,
    updatedAt: folders.reduce((m, f) => Math.max(m, f.updatedAt), 0),
    folders
  }
}

const EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg'
}

export const assetFileName = (sha256: string, mime: string) => `assets/${sha256}.${EXT[mime] ?? 'bin'}`
