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

/** 줄바꿈은 메인 스레드(engine/text)에서 화면과 같은 규칙으로 계산해 넘긴다 */
export interface ExportText {
  x: number // 페이지 왼쪽 위 기준, y 아래로
  y: number
  size: number
  lineHeight: number
  color: [number, number, number, number]
  lines: string[]
}

export interface ExportPage {
  w: number
  h: number
  paper: [number, number, number] | null
  pattern: ExportPattern | null
  pdf?: { assetId: string; pageIndex: number; rotation: number }
  raster?: { jpeg: ArrayBuffer } // 원본을 pdf-lib로 못 읽을 때 (암호 등)
  paths: ExportPath[] // under → main 순서
  texts: ExportText[] // 획 위에 그린다 (화면과 같은 순서)
}

export interface ExportJob {
  title: string
  pages: ExportPage[]
  sources: Record<string, ArrayBuffer> // assetId → PDF 원본
  font?: ArrayBuffer // 한글 폰트. 없으면 텍스트를 건너뛴다
}

export type WorkerOut =
  | { type: 'progress'; done: number; total: number }
  | { type: 'need-raster'; assetIds: string[] }
  | { type: 'done'; bytes: ArrayBuffer }
  | { type: 'error'; message: string }
