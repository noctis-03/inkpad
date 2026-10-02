import type { BackgroundType, ID, Stroke, StrokeOpts } from '../shared/model'
export type { ID, Stroke, StrokeOpts, BackgroundType }

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'lasso'

/**
 * 편집 모드 — 도구(tool)와는 별개 축.
 *  draw  : 필기 모드. 캔버스 엔진이 포인터를 전담한다.
 *  block : 블록 편집 모드. 잉크 대신 DOM 블록(텍스트 등)을 만들고 편집한다.
 */
export type EditMode = 'draw' | 'block'

/**
 * 필압 처리 방식
 *  auto     : 펜이 필압을 보내는지 자동 감지 → 있으면 필압, 없으면 fallbackMode
 *  pressure : 항상 필압 사용 (Apple Pencil)
 *  velocity : 속도로 굵기 흉내 (빨리 그리면 가늘게) — 필압 없는 펜/손가락
 *  constant : 굵기 일정
 */
export type PressureMode = 'auto' | 'pressure' | 'velocity' | 'constant'
export type FallbackMode = 'velocity' | 'constant'
export type PressureCapability = 'unknown' | 'yes' | 'no'

export interface Settings {
  // 필압
  pressureMode: PressureMode
  fallbackMode: FallbackMode // auto에서 필압이 없을 때, 그리고 손가락/터치펜/마우스 입력에 사용
  pressureCapability: PressureCapability // 자동 감지 결과 (기기에 저장)
  thinning: number // 굵기 변화 폭 0~0.95
  pressureGamma: number // 필압 곡선 (<1 가볍게, >1 세게 눌러야 굵어짐)
  minPressure: number // 이보다 약한 필압은 이 값으로 (너무 가늘어지는 것 방지)
  // 필기
  streamline: number
  smoothing: number
  fingerDraw: boolean // 손가락·정전식 터치펜으로 그리기 (기본 끔)
  eraserMode: 'stroke' | 'partial'
  // 지연·입력
  prediction: boolean
  coalesced: boolean
  palmWindowMs: number
  palmMaxContact: number // 0 = 끔
  cancelBehavior: 'commit' | 'discard'
  // 렌더링
  gestureRender: 'auto' | 'transform' | 'redraw'
  resolution: number
  showHud: boolean
  momentum: boolean // 한 손가락 스크롤 관성
  // 블록 편집
  blockSnap: boolean // 그리드 스냅
  blockSnapStep: number // 스냅 간격 (pt)
}

export const DEFAULT_SETTINGS: Settings = {
  pressureMode: 'auto',
  fallbackMode: 'velocity',
  pressureCapability: 'unknown',
  thinning: 0.6,
  pressureGamma: 1,
  minPressure: 0.05,
  streamline: 0.3,
  smoothing: 0.5,
  fingerDraw: false,
  eraserMode: 'stroke',
  prediction: true,
  coalesced: true,
  palmWindowMs: 500,
  palmMaxContact: 0,
  cancelBehavior: 'commit',
  gestureRender: 'auto',
  resolution: 1,
  showHud: false,
  momentum: true,
  blockSnap: true,
  blockSnapStep: 16
}

export interface PenStyle {
  color: string
  width: number
}

export interface ToolStyle {
  pen: PenStyle
  highlighter: PenStyle
  eraserSize: number // 화면 기준 지름 (CSS px)
  block: { fontSize: number; color: string } // 새 텍스트 블록 기본값
}

export interface Preset {
  tool: 'pen' | 'highlighter'
  color: string
  width: number
}

export interface EngineStats {
  fps: number
  latencyAvg: number
  latencyP95: number
  eventHz: number
  pointHz: number
  coalescedPerEvent: number
  predictedCount: number
  liveMs: number
  committedMs: number
  pointerType: string
  pressure: number
  tiltX: number
  tiltY: number
  altitude: number | null
  contactW: number
  contactH: number
  strokes: number
  visible: number
  zoom: number
  dpr: number
  canvasPx: string
  supportCoalesced: boolean
  supportPredicted: boolean
  renderPath: 'redraw' | 'transform' | 'idle'
  palmRejected: number
  pressureSource: string // 마지막 획에 실제로 쓴 방식
  pdfCache: string
}

export interface ViewInfo {
  canUndo: boolean
  canRedo: boolean
  zoom: number
  currentPage: number // 0부터
  pageCount: number
}

export interface SelectionInfo {
  count: number
  blocks: number // 선택에 포함된 블록 수
  rect: { x: number; y: number; w: number; h: number } // 화면 좌표 (캔버스 기준)
  moving: boolean
}
