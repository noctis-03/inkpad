import RBush from 'rbush'
import { outlineToPath, strokeOutline } from './geometry'
import type { Layout } from './layout'
import type { Element, ID, ImageElement, Stroke } from '../shared/model'

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

/** 런타임 획 레코드: 저장 데이터 + 청크 원점(월드)·내용 배율 + 캐시. 월드 = 원점 + 청크 좌표 × os */
export interface StrokeRec extends Entry {
  ox: number
  oy: number
  os: number
  item: IndexItem
  path?: Path2D
}

/** 저장 단위 위치가 붙은 사진 */
export interface ImageEntry {
  image: ImageElement
  pageId: ID
  key: string
}

/** 런타임 사진 레코드 — 획처럼 월드 = 원점 + 청크 좌표 × os. box는 월드 상자 */
export interface ImageRec extends ImageEntry {
  ox: number
  oy: number
  os: number
  box: { minX: number; minY: number; maxX: number; maxY: number }
}

export const groupKey = (pageId: ID, key: string) => `${pageId}|${key}`

function imageBox(r: ImageRec) {
  const { x, y, w, h } = r.image
  return { minX: r.ox + x * r.os, minY: r.oy + y * r.os, maxX: r.ox + (x + w) * r.os, maxY: r.oy + (y + h) * r.os }
}

/** 청크 좌표 bbox → 월드 검색 상자 */
function itemOf(rec: StrokeRec): IndexItem {
  const [a, b, c, d] = rec.stroke.bbox
  const { ox, oy, os } = rec
  return { minX: a * os + ox, minY: b * os + oy, maxX: c * os + ox, maxY: d * os + oy, rec }
}

export function getPath(rec: { stroke: Stroke; path?: Path2D }): Path2D {
  if (!rec.path) {
    const s = rec.stroke
    rec.path = outlineToPath(strokeOutline(s.points, s.width, s.opts, true))
  }
  return rec.path
}

/**
 * 청크(저장 단위)별로 획을 보관하고 R-tree로 월드 좌표 검색을 제공한다.
 * 획은 시작점이 속한 청크(무한 캔버스) 또는 페이지(문서형)에 저장한다.
 */
export class Scene {
  recs = new Map<ID, StrokeRec>()
  groups = new Map<string, Map<ID, StrokeRec>>()
  /** 아직 렌더링하지 않는 요소 (텍스트/도형, Phase 3). 저장할 때 그대로 돌려준다 */
  extras = new Map<string, Element[]>()
  /** 사진 — 몇 장뿐이라 R-tree 없이 목록으로 찾는다. 획 아래에 그린다 */
  images = new Map<ID, ImageRec>()
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
    const { ox, oy, os } = this.layout.origin(e.pageId, e.key)
    const rec = { ...e, ox, oy, os } as StrokeRec
    rec.item = itemOf(rec)
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

  addImage(e: ImageEntry): ImageRec {
    const { ox, oy, os } = this.layout.origin(e.pageId, e.key)
    const rec = { ...e, ox, oy, os } as ImageRec
    rec.box = imageBox(rec)
    if (e.image.z > this.zCounter) this.zCounter = e.image.z
    this.images.set(e.image.id, rec)
    return rec
  }

  removeImage(id: ID): ImageRec | undefined {
    const rec = this.images.get(id)
    if (rec) this.images.delete(id)
    return rec
  }

  /** 상자와 겹치는 사진 (z순) */
  queryImages(minX: number, minY: number, maxX: number, maxY: number): ImageRec[] {
    const out: ImageRec[] = []
    for (const r of this.images.values()) {
      const b = r.box
      if (b.maxX >= minX && b.minX <= maxX && b.maxY >= minY && b.minY <= maxY) out.push(r)
    }
    out.sort((a, b) => a.image.z - b.image.z)
    return out
  }

  imagesOfPage(pageId: ID): ImageEntry[] {
    const out: ImageEntry[] = []
    for (const r of this.images.values()) if (r.pageId === pageId) out.push({ image: r.image, pageId: r.pageId, key: r.key })
    return out
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

  /** 저장용: 청크의 전체 요소 */
  groupElements(gk: string): Element[] {
    const g = this.groups.get(gk)
    const strokes: Element[] = g ? [...g.values()].map((r) => r.stroke).sort((a, b) => a.z - b.z) : []
    const extra = this.extras.get(gk) ?? []
    const images: Element[] = []
    for (const r of this.images.values()) if (groupKey(r.pageId, r.key) === gk) images.push(r.image)
    images.sort((a, b) => a.z - b.z)
    return extra.length || images.length ? [...strokes, ...images, ...extra] : strokes
  }

  bounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    let b: { minX: number; minY: number; maxX: number; maxY: number } | null = null
    if (this.recs.size) {
      const root = (this.tree as unknown as { data: IndexItem }).data
      b = { minX: root.minX, minY: root.minY, maxX: root.maxX, maxY: root.maxY }
    }
    for (const r of this.images.values()) {
      const i = r.box
      b = b
        ? { minX: Math.min(b.minX, i.minX), minY: Math.min(b.minY, i.minY), maxX: Math.max(b.maxX, i.maxX), maxY: Math.max(b.maxY, i.maxY) }
        : { ...i }
    }
    return b
  }

  /** 페이지 배치·배율이 바뀐 뒤 원점과 인덱스를 다시 계산 (Path2D는 청크 좌표라 그대로 재사용 — 배율은 그릴 때 곱한다) */
  relayout() {
    const items: IndexItem[] = []
    for (const rec of this.recs.values()) {
      const { ox, oy, os } = this.layout.origin(rec.pageId, rec.key)
      rec.ox = ox
      rec.oy = oy
      rec.os = os
      rec.item = itemOf(rec)
      items.push(rec.item)
    }
    this.tree.clear()
    this.tree.load(items)
    for (const r of this.images.values()) {
      const { ox, oy, os } = this.layout.origin(r.pageId, r.key)
      r.ox = ox
      r.oy = oy
      r.os = os
      r.box = imageBox(r)
    }
  }

  /** 한 페이지(보조 용지)의 원점만 바뀌었을 때 — 그 획만 다시 계산한다 (용지를 끄는 동안 매번 전체를 다시 짓지 않게) */
  relayoutPage(pageId: ID) {
    const { ox, oy, os } = this.layout.origin(pageId, '')
    for (const [gk, g] of this.groups) {
      if (!gk.startsWith(pageId + '|')) continue
      for (const rec of g.values()) {
        if (rec.ox === ox && rec.oy === oy && rec.os === os) continue
        this.tree.remove(rec.item)
        rec.ox = ox
        rec.oy = oy
        rec.os = os
        rec.item = itemOf(rec)
        this.tree.insert(rec.item)
      }
    }
    for (const r of this.images.values()) {
      if (r.pageId !== pageId) continue
      r.ox = ox
      r.oy = oy
      r.os = os
      r.box = imageBox(r)
    }
  }

  clear() {
    this.recs.clear()
    this.groups.clear()
    this.extras.clear()
    this.images.clear()
    this.tree.clear()
  }
}
