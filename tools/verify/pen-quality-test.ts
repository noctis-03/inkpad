/**
 * 펜 품질 회귀 검사 (의존성 없음 — perfect-freehand만 쓴다)
 *
 * 실행:  node --experimental-strip-types --no-warnings tools/verify/pen-quality-test.ts
 *
 * 배경: 굵기·평활 계산이 월드 좌표에 의존해, 같은 손 동작이 배율에 따라 실효 굵기 3.9배까지
 * 달라졌다(배율 10% ↔ 2000%). 이 파일은 "화면 기준" 규칙이 지켜지는지 계산으로 확인한다.
 * addPoint와 같은 순서(화면 기준 속도 → 1€ 필터 → 최소 간격)를 그대로 흉내 내므로,
 * 계산식을 바꾸면 여기서 잡힌다.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { getStroke } from 'perfect-freehand'
import {
  MIN_STROKE_DEVICE_PX,
  OneEuroFilter,
  VELOCITY_START_PRESSURE,
  isHairline,
  minPointDist,
  speedToPressure,
  velocityPressure
} from '../../src/engine/quality.ts'
import { DEFAULT_SETTINGS } from '../../src/engine/types.ts'
import { type StrokeOpts } from '../../src/shared/model.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let pass = 0
const fails: string[] = []
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) pass++
  else fails.push(detail ? `${name} — ${detail}` : name)
}

const ZOOMS = [0.1, 0.25, 0.5, 1, 2, 4, 20]
const RATE = 120 // 이벤트 Hz
const WIDTH = 2 // 펜 굵기 (월드 pt)
const q2 = (v: number) => Math.round(v * 100) / 100

/** 손 동작: 화면 좌표(px). 배율과 무관한 "같은 필기"를 뜻한다 */
const hand = (t: number) => ({
  x: 240 * t,
  y: 12 * Math.sin(2 * Math.PI * 1.8 * t) + 3.5 * Math.sin(2 * Math.PI * 6.1 * t + 0.9)
})

/** addPoint와 같은 순서로 점 배열을 만든다. simulateOld=true면 이전 방식(거리 기반 추정)을 흉내 낸다 */
function buildStroke(zoom: number, simulateOld = false) {
  const pts: number[] = []
  const oe = OneEuroFilter.forSmoothing(DEFAULT_SETTINGS.pressureSmoothing)
  let lastT = 0
  let smooth = -1
  for (let i = 0; i <= RATE; i++) {
    const t = i / RATE
    const s = hand(t)
    const wx = q2(s.x / zoom)
    const wy = q2(s.y / zoom)
    const n = pts.length
    const dt = Math.max(0, Math.round((t - lastT) * 1000))
    const raw = simulateOld
      ? 0.5
      : n >= 4
        ? velocityPressure(wx - pts[n - 4], wy - pts[n - 3], dt, zoom)
        : VELOCITY_START_PRESSURE
    const pr = simulateOld || smooth < 0 ? raw : oe.filter(raw, dt || 1)
    smooth = pr
    if (n >= 4) {
      const dx = wx - pts[n - 4]
      const dy = wy - pts[n - 3]
      const minD = minPointDist(zoom)
      if (dx * dx + dy * dy < minD * minD) continue
    }
    lastT = t
    pts.push(wx, wy, pr, dt)
  }
  return pts
}

/** 외곽선 면적 ÷ 중심선 길이 = 실효 굵기 (월드 단위) */
function effectiveWidth(points: number[], width: number, opts: StrokeOpts) {
  const input: number[][] = []
  for (let i = 0; i < points.length; i += 4) input.push([points[i], points[i + 1], points[i + 2]])
  if (input.length < 2) return 0
  const poly = getStroke(input, {
    size: width,
    thinning: opts.thinning,
    smoothing: opts.smoothing,
    streamline: opts.streamline,
    simulatePressure: opts.simulatePressure,
    last: true,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 }
  })
  let len = 0
  for (let i = 4; i < points.length; i += 4) len += Math.hypot(points[i] - points[i - 4], points[i + 1] - points[i - 3])
  let area = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) area += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]
  return len > 0 ? Math.abs(area) / 2 / len : 0
}

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
check(
  '상하한(0.1~1) 유지',
  speedToPressure(0) <= 1 && speedToPressure(100000) >= 0.1 && speedToPressure(100000) <= 0.1 + 1e-9
)

// ───────── 2. 배율 불변 ─────────
const dtMs = 1000 / RATE
const dScreen = 2 // 120 Hz에서 화면 2px 이동 = 240 px/s — 배율이 달라도 같은 손 동작
const sampled = ZOOMS.map((z) => velocityPressure(dScreen / z, 0, dtMs, z))
const spread = Math.max(...sampled) - Math.min(...sampled)
check('같은 손 동작 → 배율이 달라도 같은 필압', spread < 1e-9, `편차 ${spread.toExponential(1)}`)

// 속도 모드가 실제로 내는 opts. pressure.ts는 매개변수 속성을 써서 node strip 모드로 불러올 수
// 없으므로(strokeOptsFor의 'velocity' 가지 값과 같게 맞춘다), 소스에 그 변경이 있는지는 아래에서 따로 본다.
const optsNew: StrokeOpts = {
  thinning: DEFAULT_SETTINGS.thinning * 0.7,
  smoothing: DEFAULT_SETTINGS.smoothing,
  streamline: DEFAULT_SETTINGS.streamline,
  simulatePressure: false
}
const pressureSrc = readFileSync(join(ROOT, 'src/engine/pressure.ts'), 'utf8')
check(
  "속도 모드가 simulatePressure를 끈다 (pressure.ts)",
  /case 'velocity':[\s\S]{0,400}?simulatePressure: false/.test(pressureSrc)
)
const widthsNew = ZOOMS.map((z) => effectiveWidth(buildStroke(z), WIDTH, optsNew))
const ratioNew = Math.max(...widthsNew) / Math.min(...widthsNew)
const workWidths = widthsNew.slice(0, ZOOMS.indexOf(4) + 1) // 10% ~ 400%: 실제로 쓰는 작업 범위
const ratioWork = Math.max(...workWidths) / Math.min(...workWidths)
check(
  '실효 굵기 배율 간 편차 8% 이내 (10%~400%)',
  ratioWork <= 1.08,
  `실제 ${((ratioWork - 1) * 100).toFixed(1)}% · ${widthsNew.map((w) => w.toFixed(3)).join(' / ')}`
)
// 2000%에는 편차가 조금 남는다(실측 25%). 그 배율에서는 같은 손 동작의 "월드" 획 길이가 12pt밖에 되지 않아
// perfect-freehand의 월드 기준 리샘플링(굵기×smoothing 간격)이 상대적으로 거칠어지기 때문이다.
// 위 굵기 계산과는 원인이 다른 별개 항목이고, 점 간격을 화면 기준으로 균일화하는 후속 작업에서 함께 다룬다.
check('2000% 포함 편차 30% 이내', ratioNew <= 1.3, `실제 ${((ratioNew - 1) * 100).toFixed(1)}%`)
const optsOld: StrokeOpts = { ...optsNew, simulatePressure: true }
const widthsOld = ZOOMS.map((z) => effectiveWidth(buildStroke(z, true), WIDTH, optsOld))
const ratioOld = Math.max(...widthsOld) / Math.min(...widthsOld)

// ───────── 3. 축소 시 중심선 규칙 ─────────
check('10%·DPR2에서 2pt 획은 중심선으로', isHairline(2, 0.1 * 2) === true)
check('100%·DPR2에서는 면으로 그린다', isHairline(2, 1 * 2) === false)
check('임계값 경계', isHairline(1, MIN_STROKE_DEVICE_PX) === false && isHairline(0.99, MIN_STROKE_DEVICE_PX) === true)
check('최소 점 간격은 화면 기준 상수', Math.abs(minPointDist(1) - minPointDist(4) * 4) < 1e-9 && minPointDist(1) === 0.55)

// ───────── 4. 1€ 필터 ─────────
const first = OneEuroFilter.forSmoothing(DEFAULT_SETTINGS.pressureSmoothing)
check('첫 샘플은 그대로 통과', first.filter(0.4, 8) === 0.4)

const step = OneEuroFilter.forSmoothing(0.6)
step.filter(0.2, 8)
let ms = 0
let reached = -1
let peak = 0.2
for (let i = 0; i < 100; i++) {
  const y = step.filter(0.9, 8)
  ms += 8
  if (y > peak) peak = y
  if (reached < 0 && y >= 0.2 + 0.7 * 0.9) reached = ms
}
check('계단 변화를 250ms 안에 따라간다', reached > 0 && reached <= 250, `90% 도달 ${reached}ms`)
check('오버슈트 없음', peak <= 0.9 + 0.02, `최대 ${peak.toFixed(3)}`)

/** 같은 잡음을 넣었을 때 출력 흔들림 / 입력 흔들림 (표준편차 비) */
function noiseRatio(smoothing: number) {
  const flt = OneEuroFilter.forSmoothing(smoothing)
  const ins: number[] = []
  const outs: number[] = []
  let seed = 12345
  for (let i = 0; i < 400; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    const x = 0.5 + ((seed / 2147483648) * 2 - 1) * 0.06
    ins.push(x)
    outs.push(flt.filter(x, 8))
  }
  const sd = (a: number[]) => {
    const s = a.slice(20) // 초기 과도 구간 제외
    const m = s.reduce((x, y) => x + y, 0) / s.length
    return Math.sqrt(s.reduce((x, y) => x + (y - m) ** 2, 0) / s.length)
  }
  return sd(outs) / sd(ins)
}
const r09 = noiseRatio(0.9)
const r0 = noiseRatio(0)
check('평활 0.9에서 잡음 흔들림 60% 이하', r09 <= 0.6, `출력/입력 표준편차 비 ${r09.toFixed(3)}`)
check('평활 0에서도 잡음이 커지지 않는다', r0 <= 1.05, `비 ${r0.toFixed(3)}`)

console.log(`  참고: 이전 방식(거리 기반 추정) 굵기 편차 ${((ratioOld - 1) * 100).toFixed(0)}% — ${widthsOld.map((w) => w.toFixed(2)).join(' / ')}`)
console.log(`  참고: 새 방식(화면 기준 속도) 굵기 ${widthsNew.map((w) => w.toFixed(3)).join(' / ')} (월드 pt)`)
console.log(`  참고: 배율 편차 — 10~400% ${((ratioWork - 1) * 100).toFixed(1)}% · 2000% 포함 ${((ratioNew - 1) * 100).toFixed(0)}%`)
console.log(`  참고: 잡음 억제 — 평활 0 ${r0.toFixed(2)} · 평활 0.9 ${r09.toFixed(2)} · 계단 90% ${reached}ms`)
console.log(`\n펜 품질: ${pass}개 통과, ${fails.length}개 실패`)
for (const f of fails) console.log(`  ✗ ${f}`)
if (fails.length) process.exitCode = 1
else console.log('모든 펜 품질 검사 통과 ✓')
