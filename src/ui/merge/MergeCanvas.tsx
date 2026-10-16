// 머지 화면의 페이지 캔버스 — 레이어를 그리고, 올가미·지우개 입력을 받는다 (편집 엔진을 쓰지 않는 가벼운 캔버스).
//
//  - 아래 캔버스: 속지(PDF·무늬) + 획. 작업본의 옮김·색은 그릴 때 얹는다(원래 획은 건드리지 않는다).
//  - 위 캔버스(덮개): 올가미 선, 선택 상자, 끌고 있는 획, 지우개에 닿은 획 — 움직일 때마다 이것만 다시 그린다.
//  - 입력: 펜·마우스는 도구, 손가락은 화면 이동(설정의 '손가락으로 그리기'를 켜면 손가락도 도구). '보기' 도구에서는 손대지 않는다.
import { useEffect, useMemo, useRef, useState } from 'react'
import { drawPattern } from '../../engine/background'
import { getPath } from '../../engine/scene'
import { parseChunkKey } from '../../engine/layout'
import { hitStroke, strokeInPolygon } from '../../engine/geometry'
import { openPdf, type PDFDocumentProxy } from '../../engine/pdf/pdfjs'
import { db } from '../../storage/db'
import type { ID, Page, Stroke } from '../../shared/model'
import { mergePageOrder, resolveItem, resolveMeta, type ItemClass, type MergeDraft, type MergeItem, type MergePlan, type Placed, type Side } from '../../sync/merge'
import type { DocFileV1 } from '../../sync/pack'

export type Tool = 'view' | 'lasso' | 'eraser'
export type Visible = Record<ItemClass, boolean>

/** 출처 테두리 색 — 노트 자체가 여러 색이라 획 색은 바꾸지 않고 둘레에만 칠한다 */
export const LAYER_COLOR: Record<ItemClass, string> = {
  common: 'transparent',
  mainOnly: '#e8890c',
  branchOnly: '#2f6fe0',
  modified: '#8b4fd6'
}
const SELECT_COLOR = '#3355c8'
const ERASE_COLOR = '#dc2626'

export interface ViewEl {
  item: MergeItem
  placed: Placed
  side: Side
  discarded: boolean
  move?: { dx: number; dy: number }
  color?: string
}

export interface ViewPage {
  id: ID
  item: MergeItem
  page: Page
  discarded: boolean
  els: ViewEl[]
  /** 이 페이지에서 공통이 아닌 항목 수 (페이지 자체 포함) */
  changes: number
}

export interface Selection {
  pageId: ID
  keys: Set<string>
}

export interface CanvasProps {
  width: number
  visible: Visible
  focus: ItemClass | null
  resultOnly: boolean
  outline: boolean
  tool: Tool
  /** 손가락도 도구로 쓰나 (설정 '손가락·터치펜으로 그리기') */
  fingerTool: boolean
  selection: Selection | null
  /** 도구가 손댈 수 있는 항목인가 — 보이는 레이어, 강조한 레이어가 있으면 그 레이어만 */
  editable: (item: MergeItem) => boolean
  onSelect: (pageId: ID, keys: string[]) => void
  onMove: (keys: string[], dx: number, dy: number) => void
  onErase: (keys: string[]) => void
  scroller: HTMLElement | null
  pdfs: Map<ID, Promise<PDFDocumentProxy | null>>
  /**
   * 바뀐 획을 얇은 테두리 대신 일렁이는 빛 테두리로 (비교 화면) — 파란 펜으로 쓴 획과 '새로 쓴 획' 표시가 헷갈리지 않게.
   * 빛은 따로 겹친 캔버스에 한 번 그리고 CSS가 투명도만 바꾼다(다시 그리지 않는다). 바뀌지 않은 획은 조금 흐리게
   */
  glow?: boolean
  /** 출처 색 바꾸기 — 비교 화면은 지운 획(mainOnly)을 빨강으로 (머지 화면은 빨강이 지우개 색이라 주황 그대로) */
  colors?: Partial<Record<ItemClass, string>>
}

const pick = <T,>(item: MergeItem, side: Side): T => (side === 'main' ? (item.main ?? item.branch) : (item.branch ?? item.main)) as T

/**
 * 분류 결과에 작업본을 얹어 페이지별로 묶는다. resultOnly가 아니면 버린 것도(흐리게 그리려고) 함께 둔다.
 * 머지 화면과 비교 화면(이 기기 변경)이 함께 쓴다.
 */
export function buildPages(s: { plan: MergePlan; main: DocFileV1; branch: DocFileV1 }, draft: MergeDraft, resultOnly: boolean): ViewPage[] {
  const pages = new Map<ID, ViewPage>()
  for (const item of s.plan.items) {
    if (item.kind !== 'page') continue
    const { side, discarded } = resolveItem(item, draft)
    if (discarded && resultOnly) continue
    pages.set(item.id, { id: item.id, item, page: pick<Page>(item, side), discarded, els: [], changes: item.cls === 'common' ? 0 : 1 })
  }
  for (const item of s.plan.items) {
    if (item.kind !== 'el') continue
    const { side, discarded } = resolveItem(item, draft)
    if (discarded && resultOnly) continue
    const placed = pick<Placed>(item, side)
    const vp = pages.get(placed.pageId)
    if (!vp) continue
    vp.els.push({ item, placed, side, discarded, move: draft.move.get(item.key), color: draft.color.get(item.key) })
    if (item.cls !== 'common') vp.changes++
  }
  const orderMeta = s.plan.meta.find((m) => m.field === 'pageOrder')
  const orderSide = orderMeta ? resolveMeta(orderMeta, draft) : 'main'
  const [primary, secondary] = orderSide === 'main' ? [s.main.doc.pageOrder, s.branch.doc.pageOrder] : [s.branch.doc.pageOrder, s.main.doc.pageOrder]
  return mergePageOrder(primary ?? [], secondary ?? [], new Set(pages.keys())).map((id) => pages.get(id)!)
}

/** 획 외곽선은 비싸다 — 같은 획 객체는 한 번만 만든다 */
const pathCache = new WeakMap<Stroke, Path2D>()
const pathOf = (s: Stroke) => {
  let p = pathCache.get(s)
  if (!p) pathCache.set(s, (p = getPath({ stroke: s })))
  return p
}

/** 아래 레이어(형광펜) → 위 레이어(펜), 같은 레이어는 z 순 — 엔진과 같은 쌓임 */
const byLayerZ = (a: ViewEl, b: ViewEl) => {
  const sa = a.placed.el
  const sb = b.placed.el
  return sa.layer === sb.layer ? sa.z - sb.z : sa.layer === 'under' ? -1 : 1
}

/** 그 획의 그리는 원점(청크 원점 + 작업본 옮김) */
function originOf(v: ViewEl, paged: boolean, drag?: { dx: number; dy: number }) {
  const o = paged ? { ox: 0, oy: 0 } : parseChunkKey(v.placed.key)
  return {
    ox: o.ox + (v.move?.dx ?? 0) + (drag?.dx ?? 0),
    oy: o.oy + (v.move?.dy ?? 0) + (drag?.dy ?? 0)
  }
}

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

function boxOf(els: ViewEl[], paged: boolean): Box | null {
  let b: Box | null = null
  for (const v of els) {
    const s = v.placed.el
    if (s.type !== 'stroke') continue
    const o = originOf(v, paged)
    const x0 = o.ox + s.bbox[0]
    const y0 = o.oy + s.bbox[1]
    const x1 = o.ox + s.bbox[2]
    const y1 = o.oy + s.bbox[3]
    b = b
      ? {
          x0: Math.min(b.x0, x0),
          y0: Math.min(b.y0, y0),
          x1: Math.max(b.x1, x1),
          y1: Math.max(b.y1, y1)
        }
      : { x0, y0, x1, y1 }
  }
  return b
}

export function PageCanvas(props: CanvasProps & { vp: ViewPage }) {
  const { vp, width } = props
  const paged = !!vp.page.size
  const base = useRef<HTMLCanvasElement>(null)
  const over = useRef<HTMLCanvasElement>(null)
  const glowEl = useRef<HTMLCanvasElement>(null)
  const [seen, setSeen] = useState(false)
  /** 끌고 있는 동안 아래 캔버스에서 뺄 항목(선택) — 덮개가 옮긴 자리에 그린다 */
  const [dragging, setDragging] = useState(false)

  // 무한 캔버스(페이지 크기 없음)는 필기가 있는 범위를 페이지로 본다. 작업본의 옮김은 범위에 넣지 않는다(옮길 때마다 틀이 흔들리지 않게)
  const frame = useMemo(() => {
    if (vp.page.size) return { x: 0, y: 0, w: vp.page.size.w, h: vp.page.size.h }
    const b = boxOf(
      vp.els.map((v) => ({ ...v, move: undefined })),
      false
    )
    if (!b) return { x: 0, y: 0, w: 800, h: 500 }
    const pad = 60
    return {
      x: b.x0 - pad,
      y: b.y0 - pad,
      w: b.x1 - b.x0 + pad * 2,
      h: Math.max(240, b.y1 - b.y0 + pad * 2)
    }
  }, [vp.page.size, vp.els])
  const height = Math.round((width * frame.h) / frame.w)
  // 캔버스 픽셀 상한 — 크게 확대해도 한 장이 너무 커지지 않게
  const dpr = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(12e6 / Math.max(1, width * height)))
  const scale = (width * dpr) / frame.w

  useEffect(() => {
    const el = base.current
    if (!el || seen) return
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [seen])

  const selectedHere = props.selection?.pageId === vp.id ? props.selection.keys : null
  /** 빛 테두리를 그리나 — 출처 표시를 켰고 결과만 보기가 아닐 때 */
  const glowing = !!props.glow && props.outline && !props.resultOnly
  const colorOf = (cls: ItemClass) => props.colors?.[cls] ?? LAYER_COLOR[cls]

  // ── 아래 캔버스 ──
  useEffect(() => {
    const el = base.current
    if (!el || !seen) return
    let cancelled = false
    el.width = Math.max(1, Math.round(width * dpr))
    el.height = Math.max(1, Math.round(height * dpr))
    const ctx = el.getContext('2d')
    if (!ctx) return
    void (async () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, el.width, el.height)
      let drewPdf = false
      if (vp.page.pdf && paged) drewPdf = await drawPdf(ctx, vp.page, el.width, el.height, props.pdfs)
      if (cancelled) return
      ctx.setTransform(scale, 0, 0, scale, -frame.x * scale, -frame.y * scale)
      if (!drewPdf && paged) drawPattern(ctx, vp.page.background, frame.w, frame.h, scale)
      for (const v of [...vp.els].sort(byLayerZ)) {
        const s = v.placed.el
        if (s.type !== 'stroke' || !props.visible[v.item.cls]) continue
        if (dragging && selectedHere?.has(v.item.key)) continue // 덮개가 옮긴 자리에 그린다
        let alpha = 1
        if (v.discarded) alpha = props.resultOnly ? 0 : 0.14
        else if (props.focus && props.focus !== v.item.cls) alpha = 0.22
        else if (glowing && v.item.cls === 'common') alpha = 0.5 // 바뀐 획이 도드라지게
        if (alpha <= 0) continue
        const o = originOf(v, paged)
        const path = pathOf(s)
        ctx.save()
        ctx.translate(o.ox, o.oy)
        ctx.globalAlpha = alpha
        ctx.fillStyle = v.color ?? s.color
        ctx.fill(path)
        if (props.outline && !glowing && v.item.cls !== 'common' && !v.discarded && !props.resultOnly) {
          ctx.globalAlpha = Math.min(1, alpha + 0.3)
          ctx.strokeStyle = colorOf(v.item.cls)
          ctx.lineWidth = (1.6 * dpr) / scale
          ctx.stroke(path)
        }
        ctx.restore()
      }
      drawOverlay()
      drawGlow()
    })()
    return () => {
      cancelled = true
    }
  }, [seen, width, height, frame, vp, props.visible, props.focus, props.resultOnly, props.outline, props.pdfs, dragging, selectedHere, glowing, props.colors])

  // ── 빛 테두리 (glow) — 바뀐 획 둘레만. 획 자리는 도려내 원래 색이 그대로 보인다 ──
  const drawGlow = () => {
    const el = glowEl.current
    if (!el) return
    el.width = Math.max(1, Math.round(width * dpr))
    el.height = Math.max(1, Math.round(height * dpr))
    const ctx = el.getContext('2d')
    if (!ctx) return
    ctx.setTransform(scale, 0, 0, scale, -frame.x * scale, -frame.y * scale)
    const px = dpr / scale
    const changed = vp.els.filter(
      (v) =>
        v.placed.el.type === 'stroke' &&
        v.item.cls !== 'common' &&
        !v.discarded &&
        props.visible[v.item.cls] &&
        (!props.focus || props.focus === v.item.cls) && // 강조한 레이어만 빛난다
        !(dragging && selectedHere?.has(v.item.key)) // 끄는 동안은 덮개가 옮긴 자리에 그린다
    )
    for (const cut of [false, true]) {
      for (const v of changed) {
        const s = v.placed.el
        if (s.type !== 'stroke') continue
        const o = originOf(v, paged)
        const path = pathOf(s)
        ctx.save()
        ctx.translate(o.ox, o.oy)
        if (cut) {
          // 획 자리와 그 둘레 조금을 도려낸다 — 획과 빛 사이에 흰 틈이 생겨 같은 색(파란 펜 + 파란 빛)이어도 갈린다
          ctx.globalCompositeOperation = 'destination-out'
          ctx.fill(path)
          ctx.lineJoin = 'round'
          ctx.lineWidth = 3 * px
          ctx.stroke(path)
        } else {
          const color = colorOf(v.item.cls)
          ctx.lineJoin = 'round'
          ctx.lineCap = 'round'
          ctx.strokeStyle = color
          ctx.shadowColor = color
          ctx.shadowBlur = 7 * dpr // 그림자 흐림은 화면 픽셀 단위
          ctx.globalAlpha = 0.8
          ctx.lineWidth = 8 * px
          ctx.stroke(path)
        }
        ctx.restore()
      }
    }
  }

  // ── 덮개 ──
  const gesture = useRef<{
    mode: 'lasso' | 'drag' | 'erase' | 'scroll'
    id: number
    poly: number[]
    start: { x: number; y: number }
    d: { dx: number; dy: number }
    hits: Set<string>
    last: { x: number; y: number }
  } | null>(null)

  const drawOverlay = () => {
    const el = over.current
    if (!el) return
    if (el.width !== Math.round(width * dpr)) el.width = Math.max(1, Math.round(width * dpr))
    if (el.height !== Math.round(height * dpr)) el.height = Math.max(1, Math.round(height * dpr))
    const ctx = el.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, el.width, el.height)
    ctx.setTransform(scale, 0, 0, scale, -frame.x * scale, -frame.y * scale)
    const px = dpr / scale // 화면 1px의 페이지 단위
    const g = gesture.current
    // 선택: 끄는 중이면 옮긴 자리에 획을 그리고, 둘레를 파랗게
    if (selectedHere?.size) {
      const sel = vp.els.filter((v) => selectedHere.has(v.item.key))
      const drag = g?.mode === 'drag' ? g.d : undefined
      for (const v of sel) {
        const s = v.placed.el
        if (s.type !== 'stroke') continue
        const o = originOf(v, paged, drag)
        const path = pathOf(s)
        ctx.save()
        ctx.translate(o.ox, o.oy)
        if (drag) {
          ctx.globalAlpha = v.discarded ? 0.3 : 1
          ctx.fillStyle = v.color ?? s.color
          ctx.fill(path)
          ctx.globalAlpha = 1
        }
        ctx.strokeStyle = SELECT_COLOR
        ctx.lineWidth = 2 * px
        ctx.stroke(path)
        ctx.restore()
      }
      const b = boxOf(sel, paged)
      if (b) {
        const dx = drag?.dx ?? 0
        const dy = drag?.dy ?? 0
        ctx.setLineDash([6 * px, 4 * px])
        ctx.strokeStyle = SELECT_COLOR
        ctx.lineWidth = 1.5 * px
        ctx.strokeRect(b.x0 + dx - 6 * px, b.y0 + dy - 6 * px, b.x1 - b.x0 + 12 * px, b.y1 - b.y0 + 12 * px)
        ctx.setLineDash([])
      }
    }
    if (g?.mode === 'lasso' && g.poly.length >= 4) {
      ctx.beginPath()
      ctx.moveTo(g.poly[0], g.poly[1])
      for (let i = 2; i < g.poly.length; i += 2) ctx.lineTo(g.poly[i], g.poly[i + 1])
      ctx.setLineDash([5 * px, 4 * px])
      ctx.strokeStyle = SELECT_COLOR
      ctx.lineWidth = 1.5 * px
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = '#3355c814'
      ctx.fill()
    }
    if (g?.mode === 'erase' && g.hits.size) {
      for (const v of vp.els) {
        if (!g.hits.has(v.item.key) || v.placed.el.type !== 'stroke') continue
        const o = originOf(v, paged)
        ctx.save()
        ctx.translate(o.ox, o.oy)
        ctx.strokeStyle = ERASE_COLOR
        ctx.lineWidth = 2.5 * px
        ctx.stroke(pathOf(v.placed.el))
        ctx.restore()
      }
    }
  }
  useEffect(drawOverlay) // 선택·작업본이 바뀌면 덮개도

  // ── 입력 ──
  const toPage = (e: React.PointerEvent) => {
    const r = over.current!.getBoundingClientRect()
    return {
      x: frame.x + ((e.clientX - r.left) / r.width) * frame.w,
      y: frame.y + ((e.clientY - r.top) / r.height) * frame.h
    }
  }
  /** 도구가 손댈 수 있는 획 — 결과만 보기에서는 버린 것도 빠진다 */
  const targets = () =>
    vp.els.filter((v) => v.placed.el.type === 'stroke' && props.visible[v.item.cls] && props.editable(v.item) && !(props.resultOnly && v.discarded))
  const eraseAt = (pt: { x: number; y: number }, hits: Set<string>) => {
    const r = (12 * frame.w) / width // 화면 12px
    for (const v of targets()) {
      if (v.discarded || hits.has(v.item.key)) continue
      const s = v.placed.el as Stroke
      const o = originOf(v, paged)
      if (hitStroke(s.points, pt.x - o.ox, pt.y - o.oy, r + s.width / 2)) hits.add(v.item.key)
    }
  }
  const insideSelection = (pt: { x: number; y: number }) => {
    if (!selectedHere?.size) return false
    const b = boxOf(
      vp.els.filter((v) => selectedHere.has(v.item.key)),
      paged
    )
    const pad = (14 * frame.w) / width
    return !!b && pt.x >= b.x0 - pad && pt.x <= b.x1 + pad && pt.y >= b.y0 - pad && pt.y <= b.y1 + pad
  }

  const onDown = (e: React.PointerEvent) => {
    if (props.tool === 'view' || gesture.current) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const pt = toPage(e)
    const g = {
      id: e.pointerId,
      poly: [] as number[],
      start: pt,
      d: { dx: 0, dy: 0 },
      hits: new Set<string>(),
      last: { x: e.clientX, y: e.clientY }
    }
    if (e.pointerType === 'touch' && !props.fingerTool)
      gesture.current = { ...g, mode: 'scroll' } // 손가락 = 화면 이동
    else if (props.tool === 'eraser') {
      gesture.current = { ...g, mode: 'erase' }
      eraseAt(pt, gesture.current.hits)
    } else if (insideSelection(pt)) {
      gesture.current = { ...g, mode: 'drag' }
      setDragging(true)
    } else gesture.current = { ...g, mode: 'lasso', poly: [pt.x, pt.y] }
    e.preventDefault()
    drawOverlay()
  }
  const onMove = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g || g.id !== e.pointerId) return
    if (g.mode === 'scroll') {
      props.scroller?.scrollBy(g.last.x - e.clientX, g.last.y - e.clientY)
      g.last = { x: e.clientX, y: e.clientY }
      return
    }
    const pt = toPage(e)
    if (g.mode === 'lasso') g.poly.push(pt.x, pt.y)
    else if (g.mode === 'drag') g.d = { dx: pt.x - g.start.x, dy: pt.y - g.start.y }
    else eraseAt(pt, g.hits)
    drawOverlay()
  }
  const onUp = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g || g.id !== e.pointerId) return
    gesture.current = null
    if (g.mode === 'lasso') {
      const keys =
        g.poly.length >= 6
          ? targets()
              .filter((v) => strokeInPolygon((v.placed.el as Stroke).points, originOf(v, paged).ox, originOf(v, paged).oy, g.poly))
              .map((v) => v.item.key)
          : []
      props.onSelect(vp.id, keys)
    } else if (g.mode === 'drag') {
      setDragging(false)
      const moved = Math.hypot(g.d.dx, g.d.dy) > (2 * frame.w) / width
      if (moved && selectedHere) props.onMove([...selectedHere], g.d.dx, g.d.dy)
    } else if (g.mode === 'erase' && g.hits.size) props.onErase([...g.hits])
    drawOverlay()
  }
  const onCancel = (e: React.PointerEvent) => {
    if (gesture.current?.id !== e.pointerId) return
    gesture.current = null
    setDragging(false)
    drawOverlay()
  }

  const toolOn = props.tool !== 'view'
  return (
    <div className={'merge-canvas-wrap' + (toolOn ? ' tool-' + props.tool : '')} style={{ width, height }}>
      <canvas ref={base} className="merge-canvas" style={{ width, height }} />
      {glowing && <canvas ref={glowEl} className="merge-glow" style={{ width, height }} aria-hidden />}
      <canvas
        ref={over}
        className="merge-overlay"
        style={{ width, height, touchAction: toolOn ? 'none' : 'auto' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
      />
    </div>
  )
}

/** PDF 속지 — 원본이 이 기기에 있을 때만 그린다(지연 로딩 원칙: 여기서 받아오지 않는다) */
async function drawPdf(ctx: CanvasRenderingContext2D, page: Page, w: number, h: number, pdfs: Map<ID, Promise<PDFDocumentProxy | null>>): Promise<boolean> {
  const ref = page.pdf!
  let doc = pdfs.get(ref.assetId)
  if (!doc) {
    doc = (async () => {
      const asset = await db.assets.get(ref.assetId)
      if (!asset?.blob) return null
      return openPdf(await asset.blob.arrayBuffer()).catch(() => null)
    })()
    pdfs.set(ref.assetId, doc)
  }
  const pdf = await doc
  if (!pdf) return false
  try {
    const p = await pdf.getPage(ref.pageIndex + 1)
    const rotation = (p.rotate + ref.rotation) % 360
    const base = p.getViewport({ scale: 1, rotation })
    const vp = p.getViewport({ scale: w / base.width, rotation })
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(vp.width))
    c.height = Math.max(1, Math.round(vp.height))
    await p.render({
      canvas: null,
      canvasContext: c.getContext('2d')!,
      viewport: vp
    }).promise
    ctx.drawImage(c, 0, 0, w, h)
    return true
  } catch {
    return false
  }
}
