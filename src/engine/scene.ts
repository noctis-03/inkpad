import RBush from 'rbush'
import { outlineToPath, strokeOutline } from './geometry'
import type { Layout } from './layout'
import type { Element, ID, Stroke } from '../shared/model'
import type { ElementEntry } from './history'

/** 저장 단위 위치가 붙은 획 */
export interface Entry {
  stroke: Stroke
  pageId: ID
  key: string
}

export interface IndexItem {
  minX: number
  minY: number
  maxX: number
  maxY: number
  rec: StrokeRec
}

/** 런타임 획 레코드: 저장 데이터 + 청크 원점(월드) + 캐시 */
export interface StrokeRec extends Entry {
  ox: number
  oy: number
  item: IndexItem
  path?: Path2D
}

export const groupKey = (pageId: ID, key: string) => `${pageId}|${key}`

export function getPath(rec: { stroke: Stroke; path?: Path2D }): Path2D {
  if (!rec.path) {
    const s = rec.stroke
    rec.path = outlineToPath(strokeOutline(s.points, s.width, s.opts, true))
  }
  return rec.path
}

/**
 * 청크(저장 단위)별로 획을 보관하고 R-tree로 월드 좌표 검색을 제공한다.
 * 획은 시작점이 속한 청크(무한 캔버스) 또는 페이지(문서형)에 저장한다 (설계 7.2).
 */
export class Scene {
  recs = new Map<ID, StrokeRec>()
  groups = new Map<string, Map<ID, StrokeRec>>()
  /** 아직 렌더링하지 않는 요소 (텍스트/이미지/도형, Phase 3). 저장할 때 그대로 돌려준다 */
  extras = new Map<string, Element[]>()
  tree = new RBush<IndexItem>()
  private zCounter = 0

  constructor(public layout: Layout) {}

  get size() {
    return this.recs.size
  }

  nextZ() {
    return ++this.zCounter
  }

  private makeRec(e: Entry): StrokeRec {
    const { ox, oy } = this.layout.origin(e.pageId, e.key)
    const [a, b, c, d] = e.stroke.bbox
    const rec = { ...e, ox, oy } as StrokeRec
    rec.item = { minX: a + ox, minY: b + oy, maxX: c + ox, maxY: d + oy, rec }
    if (e.stroke.z > this.zCounter) this.zCounter = e.stroke.z
    return rec
  }

  private link(rec: StrokeRec) {
    const gk = groupKey(rec.pageId, rec.key)
    let g = this.groups.get(gk)
    if (!g) this.groups.set(gk, (g = new Map()))
    g.set(rec.stroke.id, rec)
    this.recs.set(rec.stroke.id, rec)
  }

  add(e: Entry): StrokeRec {
    const rec = this.makeRec(e)
    this.link(rec)
    this.tree.insert(rec.item)
    return rec
  }

  addMany(list: Entry[]) {
    const wasEmpty = this.recs.size === 0
    const items: IndexItem[] = []
    for (const e of list) {
      const rec = this.makeRec(e)
      this.link(rec)
      items.push(rec.item)
    }
    if (wasEmpty) this.tree.load(items)
    else for (const it of items) this.tree.insert(it)
  }

  remove(id: ID): StrokeRec | undefined {
    const rec = this.recs.get(id)
    if (!rec) return
    this.recs.delete(id)
    const gk = groupKey(rec.pageId, rec.key)
    const g = this.groups.get(gk)
    g?.delete(id)
    if (g && g.size === 0) this.groups.delete(gk)
    this.tree.remove(rec.item)
    return rec
  }

  query(minX: number, minY: number, maxX: number, maxY: number): StrokeRec[] {
    const out = this.tree.search({ minX, minY, maxX, maxY }).map((it) => it.rec)
    out.sort((a, b) => a.stroke.z - b.stroke.z)
    return out
  }

  entriesOfPage(pageId: ID): Entry[] {
    const out: Entry[] = []
    for (const [gk, g] of this.groups) {
      if (!gk.startsWith(pageId + '|')) continue
      for (const r of g.values()) out.push({ stroke: r.stroke, pageId: r.pageId, key: r.key })
    }
    return out
  }

  recsOfPage(pageId: ID): StrokeRec[] {
    const out: StrokeRec[] = []
    for (const [gk, g] of this.groups) if (gk.startsWith(pageId + '|')) out.push(...g.values())
    out.sort((a, b) => a.stroke.z - b.stroke.z)
    return out
  }

  // ───────── R-tree에 없는 요소 (텍스트 등) ─────────
  // 개수가 많지 않다는 전제로 선형 순회한다. 종류가 늘어나면 별도 인덱스가 필요하다.

  addExtra(e: ElementEntry) {
    const gk = groupKey(e.pageId, e.key)
    const arr = this.extras.get(gk) ?? []
    arr.push(e.element)
    this.extras.set(gk, arr)
  }

  removeExtra(id: ID): ElementEntry | undefined {
    for (const [gk, arr] of this.extras) {
      const i = arr.findIndex((el) => el.id === id)
      if (i < 0) continue
      const [element] = arr.splice(i, 1)
      if (!arr.length) this.extras.delete(gk)
      const bar = gk.indexOf('|')
      return { pageId: gk.slice(0, bar), key: gk.slice(bar + 1), element }
    }
    return undefined
  }

  /** 요소의 저장 위치(+ 월드 원점) 목록 — 렌더·히트 테스트용 */
  extraEntries(): (ElementEntry & { ox: number; oy: number })[] {
    const out: (ElementEntry & { ox: number; oy: number })[] = []
    for (const [gk, arr] of this.extras) {
      const bar = gk.indexOf('|')
      const pageId = gk.slice(0, bar)
      const key = gk.slice(bar + 1)
      const { ox, oy } = this.layout.origin(pageId, key)
      for (const element of arr) out.push({ element, pageId, key, ox, oy })
    }
    return out
  }

  extrasOfPage(pageId: ID): ElementEntry[] {
    const out: ElementEntry[] = []
    for (const [gk, arr] of this.extras) {
      if (!gk.startsWith(pageId + '|')) continue
      const bar = gk.indexOf('|')
      const key = gk.slice(bar + 1)
      for (const element of arr) out.push({ element, pageId, key })
    }
    return out
  }

  /** 저장용: 청크의 전체 요소 */
  groupElements(gk: string): Element[] {
    const g = this.groups.get(gk)
    const strokes: Element[] = g ? [...g.values()].map((r) => r.stroke).sort((a, b) => a.z - b.z) : []
    const extra = this.extras.get(gk) ?? []
    return extra.length ? [...strokes, ...extra] : strokes
  }

  bounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (this.recs.size === 0) return null
    const root = (this.tree as unknown as { data: IndexItem }).data
    return { minX: root.minX, minY: root.minY, maxX: root.maxX, maxY: root.maxY }
  }

  /** 페이지 배치가 바뀐 뒤 원점과 인덱스를 다시 계산 (Path2D는 상대좌표라 그대로 재사용) */
  relayout() {
    const items: IndexItem[] = []
    for (const rec of this.recs.values()) {
      const { ox, oy } = this.layout.origin(rec.pageId, rec.key)
      rec.ox = ox
      rec.oy = oy
      const [a, b, c, d] = rec.stroke.bbox
      rec.item = { minX: a + ox, minY: b + oy, maxX: c + ox, maxY: d + oy, rec }
      items.push(rec.item)
    }
    this.tree.clear()
    this.tree.load(items)
  }

  clear() {
    this.recs.clear()
    this.groups.clear()
    this.extras.clear()
    this.tree.clear()
  }
}
