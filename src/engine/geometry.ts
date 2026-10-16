import { getStroke } from 'perfect-freehand'
import type { StrokeOpts } from '../shared/model'

/** 평탄 배열 [x,y,p,dt,...] → perfect-freehand 외곽선 */
export function strokeOutline(
  points: number[],
  width: number,
  opts: StrokeOpts,
  last: boolean,
  extra?: number[][] // 예측 점 (저장하지 않고 입력 레이어에만 사용)
): number[][] {
  const input: number[][] = []
  for (let i = 0; i < points.length; i += 4) input.push([points[i], points[i + 1], points[i + 2]])
  if (extra) for (const p of extra) input.push(p)
  if (input.length === 0) return []
  // 펜 굵기보다 짧은 획(크게 확대해 살짝 그은 것·탭)은 perfect-freehand가 한쪽이 납작한 반달이나
  // 꼬리 달린 점(점 하나면 (1, 1) 떨어진 가짜 점을 더한다)을 만든다 — 점마다 원을 놓고 감싼 모양으로 그린다
  if (pathLength(input) < width * SHORT_STROKE) return shortOutline(input, width, opts)
  return getStroke(input, {
    size: width,
    thinning: opts.thinning,
    smoothing: opts.smoothing,
    streamline: opts.streamline,
    simulatePressure: opts.simulatePressure,
    last,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 }
  })
}

/** 이보다 짧은(펜 굵기 배수) 획은 shortOutline으로 그린다 — perfect-freehand는 굵기의 0.8배 길이부터 모양이 바르다 */
const SHORT_STROKE = 1

function pathLength(pts: number[][]): number {
  let n = 0
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return n
}

/** perfect-freehand와 같은 반지름 — size × (0.5 − thinning × (0.5 − 필압)) */
const radiusOf = (size: number, thinning: number, p: number) => Math.max(size * 0.2, size * (0.5 - thinning * (0.5 - p)))

/** 짧은 획 — 점마다 반지름 r인 원을 놓고 그 전체를 감싸는 볼록 다각형(짧은 획은 거의 볼록이다). 점 하나면 원 */
function shortOutline(pts: number[][], size: number, opts: StrokeOpts): number[][] {
  const SEG = 20
  const ring: number[][] = []
  for (const [x, y, p] of pts) {
    const r = radiusOf(size, opts.thinning, opts.simulatePressure ? 0.5 : (p ?? 0.5))
    for (let k = 0; k < SEG; k++) {
      const t = (k / SEG) * Math.PI * 2
      ring.push([x + Math.cos(t) * r, y + Math.sin(t) * r])
    }
  }
  return convexHull(ring)
}

/** 볼록 껍질 (Andrew 단조 사슬) */
function convexHull(pts: number[][]): number[][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: number[][] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: number[][] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

/** 외곽선 다각형 → 곡선으로 매끄럽게 이은 Path2D */
export function outlineToPath(pts: number[][]): Path2D {
  const path = new Path2D()
  const n = pts.length
  if (n < 3) return path
  path.moveTo((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2)
  for (let i = 1; i <= n; i++) {
    const a = pts[i % n]
    const b = pts[(i + 1) % n]
    path.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
  }
  path.closePath()
  return path
}

/** 점 배열의 bbox. perfect-freehand 반지름은 최대 width이므로 width만큼 넓힌다 */
export function pointsBBox(points: number[], width: number): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < points.length; i += 4) {
    const x = points[i], y = points[i + 1]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  const pad = width + 1
  return [minX - pad, minY - pad, maxX + pad, maxY + pad]
}

/** 소수점 2자리 양자화 — 저장 크기를 줄인다 (0.01pt 아래는 눈에 보이지 않는다) */
export const q2 = (v: number) => Math.round(v * 100) / 100

/** 점 (px, py)와 획 중심선 사이 거리가 r 이하인지 (획 단위 지우개) */
export function hitStroke(points: number[], px: number, py: number, r: number): boolean {
  const r2 = r * r
  if (points.length === 4) {
    const dx = points[0] - px, dy = points[1] - py
    return dx * dx + dy * dy <= r2
  }
  for (let i = 0; i + 4 < points.length; i += 4) {
    if (segDist2(px, py, points[i], points[i + 1], points[i + 4], points[i + 5]) <= r2) return true
  }
  return false
}

export function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx - px, cy = ay + t * dy - py
  return cx * cx + cy * cy
}

/** 짝수-홀수 규칙 점-다각형 포함 판정. poly = [x0,y0,x1,y1,...] */
export function pointInPolygon(x: number, y: number, poly: number[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 올가미 선택 판정: 점의 60% 이상이 다각형 안에 있으면 선택 */
export function strokeInPolygon(points: number[], ox: number, oy: number, poly: number[]): boolean {
  const n = points.length / 4
  const stride = Math.max(1, Math.floor(n / 40)) // 긴 획은 표본만 검사
  let inside = 0
  let total = 0
  for (let i = 0; i < n; i += stride) {
    total++
    if (pointInPolygon(points[i * 4] + ox, points[i * 4 + 1] + oy, poly)) inside++
  }
  return total > 0 && inside / total >= 0.6
}
