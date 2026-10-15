/**
 * 펜 품질 회귀 검사 (의존성 없음 — perfect-freehand만 쓴다)
 *
 * 실행: node --experimental-strip-types --no-warnings tools/verify/pen-quality-test.ts
 *       (npm run test:pen, npm test에 포함)
 *
 * 배경: 굵기 계산이 월드 좌표나 "이벤트 개수"에 의존하면, 같은 손 동작이 배율·이벤트 주기에
 * 따라 다른 선이 된다(실측: 월드 기준 속도 추정에서 배율 10% ↔ 2000% 실효 굵기 3.9배 차).
 * 두 펜 스타일(펜·볼펜)의 배율 불변성과 속도 → 굵기 규칙을 계산으로 확인한다.
 *
 * engine.addPoint와 같은 순서(굵기 원값 → 최소 간격 → 저장)를 그대로 흉내 낸다 —
 * 평활은 perfect-freehand의 smoothing·streamline이 맡으므로 따로 흉내 낼 것이 없다.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { strokeOutline } from '../../src/engine/geometry.ts'
import { MIN_STROKE_DEVICE_PX, isHairline, minPointDist, speedToPressure, velocityPressure } from '../../src/engine/quality.ts'
import { strokeOptsFor } from '../../src/engine/pressure.ts'
import type { PenStyleId } from '../../src/engine/types.ts'
import type { StrokeOpts } from '../../src/shared/model.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let pass = 0
const fails: string[] = []
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) pass++
  else fails.push(detail ? `${name} — ${detail}` : name)
}

const ZOOMS = [0.1, 0.25, 0.5, 1, 2, 4, 20]
const WORK = [0.1, 0.25, 0.5, 1, 2, 4] // 실제로 쓰는 작업 범위
const WIDTH = 2 // 펜 굵기 (월드 pt)
const q2 = (v: number) => Math.round(v * 100) / 100

/** 손 동작: 화면 좌표(px). 배율과 무관한 "같은 필기"를 뜻한다 */
const hand = (t: number) => ({
  x: 240 * t,
  y: 12 * Math.sin(2 * Math.PI * 1.8 * t) + 3.5 * Math.sin(2 * Math.PI * 6.1 * t + 0.9)
})

/** 합성 필압 신호 (0.3~0.85) */
const press = (t: number) => 0.3 + 0.55 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 1.6 * t + 0.4))

type Source = 'pressure' | 'velocity' | 'fixed'
interface Sim {
  zoom: number
  rate: number
  source: Source
}

/** engine.addPoint와 같은 순서로 점 배열을 만든다 */
function buildStroke(sim: Sim): number[] {
  const { zoom, rate, source } = sim
  const pts: number[] = []
  const dtMs = 1000 / rate
  let prevScreen: { x: number; y: number } | null = null

  for (let i = 0; i <= rate; i++) {
    const t = i / rate
    const s = hand(t)
    const rdt = i === 0 ? 1 : dtMs

    // 1) 굵기 원값 — 엔진과 같다
    let pr: number
    if (source === 'pressure') pr = Math.min(1, Math.max(0.05, press(t)))
    else if (source === 'velocity') {
      pr = prevScreen ? velocityPressure(s.x - prevScreen.x, s.y - prevScreen.y, rdt) : 0.85
    } else pr = 0.5

    const wx = q2(s.x / zoom)
    const wy = q2(s.y / zoom)
    const n = pts.length
    if (n >= 4) {
      // 화면에서 sub-pixel만큼 움직인 점은 떨림으로 보고 점을 만들지 않는다 (엔진과 같다)
      const dx = wx - pts[n - 4]
      const dy = wy - pts[n - 3]
      const minD = minPointDist(zoom)
      if (dx * dx + dy * dy < minD * minD) {
        if (source === 'pressure') pts[n - 2] = q2(Math.max(pts[n - 2], pr))
        prevScreen = { x: s.x, y: s.y }
        continue
      }
    }
    pts.push(wx, wy, q2(pr), i === 0 ? 0 : Math.round(dtMs))
    prevScreen = { x: s.x, y: s.y }
  }
  return pts
}

/** 외곽선 면적 ÷ 중심선 길이 = 실효 굵기 (월드 단위) */
function effectiveWidth(points: number[], width: number, opts: StrokeOpts): number {
  const poly = strokeOutline(points, width, opts, true)
  if (poly.length < 3) return 0
  let len = 0
  for (let i = 4; i < points.length; i += 4) len += Math.hypot(points[i] - points[i - 4], points[i + 1] - points[i - 3])
  let area = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) area += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]
  return len > 0 ? Math.abs(area) / 2 / len : 0
}

const spread = (xs: number[]) => Math.max(...xs) / Math.min(...xs)

// ───────── 1. 속도 → 굵기 ─────────
check(
  '느리면 굵고 빠르면 가늘다',
  speedToPressure(50) > speedToPressure(600) + 0.3,
  `50px/s=${speedToPressure(50).toFixed(2)} · 600px/s=${speedToPressure(600).toFixed(2)}`
)
let monotone = true
let prev = Infinity
for (let v = 0; v <= 3000; v += 25) {
  const p = speedToPressure(v)
  if (p > prev + 1e-9) monotone = false
  prev = p
}
check('속도에 대해 단조 감소', monotone)
check('상하한 유지 (0.1 ≤ p ≤ 1)', speedToPressure(0) <= 1 && speedToPressure(100000) >= 0.1 && speedToPressure(100000) <= 0.1 + 1e-9)

// ───────── 2. 옵션 고정 (두 스타일이 전부다) ─────────
const ballOpts = strokeOptsFor('ballpen', 'pen')
const penOpts = strokeOptsFor('pen', 'pen')
const hlOpts = strokeOptsFor('ballpen', 'highlighter')
check('볼펜은 굵기 변화가 없다 (thinning 0)', ballOpts.thinning === 0 && hlOpts.thinning === 0)
check('펜은 굵기 변화가 있다 (thinning 0.5)', penOpts.thinning === 0.5)
check('두 스타일 모두 라이브러리 속도 추정을 끈다', !ballOpts.simulatePressure && !penOpts.simulatePressure)
check('streamline은 라이브러리에 맡긴다 (0.5)', ballOpts.streamline === 0.5 && penOpts.streamline === 0.5)
check('형광펜은 항상 일정 굵기', strokeOptsFor('pen', 'highlighter').thinning === 0)
const pressureSrc = readFileSync(join(ROOT, 'src/engine/pressure.ts'), 'utf8')
check('simulatePressure:false가 소스에 있다', pressureSrc.includes('simulatePressure: false'))

// ───────── 3. 배율 불변 ─────────
const ballW = WORK.map((z) => effectiveWidth(buildStroke({ zoom: z, rate: 120, source: 'fixed' }), WIDTH, ballOpts))
check('볼펜: 어느 배율에서나 굵기 일정', spread(ballW) <= 1.05, `편차 ${((spread(ballW) - 1) * 100).toFixed(1)}% · ${ballW.map((w) => w.toFixed(3)).join(' / ')}`)

const penP = WORK.map((z) => effectiveWidth(buildStroke({ zoom: z, rate: 120, source: 'pressure' }), WIDTH, penOpts))
check('펜(필압): 배율 간 편차 8% 이내', spread(penP) <= 1.08, `편차 ${((spread(penP) - 1) * 100).toFixed(1)}%`)

const penV = WORK.map((z) => effectiveWidth(buildStroke({ zoom: z, rate: 120, source: 'velocity' }), WIDTH, penOpts))
check('펜(속도): 배율 간 편차 8% 이내', spread(penV) <= 1.08, `편차 ${((spread(penV) - 1) * 100).toFixed(1)}%`)

// 펜(필압)이 볼펜보다 굵기 변화가 커야 한다 — 스타일이 실제로 다르게 그려지는지
const variety = (pts: number[]) => {
  const ps: number[] = []
  for (let i = 2; i < pts.length; i += 4) ps.push(pts[i])
  return Math.max(...ps) / Math.min(...ps)
}
check('펜(필압)이 볼펜보다 굵기 변화가 크다', variety(buildStroke({ zoom: 1, rate: 120, source: 'pressure' })) > 1, '볼펜은 변화 1.0')

// ───────── 4. 이벤트 주기 불변 (60Hz vs 120Hz) ─────────
const at120 = buildStroke({ zoom: 1, rate: 120, source: 'velocity' })
const at60 = buildStroke({ zoom: 1, rate: 60, source: 'velocity' })
const w120 = effectiveWidth(at120, WIDTH, penOpts)
const w60 = effectiveWidth(at60, WIDTH, penOpts)
check('60Hz와 120Hz가 같은 굵기를 낸다 (8% 이내)', Math.abs(w120 / w60 - 1) <= 0.08, `120Hz ${w120.toFixed(3)} · 60Hz ${w60.toFixed(3)}`)

// ───────── 5. 빠른 획은 가늘다 (속도 모드) ─────────
const straight = (vScreen: number, zoom = 1, rate = 120) => {
  const pts: number[] = []
  const dt = Math.round(1000 / rate)
  const stepScreen = (vScreen * dt) / 1000 // 화면 이동량 (px)
  let pr = 0.85 // 첫 점은 아직 속도를 모른다
  for (let i = 0; i <= 40; i++) {
    if (i > 0) pr = velocityPressure(stepScreen, 0, dt)
    pts.push(q2((i * stepScreen) / zoom), 0, q2(pr), dt)
  }
  return pts
}
const slowW = effectiveWidth(straight(150), WIDTH, penOpts)
const fastW = effectiveWidth(straight(1500), WIDTH, penOpts)
check('빠르게 그은 획이 가늘다', fastW < slowW * 0.75, `느림 ${slowW.toFixed(3)} · 빠름 ${fastW.toFixed(3)}`)

// ───────── 6. 축소 시 중심선 규칙 ─────────
check('10%·DPR2에서 2pt 획은 중심선으로', isHairline(2, 0.1 * 2) === true)
check('100%·DPR2에서는 면으로 그린다', isHairline(2, 1 * 2) === false)
check('임계값 경계', isHairline(1, MIN_STROKE_DEVICE_PX) === false && isHairline(0.99, MIN_STROKE_DEVICE_PX) === true)
check('최소 점 간격은 화면 기준 상수', Math.abs(minPointDist(1) - minPointDist(4) * 4) < 1e-9 && minPointDist(1) === 0.55)

// ───────── 7. package.json에 검사가 묶여 있는가 ─────────
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
check('test:pen이 npm test에 묶여 있다', pkg.scripts['test'].includes('test:pen') && !!pkg.scripts['test:pen'])

console.log(`\n펜 품질: ${pass}개 통과, ${fails.length}개 실패`)
for (const f of fails) console.log(`  ✗ ${f}`)
if (fails.length) process.exitCode = 1
else console.log('모든 펜 품질 검사 통과 ✓')
console.log(`  참고: 볼펜 실효 굵기 — ${ballW.map((w) => w.toFixed(3)).join(' / ')} (요청 ${WIDTH}pt)`)
console.log(`  참고: 펜(필압) 실효 굵기 — ${penP.map((w) => w.toFixed(3)).join(' / ')}`)
console.log(`  참고: 펜(속도) 실효 굵기 — ${penV.map((w) => w.toFixed(3)).join(' / ')}`)
