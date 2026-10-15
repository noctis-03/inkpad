// 펜 품질 보조 — 작은 순수 함수·필터만 두어 단위 시뮬레이션으로 검증할 수 있게 한다.
//
// 원칙: 굵기·평활에 쓰는 값은 모두 "화면 기준"(CSS px, px/s)으로 계산하고 저장 좌표만 월드로 되돌린다.
// 그래야 같은 손 동작이 어느 배율에서도 같은 선이 된다. perfect-freehand의 simulatePressure는
// 점 사이 "거리"(월드)를 size로 나눠 속도를 추정하므로 배율이 바뀌면 추정 속도가 함께 바뀐다
// (실측: 배율 10%↔2000%에서 실효 굵기 3.9배 차).

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** 화면(기기 px) 두께가 이보다 얇으면 외곽선 면 대신 중심선 한 줄로 긋는다 */
export const MIN_STROKE_DEVICE_PX = 1.5

/** 월드 폭 × (기기 px per 월드) 로 화면 두께가 너무 얇은지 판정 */
export function isHairline(widthWorld: number, pxPerWorld: number): boolean {
  return widthWorld * pxPerWorld < MIN_STROKE_DEVICE_PX
}

// ───────── 속도 → 굵기 (필압 없는 펜·손가락) ─────────

export const VELOCITY_REF_SPEED = 300 // CSS px/s — 이 속도가 중간 굵기
export const VELOCITY_SPEED_RANGE = 260 // 이 폭(px/s)만큼 느리면 굵어지고 빨라지면 가늘어진다
export const VELOCITY_AMPLITUDE = 0.45 // 굵기 변화 폭 (중심 0.5 기준 ±)
export const VELOCITY_START_PRESSURE = 0.85 // 펜을 대는 순간 — 아직 속도를 모를 때의 굵기

/**
 * 화면 기준 속도(CSS px/s) → 필압(0~1). 느리면 굵고 빠르면 가늘다.
 * 상하한(0.1~1)을 두어 아주 빠른 획도 사라지지 않게 한다.
 */
export function speedToPressure(vScreen: number): number {
  return clamp(0.5 - VELOCITY_AMPLITUDE * Math.tanh((vScreen - VELOCITY_REF_SPEED) / VELOCITY_SPEED_RANGE), 0.1, 1)
}

/**
 * 점 사이 이동량(월드)과 경과 시간(ms), 배율 → 굵기용 필압.
 * 이동량을 화면 px로 환산한 뒤 나누므로 배율이 달라도 같은 손 동작은 같은 값이 나온다.
 * dt 0(첫 점)은 속도를 모르므로 시작 굵기를 쓴다.
 */
export function velocityPressure(dxWorld: number, dyWorld: number, dtMs: number, zoom: number): number {
  if (!(dtMs > 0)) return VELOCITY_START_PRESSURE
  const dScreen = Math.hypot(dxWorld, dyWorld) * zoom
  return speedToPressure(dScreen / (dtMs / 1000))
}

// ───────── 필압 평활 ─────────

const alphaFor = (cutoff: number, dt: number) => {
  const tau = 1 / (2 * Math.PI * cutoff)
  return 1 / (1 + tau / dt)
}
const lowpass = (prev: number, x: number, a: number) => prev + a * (x - prev)

/**
 * 1€ 필터. 느리게 변할 때는 차단 주파수를 낮춰 떨림을 눌러 두고, 빠르게 변할 때는 주파수를 올려
 * 지연을 없앤다 — "가만히 있을 땐 고정, 세게 누르면 즉시"인 필압 신호에 맞다.
 * 고정 EMA(이전 구현)는 평활을 올리면 반응까지 같이 둔해졌다.
 */
export class OneEuroFilter {
  private x = NaN
  private dx = 0
  minCutoff: number
  beta: number
  dCutoff: number

  // 매개변수 속성(constructor(public …)) 대신 직접 대입한다 —
  // node --experimental-strip-types(단위 시뮬레이션)가 매개변수 속성을 지원하지 않는다.
  constructor(minCutoff: number, beta: number, dCutoff = 1) {
    this.minCutoff = minCutoff
    this.beta = beta
    this.dCutoff = dCutoff
  }

  /** dtMs: 직전 샘플까지의 경과 시간. 첫 샘플은 그대로 통과시킨다 */
  filter(x: number, dtMs: number): number {
    if (!Number.isFinite(this.x)) {
      this.x = x
      this.dx = 0
      return x
    }
    const dt = clamp(dtMs / 1000, 0.001, 0.1)
    const adx = lowpass(this.dx, (x - this.x) / dt, alphaFor(this.dCutoff, dt))
    this.dx = adx
    this.x = lowpass(this.x, x, alphaFor(this.minCutoff + this.beta * Math.abs(adx), dt))
    return this.x
  }

  reset() {
    this.x = NaN
    this.dx = 0
  }

  /**
   * 설정값(평활 0~0.9) → 필터. 기준점은 기존 EMA 계수다 — 120 Hz에서 같은 세기가 되도록
   * 최소 차단 주파수를 맞춰, 슬라이더 감각이 바뀌지 않게 한다.
   */
  static forSmoothing(smoothing: number): OneEuroFilter {
    const a = 1 - clamp01(smoothing) * 0.85 // 기존 EMA 계수
    const dt = 1 / 120
    const tau = (dt * (1 - a)) / Math.max(1e-3, a)
    const fc = clamp(1 / (2 * Math.PI * tau), 0.4, 30)
    return new OneEuroFilter(fc, 0.05 + 0.5 * clamp01(smoothing))
  }
}

/**
 * 저장할 점의 최소 월드 간격.
 * 화면에서 cssPx보다 가까운 점은 입력 떨림으로 보고 점으로 만들지 않는다(필압만 합친다).
 * 화면 거리 = 월드 거리 × zoom 이므로 월드 간격 = cssPx / zoom — 화면 기준으로는 어느 배율에서나 같은 밀도다.
 * 이 필터로 선이 매끄러워지고 점 수가 줄어 입력 지연도 함께 줄어든다.
 */
export function minPointDist(zoom: number, cssPx = 0.55): number {
  return cssPx / Math.max(0.05, zoom)
}
