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
  const b = box(strokeOutline(flat([[0, 0, 0.1], [0.5, 0, 0.9]]), 2.5, opts, true))
  check('필압이 바뀌어도 가장 굵은 곳 기준(perfect-freehand와 같은 반지름)', Math.abs(b.y1 - 2.5 * (0.5 - 0.5 * (0.5 - 0.9))) < 0.05, JSON.stringify(b))
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
