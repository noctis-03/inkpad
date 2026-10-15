import type { BackgroundType, ID, Stroke, StrokeOpts } from '../shared/model'
export type { ID, Stroke, StrokeOpts, BackgroundType }

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'lasso'

/**
 * 펜 스타일 — 두 가지뿐이다. 값 조절 슬라이더는 두지 않는다.
 *  pen     : 기본 펜 — 필압 펜은 누르는 힘대로, 손가락·마우스는 속도대로 굵기가 흐른다
 *  ballpen : 굵기가 항상 일정한 펜
 */
export type PenStyleId = 'pen' | 'ballpen'

export const PEN_STYLE_ORDER: PenStyleId[] = ['pen', 'ballpen']

export const PEN_STYLES: Record<PenStyleId, { label: string; hint: string }> = {
  pen: {
    label: '펜',
    hint: '필압 펜은 누르는 힘에 따라, 손가락·마우스는 속도에 따라 굵기가 흐릅니다'
  },
  ballpen: {
    label: '볼펜',
    hint: '필압에 반응하지 않고 굵기가 항상 일정합니다'
  }
}

export interface Settings {
  // 펜
  penStyle: PenStyleId
  fingerDraw: boolean // 손가락·정전식 터치펜으로 그리기 (기본 끔)
  eraserMode: 'stroke' | 'partial'
  // 지연·입력
  prediction: boolean
  coalesced: boolean
  palmWindowMs: number
  palmMaxContact: number // 0 = 끔
  /** 입력 중인 획에서 매 프레임 다시 계산하는 최근 점 개수 — 나머지는 확정 레이어에 한 번만 굳힌다 */
  liveWindow: number
  cancelBehavior: 'commit' | 'discard'
  // 렌더링
  gestureRender: 'auto' | 'transform' | 'redraw'
  resolution: number
  showHud: boolean
  momentum: boolean // 한 손가락 스크롤 관성
  // 기타 파일 전송 전 확인 (iPad Safari는 셀룰러 여부를 알 수 없어 크기로 묻는다)
  largeFileConfirm: 'always' | 'off' | '5' | '10' | '50'
  // 인터랙티브 모션 (MOTION_SPEC 4장). auto = 기기의 '동작 줄이기' 설정을 따름
  motion: 'auto' | 'off' | 'normal' | 'rich'
  // 테마 (다크 모드). auto = 기기의 외관 설정을 따름
  theme: 'auto' | 'light' | 'dark'
}

export const DEFAULT_SETTINGS: Settings = {
  penStyle: 'pen',
  fingerDraw: false,
  eraserMode: 'stroke',
  prediction: true,
  coalesced: true,
  // 펜을 뗀 뒤 이 시간 동안의 "단일" 접촉만 손바닥으로 본다 — 두 번째 접촉이 오면 되살려
  // 제스처(핀치·두 손가락 탭)로 쓴다. 예전 기본값 500ms는 필기 직후 제스처를 통째로 막았다.
  palmWindowMs: 250,
  palmMaxContact: 0,
  liveWindow: 32,
  cancelBehavior: 'commit',
  gestureRender: 'auto',
  resolution: 1,
  showHud: false,
  momentum: true,
  largeFileConfirm: 'always',
  motion: 'auto',
  theme: 'auto'
}

export interface PenStyle {
  color: string
  width: number
}

export interface ToolStyle {
  pen: PenStyle
  highlighter: PenStyle
  eraserSize: number // 화면 기준 지름 (CSS px)
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
  rect: { x: number; y: number; w: number; h: number } // 화면 좌표 (캔버스 기준)
  moving: boolean
}
