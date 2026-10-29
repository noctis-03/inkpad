// 데이터 모델. 클라이언트 전체(엔진·저장소·내보내기·동기화)가 공유한다.
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
  /** paged: 노트(페이지) · infinite: 무한 캔버스 · text: 문서(키보드로 쓰는 블록 문서 — 페이지·필기 없이 textBlocks만) */
  mode: DocMode
  folderId: ID | null // 로컬 전용 — 동기화하지 않는다 (폴더는 기기별 정리 도구)
  category: string | null // 단일 카테고리, null = 미분류 (동기화함)
  pageOrder: ID[] // paged: 페이지 순서 / infinite: 페이지 1개
  createdAt: number
  updatedAt: number
  deletedAt?: number // 휴지통 (tombstone)
  version: number
  lastView?: ViewState // 로컬 전용: 마지막으로 보던 위치
}

export type DocMode = 'infinite' | 'paged' | 'text'

// ───────── 문서(text 모드)의 블록 ─────────
// 노션처럼 한 줄 한 블록. 필기 노트의 편집 블록(Block — 메모·링크 등)과는 다른 것이다.
// 평평한 목록 + 들여쓰기(indent)로 중첩을 나타낸다 — 블록 단위로 머지하기 쉽게.

export type TextBlockType = 'p' | 'h1' | 'h2' | 'h3' | 'bullet' | 'number' | 'todo' | 'quote' | 'code' | 'divider' | 'toggle'

export interface TextBlock {
  id: ID // ULID
  documentId: ID
  type: TextBlockType
  /** 인라인 서식이 든 HTML 조각 — b·i·u·s·code·a·br만 (shared/richText의 sanitizeInline이 지킨다). code 블록은 서식 없이 글자만 */
  html: string
  /** 들여쓰기 0~TEXT_MAX_INDENT — 목록 중첩, 토글 안쪽 */
  indent: number
  /** 순서 키 (분수 인덱스, shared/fracIndex) — 두 기기가 따로 끼워 넣어도 순서가 정해진다 */
  pos: string
  /** todo: 했음 */
  checked?: boolean
  /** toggle: 접음 — 아래 더 깊이 들여쓴 블록을 숨긴다 */
  collapsed?: boolean
  createdAt: number
  updatedAt: number
  /** tombstone (동기화 머지용) */
  deletedAt?: number
}

export const TEXT_MAX_INDENT = 6

export type Background =
  | { type: 'blank'; color: string }
  | { type: 'lined'; spacing: number; color: string }
  | { type: 'grid'; spacing: number; color: string }
  | { type: 'dot'; spacing: number; color: string }
  | { type: 'cornell'; spacing: number; color: string }

export type BackgroundType = Background['type']

/**
 * 보조 용지 — 페이지 옆에서 추가로 필기하는 용지. 페이지처럼 획(청크)을 갖지만 페이지 번호·순서에 들지 않는다.
 * 좌표는 기준 페이지 왼쪽 위에 대한 상대값(pt). snap이면 x는 무시하고 기준 페이지 가장자리에 붙인다.
 */
export interface SheetInfo {
  anchorPageId: ID
  x: number
  y: number
  snap: 'left' | 'right' | null
  title: string
  /** 쌓임 순서 (위에 있는 용지가 큰 값) */
  z: number
  /** 고정 — 헤더로 옮기거나 크기를 바꿀 수 없다 */
  fixed?: boolean
  /** 투명 — 종이·속지 없이 테두리만. 아래 페이지가 비쳐 보인다 (background는 되돌릴 때를 위해 그대로 둔다) */
  transparent?: boolean
}

export const SHEET_MIN = { w: 80, h: 80 }
export const SHEET_MAX = { w: 2400, h: 3600 }

/** 살아 있는 보조 용지인가 — 지워지지 않았고 기준 페이지가 살아 있다 */
export const isLiveSheet = (p: Page, livePageIds: Set<ID>): boolean => !!p.sheet && !p.deletedAt && livePageIds.has(p.sheet.anchorPageId)

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
  /**
   * 내용 배율 — 획·속지 무늬·PDF를 이 배율로 키우거나 줄여 보여 준다(없으면 1). size는 배율을 곱한 뒤의 크기다.
   * 페이지 크기 맞추기(A4 폭)는 이 값과 size만 바꾸고 획 좌표는 건드리지 않는다 — 되돌리면 정확히 원래대로이고,
   * 다른 기기에서 같은 페이지에 쓴 획과도 부딪히지 않는다
   */
  scale?: number
  background: Background
  pdf?: PdfRef
  /** 있으면 보조 용지 — pageOrder에 들지 않고 기준 페이지 옆에 붙거나 떠 있다. size가 용지 크기다 */
  sheet?: SheetInfo
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

// ───────── 상수 ─────────
export const CHUNK_SIZE = 4096
export const PAGE_CHUNK_KEY = '0_0' // paged 모드: 페이지 1개 = 청크 1개
export const MAX_HISTORY = 200
export const TRASH_RETENTION_DAYS = 30
export const MAX_IMPORT_BYTES = 200 * 1024 * 1024
export const MAX_CATEGORY_CHARS = 40 // 카테고리 이름 길이 제한 (한글 40자 ≈ 120바이트 < Drive appProperties 124바이트)

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

/** 페이지 내용 배율 (없으면 1) */
export const pageScale = (p: Pick<Page, 'scale'> | null | undefined): number => p?.scale ?? 1

/**
 * A4 폭에 맞출 때의 배율 — 세로 페이지는 A4 폭, 가로 페이지는 A4 가로 폭(842pt)에 맞춘다.
 * 슬라이드 같은 가로 페이지를 A4 세로 폭(595pt)에 맞추면 쓸 자리가 너무 작아진다
 */
export function a4FitFactor(size: { w: number; h: number }): number {
  const target = size.w > size.h ? PAGE_SIZES.a4.h : PAGE_SIZES.a4.w
  return target / size.w
}

/** 원래 크기에서 많이 벗어났는가 — PDF를 가져올 때 A4 폭에 맞출지 물어보는 기준(0.8배 미만, 1.25배 초과) */
export const farFromA4 = (size: { w: number; h: number }) => {
  const f = a4FitFactor(size)
  return f > 1.25 || f < 0.8
}

export const PAPER_COLOR = '#ffffff'
export const LINE_COLOR = '#d3d9e2'

export function makeBackground(type: BackgroundType, spacing = 24): Background {
  switch (type) {
    case 'blank':
      return { type, color: PAPER_COLOR }
    case 'dot':
      return { type, spacing: spacing * 0.83, color: '#a9b1bc' }
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

// ───────── 편집 블록 (PDF 내보내기 제외, Element와 별개) ─────────
// 블록은 절대 Element 유니언이나 chunks 테이블에 넣지 않는다. 별도 타입·별도 테이블(blocks)로
// 관리하면 기존 PDF 내보내기 경로(chunks의 stroke만 읽음)는 코드를 고치지 않아도 블록을 볼 수 없다.
export const BLOCK_SCHEMA_VERSION = 1

export type BlockType = 'memo' | 'link' | 'todo' | 'timer' | 'jump'
export type MemoColor = 'yellow' | 'pink' | 'blue' | 'green'

export interface BlockBase {
  id: ID // ULID
  documentId: ID
  /** 기준 페이지. 블록 좌표는 이 페이지 원점에 대한 상대값이다. */
  pageId: ID
  schemaVersion: number
  /**
   * 기준 페이지 원점 기준 좌표(pt).
   *  - paged: 원점 = 페이지 왼쪽 위. 페이지 밖이면 음수이거나 page.size보다 클 수 있다(여백, 페이지 사이).
   *  - infinite: 원점 = 월드 (0,0), 즉 월드 좌표 그대로.
   */
  x: number
  y: number
  /** 폭(pt). 높이는 내용에 따라 자동으로 정해진다. */
  w: number
  /** 블록끼리의 쌓임 순서 */
  z: number
  createdAt: number
  updatedAt: number
  /** tombstone (동기화 머지용) */
  deletedAt?: number
  /** 간소화 — 헤더를 숨기고 내용만 표시한다 */
  minimal?: boolean
  /** 배경 투명 — 카드 배경·그림자를 없애 텍스트 박스처럼 보인다 */
  transparent?: boolean
  /** 고정 — 헤더 드래그로 옮길 수 없다 */
  fixed?: boolean
}

export interface MemoData {
  text: string
  color: MemoColor
  collapsed: boolean
}
export interface LinkData {
  url: string
  label: string
}
export interface TodoItem {
  id: ID
  text: string
  done: boolean
}
export interface TodoData {
  items: TodoItem[]
}
export interface TimerData {
  durationSec: number
}
export interface JumpData {
  targetPageId: ID | null
}

export interface MemoBlock extends BlockBase {
  type: 'memo'
  data: MemoData
}
export interface LinkBlock extends BlockBase {
  type: 'link'
  data: LinkData
}
export interface TodoBlock extends BlockBase {
  type: 'todo'
  data: TodoData
}
export interface TimerBlock extends BlockBase {
  type: 'timer'
  data: TimerData
}
export interface JumpBlock extends BlockBase {
  type: 'jump'
  data: JumpData
}

export type Block = MemoBlock | LinkBlock | TodoBlock | TimerBlock | JumpBlock

export const BLOCK_DEFAULT_W: Record<BlockType, number> = { memo: 200, link: 230, todo: 210, timer: 170, jump: 190 }
/** 페이지 가장자리에서 블록이 벗어날 수 있는 최대 거리(pt). 블록 분실 방지용이며 paged 모드에만 적용한다. */
export const BLOCK_MAX_OUTSIDE = 1600

// ───────── HTML 앱 (노트와 별개 — documents/chunks와 절대 섞지 않는다) ─────────
// 앱 1개 = 단일 .html 파일 1개. PDF 내보내기·머지·엔진·.inkpad 형식은 앱을 몰라야 한다.
export interface HtmlApp {
  id: ID // ULID
  title: string
  category: string | null
  html: string
  size: number
  createdAt: number
  updatedAt: number
  fileId?: string // Drive 파일 id
  /** 클라우드 반영 대기 (오프라인·로그인 전에 바꾼 경우) */
  pending?: 'upsert' | 'delete'
  deletedAt?: number // pending 'delete'인 동안만 존재 (목록에서 숨김)
  /** 이 기기에서 직접 클라우드 삭제 — 클라우드에는 없고 이 기기에만 남아 있음 */
  cloudDetachedAt?: number
}
export const MAX_APP_BYTES = 20 * 1024 * 1024
export const MAX_APP_TITLE_CHARS = 40

// ───────── 일반 파일 (앱·노트와 별개 — 임의 형식을 저장하고 종류별 뷰어로 연다) ─────────
// 편집기(노트)는 아직 텍스트·이미지 배치를 지원하지 않으므로(Phase 3), 파일은 노트로 변환하지
// 않고 그대로 보관한 뒤 종류에 맞는 읽기 전용 뷰어로 연다.
export type FileKind = 'text' | 'image' | 'other'

export interface StoredFile {
  id: ID // ULID
  title: string
  category: string | null
  name: string // 원본 파일명 (확장자 포함)
  mime: string
  size: number
  kind: FileKind
  createdAt: number
  updatedAt: number
  fileId?: string // Drive 파일 id
  /** 클라우드 반영 대기 (오프라인·로그인 전에 바꾼 경우) */
  pending?: 'upsert' | 'delete'
  deletedAt?: number // pending 'delete'인 동안만 존재 (목록에서 숨김)
  /** 이 기기에서 직접 클라우드 삭제 — 클라우드에는 없고 이 기기에만 남아 있음 */
  cloudDetachedAt?: number
  /** 'upsert' 대기 중 무엇을 보내야 하는지 — 'meta'는 본문 없이 메타만 (이름·카테고리 변경) */
  pendingKind?: 'meta' | 'content'
}

export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const MAX_FILE_TITLE_CHARS = 40

/** 텍스트 뷰어로 열 확장자 */
const TEXT_EXT = new Set([
  'txt', 'text', 'md', 'markdown', 'mdx', 'csv', 'tsv', 'json', 'jsonc', 'xml', 'yaml', 'yml', 'toml',
  'ini', 'conf', 'cfg', 'env', 'log', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'sql',
  'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'r', 'lua', 'pl', 'dart', 'gradle', 'properties', 'srt', 'vtt'
])
/** 이미지 뷰어로 열 확장자 */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif', 'ico', 'heic', 'heif'])

export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name)
  return m ? m[1].toLowerCase() : ''
}

/** 파일을 어떻게 열지 판정한다 (확장자·MIME 기준) */
export function fileKindOf(name: string, mime: string): FileKind {
  const ext = extOf(name)
  if (mime.startsWith('image/') || IMAGE_EXT.has(ext)) return 'image'
  if (mime.startsWith('text/') || TEXT_EXT.has(ext) || mime === 'application/json' || mime === 'application/xml') return 'text'
  return 'other'
}
