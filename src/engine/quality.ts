// 펜 품질 보조 — 순수 함수만 두어 단위 시뮬레이션으로 검증할 수 있게 한다.
//
// 원칙: 굵기에 쓰는 값은 모두 "화면 기준"(CSS px, px/s)으로 계산하고 저장 좌표만 월드로 되돌린다.
// 그래야 같은 손 동작이 어느 배율에서, 어느 이벤트 주기(60/120Hz)에서도 같은 선이 된다.
// 평활(손떨림·필압)은 perfect-freehand의 streamline·smoothing이 맡는다 — 엔진이 따로 두지 않는다.

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** 화면(기기 px) 두께가 이보다 얇으면 외곽선 면 대신 중심선 한 줄로 긋는다 */
export const MIN_STROKE_DEVICE_PX = 1.5

/** 월드 폭 × (기기 px per 월드) 로 화면 두께가 너무 얇은지 판정 */
export function isHairline(widthWorld: number, pxPerWorld: number): boolean {
  return widthWorld * pxPerWorld < MIN_STROKE_DEVICE_PX
}

// ───────── 속도 → 굵기 (필압 없는 입력: 손가락·마우스) ─────────

export const VELOCITY_REF_SPEED = 300 // CSS px/s — 이 속도가 중간 굵기
export const VELOCITY_SPEED_RANGE = 260 // 이 폭(px/s)만큼 느리면 굵어지고 빨라지면 가늘어진다
export const VELOCITY_AMPLITUDE = 0.45 // 굵기 변화 폭 (중심 0.5 기준 ±)
export const VELOCITY_START_PRESSURE = 0.85 // 펜을 대는 순간 — 아직 속도를 모를 때의 굵기
const VELOCITY_MIN_PRESSURE = 0.1

/**
 * 화면 기준 속도(CSS px/s) → 필압(0~1). 느리면 굵고 빠르면 가늘다.
 * 상하한을 두어 아주 빠른 획도 사라지지 않게 한다.
 */
export function speedToPressure(vScreen: number): number {
  return clamp(0.5 - VELOCITY_AMPLITUDE * Math.tanh((vScreen - VELOCITY_REF_SPEED) / VELOCITY_SPEED_RANGE), VELOCITY_MIN_PRESSURE, 1)
}

/**
 * 화면 두 점 사이 이동량(px)과 경과 시간(ms) → 굵기용 필압.
 * 화면 좌표로 재므로 배율이 달라도 같은 손 동작은 같은 값이 나온다.
 * dt 0(첫 점)은 속도를 모르므로 시작 굵기를 쓴다.
 */
export function velocityPressure(dxScreen: number, dyScreen: number, dtMs: number): number {
  if (!(dtMs > 0)) return VELOCITY_START_PRESSURE
  return speedToPressure(Math.hypot(dxScreen, dyScreen) / (dtMs / 1000))
}

// ───────── 점 간격 ─────────

/**
 * 저장할 점의 최소 월드 간격.
 * 화면에서 cssPx보다 가까운 점은 입력 떨림으로 보고 점으로 만들지 않는다.
 * 화면 거리 = 월드 거리 × zoom 이므로 월드 간격 = cssPx / zoom — 화면 기준으로는 어느 배율에서나 같은 밀도다.
 * 이 필터로 선이 매끄러워지고 점 수가 줄어 입력 지연도 함께 줄어든다.
 */
export function minPointDist(zoom: number, cssPx = 0.55): number {
  return cssPx / Math.max(0.05, zoom)
}
