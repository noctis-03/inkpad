import type { BackgroundType, ID, Stroke, StrokeOpts } from '../shared/model'
export type { ID, Stroke, StrokeOpts, BackgroundType }

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'lasso'

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

/**
 * 필기 프로파일 — GoodNotes의 펜 종류(볼펜·만년필·붓펜)에 대응한다.
 * 하나를 고르면 그 펜에 맞는 필압·평활·안정화 값을 한 번에 맞춘다(custom = 직접 맞춤).
 * 값을 손으로 바꾸면 자동으로 custom으로 돌아간다(store.setSettings).
 */
export type InkProfile = 'ballpen' | 'fountain' | 'brush' | 'custom'

/** 프로파일이 함께 정하는 값들 */
export interface ProfileValues {
  pressureMode: PressureMode
  fallbackMode: FallbackMode
  thinning: number // 굵기 변화 폭
  pressureGamma: number // 필압 곡선
  minPressure: number // 최소 필압 (GoodNotes의 Pressure Sensitivity 'Min'에 해당)
  pressureSmoothing: number // 필압 평활
  streamline: number // 손떨림 보정 (Stroke Stabilization)
  smoothing: number // 외곽선 매끄럽게
  tipSharpness: number // 획 끝 날카로움 (Tip Sharpness)
}

export const INK_PROFILE_ORDER: InkProfile[] = ['ballpen', 'fountain', 'brush', 'custom']

export const INK_PROFILES: Record<Exclude<InkProfile, 'custom'>, { label: string; hint: string; values: ProfileValues }> = {
  ballpen: {
    label: '볼펜',
    hint: '필압에 반응하지 않고 굵기가 일정합니다 (GoodNotes Ball Pen)',
    values: {
      pressureMode: 'constant',
      fallbackMode: 'constant',
      thinning: 0,
      pressureGamma: 1,
      minPressure: 0.05,
      pressureSmoothing: 0.5,
      streamline: 0.45,
      smoothing: 0.5,
      tipSharpness: 0
    }
  },
  fountain: {
    label: '만년필',
    hint: '누르는 힘에 따라 굵기가 부드럽게 변합니다 (GoodNotes Fountain Pen)',
    values: {
      pressureMode: 'pressure',
      fallbackMode: 'velocity',
      thinning: 0.5,
      pressureGamma: 1,
      minPressure: 0.15,
      pressureSmoothing: 0.6,
      streamline: 0.4,
      smoothing: 0.5,
      tipSharpness: 0.5
    }
  },
  brush: {
    label: '붓펜',
    hint: '필압에 크게 반응하고 획 끝이 날카롭습니다 (GoodNotes Brush Pen)',
    values: {
      pressureMode: 'pressure',
      fallbackMode: 'velocity',
      thinning: 0.85,
      pressureGamma: 1.2,
      minPressure: 0.06,
      pressureSmoothing: 0.45,
      streamline: 0.5,
      smoothing: 0.55,
      tipSharpness: 0.85
    }
  }
}

/** 프로파일이 정하는 키 — 이 값을 손으로 바꾸면 custom으로 표시한다 */
export const PROFILE_KEYS: (keyof ProfileValues)[] = [
  'pressureMode',
  'fallbackMode',
  'thinning',
  'pressureGamma',
  'minPressure',
  'pressureSmoothing',
  'streamline',
  'smoothing',
  'tipSharpness'
]

/**
 * 프로파일 값을 설정에 얹는다 (id = 'custom'이면 표시만 바꾼다).
 * 프로파일은 "펜 종류 한 벌"이므로 값이 여러 개 한꺼번에 바뀐다.
 */
export function profileSettings(cur: Settings, id: InkProfile): Settings {
  if (id === 'custom') return { ...cur, inkProfile: 'custom' }
  return { ...cur, ...INK_PROFILES[id].values, inkProfile: id }
}

/**
 * 설정을 한 항목 바꿀 때 프로파일 표시를 맞춘다 — 프로파일이 정하는 값을 손으로 바꾸면
 * '직접 맞춤'이 된다(프로파일 칩이 실제 값과 어긋나지 않게).
 */
export function applySettingsPatch(cur: Settings, patch: Partial<Settings>): Settings {
  const next = { ...cur, ...patch }
  if (next.inkProfile !== 'custom' && PROFILE_KEYS.some((k) => k in patch)) next.inkProfile = 'custom'
  return next
}

export interface Settings {
  // 필압
  inkProfile: InkProfile
  pressureMode: PressureMode
  fallbackMode: FallbackMode // auto에서 필압이 없을 때, 그리고 손가락/터치펜/마우스 입력에 사용
  pressureCapability: PressureCapability // 자동 감지 결과 (기기에 저장)
  thinning: number // 굵기 변화 폭 0~0.95
  pressureGamma: number // 필압 곡선 (<1 가볍게, >1 세게 눌러야 굵어짐)
  minPressure: number // 이보다 약한 필압은 이 값으로 (너무 가늘어지는 것 방지)
  pressureSmoothing: number // 필압 평활화 0~0.9 (높을수록 굵기 변화가 부드럽지만 반응이 둔해짐)
  // 필기
  streamline: number // 손떨림 보정 0~0.9 — 위치 안정화(Stroke Stabilization), 높을수록 부드럽지만 펜 끝이 뒤처짐
  smoothing: number // 외곽선을 잇는 곡선의 매끄러움 (perfect-freehand smoothing)
  tipSharpness: number // 획 끝 날카로움 0~1 — 빠르게 스쳐 끝난 획의 끝을 가늘게 (Tip Sharpness)
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
  inkProfile: 'custom',
  pressureMode: 'auto',
  fallbackMode: 'velocity',
  pressureCapability: 'unknown',
  thinning: 0.6,
  pressureGamma: 1,
  minPressure: 0.05,
  pressureSmoothing: 0.35,
  streamline: 0.3,
  smoothing: 0.5,
  tipSharpness: 0.5,
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
