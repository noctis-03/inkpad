import Dexie, { type Table } from 'dexie'
import type { Asset, Block, DocumentMeta, Folder, HtmlApp, ID, Page, StoredFile } from '../shared/model'

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

/** 일반 파일 행. text 종류는 `text`에, 그 외는 `blob`에 내용을 담는다.
 *  클라우드에서 메타만 받은 파일은 둘 다 비어 있고, 열 때 지연 로딩한다. */
export interface FileRow extends StoredFile {
  text?: string
  blob?: Blob
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
  files!: Table<FileRow, ID>

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
    // v5: 일반 파일 (임의 형식 — 노트·앱과 별개 테이블)
    this.version(5).stores({ files: 'id, updatedAt' })
  }
}

export const db = new InkpadDB()

export interface CacheClearResult {
  /** 지운 미리보기(썸네일) 개수 */
  thumbnails: number
  /** 지운 미리보기 바이트 합계 */
  thumbBytes: number
  /** 지운 서비스 워커 캐시 개수 */
  swCaches: number
}

/**
 * 캐시 삭제 — 노트·앱·파일·설정은 그대로 두고, 다시 만들 수 있는 것만 지운다.
 *  1) 미리보기(썸네일): 노트를 열거나 받을 때 다시 만들어진다
 *  2) 서비스 워커 Cache Storage: 다음 실행 때 다시 채워진다 (오프라인 캐시)
 * PDF 렌더 비트맵 캐시는 메모리 전용이라 이 기기 저장소에는 남지 않는다.
 */
export async function clearAppCaches(): Promise<CacheClearResult> {
  let thumbnails = 0
  let thumbBytes = 0
  const rows = await db.thumbnails.toArray()
  for (const r of rows) {
    thumbnails++
    thumbBytes += r.blob?.size ?? 0
  }
  if (thumbnails) await db.thumbnails.clear()

  let swCaches = 0
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys()
      swCaches = keys.length
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch {
    /* 캐시 저장소 차단 환경 */
  }
  return { thumbnails, thumbBytes, swCaches }
}

/** 로컬 초기화 — 이 기기의 모든 데이터(노트·앱·파일·설정·동기화 상태·백업)를 지운다. 클라우드는 건드리지 않는다 */
export async function wipeLocalData(): Promise<void> {
  await db.delete()
  try {
    localStorage.clear()
  } catch {
    /* 저장소 차단 환경 — DB 삭제만으로도 초기화다 */
  }
  try {
    sessionStorage.clear()
  } catch {
    /* 저장소 차단 환경 */
  }
}
