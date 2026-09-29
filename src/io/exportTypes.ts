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

export interface ExportPage {
  w: number
  h: number
  paper: [number, number, number] | null
  pattern: ExportPattern | null
  pdf?: { assetId: string; pageIndex: number; rotation: number }
  raster?: { jpeg: ArrayBuffer } // 원본을 pdf-lib로 못 읽을 때 (암호 등)
  paths: ExportPath[] // under → main 순서
}

export interface ExportJob {
  title: string
  pages: ExportPage[]
  sources: Record<string, ArrayBuffer> // assetId → PDF 원본
}

export type WorkerOut =
  | { type: 'progress'; done: number; total: number }
  | { type: 'need-raster'; assetIds: string[] }
  | { type: 'done'; bytes: ArrayBuffer }
  | { type: 'error'; message: string }
