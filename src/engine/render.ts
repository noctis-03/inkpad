import { Camera } from './camera'
import { MAX_CANVAS_PIXELS } from './constants'
import { drawPattern } from './background'
import { outlineToPath, strokeOutline } from './geometry'
import type { Layout } from './layout'
import type { PdfCache } from './pdf/pdfCache'
import { getPath, type Scene, type StrokeRec } from './scene'
import { layoutTextBox } from './text'
import type { Background, StrokeOpts, TextBox } from '../shared/model'

export interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface LiveDraw {
  ox: number
  oy: number
  points: number[]
  predicted: number[][]
  width: number
  color: string
  opts: StrokeOpts
  clip?: Box
}

export interface Cursor {
  sx: number
  sy: number
  radius: number
  kind: 'pen' | 'eraser'
  color: string
}

/** 선택된 텍스트 요소 (월드 원점 포함) */
export interface SelectionText {
  element: TextBox
  ox: number
  oy: number
}

export interface Overlay {
  lasso?: number[] // 월드 좌표 다각형
  selection?: {
    recs: StrokeRec[]
    texts?: SelectionText[]
    dx: number
    dy: number
    scale: number
    cx: number
    cy: number
  }
}

/**
 * 레이어 (아래 → 위)
 *  1. 배경 레이어 canvas: 무한 캔버스 = CSS 점/격자 패턴, 문서형 = 종이 + 속지 + PDF 비트맵
 *  2. 확정 레이어 canvas: 끝난 획. 팬/줌 중에는 CSS transform만 적용할 수 있다.
 *  3. 입력 레이어 canvas: 입력 중인 획 + 커서 + 올가미 + 이동 중인 선택 영역.
 */
export class Renderer {
  readonly root: HTMLElement
  readonly pageLayer: HTMLCanvasElement
  readonly committed: HTMLCanvasElement
  readonly live: HTMLCanvasElement
  private pctx: CanvasRenderingContext2D
  private cctx: CanvasRenderingContext2D
  private lctx: CanvasRenderingContext2D

  cssW = 1
  cssH = 1
  scale = 1
  dpr = 1
  renderedCam = new Camera()
  transformed = false
  lastFullMs = 0
  visibleCount = 0
  private liveHasContent = false
  /** 선택된 획은 확정 레이어에서 빼고 입력 레이어에 그린다 */
  hidden: Set<string> | null = null
  /** 편집 중인 텍스트 박스는 DOM 오버레이가 대신 그린다 (이중 표시 방지) */
  hiddenExtras: Set<string> | null = null

  constructor(root: HTMLElement) {
    this.root = root
    this.pageLayer = document.createElement('canvas')
    this.pageLayer.className = 'layer layer-page'
    this.committed = document.createElement('canvas')
    this.committed.className = 'layer layer-committed'
    this.live = document.createElement('canvas')
    this.live.className = 'layer layer-live'
    root.append(this.pageLayer, this.committed, this.live)
    this.pctx = this.pageLayer.getContext('2d')!
    this.cctx = this.committed.getContext('2d')!
    this.lctx = this.live.getContext('2d', { desynchronized: true } as CanvasRenderingContext2DSettings)!
  }

  destroy() {
    for (const c of [this.pageLayer, this.committed, this.live]) {
      c.width = c.height = 0
      c.remove()
    }
    this.root.style.backgroundImage = ''
  }

  resize(cssW: number, cssH: number, dpr: number, resolution: number) {
    this.cssW = Math.max(1, cssW)
    this.cssH = Math.max(1, cssH)
    this.dpr = dpr
    let scale = dpr * resolution
    const px = this.cssW * this.cssH * scale * scale
    if (px > MAX_CANVAS_PIXELS) scale = Math.sqrt(MAX_CANVAS_PIXELS / (this.cssW * this.cssH))
    this.scale = scale
    for (const c of [this.pageLayer, this.committed, this.live]) {
      c.width = Math.round(this.cssW * scale)
      c.height = Math.round(this.cssH * scale)
      c.style.width = this.cssW + 'px'
      c.style.height = this.cssH + 'px'
    }
  }

  get canvasPx() {
    return `${this.committed.width}×${this.committed.height}`
  }

  inSync(cam: Camera) {
    return !this.transformed && this.renderedCam.equals(cam)
  }

  viewBox(cam: Camera): Box {
    return { minX: cam.x, minY: cam.y, maxX: cam.x + this.cssW / cam.zoom, maxY: cam.y + this.cssH / cam.zoom }
  }

  // ───────── 배경 ─────────

  /** 무한 캔버스: 점/격자를 CSS 배경으로 (캔버스 메모리를 쓰지 않는다) */
  drawInfiniteBackground(cam: Camera, bg: Background) {
    const s = this.root.style
    this.pageLayer.style.display = 'none'
    if (bg.type === 'blank' || !('spacing' in bg)) {
      s.backgroundImage = 'none'
      return
    }
    let worldSp = bg.type === 'dot' ? 32 : bg.spacing
    while (worldSp * cam.zoom < 14) worldSp *= 2
    while (worldSp * cam.zoom > 80) worldSp /= 2
    const sp = worldSp * cam.zoom
    const offX = -mod(cam.x, worldSp) * cam.zoom
    const offY = -mod(cam.y, worldSp) * cam.zoom
    if (bg.type === 'dot') {
      s.backgroundImage = 'radial-gradient(circle, var(--bg-pattern) 1.1px, transparent 1.6px)'
      s.backgroundSize = `${sp}px ${sp}px`
      s.backgroundPosition = `${offX - sp / 2}px ${offY - sp / 2}px`
    } else if (bg.type === 'lined') {
      s.backgroundImage = 'linear-gradient(to bottom, var(--bg-pattern) 1px, transparent 1px)'
      s.backgroundSize = `100% ${sp}px`
      s.backgroundPosition = `0 ${offY}px`
    } else {
      s.backgroundImage =
        'linear-gradient(to right, var(--bg-pattern) 1px, transparent 1px),' +
        'linear-gradient(to bottom, var(--bg-pattern) 1px, transparent 1px)'
      s.backgroundSize = `${sp}px ${sp}px`
      s.backgroundPosition = `${offX}px ${offY}px`
    }
  }

  /** 문서형: 보이는 페이지마다 종이 + 속지 + PDF */
  drawPages(cam: Camera, layout: Layout, pdf: PdfCache | null): boolean {
    this.root.style.backgroundImage = 'none'
    this.pageLayer.style.display = ''
    this.pageLayer.style.transform = ''
    const ctx = this.pctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.pageLayer.width, this.pageLayer.height)
    const v = this.viewBox(cam)
    const k = cam.zoom * this.scale
    const pages = layout.visiblePages(v.minY, v.maxY, v.minX, v.maxX)
    const visibleKeys = new Set<string>()
    let pending = false
    for (const p of pages) {
      const r = layout.rects.get(p.id)!
      ctx.setTransform(k, 0, 0, k, (r.x - cam.x) * k, (r.y - cam.y) * k)
      // 그림자 + 종이
      ctx.fillStyle = 'rgba(0,0,0,0.08)'
      ctx.fillRect(1 / cam.zoom, 2 / cam.zoom, r.w, r.h)
      ctx.fillStyle = p.background.type === 'blank' ? p.background.color : '#ffffff'
      ctx.fillRect(0, 0, r.w, r.h)
      if (p.pdf && pdf) {
        visibleKeys.add(`${p.pdf.assetId}:${p.pdf.pageIndex}`)
        const bmp = pdf.get(p.pdf, r.w, r.h, cam.zoom * this.scale, true)
        if (bmp) {
          ctx.imageSmoothingQuality = 'high'
          ctx.drawImage(bmp, 0, 0, r.w, r.h)
        } else if (pdf.isFailed(p.pdf)) {
          ctx.fillStyle = '#9ca3af'
          ctx.font = `${14}px sans-serif`
          ctx.fillText('PDF 페이지를 표시할 수 없습니다', 24, 40)
        } else pending = true
      } else {
        drawPattern(ctx, p.background, r.w, r.h, cam.zoom * this.scale)
      }
    }
    pdf?.retain(visibleKeys)
    // 화면 근처 다음 페이지 미리 렌더링
    if (pdf) {
      const ahead = layout.visiblePages(v.maxY, v.maxY + (v.maxY - v.minY) * 0.8)
      for (const p of ahead) {
        if (p.pdf) {
          const r = layout.rects.get(p.id)!
          pdf.get(p.pdf, r.w, r.h, cam.zoom * this.scale, false)
        }
      }
    }
    return pending
  }

  applyPageTransform(cam: Camera) {
    this.pageLayer.style.transform = this.committed.style.transform = this.transformFor(cam)
  }

  // ───────── 확정 레이어 ─────────

  private drawRec(ctx: CanvasRenderingContext2D, rec: StrokeRec, cam: Camera, k: number) {
    ctx.setTransform(k, 0, 0, k, (rec.ox - cam.x) * k, (rec.oy - cam.y) * k)
    ctx.fillStyle = rec.stroke.color
    ctx.fill(getPath(rec))
  }

  private drawList(ctx: CanvasRenderingContext2D, recs: StrokeRec[], cam: Camera) {
    const k = cam.zoom * this.scale
    const minScreen = 0.5 / cam.zoom // LOD
    const hidden = this.hidden
    let n = 0
    for (const pass of ['under', 'main'] as const) {
      for (const rec of recs) {
        if (rec.stroke.layer !== pass) continue
        if (hidden && hidden.has(rec.stroke.id)) continue
        const it = rec.item
        if (it.maxX - it.minX < minScreen && it.maxY - it.minY < minScreen) continue
        this.drawRec(ctx, rec, cam, k)
        n++
      }
    }
    return n
  }

  /** 텍스트 박스(그리고 앞으로 추가될 R-tree 밖 요소)를 그린다 */
  private drawTexts(ctx: CanvasRenderingContext2D, scene: Scene, cam: Camera, k: number, view: Box | null) {
    for (const e of scene.extraEntries()) {
      const el = e.element
      if (el.type !== 'text') continue
      if (this.hiddenExtras?.has(el.id)) continue // 편집 중 → 오버레이가 그림
      if (el.fontSize * cam.zoom < 0.6) continue // LOD: 너무 작으면 건너뜀
      const x = el.x + e.ox
      const y = el.y + e.oy
      const lay = layoutTextBox(el)
      const w = Math.max(24, el.w)
      if (view && (x > view.maxX || y > view.maxY || x + w < view.minX || y + lay.height < view.minY)) continue
      ctx.setTransform(k, 0, 0, k, (x - cam.x) * k, (y - cam.y) * k)
      ctx.font = lay.font
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillStyle = el.color
      for (let i = 0; i < lay.lines.length; i++) ctx.fillText(lay.lines[i], 0, i * lay.lineHeight)
    }
  }

  fullRedraw(scene: Scene, cam: Camera) {
    const t0 = performance.now()
    const ctx = this.cctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.committed.width, this.committed.height)
    const v = this.viewBox(cam)
    this.visibleCount = this.drawList(ctx, scene.query(v.minX, v.minY, v.maxX, v.maxY), cam)
    this.drawTexts(ctx, scene, cam, cam.zoom * this.scale, v)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.renderedCam.copy(cam)
    if (this.transformed) {
      this.committed.style.transform = ''
      this.pageLayer.style.transform = ''
      this.transformed = false
    }
    this.lastFullMs = performance.now() - t0
  }

  redrawRegion(scene: Scene, cam: Camera, box: Box) {
    const ctx = this.cctx
    const k = cam.zoom * this.scale
    const x0 = Math.max(0, Math.floor((box.minX - cam.x) * k) - 2)
    const y0 = Math.max(0, Math.floor((box.minY - cam.y) * k) - 2)
    const x1 = Math.min(this.committed.width, Math.ceil((box.maxX - cam.x) * k) + 2)
    const y1 = Math.min(this.committed.height, Math.ceil((box.maxY - cam.y) * k) + 2)
    if (x1 <= x0 || y1 <= y0) return
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0)
    ctx.beginPath()
    ctx.rect(x0, y0, x1 - x0, y1 - y0)
    ctx.clip()
    const vx0 = x0 / k + cam.x
    const vy0 = y0 / k + cam.y
    const vx1 = x1 / k + cam.x
    const vy1 = y1 / k + cam.y
    this.drawList(ctx, scene.query(vx0, vy0, vx1, vy1), cam)
    this.drawTexts(ctx, scene, cam, k, { minX: vx0, minY: vy0, maxX: vx1, maxY: vy1 })
    ctx.restore()
  }

  drawIncremental(rec: StrokeRec, cam: Camera) {
    const ctx = this.cctx
    ctx.save()
    ctx.globalCompositeOperation = rec.stroke.layer === 'under' ? 'destination-over' : 'source-over'
    this.drawRec(ctx, rec, cam, cam.zoom * this.scale)
    ctx.restore()
    this.visibleCount++
  }

  private transformFor(cam: Camera) {
    const r = this.renderedCam
    const k = cam.zoom / r.zoom
    const tx = (r.x - cam.x) * cam.zoom
    const ty = (r.y - cam.y) * cam.zoom
    return `translate(${tx}px, ${ty}px) scale(${k})`
  }

  applyTransform(cam: Camera, withPages: boolean) {
    const t = this.transformFor(cam)
    this.committed.style.transform = t
    if (withPages) this.pageLayer.style.transform = t
    this.transformed = true
  }

  // ───────── 입력 레이어 ─────────

  drawLive(cam: Camera, stroke: LiveDraw | null, cursor: Cursor | null, overlay: Overlay | null) {
    const ctx = this.lctx
    if (this.liveHasContent) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, this.live.width, this.live.height)
      this.liveHasContent = false
    }
    const k = cam.zoom * this.scale
    if (overlay?.selection) {
      const { recs, texts, dx, dy, scale, cx, cy } = overlay.selection
      for (const rec of recs) {
        // 월드 좌표: p' = c + (p - c) * scale + d
        const ox = cx + (rec.ox - cx) * scale + dx
        const oy = cy + (rec.oy - cy) * scale + dy
        ctx.setTransform(k * scale, 0, 0, k * scale, (ox - cam.x) * k, (oy - cam.y) * k)
        ctx.fillStyle = rec.stroke.color
        ctx.fill(getPath(rec))
      }
      for (const st of texts ?? []) {
        const el = st.element
        const lay = layoutTextBox(el)
        const x = el.x + st.ox + dx
        const y = el.y + st.oy + dy
        ctx.setTransform(k, 0, 0, k, (x - cam.x) * k, (y - cam.y) * k)
        ctx.font = lay.font
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillStyle = el.color
        for (let i = 0; i < lay.lines.length; i++) ctx.fillText(lay.lines[i], 0, i * lay.lineHeight)
      }
      this.liveHasContent = true
    }
    if (stroke && stroke.points.length) {
      ctx.save()
      if (stroke.clip) {
        const c = stroke.clip
        ctx.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k)
        ctx.beginPath()
        ctx.rect(c.minX, c.minY, c.maxX - c.minX, c.maxY - c.minY)
        ctx.clip()
      }
      ctx.setTransform(k, 0, 0, k, (stroke.ox - cam.x) * k, (stroke.oy - cam.y) * k)
      ctx.fillStyle = stroke.color
      ctx.fill(outlineToPath(strokeOutline(stroke.points, stroke.width, stroke.opts, false, stroke.predicted)))
      ctx.restore()
      this.liveHasContent = true
    }
    if (overlay?.lasso && overlay.lasso.length >= 4) {
      const l = overlay.lasso
      ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0)
      ctx.beginPath()
      for (let i = 0; i < l.length; i += 2) {
        const sx = (l[i] - cam.x) * cam.zoom
        const sy = (l[i + 1] - cam.y) * cam.zoom
        if (i === 0) ctx.moveTo(sx, sy)
        else ctx.lineTo(sx, sy)
      }
      ctx.closePath()
      ctx.fillStyle = 'rgba(37,99,235,0.06)'
      ctx.fill()
      ctx.setLineDash([6, 5])
      ctx.lineWidth = 1.5
      ctx.strokeStyle = '#2563eb'
      ctx.stroke()
      ctx.setLineDash([])
      this.liveHasContent = true
    }
    if (cursor) {
      const s = this.scale
      ctx.setTransform(s, 0, 0, s, 0, 0)
      ctx.beginPath()
      ctx.arc(cursor.sx, cursor.sy, Math.max(1.5, cursor.radius), 0, Math.PI * 2)
      if (cursor.kind === 'eraser') {
        ctx.lineWidth = 1
        ctx.strokeStyle = 'rgba(0,0,0,0.55)'
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        ctx.fill()
        ctx.stroke()
      } else {
        ctx.fillStyle = cursor.color
        ctx.globalAlpha = 0.45
        ctx.fill()
        ctx.globalAlpha = 1
      }
      this.liveHasContent = true
    }
  }
}

function mod(a: number, n: number) {
  return ((a % n) + n) % n
}
