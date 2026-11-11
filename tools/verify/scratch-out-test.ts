// 지그재그로 긋기(스크래치 아웃) 판정 — src/engine/geometry.ts isScratchOut. 지그재그는 잡고, 글씨·도형은 잡지 않는가
import { convexHullFlat, isScratchOut } from '../../src/engine/geometry.ts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean) {
  if (cond) pass++
  else fail++
  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
}

/** 꼭짓점을 잇는 꺾은선을 촘촘한 점(청크 좌표 [x, y, p, dt])으로 — 약간 흔들어 손으로 그린 것처럼 */
function poly(vs: number[][], step = 1.5, seed = 1): number[] {
  let r = seed
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647 - 0.5) * 0.6
  const out: number[] = []
  for (let i = 0; i + 1 < vs.length; i++) {
    const [ax, ay] = vs[i], [bx, by] = vs[i + 1]
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step))
    for (let j = 0; j < n; j++) out.push(ax + ((bx - ax) * j) / n + rnd(), ay + ((by - ay) * j) / n + rnd(), 0.5, 8)
  }
  const [x, y] = vs[vs.length - 1]
  out.push(x, y, 0.5, 8)
  return out
}
function curve(f: (t: number) => number[], n = 200): number[] {
  const out: number[] = []
  for (let i = 0; i <= n; i++) out.push(...f(i / n), 0.5, 8)
  return out
}

// 잡아야 하는 것
const zig: number[][] = [] // 사진처럼 위아래로 오가며 오른쪽으로 (살짝 내려가며)
for (let i = 0; i < 14; i++) zig.push([i * 8, (i % 2 ? 0 : 20) + i * 1.5])
check('위아래 지그재그(오른쪽으로 나아가며)', isScratchOut(poly(zig)))
const hz: number[][] = [] // 같은 자리를 좌우로 왔다 갔다
for (let i = 0; i < 8; i++) hz.push([i % 2 ? 0 : 80, i * 2])
check('좌우로 왔다 갔다', isScratchOut(poly(hz)))
check('둥글게 꺾이는 지그재그', isScratchOut(curve((t) => [t * 120, Math.sin(t * Math.PI * 12) * 12], 400)))

// 잡지 말아야 하는 것
check('직선', !isScratchOut(poly([[0, 0], [100, 30]])))
check('동그라미', !isScratchOut(curve((t) => [Math.cos(t * 2 * Math.PI) * 30, Math.sin(t * 2 * Math.PI) * 30])))
check('ㄹ', !isScratchOut(poly([[0, 0], [30, 0], [30, 15], [0, 15], [0, 30], [30, 30]])))
check('w', !isScratchOut(poly([[0, 0], [8, 30], [16, 10], [24, 30], [32, 0]])))
check('m', !isScratchOut(poly([[0, 30], [0, 0], [0, 5], [10, 0], [12, 30], [12, 5], [22, 0], [24, 30]])))
check('나선', !isScratchOut(curve((t) => [Math.cos(t * 6 * Math.PI) * 30 * t, Math.sin(t * 6 * Math.PI) * 30 * t], 300)))
check('물결(완만한)', !isScratchOut(curve((t) => [t * 200, Math.sin(t * Math.PI * 6) * 10])))
check('점 몇 개', !isScratchOut(poly([[0, 0], [1, 1]])))

// 볼록 껍질
const h = convexHullFlat([0, 0, 10, 0, 5, 5, 10, 10, 0, 10, 3, 4])
check('볼록 껍질: 네 모서리만', h.length === 8)

console.log(`\n지그재그 판정: ${pass} 통과, ${fail} 실패`)
if (fail) process.exit(1)
