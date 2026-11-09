/**
 * 꾹 눌러 부른 도구창의 원형 모양 (settings.holdToolbarShape = 'ring').
 *
 * 일자 도구창이 누른 점으로 다가오면서 동그랗게 말린다 — 띠를 구부리듯이:
 * 버튼을 띠 위의 거리 s로 보고, 굽힘 k를 0(일자)에서 1/R(원)까지 키운다. 띠 한가운데(기준점)는 제자리에서
 * 원의 맨 아래로 옮겨 가고, 버튼 간격은 지금 바의 간격에서 원둘레를 고르게 나눈 간격으로 바뀐다.
 *   위치 = 기준점 + 접선·sin(sk)/k + 법선·(1 − cos(sk))/k     (k → 0이면 기준점 + 접선·s, 즉 일자)
 * 바 자체는 제자리에 두고 버튼마다 transform만 준다 — 엔진·레이아웃 계산을 건드리지 않고, 떼면 그대로 풀린다.
 *
 * 고르기는 방향으로 한다: 가운데(누른 점)에서 어느 쪽으로 펜을 옮겼는지로 버튼을 고른다 — 정확히 버튼 위가 아니어도 된다.
 */

type Vec = { x: number; y: number }
type Item = { el: HTMLElement; c: Vec; s0: number }

const OPEN_MS = 380
const CLOSE_MS = 240
const PAD = 8
/** 가운데 이 비율(×R) 안이면 아무것도 고르지 않는다 — 거기서 떼면 취소 */
const DEAD = 0.45

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

/** 원 위 버튼 개수 → 반지름 (버튼이 겹치지 않게, 너무 작지도 않게) */
export function ringRadius(n: number, size: number): number {
  return Math.max(64, (n * (size + 6)) / (2 * Math.PI))
}

/** 누른 점 기준 방향(라디안, 원 위 버튼 각과 같은 기준)에서 가장 가까운 칸. 칸 사이 틈(원의 맨 위)이면 -1 */
export function pickSlot(theta: number, n: number): number {
  const slot = (2 * Math.PI) / n
  // 칸 i의 각 = (i − (n−1)/2)·slot
  const i = Math.round(theta / slot + (n - 1) / 2)
  if (i < 0 || i >= n) return -1
  const d = Math.abs(theta - (i - (n - 1) / 2) * slot)
  return d <= slot * 0.75 ? i : -1
}

export class HoldRing {
  private items: Item[] = []
  private R = 64
  private center: Vec = { x: 0, y: 0 }
  private t = 0
  private raf = 0
  private closing = false
  private readonly animate: boolean

  constructor(
    private bar: HTMLElement,
    private disc: HTMLElement,
    private press: Vec, // 누른 점 (client 좌표)
    private selector: string
  ) {
    this.animate = document.documentElement.dataset.motion !== 'off'
  }

  /** 버튼을 다시 모은다 (열 때, 고른 도구가 바뀌어 바 안 버튼이 달라졌을 때) */
  private collect() {
    for (const it of this.items) it.el.style.transform = ''
    const els = [...this.bar.querySelectorAll<HTMLElement>(this.selector)].filter(visible)
    const centers = els.map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    const vertical = this.bar.dataset.orient === 'v'
    const mid = centers.length ? { x: (centers[0].x + centers[centers.length - 1].x) / 2, y: (centers[0].y + centers[centers.length - 1].y) / 2 } : this.press
    this.items = els.map((el, i) => ({ el, c: centers[i], s0: vertical ? centers[i].y - mid.y : centers[i].x - mid.x }))
    this.mid = mid
    this.vertical = vertical
    const size = parseFloat(getComputedStyle(this.bar).getPropertyValue('--ft-btn')) || 40
    this.R = ringRadius(els.length, size)
    // 원 전체가 편집 영역 안에 들어오게 가운데를 민다
    const area = this.bar.parentElement!.getBoundingClientRect()
    const m = this.R + size / 2 + PAD
    this.center = { x: clamp(this.press.x, area.left + m, area.right - m), y: clamp(this.press.y, area.top + m, area.bottom - m) }
    const d = 2 * (this.R + size / 2 + PAD)
    Object.assign(this.disc.style, { width: `${d}px`, height: `${d}px`, left: `${this.center.x - area.left - d / 2}px`, top: `${this.center.y - area.top - d / 2}px` })
  }
  private mid: Vec = { x: 0, y: 0 }
  private vertical = false

  /** t: 0 = 일자(제자리) … 1 = 원 */
  private place(t: number) {
    const n = this.items.length
    if (!n) return
    const e = t
    const R = this.R
    const k = e / R
    const slot = (2 * Math.PI * R) / n
    // 접선은 바 방향(가로 0°, 세로 90°)에서 0°로 돈다. 법선은 원의 가운데 쪽
    const a = lerp(this.vertical ? Math.PI / 2 : 0, 0, e)
    const u = { x: Math.cos(a), y: Math.sin(a) }
    const nrm = { x: u.y, y: -u.x }
    // 기준점: 바 가운데 → 원의 맨 아래
    const A = { x: lerp(this.mid.x, this.center.x, e), y: lerp(this.mid.y, this.center.y + R, e) }
    this.items.forEach((it, i) => {
      const s = lerp(it.s0, (i - (n - 1) / 2) * slot, e)
      const [p, q] = curl(s, k)
      const x = A.x + u.x * p + nrm.x * q
      const y = A.y + u.y * p + nrm.y * q
      it.el.style.transform = `translate(${(x - it.c.x).toFixed(1)}px, ${(y - it.c.y).toFixed(1)}px)`
    })
    this.disc.style.opacity = String(clamp(e * 1.4 - 0.3, 0, 1))
    this.disc.style.transform = `scale(${lerp(0.3, 1, e).toFixed(3)})`
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
    this.disc.dataset.on = ''
    this.collect()
    this.place(0)
    this.run(0, 1, OPEN_MS, easeOut)
  }

  /** 바 안 버튼이 바뀌었을 때 (머물러 고른 도구) — 원은 그대로, 버튼만 다시 늘어놓는다 */
  refresh() {
    if (this.closing) return
    this.collect()
    this.place(this.t)
  }

  close(done: () => void) {
    if (this.closing) return
    this.closing = true
    this.bar.dataset.ring = ''
    this.run(this.t, 0, CLOSE_MS, easeIn, () => {
      for (const it of this.items) it.el.style.transform = ''
      delete this.bar.dataset.ring
      delete this.disc.dataset.on
      this.bar.style.removeProperty('--ring-t')
      Object.assign(this.disc.style, { opacity: '', transform: '' })
      done()
    })
  }

  /** 펜 위치 → 고를 버튼 (가운데·원의 틈이면 null) */
  pick(x: number, y: number): HTMLElement | null {
    const n = this.items.length
    if (!n || this.t < 0.6) return null
    const dx = x - this.center.x
    const dy = y - this.center.y
    if (Math.hypot(dx, dy) < this.R * DEAD) return null
    // 원 위 칸 i의 각 θ_i에서 위치는 가운데 + R·(sin θ, cos θ) — 0이 맨 아래, 양수가 오른쪽으로 돈다
    const i = pickSlot(Math.atan2(dx, dy), n)
    return i < 0 ? null : this.items[i].el
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    for (const it of this.items) it.el.style.transform = ''
    delete this.bar.dataset.ring
    delete this.disc.dataset.on
    this.bar.style.removeProperty('--ring-t')
  }
}
