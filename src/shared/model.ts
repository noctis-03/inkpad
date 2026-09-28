// 설계 문서 7장 데이터 모델. 클라이언트 전체(엔진·저장소·내보내기)와 Phase 2 API가 공유한다.
export const SCHEMA_VERSION = 1

export type ID = string // ULID

export interface Folder {
  id: ID
  schemaVersion: number
  name: string
  parentId: ID | null
  createdAt: number
  updatedAt: number
  deletedAt?: number
  version: number // 서버 기준 버전 (0 = 아직 서버에 없음)
}

export interface ViewState {
  x: number
  y: number
  zoom: number
}

export interface DocumentMeta {
  id: ID
  schemaVersion: number
  title: string
  mode: 'infinite' | 'paged'
  folderId: ID | null
  pageOrder: ID[] // paged: 페이지 순서 / infinite: 페이지 1개
  createdAt: number
  updatedAt: number
  deletedAt?: number // 휴지통 (tombstone)
  version: number
  lastView?: ViewState // 로컬 전용: 마지막으로 보던 위치
}

export type Background =
  | { type: 'blank'; color: string }
  | { type: 'lined'; spacing: number; color: string }
  | { type: 'grid'; spacing: number; color: string }
  | { type: 'dot'; spacing: number; color: string }
  | { type: 'cornell'; spacing: number; color: string }

export type BackgroundType = Background['type']

export interface PdfRef {
  assetId: ID
  pageIndex: number // 0부터
  rotation: 0 | 90 | 180 | 270 // 사용자가 추가로 돌린 각도 (PDF 자체 회전은 pdf.js가 적용)
}

export interface Page {
  id: ID
  documentId: ID
  schemaVersion: number
  size: { w: number; h: number } | null // null = 무한 캔버스
  background: Background
  pdf?: PdfRef
  createdAt: number
  updatedAt: number
  deletedAt?: number
  version: number
}

/** 획 외곽선 파라미터. 나중에 설정을 바꿔도 이미 그린 획 모양이 변하지 않도록 획마다 저장한다. */
export interface StrokeOpts {
  thinning: number
  smoothing: number
  streamline: number
  simulatePressure: boolean
}

export interface BaseElement {
  id: ID
  layer: 'under' | 'main'
  z: number
  createdAt: number
}

export interface Stroke extends BaseElement {
  type: 'stroke'
  tool: 'pen' | 'pencil' | 'highlighter'
  color: string // #RRGGBBAA
  width: number
  points: number[] // [x, y, pressure, dt] 평탄 배열, 청크 원점 기준 상대좌표
  bbox: [number, number, number, number]
  opts: StrokeOpts
}

export interface TextBox extends BaseElement {
  type: 'text'; x: number; y: number; w: number; text: string; fontSize: number; color: string
}
export interface ImageElement extends BaseElement {
  type: 'image'; assetId: ID; x: number; y: number; w: number; h: number; rotation: number
}
export interface ShapeElement extends BaseElement {
  type: 'shape'; shape: 'line' | 'arrow' | 'rect' | 'ellipse'
  x: number; y: number; w: number; h: number; color: string; width: number
}

export type Element = Stroke | TextBox | ImageElement | ShapeElement

export interface Asset {
  id: ID
  kind: 'pdf' | 'image'
  mime: string
  size: number
  sha256: string
  name?: string
  createdAt: number
  version: number
}

// ───────── 상수 (7.3) ─────────
export const CHUNK_SIZE = 4096
export const PAGE_CHUNK_KEY = '0_0' // paged 모드: 페이지 1개 = 청크 1개
export const MAX_HISTORY = 200
export const SYNC_DEBOUNCE_MS = 3000
export const TRASH_RETENTION_DAYS = 30
export const MAX_IMPORT_BYTES = 200 * 1024 * 1024

// ───────── 페이지 크기 (pt, 1pt = 1/72in) ─────────
export const PAGE_SIZES = {
  a4: { label: 'A4', w: 595.28, h: 841.89 },
  letter: { label: 'Letter', w: 612, h: 792 },
  a5: { label: 'A5', w: 419.53, h: 595.28 }
} as const
export type PageSizeKey = keyof typeof PAGE_SIZES | 'custom'

export const PAPER_COLOR = '#ffffff'
export const LINE_COLOR = '#c7d2e0'

export function makeBackground(type: BackgroundType, spacing = 24): Background {
  switch (type) {
    case 'blank':
      return { type, color: PAPER_COLOR }
    case 'dot':
      return { type, spacing: spacing * 0.83, color: '#9aa3ad' }
    default:
      return { type, spacing, color: LINE_COLOR }
  }
}

export const BACKGROUND_LABELS: Record<BackgroundType, string> = {
  blank: '무지',
  lined: '줄',
  grid: '모눈',
  dot: '점',
  cornell: '코넬'
}

export function chunkKeyOf(pageId: ID, key: string) {
  return `${pageId}|${key}`
}
