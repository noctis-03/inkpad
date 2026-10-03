// 플로팅 도구바의 순수 레이아웃 계산과 DOM 측정 유틸.
// 위치/밀도를 계산할 때만 DOM을 읽고, 화면에 쓰는 것은 applyTrial과 FloatingToolbar가 담당한다.
import type { ToolbarPos } from '../../app/store'

export type Orient = 'h' | 'v'
export type Density = 'full' | 'medium' | 'compact' | 'dense' | 'tiny'
export type OvKey = 'undo' | 'redo' | 'fit' | 'collapse' | 'block'
export interface Insets {
  l: number
  r: number
  b: number
}
export interface Layout {
  pos: ToolbarPos
  orient: Orient
  density: Density
  hide: OvKey[]
  w: number
  h: number
  fits: boolean
}

export const POS_ALL: ToolbarPos[] = ['top', 'top-left', 'top-right', 'bottom', 'bottom-left', 'bottom-right', 'left', 'right']
export const POS_NARROW: ToolbarPos[] = ['top', 'bottom', 'left', 'right']
export const NARROW_BP = 600

export const STEPS: [Density, OvKey[]][] = [
  ['full', []],
  ['medium', []],
  ['compact', []],
  ['dense', []],
  ['dense', ['collapse']],
  ['dense', ['collapse', 'fit']],
  ['dense', ['collapse', 'fit', 'redo']],
  ['tiny', ['block', 'collapse', 'fit', 'redo']],
  ['tiny', ['block', 'collapse', 'fit', 'redo', 'undo']]
]

const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), Math.max(a, b))
export const orientOf = (p: ToolbarPos): Orient => (p === 'left' || p === 'right' ? 'v' : 'h')
export const marginFor = (areaW: number) => (areaW < NARROW_BP ? 8 : 12)

/** 좁은 화면에서 모서리 → 상/하 중앙 (표시용, 저장값은 유지) */
export function normalizePos(p: ToolbarPos, areaW: number): ToolbarPos {
  if (areaW >= NARROW_BP || !p.includes('-')) return p
  return p.startsWith('top') ? 'top' : 'bottom'
}

/** probe: padding에 env(safe-area-inset-*)가 들어간 숨김 요소. area가 화면 가장자리에 닿은 만큼만 반영 */
export function readInsets(probe: HTMLElement, area: HTMLElement): Insets {
  const s = getComputedStyle(probe)
  const r = area.getBoundingClientRect()
  return {
    l: Math.max(0, (parseFloat(s.paddingLeft) || 0) - r.left),
    r: Math.max(0, (parseFloat(s.paddingRight) || 0) - (window.innerWidth - r.right)),
    b: Math.max(0, (parseFloat(s.paddingBottom) || 0) - (window.innerHeight - r.bottom))
  }
}

/** 레이아웃 속성은 이 함수로만 DOM에 쓴다 (React JSX에서 이 data-* 를 렌더하지 말 것) */
export function applyTrial(el: HTMLElement, orient: Orient, density: Density, hide: OvKey[]) {
  el.dataset.orient = orient
  el.dataset.density = density
  el.dataset.hide = hide.join(' ')
}

/** STEPS를 순서대로 적용·측정해 avail 안에 드는 첫 단계를 반환. DOM에는 반환한 단계가 적용된 상태로 남는다 */
export function fitLayout(el: HTMLElement, orient: Orient, avail: number): Omit<Layout, 'pos'> {
  let last: Omit<Layout, 'pos'> | null = null
  for (const [density, hide] of STEPS) {
    applyTrial(el, orient, density, hide)
    const w = el.offsetWidth
    const h = el.offsetHeight
    last = { orient, density, hide, w, h, fits: false }
    if ((orient === 'h' ? w : h) <= avail) return { ...last, fits: true }
  }
  return last!
}

export function availFor(orient: Orient, W: number, H: number, ins: Insets, m: number) {
  return orient === 'h' ? W - 2 * m - ins.l - ins.r : H - 2 * m - ins.b
}

export function anchorXY(pos: ToolbarPos, w: number, h: number, W: number, H: number, ins: Insets, m: number): [number, number] {
  const L = m + ins.l
  const R = W - w - m - ins.r
  const T = m
  const B = H - h - m - ins.b
  const cx = clamp((W - w) / 2, L, R)
  const cy = clamp((H - h) / 2, T, B)
  const map: Record<ToolbarPos, [number, number]> = {
    top: [cx, T],
    'top-left': [L, T],
    'top-right': [R, T],
    bottom: [cx, B],
    'bottom-left': [L, B],
    'bottom-right': [R, B],
    left: [L, cy],
    right: [R, cy]
  }
  return map[pos]
}

export function zonePoint(pos: ToolbarPos, W: number, H: number): [number, number] {
  const map: Record<ToolbarPos, [number, number]> = {
    top: [W / 2, 0],
    'top-left': [0, 0],
    'top-right': [W, 0],
    bottom: [W / 2, H],
    'bottom-left': [0, H],
    'bottom-right': [W, H],
    left: [0, H / 2],
    right: [W, H / 2]
  }
  return map[pos]
}

export function nearestPos(px: number, py: number, W: number, H: number, allowed: ToolbarPos[]): ToolbarPos {
  let best = allowed[0]
  let bd = Infinity
  for (const p of allowed) {
    const [x, y] = zonePoint(p, W, H)
    const d = Math.hypot(px - x, py - y)
    if (d < bd) {
      bd = d
      best = p
    }
  }
  return best
}

/** 스냅 지점 표시용 사각형 */
export function zoneRect(pos: ToolbarPos, W: number, H: number) {
  const [x, y] = zonePoint(pos, W, H)
  const corner = pos.includes('-')
  const v = orientOf(pos) === 'v'
  const inset = 5
  const w = corner ? 14 : v ? 6 : 64
  const h = corner ? 14 : v ? 64 : 6
  return { left: clamp(x - w / 2, inset, W - w - inset), top: clamp(y - h / 2, inset, H - h - inset), width: w, height: h }
}
