// 화면 왼쪽·오른쪽 끝 놓는 자리 — 탭(TabBar)이나 카드(Library)를 끌어 와 놓으면 그쪽 옆 칸(듀얼)에 연다.
// 끄는 쪽은 pointermove마다 다시 그리지 않도록 DOM을 직접 다룬다 (라이브러리는 무겁다).
import { PATHS } from './Icon'

export type Side = 'left' | 'right'
/** 놓는 자리의 폭 — 칸 영역 폭의 이 비율, 최대 EDGE_ZONE_MAX */
const EDGE_ZONE_FRAC = 0.22
const EDGE_ZONE_MAX = 180

/** 노트는 옆 칸에 열 수 없다 (편집 화면은 한 번에 하나) */
export const NO_NOTE = '노트는 옆 칸에 열 수 없어요'
export const NO_MANY = '옆 칸에는 하나만 열 수 있어요'

function panesRect() {
  return document.querySelector('.panes')?.getBoundingClientRect() ?? null
}

/** (x, y)가 칸 영역의 왼쪽·오른쪽 끝 놓는 자리 안이면 그쪽 */
export function edgeZone(x: number, y: number): Side | null {
  const r = panesRect()
  if (!r || y < r.top || y > r.bottom) return null
  const w = Math.min(EDGE_ZONE_MAX, r.width * EDGE_ZONE_FRAC)
  return x < r.left + w ? 'left' : x > r.right - w ? 'right' : null
}

export interface EdgeZones {
  /** 손가락 자리로 켤 쪽을 고르고 돌려준다 */
  update: (x: number, y: number) => Side | null
  remove: () => void
}

/** 양 끝 놓는 자리를 띄운다 — no: 놓을 수 없는 까닭(있으면 그 말을 보이고 흐리게) */
export function showEdgeZones(no: string | null): EdgeZones {
  const r = panesRect()
  if (!r) return { update: () => null, remove: () => {} }
  const w = Math.min(EDGE_ZONE_MAX, r.width * EDGE_ZONE_FRAC)
  const els = (['left', 'right'] as const).map((side) => {
    const el = document.createElement('div')
    el.className = 'edge-drop' + (no ? ' is-no' : '')
    el.dataset.side = side
    el.style.cssText = `left:${side === 'left' ? r.left : r.right - w}px;top:${r.top}px;width:${w}px;height:${r.height}px`
    const label = document.createElement('span')
    label.className = 'edge-drop-label'
    label.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${PATHS[no ? 'close' : 'sidebar']}"/></svg>`
    label.append(no ?? (side === 'left' ? '왼쪽 칸에 열기' : '오른쪽 칸에 열기'))
    el.append(label)
    document.body.append(el)
    return el
  })
  return {
    update: (x, y) => {
      const z = edgeZone(x, y)
      for (const el of els) el.classList.toggle('is-on', el.dataset.side === z)
      return z
    },
    remove: () => els.forEach((el) => el.remove())
  }
}
