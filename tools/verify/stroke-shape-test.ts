// 짧은 획 모양 — 크게 확대해 살짝 그은 획·탭이 반달이나 꼬리 달린 점이 되지 않는다 (src/engine/geometry.ts)
import { strokeOutline } from '../../src/engine/geometry.ts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ' — ' + detail}`)
}
const opts = { thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false }
const flat = (pts: number[][]) => pts.flatMap(([x, y, p]) => [x, y, p, 16])
const box = (o: number[][]) => {
  const xs = o.map((p) => p[0])
  const ys = o.map((p) => p[1])
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
}

console.log('짧은 획 모양')
{
  const o = strokeOutline(flat([[10, 20, 0.5]]), 2.5, opts, true)
  const far = Math.max(...o.map(([x, y]) => Math.abs(Math.hypot(x - 10, y - 20) - 1.25)))
  check('탭(점 하나): 가운데를 중심으로 한 원(반지름 = 굵기/2)', far < 0.01, far.toFixed(3))
}
{
  const b = box(strokeOutline(flat([[0, 0, 0.5], [0.06, 0, 0.5]]), 2.5, opts, true))
  check('아주 짧은 두 점: 꼬리 없이 둥근 점', Math.abs(b.y1 - b.y0 - 2.5) < 0.05 && b.x1 - b.x0 < 2.7, JSON.stringify(b))
}
{
  const b = box(strokeOutline(flat([[0, 0, 0.5], [0.5, 0, 0.5], [1, 0, 0.5], [1.5, 0, 0.5]]), 2.5, opts, true))
  check('굵기보다 짧은 획(1.5): 위아래가 같다 — 한쪽이 납작한 반달이 아니다', Math.abs(b.y1 + b.y0) < 0.05 && Math.abs(b.y1 - 1.25) < 0.05, JSON.stringify(b))
  check('굵기보다 짧은 획(1.5): 길이 = 획 길이 + 굵기', Math.abs(b.x1 - b.x0 - 4) < 0.05, JSON.stringify(b))
}
{
  const b = box(strokeOutline(flat([[0, 0, 0.1], [0.25, 0, 0.9], [0.5, 0, 0.9]]), 2.5, opts, true))
  check('펜을 댈 때 약한 필압에 끌리지 않는 굵기(필압 중앙값, perfect-freehand와 같은 반지름)', Math.abs(b.y1 - 2.5 * (0.5 - 0.5 * (0.5 - 0.9))) < 0.05, JSON.stringify(b))
}
// 굵기의 1~4배 — 조금 더 길게 살짝 그은 획
const capsule = (o: number[][], len: number, r: number) => {
  // 중심선 (0,0)→(len,0), 반지름 r인 캡슐에서 가장 멀리 벗어난 거리
  return Math.max(...o.map(([x, y]) => Math.abs(Math.hypot(x - Math.min(len, Math.max(0, x)), y) - r)))
}
{
  // 펜처럼: 약하게 대고 → 눌렀다 → 떼면서 오른쪽 아래로 짧게 꺾임(갈고리)
  const pts = Array.from({ length: 12 }, (_, i) => {
    const t = i / 11
    const p = Math.sin(Math.PI * Math.min(1, t * 1.1)) * 0.6 + 0.15
    return t <= 0.9 ? [t * 6, 0, p] : [5.4 + (t - 0.9) * 3, (t - 0.9) * 6, p]
  })
  const o = strokeOutline(flat(pts), 2.5, opts, true)
  const b = box(o)
  check('짧은 획(굵기의 2배): 떼면서 생긴 갈고리는 떼어 내 끝이 혹으로 부풀지 않는다', b.y1 < 1.25 * 1.15 + 0.05, JSON.stringify(b))
  check('짧은 획: 대고 떼는 약한 필압에도 굵기가 하나 — 올챙이가 아니다', Math.abs(b.y1 + b.y0) < 0.1, JSON.stringify(b))
}
{
  // 마우스처럼: 좌표가 0.05씩 오르내린다
  const pts = Array.from({ length: 40 }, (_, i) => [i * 0.2, Math.round(Math.sin(i / 2) * 1.2) * 0.05, 0.5])
  const o = strokeOutline(flat(pts), 2.5, { ...opts, simulatePressure: true }, true)
  const len = 39 * 0.2
  const far = capsule(o, len, 2.5 * (0.5 - 0.5 * (0.5 - 0.5)))
  check('짧은 획(굵기의 3배): 떨림이 가장자리 물결·양끝 혹으로 드러나지 않는 둥근 막대', far < 0.08, far.toFixed(3))
}
{
  // 듬성한 점 넷이 살짝 휘었다
  const pts = [[0, 0, 0.5], [2, 0.3, 0.5], [4, 0.3, 0.5], [6, 0, 0.5]]
  const o = strokeOutline(flat(pts), 2.5, opts, true)
  const b = box(o)
  check('듬성한 점의 짧은 획: 꺾인 자리가 모나지 않고 둥근 막대 굵기 그대로', b.y1 - b.y0 < 2.5 + 0.35 && b.x1 - b.x0 > 6 + 2.4, JSON.stringify(b))
}
{
  const pts = Array.from({ length: 21 }, (_, i) => [i * 0.5, Math.sin(i / 3), 0.5])
  const o = strokeOutline(flat(pts), 2.5, opts, true)
  const b = box(o)
  check('보통 길이의 획은 그대로(perfect-freehand) — 곡선을 따라간다', b.x1 - b.x0 > 11 && o.length > 30, JSON.stringify({ ...b, n: o.length }))
}

console.log('크게 확대해 천천히 그은 획')
{
  // 2000%로 확대해 천천히 — 화면 0.6px마다 점, 화면 ±0.4px 손떨림, 좌표는 0.01pt로 반올림(엔진처럼), 화면 0.55px보다 가까운 점은 뺀다
  const zoom = 20
  const r2 = (v: number) => Math.round(v * 100) / 100
  let seed = 11
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const slow = (fwd: number, back: number) => {
    seed = 11
    const pts: number[][] = []
    const add = (sx: number, sy: number) => {
      const x = r2(sx / zoom)
      const y = r2(sy / zoom)
      const l = pts[pts.length - 1]
      if (!l || Math.hypot(x - l[0], y - l[1]) * zoom >= 0.55) pts.push([x, y, 0.5])
    }
    for (let x = 0; x <= fwd; x += 0.6) add(x, (rnd() - 0.5) * 0.8)
    for (let b = 0.6; b <= back; b += 0.6) add(fwd - b, (rnd() - 0.5) * 0.8)
    return flat(pts)
  }
  const modes = {
    속도: { thinning: 0.42, smoothing: 0.5, streamline: 0.3, simulatePressure: true },
    필압: { thinning: 0.6, smoothing: 0.5, streamline: 0.3, simulatePressure: false }
  }
  for (const [name, o] of Object.entries(modes)) {
    const tip = 300 / zoom
    for (const back of [4, 10, 30, 50]) {
      for (const last of [true, false]) {
        const ol = strokeOutline(slow(300, back), 2.5, o, last)
        const over = (Math.max(...ol.map((q) => q[0])) - tip) / 1.25 // 끝 너머 잉크(반지름 배수)
        check(`${name}: 화면 ${back}px 되돌려도 그어 놓은 끝이 잘리지 않는다(${last ? '확정' : '그리는 중'})`, over > 0.7, over.toFixed(2))
      }
    }
    // 손떨림이 가장자리 가시로 — 긴 변(양끝 굵기만큼 뺀 가운데)에서 외곽선이 앞뒤로 튀지 않는다
    const ol = strokeOutline(slow(300, 0), 2.5, o, true)
    // 외곽선은 한쪽 변을 앞으로(x 증가), 끝 모자를 돌아 다른 쪽 변을 뒤로 간다 — 한 변 안에서 거꾸로 가는 만큼이 가시
    const mid = (q: number[]) => q[0] > 2.5 && q[0] < tip - 2.5 && Math.abs(q[1]) > 0.5
    const first = Math.sign(ol.find(mid)![1])
    let spike = 0
    for (let i = 1; i < ol.length; i++) {
      const [a, b] = [ol[i - 1], ol[i]]
      if (!mid(a) || !mid(b) || Math.sign(a[1]) !== Math.sign(b[1])) continue
      spike = Math.max(spike, Math.sign(a[1]) === first ? a[0] - b[0] : b[0] - a[0])
    }
    check(`${name}: 손떨림이 가장자리 가시로 드러나지 않는다`, spike < 0.1, (spike * zoom).toFixed(1) + '화면px')
  }
}

console.log(`\n획 모양: ${pass}개 통과, ${fail}개 실패`)
if (fail) process.exit(1)
console.log('모든 획 모양 검사 통과 ✓')
