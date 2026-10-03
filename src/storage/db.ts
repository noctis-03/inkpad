import Dexie, { type Table } from 'dexie'
import type { Asset, Block, DocumentMeta, Folder, HtmlApp, ID, Page } from '../shared/model'

/** IndexedDB 레코드 (설계 8장) */
export interface ChunkRow {
  pageId: ID
  key: string
  documentId: ID
  schemaVersion: number
  data: Blob // gzip(JSON Element[])
  count: number // 요소 수 (목록 표시/통계용)
  version: number // 서버 기준 버전
  localRev: number // 로컬에서 바뀔 때마다 +1
  updatedAt: number
  deletedAt?: number
}

export interface AssetRow extends Asset {
  blob?: Blob // 없으면 아직 받지 않음(클라우드에만 있음)
}

export interface ThumbRow {
  documentId: ID
  blob: Blob
  updatedAt: number
}

export type OutboxEntity = 'document' | 'page' | 'chunk' | 'asset'

export interface OutboxRow {
  seq?: number // 자동 증가
  entity: OutboxEntity
  entityId: string // chunk는 "pageId|key"
  op: 'upsert' | 'delete'
  createdAt: number
  attempts: number
}

export interface KV {
  key: string
  value: unknown
}

export class InkpadDB extends Dexie {
  folders!: Table<Folder, ID>
  documents!: Table<DocumentMeta, ID>
  pages!: Table<Page, ID>
  chunks!: Table<ChunkRow, [ID, string]>
  assets!: Table<AssetRow, ID>
  thumbnails!: Table<ThumbRow, ID>
  outbox!: Table<OutboxRow, number>
  syncState!: Table<KV, string>
  settings!: Table<KV, string>
  blocks!: Table<Block, ID>
  backups!: Table<{ id: string; createdAt: number; reason: string; data: Blob }, string>
  apps!: Table<HtmlApp, ID>
  appStorage!: Table<{ appId: ID; data: Record<string, string> }, ID>

  constructor(name = 'inkpad') {
    super(name)
    this.version(1).stores({
      folders: 'id, parentId, updatedAt, deletedAt',
      documents: 'id, folderId, updatedAt, deletedAt',
      pages: 'id, documentId',
      chunks: '[pageId+key], pageId, documentId',
      assets: 'id, &sha256',
      thumbnails: 'documentId',
      outbox: '++seq, [entity+entityId]',
      syncState: 'key',
      settings: 'key',
      backups: 'id, createdAt'
    })
    // v2: 폴더 설정 백업 보존 관리용 reason 인덱스 (나머지 테이블은 v1을 상속한다)
    this.version(2).stores({ backups: 'id, createdAt, reason' })
    // v3: 편집 블록 (PDF 내보내기 제외 — chunks와 절대 섞지 않는 별도 테이블)
    this.version(3).stores({ blocks: 'id, documentId, pageId, deletedAt' })
    // v4: HTML 앱 + 앱별 localStorage 대용 저장소(로컬 전용, 동기화하지 않음)
    this.version(4).stores({ apps: 'id, updatedAt', appStorage: 'appId' })
  }
}

export const db = new InkpadDB()
