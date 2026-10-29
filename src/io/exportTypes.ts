// 메인 스레드 ↔ 내보내기 Worker 메시지
export interface ExportPath {
  d: string // SVG path (페이지 왼쪽 위 기준, y 아래로)
  r: number
  g: number
  b: number
  a: number
}

export interface ExportPattern {
  lines: [number, number, number, number][]
  dots: [number, number][]
  lineWidth: number
  dotRadius: number
  color: [number, number, number]
  accent?: { lines: [number, number, number, number][]; color: [number, number, number]; width: number }
}

/** 노트에 넣은 사진 — 그 종이(페이지·용지) 왼쪽 위 기준 pt */
export interface ExportImage {
  assetId: string
  x: number
  y: number
  w: number
  h: number
}

/** 페이지 옆에 함께 내보내는 보조 용지. x·y는 PDF 페이지(frame) 왼쪽 위 기준, paths는 용지 왼쪽 위 기준 */
export interface ExportSheet {
  x: number
  y: number
  w: number
  h: number
  paper: [number, number, number] | null // null = 투명 용지
  pattern: ExportPattern | null
  /** 투명 용지는 점선, 불투명 용지는 옅은 실선 (흰 종이끼리 경계가 보이게) */
  border: 'solid' | 'dashed'
  images?: ExportImage[] // 용지 안으로 자른다
  paths: ExportPath[] // 용지 안으로 자른다
}

export interface ExportPage {
  /** 원래 페이지 크기 — 원본 PDF·래스터·속지는 이 크기로 그린다 */
  w: number
  h: number
  /** 보조 용지를 함께 내보내면 PDF 페이지를 넓힌다: 전체 크기와 그 안에서 원래 페이지가 놓이는 자리 */
  frame?: { w: number; h: number; ox: number; oy: number }
  sheets?: ExportSheet[]
  paper: [number, number, number] | null
  pattern: ExportPattern | null
  pdf?: { assetId: string; pageIndex: number; rotation: number }
  raster?: { jpeg: ArrayBuffer } // 원본을 pdf-lib로 못 읽을 때 (암호 등)
  images?: ExportImage[] // 속지 위, 필기 아래
  paths: ExportPath[] // under → main 순서
}

export interface ExportJob {
  title: string
  pages: ExportPage[]
  sources: Record<string, ArrayBuffer> // assetId → PDF 원본
  images?: Record<string, ArrayBuffer> // assetId → 사진 원본 (PNG·JPEG)
}

export type WorkerOut =
  | { type: 'progress'; done: number; total: number }
  | { type: 'need-raster'; assetIds: string[] }
  | { type: 'done'; bytes: ArrayBuffer }
  | { type: 'error'; message: string }
