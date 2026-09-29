import { CHUNK_SIZE, PAGE_CHUNK_KEY, type ID, type Page } from '../shared/model'

export const PAGE_GAP = 28 // 페이지 사이 간격 (월드 단위 = pt)

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Target {
  pageId: ID
  key: string
  ox: number
  oy: number
}

export function chunkOf(wx: number, wy: number) {
  const cx = Math.floor(wx / CHUNK_SIZE)
  const cy = Math.floor(wy / CHUNK_SIZE)
  return { key: `${cx}_${cy}`, ox: cx * CHUNK_SIZE, oy: cy * CHUNK_SIZE }
}

export function parseChunkKey(key: string) {
  const [cx, cy] = key.split('_').map(Number)
  return { ox: cx * CHUNK_SIZE, oy: cy * CHUNK_SIZE }
}

/**
 * 문서의 페이지 배치.
 *  - infinite: 페이지 1개, 월드 좌표를 CHUNK_SIZE 격자로 나눈 청크마다 원점이 있다.
 *  - paged: 페이지를 세로로 이어 붙인다 (연속 스크롤). 페이지 1개 = 청크 1개, 원점 = 페이지 왼쪽 위.
 */
export class Layout {
  mode: 'infinite' | 'paged'
  pages: Page[] = []
  rects = new Map<ID, Rect>()
  index = new Map<ID, number>()
  bounds: Rect = { x: 0, y: 0, w: 0, h: 0 }

  constructor(mode: 'infinite' | 'paged') {
    this.mode = mode
  }

  setPages(pages: Page[]) {
    this.pages = pages
    this.rects.clear()
    this.index.clear()
    let y = 0
    let maxW = 0
    pages.forEach((p, i) => {
      this.index.set(p.id, i)
      if (!p.size) return
      const r = { x: -p.size.w / 2, y, w: p.size.w, h: p.size.h }
      this.rects.set(p.id, r)
      y += p.size.h + PAGE_GAP
      maxW = Math.max(maxW, p.size.w)
    })
    this.bounds = { x: -maxW / 2, y: 0, w: maxW, h: Math.max(0, y - PAGE_GAP) }
  }

  get paged() {
    return this.mode === 'paged'
  }

  origin(pageId: ID, key: string): { ox: number; oy: number } {
    if (this.paged) {
      const r = this.rects.get(pageId)
      return r ? { ox: r.x, oy: r.y } : { ox: 0, oy: 0 }
    }
    return parseChunkKey(key)
  }

  /** 월드 좌표에서 새 요소가 들어갈 위치 (paged: 가장 가까운 페이지) */
  targetAt(wx: number, wy: number): Target | null {
    if (!this.paged) {
      const page = this.pages[0]
      if (!page) return null
      const c = chunkOf(wx, wy)
      return { pageId: page.id, key: c.key, ox: c.ox, oy: c.oy }
    }
    const p = this.pageNear(wx, wy)
    if (!p) return null
    const r = this.rects.get(p.id)!
    return { pageId: p.id, key: PAGE_CHUNK_KEY, ox: r.x, oy: r.y }
  }

  pageNear(wx: number, wy: number): Page | null {
    let best: Page | null = null
    let bestD = Infinity
    for (const p of this.pages) {
      const r = this.rects.get(p.id)
      if (!r) continue
      const dx = wx < r.x ? r.x - wx : wx > r.x + r.w ? wx - r.x - r.w : 0
      const dy = wy < r.y ? r.y - wy : wy > r.y + r.h ? wy - r.y - r.h : 0
      const d = dx * dx + dy * dy
      if (d < bestD) {
        bestD = d
        best = p
        if (d === 0) break
      }
    }
    return best
  }

  /** 점이 어떤 페이지 안에 있는지 (paged 전용) */
  pageContaining(wx: number, wy: number): Page | null {
    for (const p of this.pages) {
      const r = this.rects.get(p.id)
      if (r && wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) return p
    }
    return null
  }

  /** 화면 영역과 겹치는 페이지 (세로로 정렬되어 있으므로 이진 탐색) */
  visiblePages(minY: number, maxY: number, minX = -Infinity, maxX = Infinity): Page[] {
    const out: Page[] = []
    const ps = this.pages
    let lo = 0
    let hi = ps.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const r = this.rects.get(ps[mid].id)!
      if (r.y + r.h < minY) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < ps.length; i++) {
      const r = this.rects.get(ps[i].id)
      if (!r) continue
      if (r.y > maxY) break
      if (r.x + r.w < minX || r.x > maxX) continue
      out.push(ps[i])
    }
    return out
  }

  /** 화면 중앙에 가장 많이 보이는 페이지 번호 */
  currentIndex(minY: number, maxY: number): number {
    if (!this.paged || !this.pages.length) return 0
    const mid = (minY + maxY) / 2
    let best = 0
    let bestD = Infinity
    this.pages.forEach((p, i) => {
      const r = this.rects.get(p.id)!
      const d = mid < r.y ? r.y - mid : mid > r.y + r.h ? mid - r.y - r.h : 0
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }
}
