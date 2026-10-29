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
  // 짧은 획(굵기의 4배 미만 — 크게 확대해 살짝 그은 것)은 perfect-freehand가 반달·올챙이·울퉁불퉁한 모양을 만든다
  // (점이 듬성하거나 펜을 대고 뗄 때의 작은 갈고리, 굵기와 맞먹는 길이). 점 하나(탭)면 (1, 1) 떨어진 가짜 점을 더해 꼬리가 생긴다.
  // 그래서 짧은 획은 갈고리를 떼고 촘촘히 한 뒤 직접 그린다 — 굵기보다 짧으면 원들을 감싼 모양, 그 이상은 둥근 붓 모양
  if (pathLength(input) < width * TIDY_STROKE) {
    const pts = tidyShort(input, width)
    const r = briefRadius(input, width, opts) // 다듬기 전 점들로(사이값이 필압을 흐리지 않게)
    return pathLength(pts) < width * SHORT_STROKE ? shortOutline(pts, r) : brushOutline(pts, width, r)
  }
  // perfect-freehand는 화면 좌표를 생각하고 만들어, 획 끝 3단위 안의 점을 건너뛴다(끝 떨림 무시).
  // 2000%로 확대해 그리면 3pt가 화면 60px이라 — 천천히 긋다 살짝 되돌리면 되돌린 점들이 이 안에 들어
  // 꺾임 처리를 건너뛰고 마지막 점만 거꾸로 붙어, 그어 놓은 끝이 잘려 나간다.
  // 굵기 PF_SIZE인 좌표로 늘여 넘기고 되돌린다 — 다른 기준(외곽선 점 간격·속도 필압·시작 건너뛰기)은 모두 굵기 비례라 그대로이고,
  // 끝 떨림은 sparse가 맡는다
  const k = PF_SIZE / width
  const out = getStroke(
    sparse(input, width * PF_STEP).map(([x, y, p]) => [x * k, y * k, p]),
    {
      size: PF_SIZE,
      thinning: opts.thinning,
      smoothing: opts.smoothing,
      streamline: opts.streamline,
      simulatePressure: opts.simulatePressure,
      last,
      start: { cap: true, taper: 0 },
      end: { cap: true, taper: 0 }
    }
  )
  for (const q of out) {
    q[0] /= k
    q[1] /= k
  }
  return out
}

/** perfect-freehand에 넘기는 굵기 — 이 좌표에서 끝 건너뛰기(3단위)는 굵기의 0.02배로, 솎은 점 간격(PF_STEP)보다 짧다 */
const PF_SIZE = 128
/** perfect-freehand에 넘기는 점 사이 최소 간격(펜 굵기 배수) */
const PF_STEP = 0.1

/**
 * 점을 솎는다 — 바로 앞에 남긴 점에서 step보다 가까운 점은 뺀다(처음·마지막 점은 남긴다).
 * perfect-freehand는 이웃한 두 점의 방향으로 가장자리를 세운다. 크게 확대해 천천히 그으면 점 간격이 굵기의 1%쯤이라
 * 손떨림·좌표 반올림(0.01pt)만으로 방향이 수십 도씩 흔들리고, 가장자리가 굵기의 절반만큼 앞뒤로 튀어 가시가 된다.
 * 보통 배율에서는 입력 단계에서 이미 화면 0.55px 간격이라(minPointDist) 거의 솎이지 않는다.
 * 뺀 점들 가운데 갔다가 되돌아온 끝(꺾인 자리)은 남긴다 — 빼면 그어 놓은 끝이 그만큼 줄어든다
 */
function sparse(input: number[][], step: number): number[][] {
  const n = input.length
  if (n < 3) return input
  const out = [input[0]]
  const s2 = step * step
  let far: number[] | null = null // 마지막으로 남긴 점에서 가장 멀리 간 뺀 점
  let farD = 0
  for (let i = 1; i < n; i++) {
    const p = input[i]
    const a = out[out.length - 1]
    const d2 = (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2
    const last = i === n - 1
    if (d2 < s2 && !last) {
      if (d2 > farD) {
        far = p
        farD = d2
      }
      continue
    }
    // far까지 갔다가 p로 step의 1/4 넘게 되돌아왔으면 far를 남긴다
    let back = false
    if (far) {
      const [ux, uy] = unit(far[0] - a[0], far[1] - a[1])
      back = (p[0] - far[0]) * ux + (p[1] - far[1]) * uy < -step * 0.25
    }
    if (back) out.push(far!, p)
    else if (last && d2 < s2 / 4 && out.length > 1) out[out.length - 1] = p // 마지막 점이 바로 앞 점에 붙어 있으면 바꾼다(끝에서 방향이 튀지 않게)
    else out.push(p)
    far = null
    farD = 0
  }
  return out
}

/** 이보다 짧은(펜 굵기 배수) 획은 shortOutline으로 그린다 — perfect-freehand는 굵기의 0.8배 길이부터 모양이 바르다 */
const SHORT_STROKE = 1
/** 이보다 짧은(펜 굵기 배수) 획은 perfect-freehand 대신 직접 그린다(tidyShort → shortOutline / brushOutline) */
const TIDY_STROKE = 4

/** 단위 벡터 (길이 0이면 0) */
function unit(dx: number, dy: number): [number, number] {
  const l = Math.hypot(dx, dy)
  return l ? [dx / l, dy / l] : [0, 0]
}

/**
 * 짧은 획 다듬기 — 끝(펜을 뗄 때)과 처음(펜을 댈 때)의 작은 갈고리를 떼고, 점이 듬성하면 촘촘히 채운다.
 * 갈고리: 그 끝에서 굵기의 0.35배 길이 안에서 획의 큰 방향과 45° 넘게 어긋나는 점들. 그보다 긴 꺾임(✓ 같은)은 그대로 둔다
 */
function tidyShort(input: number[][], width: number): number[][] {
  let pts = input
  const trim = (seq: number[][]) => {
    const n = seq.length
    if (n < 3) return seq
    // 큰 방향: 처음 → 길이 70% 지점
    const total = pathLength(seq)
    let acc = 0
    let k = n - 1
    for (let i = 1; i < n; i++) {
      acc += Math.hypot(seq[i][0] - seq[i - 1][0], seq[i][1] - seq[i - 1][1])
      if (acc >= total * 0.7) {
        k = i
        break
      }
    }
    const d = unit(seq[k][0] - seq[0][0], seq[k][1] - seq[0][1])
    let end = n
    let tail = 0
    while (end > 2) {
      const a = seq[end - 2]
      const b = seq[end - 1]
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      const u = unit(b[0] - a[0], b[1] - a[1])
      if (tail + len > width * 0.35 || u[0] * d[0] + u[1] * d[1] >= 0.7) break
      tail += len
      end--
    }
    return end < n ? seq.slice(0, end) : seq
  }
  pts = trim(pts) // 끝 갈고리
  pts = trim([...pts].reverse()).reverse() // 처음 갈고리
  // 꺾인 곳을 둥글게(Chaikin, 양끝은 그대로) — 점이 듬성하면 꺾인 자리가 가장자리 혹으로 드러난다
  for (let k = 0; k < 3 && pts.length > 2; k++) {
    const next: number[][] = [pts[0]]
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      const mix = (t: number) => a.map((v, j) => v + ((b[j] ?? v) - v) * t)
      if (i > 1) next.push(mix(0.25))
      if (i < pts.length - 1) next.push(mix(0.75))
    }
    next.push(pts[pts.length - 1])
    pts = next
  }
  // 촘촘히 — 굵기의 0.12배 간격(필압도 사이값)
  const step = width * 0.12
  const out: number[][] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const m = Math.floor(len / step)
    for (let j = 1; j <= m; j++) {
      const t = (j * step) / len
      if (t >= 1) break
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (a[2] ?? 0.5) + ((b[2] ?? 0.5) - (a[2] ?? 0.5)) * t])
    }
    out.push(b)
  }
  return out
}

function pathLength(pts: number[][]): number {
  let n = 0
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return n
}

/** perfect-freehand와 같은 반지름 — size × (0.5 − thinning × (0.5 − 필압)) */
const radiusOf = (size: number, thinning: number, p: number) => Math.max(size * 0.2, size * (0.5 - thinning * (0.5 - p)))

/**
 * 짧은 획의 반지름 — 굵기를 하나로(필압 중앙값). 펜을 대고 뗄 때의 약한 필압이 이렇게 짧은 획에선 올챙이·혹·움푹한 모양으로만 드러난다.
 * 중앙값이라 대고 떼는 순간의 몇 점에 끌려 가늘어지지 않는다
 */
function briefRadius(pts: number[][], size: number, opts: StrokeOpts): number {
  if (opts.simulatePressure) return radiusOf(size, opts.thinning, 0.5)
  const ps = pts.map((p) => p[2] ?? 0.5).sort((a, b) => a - b)
  const m = ps.length >> 1
  return radiusOf(size, opts.thinning, ps.length % 2 ? ps[m] : (ps[m - 1] + ps[m]) / 2)
}

/** 짧은 획 — 점마다 반지름 r인 원을 놓고 그 전체를 감싸는 볼록 다각형(짧은 획은 거의 볼록이다). 점 하나면 원 */
function shortOutline(pts: number[][], r: number): number[][] {
  const SEG = 20
  const ring: number[][] = []
  for (const [x, y] of pts) {
    for (let k = 0; k < SEG; k++) {
      const t = (k / SEG) * Math.PI * 2
      ring.push([x + Math.cos(t) * r, y + Math.sin(t) * r])
    }
  }
  return convexHull(ring)
}

/**
 * 둥근 붓 모양 — 중심선(촘촘한 점) 양옆으로 점마다 반지름만큼 띄운 두 선을 잇고, 양끝은 반원으로 닫는다.
 * 짧은 획(갈고리를 뗀 뒤)은 꺾임이 작아 두 선이 꼬이지 않는다
 */
function brushOutline(input: number[][], size: number, rad: number): number[][] {
  const n = input.length
  // 중심선을 고른다 — 손떨림·좌표 반올림이 가장자리 물결·양끝 혹으로 드러나지 않게(perfect-freehand의 streamline 몫).
  // 점마다 획 길이 ±굵기의 0.5배 안의 점들에 직선을 맞춰 그 자리 값을 쓴다(끝에선 한쪽 점만으로 — 평균과 달리 안쪽으로 끌리지 않는다)
  const s: number[] = [0]
  for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(input[i][0] - input[i - 1][0], input[i][1] - input[i - 1][1]))
  const W = size * 0.5
  const pts = input.map((p, i) => {
    let c = 0
    let ms = 0
    let mx = 0
    let my = 0
    for (let j = 0; j < n; j++) {
      if (Math.abs(s[j] - s[i]) > W) continue
      c++
      ms += s[j]
      mx += input[j][0]
      my += input[j][1]
    }
    ms /= c
    mx /= c
    my /= c
    let ss = 0
    let sx = 0
    let sy = 0
    for (let j = 0; j < n; j++) {
      if (Math.abs(s[j] - s[i]) > W) continue
      const d = s[j] - ms
      ss += d * d
      sx += d * (input[j][0] - mx)
      sy += d * (input[j][1] - my)
    }
    const t = ss ? (s[i] - ms) / ss : 0
    return [mx + sx * t, my + sy * t, p[2]]
  })
  const r = pts.map(() => rad)
  const tan = pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(n - 1, i + 1)]
    return unit(b[0] - a[0], b[1] - a[1])
  })
  // 꺾이는 곳의 안쪽 가장자리는 뒤로 물러나 접힌다(반지름이 꺾임보다 크면) — 진행 방향으로 나아가지 않는 점은 건너뛴다
  const left: number[][] = []
  const right: number[][] = []
  const keep = (side: number[][], q: number[], i: number) => {
    const last = side[side.length - 1]
    if (!last || (q[0] - last[0]) * tan[i][0] + (q[1] - last[1]) * tan[i][1] > 1e-6) side.push(q)
  }
  for (let i = 0; i < n; i++) {
    const [tx, ty] = tan[i]
    keep(left, [pts[i][0] - ty * r[i], pts[i][1] + tx * r[i]], i)
    keep(right, [pts[i][0] + ty * r[i], pts[i][1] - tx * r[i]], i)
  }
  const cap = (c: number[], rad: number, from: number[], dir: number[]) => {
    // from(한쪽 가장자리)에서 dir 쪽으로 돌아 반대쪽 가장자리까지 반원
    const out: number[][] = []
    const a0 = Math.atan2(from[1] - c[1], from[0] - c[0])
    const ad = Math.atan2(dir[1], dir[0])
    let sweep = ad - a0
    while (sweep <= -Math.PI) sweep += Math.PI * 2
    while (sweep > Math.PI) sweep -= Math.PI * 2
    const sgn = Math.sign(sweep) || 1
    for (let k = 1; k < 12; k++) {
      const t = a0 + sgn * (Math.PI * k) / 12
      out.push([c[0] + Math.cos(t) * rad, c[1] + Math.sin(t) * rad])
    }
    return out
  }
  return [
    ...left,
    ...cap(pts[n - 1], r[n - 1], left[left.length - 1], tan[n - 1]),
    ...right.reverse(),
    ...cap(pts[0], r[0], right[0] ? [pts[0][0] + tan[0][1] * r[0], pts[0][1] - tan[0][0] * r[0]] : pts[0], [-tan[0][0], -tan[0][1]])
  ]
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
/** os: 페이지 내용 배율 — 월드 = 원점 + 점 × os */
export function strokeInPolygon(points: number[], ox: number, oy: number, poly: number[], os = 1): boolean {
  const n = points.length / 4
  const stride = Math.max(1, Math.floor(n / 40)) // 긴 획은 표본만 검사
  let inside = 0
  let total = 0
  for (let i = 0; i < n; i += stride) {
    total++
    if (pointInPolygon(points[i * 4] * os + ox, points[i * 4 + 1] * os + oy, poly)) inside++
  }
  return total > 0 && inside / total >= 0.6
}
