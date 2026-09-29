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

/** 소수점 2자리 양자화 (설계 7.2) */
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

/**
 * 부분 지우개 (FR-TL-03, 획 분할 방식).
 * 지우개 원 안에 들어간 점을 빼고 남은 연속 구간들을 돌려준다. 원이 점 사이를 지나가는 경우를 위해
 * 간격이 넓은 구간은 먼저 잘게 나눈다. 지우개에 닿지 않았으면 null.
 */
export function splitStroke(points: number[], cx: number, cy: number, r: number): number[][] | null {
  const r2 = r * r
  const step = Math.max(0.5, r / 2)
  // 1) 조밀화
  const dense: number[] = []
  for (let i = 0; i < points.length; i += 4) {
    if (i > 0) {
      const ax = points[i - 4], ay = points[i - 3], ap = points[i - 2]
      const bx = points[i], by = points[i + 1], bp = points[i + 2]
      const d = Math.hypot(bx - ax, by - ay)
      if (d > step) {
        const n = Math.ceil(d / step)
        for (let k = 1; k < n; k++) {
          const t = k / n
          dense.push(ax + (bx - ax) * t, ay + (by - ay) * t, ap + (bp - ap) * t, 0)
        }
      }
    }
    dense.push(points[i], points[i + 1], points[i + 2], points[i + 3])
  }
  // 2) 원 안의 점 제거
  let hit = false
  const runs: number[][] = []
  let cur: number[] = []
  for (let i = 0; i < dense.length; i += 4) {
    const dx = dense[i] - cx, dy = dense[i + 1] - cy
    if (dx * dx + dy * dy <= r2) {
      hit = true
      if (cur.length) runs.push(cur)
      cur = []
    } else {
      cur.push(q2(dense[i]), q2(dense[i + 1]), q2(dense[i + 2]), dense[i + 3])
    }
  }
  if (cur.length) runs.push(cur)
  if (!hit) return null
  // 너무 짧은 조각은 버린다
  return runs.filter((r) => r.length >= 8 || (r.length === 4 && points.length === 4))
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
