/**
 * 꾹 눌러 부른 도구창의 원형 모양 (settings.holdToolbarShape = 'ring').
 *
 * 일자 도구창이 누른 점으로 다가오면서 동그랗게 말린다 — 띠를 구부리듯이, 버튼과 바의 판(띠)이 함께:
 * 버튼을 띠 위의 거리 s로 보고, 굽힘 k를 0(일자)에서 1/R(원)까지 키운다. 띠 한가운데(기준점)는 바 자리에서
 * 원의 맨 아래로 옮겨 가고, 버튼 간격은 지금 바의 간격에서 원의 칸 간격으로 바뀐다.
 *   위치 = 기준점 + 접선·sin(sk)/k + 법선·(1 − cos(sk))/k     (k → 0이면 기준점 + 접선·s, 즉 일자)
 * 판은 같은 곡선을 따라 그린 굵은 띠(SVG 획)라서, 다 말리면 가운데가 빈 고리가 된다.
 * 바 자체는 제자리에 두고 버튼마다 transform만 준다 — 레이아웃 계산을 건드리지 않고, 떼면 그대로 풀린다.
 *
 * 크기는 고른 도구와 상관없이 같다: 원은 늘 slots칸(펜일 때 바의 버튼 수)으로 나누고, 버튼은 0번 칸부터 채운다.
 * 그래서 머물러 도구가 바뀌어도 원 크기와 도구 버튼 자리는 그대로이고, 버튼이 적은 도구(지우개·올가미)는 고리 일부가 빈다.
 *
 * 고르기는 방향으로 한다: 가운데(누른 점)에서 어느 쪽으로 펜을 옮겼는지로 버튼을 고른다 — 정확히 버튼 위가 아니어도 된다.
 */

type Vec = { x: number; y: number }
type Item = { el: HTMLElement; c: Vec; s0: number }

const OPEN_MS = 380
const CLOSE_MS = 240
const EDGE = 8
/** 가운데 이 비율(×R) 안이면 아무것도 고르지 않는다 — 거기서 떼면 취소 */
const DEAD = 0.45
/** 띠 곡선을 이만한 길이(px)마다 한 점씩 */
const SAMPLE = 6

const easeOut = (t: number) => 1 - (1 - t) ** 3
const easeIn = (t: number) => t * t
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), Math.max(a, b))
const visible = (el: HTMLElement) => el.getClientRects().length > 0

/** 띠 위 거리 s, 굽힘 k → (접선 방향, 법선 방향) 성분 */
export function curl(s: number, k: number): [number, number] {
  if (Math.abs(k) < 1e-6) return [s, 0]
  return [Math.sin(s * k) / k, (1 - Math.cos(s * k)) / k]
}

/** 칸 수 → 반지름 (버튼이 겹치지 않게, 너무 작지도 않게) */
export function ringRadius(slots: number, size: number): number {
  return Math.max(64, (slots * (size + 6)) / (2 * Math.PI))
}

/** i번 칸의 각 (0 = 원의 맨 아래, 양수 = 오른쪽으로 돈다). 칸 0..slots−1이 맨 위 틈에서 시작해 한 바퀴 */
export const slotAngle = (i: number, slots: number) => (i - (slots - 1) / 2) * ((2 * Math.PI) / slots)

/** 방향(라디안) → 버튼 번호. 빈 칸·칸 사이 틈이면 -1 */
export function pickSlot(theta: number, n: number, slots: number): number {
  const step = (2 * Math.PI) / slots
  const i = Math.round(theta / step + (slots - 1) / 2)
  if (i < 0 || i >= n) return -1
  return Math.abs(theta - slotAngle(i, slots)) <= step * 0.75 ? i : -1
}

export class HoldRing {
  private items: Item[] = []
  private slots = 0
  private R = 64
  private size = 40
  private pad = 4
  private center: Vec = { x: 0, y: 0 }
  private mid: Vec = { x: 0, y: 0 }
  private vertical = false
  private area = { left: 0, top: 0 }
  private t = 0
  private raf = 0
  private closing = false
  private readonly animate: boolean
  private readonly border: SVGPathElement
  private readonly fill: SVGPathElement
  private readonly dot: SVGCircleElement

  constructor(
    private bar: HTMLElement,
    private band: SVGSVGElement, // 판 — <path.b>(테두리) <path.f>(판) <circle.c>(가운데)
    private press: Vec, // 누른 점 (client 좌표)
    private selector: string,
    private minSlots: number // 펜일 때 바의 버튼 수 — 원 크기를 도구와 상관없이 고정한다
  ) {
    this.animate = document.documentElement.dataset.motion !== 'off'
    this.border = band.querySelector('path.b')!
    this.fill = band.querySelector('path.f')!
    this.dot = band.querySelector('circle.c')!
  }

  /** 버튼을 다시 모은다 (열 때, 고른 도구가 바뀌어 바 안 버튼이 달라졌을 때) */
  private collect(first: boolean) {
    for (const it of this.items) it.el.style.transform = ''
    const els = [...this.bar.querySelectorAll<HTMLElement>(this.selector)].filter(visible)
    const centers = els.map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    this.vertical = this.bar.dataset.orient === 'v'
    const n = els.length
    this.mid = n ? { x: (centers[0].x + centers[n - 1].x) / 2, y: (centers[0].y + centers[n - 1].y) / 2 } : this.press
    this.items = els.map((el, i) => ({ el, c: centers[i], s0: this.vertical ? centers[i].y - this.mid.y : centers[i].x - this.mid.x }))
    // 원 크기는 연 순간 정하고 그대로 둔다 — 버튼이 칸보다 많아질 때만 키운다
    if (first || n > this.slots) {
      const cs = getComputedStyle(this.bar)
      this.size = parseFloat(cs.getPropertyValue('--ft-btn')) || 40
      this.pad = parseFloat(cs.getPropertyValue('--ft-pad')) || 4
      this.slots = Math.max(n, this.minSlots)
      this.R = ringRadius(this.slots, this.size)
      const a = this.bar.parentElement!.getBoundingClientRect()
      this.area = { left: a.left, top: a.top }
      // 고리 전체가 편집 영역 안에 들어오게 가운데를 민다
      const m = this.R + this.size / 2 + this.pad + EDGE
      this.center = { x: clamp(this.press.x, a.left + m, a.right - m), y: clamp(this.press.y, a.top + m, a.bottom - m) }
      const w = this.size + 2 * this.pad
      this.fill.style.strokeWidth = `${w}px`
      this.border.style.strokeWidth = `${w + 2}px`
    }
  }

  /** t: 0 = 일자(제자리) … 1 = 원 */
  private place(e: number) {
    const n = this.items.length
    if (!n) return
    const R = this.R
    const k = e / R
    const step = (2 * Math.PI * R) / this.slots
    // 접선은 바 방향(가로 0°, 세로 90°)에서 0°로 돈다. 법선은 원의 가운데 쪽
    const ang = lerp(this.vertical ? Math.PI / 2 : 0, 0, e)
    const u = { x: Math.cos(ang), y: Math.sin(ang) }
    const nrm = { x: u.y, y: -u.x }
    // 기준점: 바 가운데 → 원의 맨 아래
    const A = { x: lerp(this.mid.x, this.center.x, e), y: lerp(this.mid.y, this.center.y + R, e) }
    const at = (s: number): Vec => {
      const [p, q] = curl(s, k)
      return { x: A.x + u.x * p + nrm.x * q, y: A.y + u.y * p + nrm.y * q }
    }
    const sOf = (it: Item, i: number) => lerp(it.s0, (i - (this.slots - 1) / 2) * step, e)
    this.items.forEach((it, i) => {
      const p = at(sOf(it, i))
      it.el.style.transform = `translate(${(p.x - it.c.x).toFixed(1)}px, ${(p.y - it.c.y).toFixed(1)}px)`
    })
    // 판: 첫 버튼에서 끝 버튼까지 같은 곡선을 따라 — 끝은 둥근 마개라 일자일 때는 바의 알약 모양 그대로
    const s1 = sOf(this.items[0], 0)
    const s2 = sOf(this.items[n - 1], n - 1)
    const count = Math.max(2, Math.ceil((s2 - s1) / SAMPLE))
    let d = ''
    for (let j = 0; j <= count; j++) {
      const p = at(lerp(s1, s2, j / count))
      d += `${j ? 'L' : 'M'}${(p.x - this.area.left).toFixed(1)} ${(p.y - this.area.top).toFixed(1)}`
    }
    this.fill.setAttribute('d', d)
    this.border.setAttribute('d', d)
    this.dot.setAttribute('cx', (this.center.x - this.area.left).toFixed(1))
    this.dot.setAttribute('cy', (this.center.y - this.area.top).toFixed(1))
    this.dot.style.opacity = String(clamp(e * 2 - 1, 0, 1))
    this.bar.style.setProperty('--ring-t', e.toFixed(3))
  }

  private run(from: number, to: number, ms: number, ease: (t: number) => number, done?: () => void) {
    cancelAnimationFrame(this.raf)
    if (!this.animate) {
      this.t = to
      this.place(to)
      done?.()
      return
    }
    const t0 = performance.now()
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms)
      this.t = lerp(from, to, ease(p))
      this.place(this.t)
      if (p < 1) this.raf = requestAnimationFrame(step)
      else done?.()
    }
    this.raf = requestAnimationFrame(step)
  }

  open() {
    this.bar.dataset.ring = ''
    this.collect(true)
    this.place(0)
    this.band.dataset.on = ''
    this.run(0, 1, OPEN_MS, easeOut)
  }

  /** 바 안 버튼이 바뀌었을 때 (머물러 고른 도구) — 원 크기·칸은 그대로, 버튼만 다시 채운다 */
  refresh() {
    if (this.closing) return
    this.collect(false)
    this.place(this.t)
  }

  close(done: () => void) {
    if (this.closing) return
    this.closing = true
    this.run(this.t, 0, CLOSE_MS, easeIn, () => {
      this.reset()
      done()
    })
  }

  private reset() {
    cancelAnimationFrame(this.raf)
    for (const it of this.items) it.el.style.transform = ''
    delete this.bar.dataset.ring
    delete this.band.dataset.on
    this.bar.style.removeProperty('--ring-t')
  }

  /** 펜 위치 → 고를 버튼 (가운데·빈 칸·틈이면 null) */
  pick(x: number, y: number): HTMLElement | null {
    const n = this.items.length
    if (!n || this.t < 0.6) return null
    const dx = x - this.center.x
    const dy = y - this.center.y
    if (Math.hypot(dx, dy) < this.R * DEAD) return null
    // 칸 i의 위치는 가운데 + R·(sin θ_i, cos θ_i) — 그래서 atan2(dx, dy)
    const i = pickSlot(Math.atan2(dx, dy), n, this.slots)
    return i < 0 ? null : this.items[i].el
  }

  dispose() {
    this.reset()
  }
}
