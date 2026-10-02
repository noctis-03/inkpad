// 설계 문서 7장 데이터 모델. 클라이언트 전체(엔진·저장소·내보내기)와 Phase 2 API가 공유한다.
export const SCHEMA_VERSION = 2

export type ID = string // ULID

export interface Folder {
  id: ID
  schemaVersion: number
  name: string
  parentId: ID | null
  createdAt: number
  updatedAt: number
  deletedAt?: number
  version: number // (구) 서버 기준 버전 — 폴더는 이제 기기별 로컬 전용
  categories?: string[] // 이 폴더가 담는 카테고리 목록 (로컬 전용 설정)
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
  folderId: ID | null // 로컬 전용 — 동기화하지 않는다 (폴더는 기기별 정리 도구)
  category: string | null // 단일 카테고리, null = 미분류 (동기화함)
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
  type: 'text'
  /** 블록이 속한 저장 단위(문서형=페이지, 무한=청크) 원점 기준 상대좌표 — 획(points)과 같은 규약 */
  x: number
  y: number
  /** 고정 폭 (pt). 줄바꿈 기준 */
  w: number
  /** 마지막으로 측정한 높이 (없으면 렌더 시 계산) */
  h?: number
  text: string
  fontSize: number
  color: string
  fontFamily?: string
  align?: 'left' | 'center' | 'right'
  /** 우하단 핸들로 고정한 최소 높이 — 없으면 내용에 맞춰 자동 측정 */
  hFixed?: boolean
}
export interface LinkElement extends BaseElement {
  type: 'link'
  /** 저장 단위(페이지/청크) 원점 기준 상대좌표 — 획·텍스트와 같은 규약 */
  x: number
  y: number
  w: number
  h?: number
  label: string
  url: string
  fontSize: number
  color: string
  fontFamily?: string
  align?: 'left' | 'center' | 'right'
  /** 우하단 핸들로 고정한 최소 높이 — 없으면 내용에 맞춰 자동 측정 */
  hFixed?: boolean
}
export interface ImageElement extends BaseElement {
  type: 'image'; assetId: ID; x: number; y: number; w: number; h: number; rotation: number
}
export interface ShapeElement extends BaseElement {
  type: 'shape'; shape: 'line' | 'arrow' | 'rect' | 'ellipse'
  x: number; y: number; w: number; h: number; color: string; width: number
}

export interface MemoElement extends BaseElement {
  type: 'memo'
  x: number
  y: number
  w: number
  /** 박스 높이 — 헤더(34pt) + 본문. 내용이 넘치면 본문이 스크롤된다 */
  h: number
  text: string
  fontSize: number
  color: string
  fontFamily?: string
  align?: 'left' | 'center' | 'right'
}

export type Element = Stroke | TextBox | LinkElement | MemoElement | ImageElement | ShapeElement

/** 블록 편집 모드에서 빈 곳을 탭했을 때 만드는 블록 종류 */
export type BlockKind = 'text' | 'link' | 'memo'

/** 외부로 열어도 되는 링크인지 (javascript: 등 차단) */
export function isSafeUrl(raw: string): boolean {
  return /^(https?:|mailto:)/i.test(raw.trim())
}

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
export const MAX_CATEGORY_CHARS = 40 // 카테고리 이름 길이 제한 (한글 40자 ≈ 120바이트 < Drive appProperties 124바이트)
export const BLOCK_SNAP_STEP = 16 // 블록 편집 모드 그리드 스냅 간격 (pt)
export const DEFAULT_TEXT_W = 240 // 새 텍스트 블록 기본 폭 (pt)
export const MIN_TEXT_W = 48 // 텍스트 블록 최소 폭 (pt)
export const DEFAULT_MEMO_W = 240 // 새 메모 블록 기본 폭 (pt)
export const DEFAULT_MEMO_H = 176 // 새 메모 블록 기본 높이 (pt)
export const MIN_MEMO_W = 120 // 메모 블록 최소 폭 (pt)
export const MIN_MEMO_H = 88 // 메모 블록 최소 높이 (pt)

/** 카테고리 이름 정규화 — trim, 연속 공백 정리, 앞뒤 슬래시 제거. 빈 이름이면 null */
export function normalizeCategory(raw: string): string | null {
  const name = raw.replace(/\s+/g, ' ').trim().replace(/^\/+|\/+$/g, '')
  return name || null
}

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
