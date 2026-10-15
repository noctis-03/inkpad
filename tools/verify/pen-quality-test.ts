/**
 * 펜 품질 회귀 검사 (의존성 없음 — perfect-freehand만 쓴다)
 *
 * 실행: node --experimental-strip-types --no-warnings tools/verify/pen-quality-test.ts
 *       (npm run test:pen, npm test에 포함)
 *
 * 배경: 굵기·평활 계산이 월드 좌표나 "이벤트 개수"에 의존하면, 같은 손 동작이 배율·이벤트 주기에
 * 따라 다른 선이 된다(실측: 배율 10% ↔ 2000%에서 실효 굵기 3.9배 차). 이 파일은 GoodNotes식 규칙
 * — "화면 기준(px, px/s) + 시간 기준(ms)" — 이 지켜지는지 계산으로 확인한다.
 *
 * engine.addPoint와 같은 순서(속도 → 1€ 평활 → 위치 안정화 → 최소 간격 → 저장)를 그대로 흉내 내므로
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
  taperStrokeEnd,
  velocityPressure
} from '../../src/engine/quality.ts'
import { DEFAULT_SETTINGS, INK_PROFILES } from '../../src/engine/types.ts'
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

type Mode = 'velocity' | 'pressure' | 'constant'
interface Sim {
  zoom: number
  rate: number
  mode: Mode
  stabilize: number
  pressureSmoothing: number
  gamma?: number
  minPressure?: number
  /** true = 이전 방식(월드 기준 속도 추정 + 라이브러리 simulatePressure) 흉내 */
  old?: boolean
}

/** engine.addPoint와 같은 순서로 점 배열을 만든다 */
function buildStroke(sim: Sim): number[] {
  const { zoom, rate, mode, stabilize, pressureSmoothing, old = false } = sim
  const gamma = sim.gamma ?? 1
  const minP = sim.minPressure ?? 0.05
  const pts: number[] = []
  const fx = OneEuroFilter.forStabilization(stabilize)
  const fy = OneEuroFilter.forStabilization(stabilize)
  const oe = OneEuroFilter.forSmoothing(pressureSmoothing)
  const dtMs = 1000 / rate
  let rsx = 0
  let rsy = 0
  let hasRaw = false
  let smoothP = -1
  let prevScreen: { x: number; y: number } | null = null

  for (let i = 0; i <= rate; i++) {
    const t = i / rate
    const s = hand(t)
    const rdt = i === 0 ? 1 : dtMs

    // 1) 굵기 원값
    let raw: number
    if (mode === 'velocity') {
      if (!hasRaw) raw = VELOCITY_START_PRESSURE
      else if (old) {
        // 이전 방식: 월드 거리로 속도를 추정 — 배율에 끌려간다
        const wx = s.x / zoom
        const wy = s.y / zoom
        const px = prevScreen ? prevScreen.x / zoom : wx
        const py = prevScreen ? prevScreen.y / zoom : wy
        raw = speedToPressure(Math.hypot(wx - px, wy - py) / (rdt / 1000))
      } else raw = velocityPressure(s.x - rsx, s.y - rsy, rdt)
    } else if (mode === 'pressure') raw = Math.max(minP, Math.pow(Math.min(1, press(t)), gamma))
    else raw = 0.5

    // 2) 시간 기준 1€ 평활
    const pr = smoothP < 0 ? raw : oe.filter(raw, rdt)
    smoothP = pr

    // 3) 위치 안정화 (이전 방식 흉내에서는 하지 않는다)
    let spx = s.x
    let spy = s.y
    if (!old && hasRaw) {
      spx = fx.filter(s.x, rdt)
      spy = fy.filter(s.y, rdt)
    }
    rsx = s.x
    rsy = s.y
    hasRaw = true

    const wx = q2(spx / zoom)
    const wy = q2(spy / zoom)
    const n = pts.length
    if (n >= 4) {
      const dx = wx - pts[n - 4]
      const dy = wy - pts[n - 3]
      const minD = minPointDist(zoom)
      if (dx * dx + dy * dy < minD * minD) {
        if (mode === 'pressure') pts[n - 2] = q2(Math.max(pts[n - 2], pr))
        prevScreen = { x: spx, y: spy }
        continue
      }
    }
    pts.push(wx, wy, q2(pr), i === 0 ? 0 : Math.round(dtMs))
    prevScreen = { x: spx, y: spy }
  }
  return pts
}

/** 외곽선 면적 ÷ 중심선 길이 = 실효 굵기 (월드 단위) */
function effectiveWidth(points: number[], width: number, opts: StrokeOpts): number {
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

const optsFor = (thinning: number, smoothing: number, simulate: boolean, streamline = 0): StrokeOpts => ({
  thinning,
  smoothing,
  streamline,
  simulatePressure: simulate
})

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
check('상하한(0.1~1) 유지', speedToPressure(0) <= 1 && speedToPressure(100000) >= 0.1 && speedToPressure(100000) <= 0.1 + 1e-9)

// ───────── 2. 배율 불변 ─────────
const dtMs = 1000 / 120
const dScreen = 2 // 120 Hz에서 화면 2px 이동 = 240 px/s — 배율이 달라도 같은 손 동작
const sampled = ZOOMS.map((z) => velocityPressure(dScreen, 0, dtMs))
check('같은 손 동작 → 배율이 달라도 같은 굵기 신호', Math.max(...sampled) - Math.min(...sampled) < 1e-9)

// 속도 모드가 실제로 내는 opts — pressure.ts가 simulatePressure를 끄는지 소스로 확인
const pressureSrc = readFileSync(join(ROOT, 'src/engine/pressure.ts'), 'utf8')
check("속도 모드가 simulatePressure를 끈다 (pressure.ts)", /case 'velocity':[\s\S]{0,400}?simulatePressure: false/.test(pressureSrc))
check('스트림라인은 저장하지 않는다 (안정화는 엔진이 담당)', /streamline: 0/.test(pressureSrc))

const VOPTS = optsFor(DEFAULT_SETTINGS.thinning * 0.7, DEFAULT_SETTINGS.smoothing, false)
const VOPTS_OLD = { ...VOPTS, simulatePressure: true }
const simV = (z: number, old = false) =>
  buildStroke({ zoom: z, rate: 120, mode: 'velocity', stabilize: old ? 0 : DEFAULT_SETTINGS.streamline, pressureSmoothing: DEFAULT_SETTINGS.pressureSmoothing, old })

const widthsNew = ZOOMS.map((z) => effectiveWidth(simV(z), WIDTH, VOPTS))
const ratioWork = spread(WORK.map((z) => effectiveWidth(simV(z), WIDTH, VOPTS)))
check('실효 굵기 배율 간 편차 8% 이내 (10%~400%)', ratioWork <= 1.08, `실제 ${((ratioWork - 1) * 100).toFixed(1)}% · ${widthsNew.map((w) => w.toFixed(3)).join(' / ')}`)
check('2000% 포함 편차 30% 이내', spread(widthsNew) <= 1.3, `실제 ${((spread(widthsNew) - 1) * 100).toFixed(0)}%`)

// 검사 자체가 예민한지 — 이전 방식(월드 기준)은 크게 어긋나야 한다
const widthsOld = ZOOMS.map((z) => effectiveWidth(simV(z, true), WIDTH, VOPTS_OLD))
check('이전 방식은 편차가 크다 (검사 예민도)', spread(widthsOld) > 1.5, `실제 ${((spread(widthsOld) - 1) * 100).toFixed(0)}%`)

// ───────── 3. 이벤트 주기 불변 (60Hz vs 120Hz) ─────────
const at120 = buildStroke({ zoom: 1, rate: 120, mode: 'velocity', stabilize: DEFAULT_SETTINGS.streamline, pressureSmoothing: DEFAULT_SETTINGS.pressureSmoothing })
const at60 = buildStroke({ zoom: 1, rate: 60, mode: 'velocity', stabilize: DEFAULT_SETTINGS.streamline, pressureSmoothing: DEFAULT_SETTINGS.pressureSmoothing })
const w120 = effectiveWidth(at120, WIDTH, VOPTS)
const w60 = effectiveWidth(at60, WIDTH, VOPTS)
check('60Hz와 120Hz가 같은 굵기를 낸다 (5% 이내)', Math.abs(w120 / w60 - 1) <= 0.05, `120Hz ${w120.toFixed(3)} · 60Hz ${w60.toFixed(3)}`)
// 위치도 시간 기준이라 크게 어긋나지 않아야 한다 — 같은 시각의 점끼리 비교한다
// (120Hz는 60Hz의 두 배 밀도이므로 at120[2i] ↔ at60[i])
let maxDev = 0
for (let i = 0; i < at60.length / 4; i++) {
  const a = i * 8
  if (a + 1 >= at120.length) break
  maxDev = Math.max(maxDev, Math.abs(at120[a] - at60[i * 4]), Math.abs(at120[a + 1] - at60[i * 4 + 1]))
}
check('60Hz와 120Hz의 경로가 비슷하다 (월드 0.6 이내)', maxDev <= 0.6, `최대 편차 ${maxDev.toFixed(3)}`)

// ───────── 4. 축소 시 중심선 규칙 ─────────
check('10%·DPR2에서 2pt 획은 중심선으로', isHairline(2, 0.1 * 2) === true)
check('100%·DPR2에서는 면으로 그린다', isHairline(2, 1 * 2) === false)
check('임계값 경계', isHairline(1, MIN_STROKE_DEVICE_PX) === false && isHairline(0.99, MIN_STROKE_DEVICE_PX) === true)
check('최소 점 간격은 화면 기준 상수', Math.abs(minPointDist(1) - minPointDist(4) * 4) < 1e-9 && minPointDist(1) === 0.55)

// ───────── 5. 필압 평활 (1€) ─────────
const first = OneEuroFilter.forSmoothing(DEFAULT_SETTINGS.pressureSmoothing)
check('첫 샘플은 그대로 통과', first.filter(0.4, 8) === 0.4)

const stepF = OneEuroFilter.forSmoothing(0.6)
stepF.filter(0.2, 8)
let ms = 0
let reached = -1
let peak = 0.2
for (let i = 0; i < 100; i++) {
  const y = stepF.filter(0.9, 8)
  ms += 8
  if (y > peak) peak = y
  if (reached < 0 && y >= 0.2 + 0.7 * 0.9) reached = ms
}
check('계단 변화를 250ms 안에 따라간다', reached > 0 && reached <= 250, `90% 도달 ${reached}ms`)
check('오버슈트 없음', peak <= 0.9 + 0.02, `최대 ${peak.toFixed(3)}`)

/** 같은 잡음을 넣었을 때 출력 흔들림 / 입력 흔들림 (표준편차 비) */
function noiseRatio(make: () => OneEuroFilter, amp = 0.06) {
  const flt = make()
  const ins: number[] = []
  const outs: number[] = []
  let seed = 12345
  for (let i = 0; i < 400; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    const x = 0.5 + ((seed / 2147483648) * 2 - 1) * amp
    ins.push(x)
    outs.push(flt.filter(x, 8))
  }
  const sd = (a: number[]) => {
    const s = a.slice(20) // 초기 과도 구간 제외
    const mean = s.reduce((x, y) => x + y, 0) / s.length
    return Math.sqrt(s.reduce((x, y) => x + (y - mean) ** 2, 0) / s.length)
  }
  return sd(outs) / sd(ins)
}
const r09 = noiseRatio(() => OneEuroFilter.forSmoothing(0.9))
const r0 = noiseRatio(() => OneEuroFilter.forSmoothing(0))
check('평활 0.9에서 잡음 흔들림 60% 이하', r09 <= 0.6, `출력/입력 표준편차 비 ${r09.toFixed(3)}`)
check('평활 0에서도 잡음이 커지지 않는다', r0 <= 1.05, `비 ${r0.toFixed(3)}`)

// ───────── 6. 위치 안정화 (Stroke Stabilization) ─────────
const posRatio = (strength: number) => noiseRatio(() => OneEuroFilter.forStabilization(strength), 0.8)
const p0 = posRatio(0)
const p45 = posRatio(0.45)
const p90 = posRatio(0.9)
check('손떨림 보정: 세기에 따라 단조로 강해진다', p0 >= p45 && p45 > p90, `0 → ${p0.toFixed(3)} · 0.45 → ${p45.toFixed(3)} · 0.9 → ${p90.toFixed(3)}`)
check('손떨림 보정 0은 거의 그대로(끔)', p0 >= 0.9, `비 ${p0.toFixed(3)}`)
check('손떨림 보정 최대에서 잔떨림을 절반 이하로', p90 <= 0.5, `비 ${p90.toFixed(3)}`)

/** 일정 속도로 움직일 때 필터가 뒤처지는 시간(ms) */
function lagMs(strength: number, speed: number, rate = 120): number {
  const flt = OneEuroFilter.forStabilization(strength)
  const dt = 1000 / rate
  let out = 0
  let truth = 0
  for (let i = 0; i < 400; i++) {
    truth = (i * speed * dt) / 1000
    out = flt.filter(truth, dt)
  }
  return ((truth - out) / speed) * 1000
}
const lagDefault = lagMs(DEFAULT_SETTINGS.streamline, 300)
const lagMaxSlow = lagMs(0.9, 300)
const lagMaxFast = lagMs(0.9, 1200)
check('기본 보정에서 뒤처짐 12ms 이내 (120Hz 한 프레임≈8.3ms)', lagDefault <= 12, `${lagDefault.toFixed(1)}ms`)
check('보정 최대 + 느린 손에서도 25ms 이내', lagMaxSlow <= 25, `${lagMaxSlow.toFixed(1)}ms`)
check('1€: 빠른 획은 보정 최대에서도 12ms 이내', lagMaxFast <= 12, `${lagMaxFast.toFixed(1)}ms`)

// ───────── 7. 획 끝 날카로움 (Tip Sharpness) ─────────
/** 화면 x축으로 일정 속도로 그은 획 (px/s) */
function straight(vScreen: number, zoom = 1, rate = 120): number[] {
  const pts: number[] = []
  for (let i = 0; i <= 40; i++) pts.push(q2((i * vScreen * (1000 / rate)) / 1000 / zoom), 0, 0.6, Math.round(1000 / rate))
  return pts
}
const slow = straight(150)
const slowCopy = slow.slice()
check('천천히 멈춘 획은 그대로 둔다', taperStrokeEnd(slow, 0.8, 1) === 0 && slow.every((v, i) => v === slowCopy[i]))
const fast = straight(1500)
const fastLast = fast[fast.length - 2]
const amount = taperStrokeEnd(fast, 0.8, 1)
check('빠르게 스친 획의 끝을 깎는다', amount >= 0.3, `세기 ${amount.toFixed(2)}`)
check('획 끝으로 갈수록 가늘어진다', fast[fast.length - 2] < fastLast * 0.5 && fast[fast.length - 6] > fast[fast.length - 2])
check('보정 0이면 아무것도 바꾸지 않는다', taperStrokeEnd(straight(1500), 0, 1) === 0)

// ───────── 8. 프로파일 (GoodNotes 볼펜·만년필·붓펜) ─────────
const profOpts = (id: 'ballpen' | 'fountain' | 'brush'): StrokeOpts =>
  optsFor(INK_PROFILES[id].values.thinning, INK_PROFILES[id].values.smoothing, false)

// 볼펜: 필압에 반응하지 않으므로 배율이 달라도 굵기가 정확히 같아야 한다
const ballW = WORK.map((z) => effectiveWidth(buildStroke({ zoom: z, rate: 120, mode: 'constant', stabilize: 0.45, pressureSmoothing: 0.5 }), WIDTH, profOpts('ballpen')))
check('볼펜: 어느 배율에서나 굵기 일정', spread(ballW) <= 1.08, `편차 ${((spread(ballW) - 1) * 100).toFixed(1)}% · ${ballW.map((w) => w.toFixed(3)).join(' / ')}`)

for (const id of ['fountain', 'brush'] as const) {
  const v = INK_PROFILES[id].values
  const w = WORK.map((z) =>
    effectiveWidth(
      buildStroke({ zoom: z, rate: 120, mode: 'pressure', stabilize: v.streamline, pressureSmoothing: v.pressureSmoothing, gamma: v.pressureGamma, minPressure: v.minPressure }),
      WIDTH,
      profOpts(id)
    )
  )
  check(`${INK_PROFILES[id].label}: 배율 간 편차 8% 이내`, spread(w) <= 1.08, `편차 ${((spread(w) - 1) * 100).toFixed(1)}%`)
}

// 붓펜이 만년필보다 굵기 변화가 커야 한다 (프로파일이 실제로 다르게 그려지는지)
const variety = (id: 'fountain' | 'brush') => {
  const v = INK_PROFILES[id].values
  const pts = buildStroke({ zoom: 1, rate: 120, mode: 'pressure', stabilize: v.streamline, pressureSmoothing: v.pressureSmoothing, gamma: v.pressureGamma, minPressure: v.minPressure })
  const ps: number[] = []
  for (let i = 2; i < pts.length; i += 4) ps.push(pts[i])
  return Math.max(...ps) / Math.min(...ps)
}
check('붓펜이 만년필보다 굵기 변화가 크다', variety('brush') > variety('fountain'), `붓펜 ${variety('brush').toFixed(2)} · 만년필 ${variety('fountain').toFixed(2)}`)

// ───────── 9. package.json에 검사가 묶여 있는가 ─────────
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
check('test:pen이 npm test에 묶여 있다', pkg.scripts['test'].includes('test:pen') && !!pkg.scripts['test:pen'])

console.log(`\n펜 품질: ${pass}개 통과, ${fails.length}개 실패`)
for (const f of fails) console.log(`  ✗ ${f}`)
if (fails.length) process.exitCode = 1
else console.log('모든 펜 품질 검사 통과 ✓')

console.log(`  참고: 배율 편차 — 10~400% ${((ratioWork - 1) * 100).toFixed(1)}% · 2000% 포함 ${((spread(widthsNew) - 1) * 100).toFixed(0)}% (이전 방식 ${((spread(widthsOld) - 1) * 100).toFixed(0)}%)`)
console.log(`  참고: 이벤트 주기 — 120Hz ${w120.toFixed(3)}pt · 60Hz ${w60.toFixed(3)}pt · 경로 최대 편차 ${maxDev.toFixed(3)}월드`)
console.log(`  참고: 볼펜 실효 굵기 — ${ballW.map((w) => w.toFixed(3)).join(' / ')} (요청 ${WIDTH}pt)`)
console.log(`  참고: 잔떨림 억제 — 위치 0→${p0.toFixed(2)} · 0.45→${p45.toFixed(2)} · 0.9→${p90.toFixed(2)}`)
console.log(`  참고: 펜 끝 뒤처짐 — 기본 ${lagDefault.toFixed(1)}ms · 최대/느림 ${lagMaxSlow.toFixed(1)}ms · 최대/빠름 ${lagMaxFast.toFixed(1)}ms`)
