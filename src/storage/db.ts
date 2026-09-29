import Dexie, { type Table } from 'dexie'
import type { Asset, DocumentMeta, Folder, ID, Page } from '../shared/model'

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
  backups!: Table<{ id: string; createdAt: number; reason: string; data: Blob }, string>

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
  }
}

export const db = new InkpadDB()
