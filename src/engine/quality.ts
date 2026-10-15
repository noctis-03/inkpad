// 펜 품질 보조 — 순수 함수만 두어 단위 시뮬레이션으로 검증할 수 있게 한다.

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * 필압 지수 평활(EMA).
 * 펜이 보내는 필압 원시값은 이벤트마다 튀어서, 그대로 굵기에 쓰면 선 굵기가 계단처럼 변한다.
 * 직전 값과 섞어(EMA) 굵기 변화를 매끄럽게 만든다.
 *  - smoothing 0 → 원값 그대로 (반응 최우선)
 *  - smoothing 1 → 15%만 이동 (상한을 두어 완전히 굳어 반응이 죽지 않게)
 */
export function smoothPressure(prev: number, raw: number, smoothing: number): number {
  const alpha = 1 - clamp01(smoothing) * 0.85
  return prev + (raw - prev) * alpha
}

/**
 * 저장할 점의 최소 월드 간격.
 * 화면에서 cssPx보다 가까운 점은 입력 떨림으로 보고 점으로 만들지 않는다(필압만 합친다).
 * 화면 거리 = 월드 거리 × zoom 이므로 월드 간격 = cssPx / zoom.
 * 이 필터로 선이 매끄러워지고 점 수가 줄어 입력 지연도 함께 줄어든다.
 */
export function minPointDist(zoom: number, cssPx = 0.55): number {
  return cssPx / Math.max(0.05, zoom)
}
