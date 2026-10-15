// 펜 품질 보조 — 순수 함수만 두어 단위 시뮬레이션으로 검증할 수 있게 한다.
//
// 원칙(GoodNotes식): 굵기·안정화에 쓰는 값은 모두 "화면 기준"(CSS px, px/s)과 "시간 기준"(ms)으로
// 계산하고 저장 좌표만 월드로 되돌린다. 그래야 같은 손 동작이 어느 배율에서도, 어느 이벤트
// 주기(60/120Hz, coalesced 배수)에서도 같은 선이 된다.
//  - 굵기: 필압 펜은 원시 필압을, 필압 없는 펜·손가락은 "화면 기준 속도"를 쓴다.
//  - 평활·안정화: 이벤트 개수가 아니라 경과 시간(dt)으로 계수를 잡는다.
// perfect-freehand의 simulatePressure는 점 사이 "거리"(월드)를 size로 나눠 속도를 추정하므로
// 배율이 바뀌면 추정 속도가 함께 바뀐다(실측: 배율 10%↔2000%에서 실효 굵기 3.9배 차) — 그래서 끈다.

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** 화면(기기 px) 두께가 이보다 얇으면 외곽선 면 대신 중심선 한 줄로 긋는다 */
export const MIN_STROKE_DEVICE_PX = 1.5

/** 월드 폭 × (기기 px per 월드) 로 화면 두께가 너무 얇은지 판정 */
export function isHairline(widthWorld: number, pxPerWorld: number): boolean {
  return widthWorld * pxPerWorld < MIN_STROKE_DEVICE_PX
}

// ───────── 속도 → 굵기 (필압 없는 볼펜·손가락) ─────────

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
 * 화면 두 점 사이 이동량(px)과 경과 시간(ms) → 굵기용 필압.
 * 화면 좌표로 재므로 배율이 달라도 같은 손 동작은 같은 값이 나온다.
 * dt 0(첫 점)은 속도를 모르므로 시작 굵기를 쓴다.
 */
export function velocityPressure(dxScreen: number, dyScreen: number, dtMs: number): number {
  if (!(dtMs > 0)) return VELOCITY_START_PRESSURE
  return speedToPressure(Math.hypot(dxScreen, dyScreen) / (dtMs / 1000))
}

// ───────── 시간 기준 평활 (1€ 필터) ─────────

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
  // 매개변수 속성(constructor(public …)) 대신 직접 대입한다 —
  // node --experimental-strip-types(단위 시뮬레이션)가 매개변수 속성을 지원하지 않는다.
  minCutoff: number
  beta: number
  dCutoff: number
  private x = NaN
  private dx = 0

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
   * 평활 슬라이더(0~0.9) → 필터. 기준점은 기존 EMA 계수다 — 120 Hz에서 같은 세기가 되도록
   * 최소 차단 주파수를 맞춰, 슬라이더 감각이 바뀌지 않게 한다.
   */
  static forSmoothing(smoothing: number): OneEuroFilter {
    const a = 1 - clamp01(smoothing) * 0.85 // 기존 EMA 계수
    const dt = 1 / 120
    const tau = (dt * (1 - a)) / Math.max(1e-3, a)
    const fc = clamp(1 / (2 * Math.PI * tau), 0.4, 30)
    return new OneEuroFilter(fc, 0.05 + 0.5 * clamp01(smoothing))
  }

  /**
   * 손떨림 보정(Stroke Stabilization) 슬라이더(0~0.9) → 위치용 필터.
   * 낮을수록 그대로(반응 최우선), 높을수록 손떨림만 눌러 둔다.
   * 빠른 획에서는 beta가 차단 주파수를 올려 펜 끝 뒤처짐을 줄인다 — 1€의 요점 그대로다.
   */
  static forStabilization(strength: number): OneEuroFilter {
    const s = clamp01(strength / 0.9)
    // 0 = 사실상 끔(120Hz에서 α≈0.95), 0.9 = 잔떨림만 남기고 누른다. 사이는 지수적으로.
    const minCutoff = 400 * Math.pow(0.008, s)
    return new OneEuroFilter(minCutoff, 0.004 + 0.05 * s)
  }
}

// ───────── 점 간격 ─────────

/**
 * 저장할 점의 최소 월드 간격.
 * 화면에서 cssPx보다 가까운 점은 입력 떨림으로 보고 점으로 만들지 않는다(필압만 합친다).
 * 화면 거리 = 월드 거리 × zoom 이므로 월드 간격 = cssPx / zoom — 화면 기준으로는 어느 배율에서나 같은 밀도다.
 * 이 필터로 선이 매끄러워지고 점 수가 줄어 입력 지연도 함께 줄어든다.
 *
 * 화면 기준으로 일정하므로 배율이 달라도 점 밀도(획 모양)가 같다.
 *
 * 참고: 2000% 같은 극단 배율에서는 같은 손 동작의 "월드" 획 길이가 아주 짧아져
 * perfect-freehand의 월드 기준 리샘플링이 상대적으로 거칠어지고, 실효 굵기 편차가 25% 남는다.
 * 이는 점 간격 문제가 아니라 라이브러리 리샘플링 문제라 여기서는 다루지 않는다(별도 과제).
 */
export function minPointDist(zoom: number, cssPx = 0.55): number {
  return cssPx / Math.max(0.05, zoom)
}

// ───────── 획 끝 날카로움 (Tip Sharpness) ─────────

/**
 * 획 끝을 플릭에 따라 가늘게 다듬는다 (GoodNotes의 Tip Sharpness에 해당).
 * 빠르게 스쳐 끝난 획만 손보고, 천천히 멈춘 획은 그대로 둔다 — 손으로 멈춘 획 끝이
 * 뾰족해지면 오히려 부자연스럽다. 필압(굵기)을 직접 줄이므로 thinning이 0인
 * 일정 굵기 모드에서는 아무 일도 하지 않는다.
 *
 * @returns 실제로 적용한 세기(0~1) — HUD·검증용
 */
export function taperStrokeEnd(points: number[], strength: number, zoom: number, maxPoints = 8): number {
  const s = clamp01(strength)
  const n = points.length / 4
  if (s <= 0 || n < 4) return 0
  const take = Math.min(maxPoints, n - 1)
  // 끝부분의 "화면 기준" 속도 (px/s)
  let moved = 0
  let ms = 0
  for (let k = n - take; k < n; k++) {
    const i = k * 4
    moved += Math.hypot(points[i] - points[i - 4], points[i + 1] - points[i - 3]) * zoom
    ms += Math.max(1, points[i + 3])
  }
  if (!(ms > 0)) return 0
  const speed = moved / (ms / 1000)
  const flick = clamp((speed - 350) / 850, 0, 1) // 350px/s 이하는 그대로, 1200px/s 이상이면 최대
  const amount = s * flick
  if (amount <= 0.01) return 0
  for (let k = 0; k < take; k++) {
    const i = (n - take + k) * 4
    points[i + 2] = clamp01(points[i + 2] * (1 - amount * ((k + 1) / take) * 0.9))
  }
  return amount
}
