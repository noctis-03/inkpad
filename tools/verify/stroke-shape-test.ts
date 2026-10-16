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

console.log(`\n획 모양: ${pass}개 통과, ${fail}개 실패`)
if (fail) process.exit(1)
console.log('모든 획 모양 검사 통과 ✓')
