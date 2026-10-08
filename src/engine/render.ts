import { Camera } from './camera'
import { MAX_CANVAS_PIXELS } from './constants'
import { drawPattern } from './background'
import { outlineToPath, strokeOutline } from './geometry'
import type { Layout } from './layout'
import type { PdfCache } from './pdf/pdfCache'
import { getPath, type Scene, type StrokeRec } from './scene'
import type { Background, StrokeOpts } from '../shared/model'

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

export interface Overlay {
  lasso?: number[] // 월드 좌표 다각형
  selection?: { recs: StrokeRec[]; dx: number; dy: number; scale: number; cx: number; cy: number }
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
  /** 입력 레이어에서 지난 프레임에 실제로 그린 영역(기기 픽셀). 전체 clearRect를 피하기 위해 기록한다 */
  private liveDrawn: LiveBox | null = null
  /** 선택된 획은 확정 레이어에서 빼고 입력 레이어에 그린다 */
  hidden: Set<string> | null = null
  /** 모션그래픽 레이어(화면 좌표계)와 입자 목록 */
  readonly fx: HTMLCanvasElement
  private fctx: CanvasRenderingContext2D
  private fxp: FxParticle[] = []
  private fxOn = false

  constructor(root: HTMLElement) {
    this.root = root
    this.pageLayer = document.createElement('canvas')
    this.pageLayer.className = 'layer layer-page'
    this.committed = document.createElement('canvas')
    this.committed.className = 'layer layer-committed'
    this.live = document.createElement('canvas')
    this.live.className = 'layer layer-live'
    // 인터랙티브 모션그래픽(잉크 버스트) 전용 레이어 — 카메라 변환 없이 화면 좌표계로 그린다
    this.fx = document.createElement('canvas')
    this.fx.className = 'layer layer-fx'
    root.append(this.pageLayer, this.committed, this.live, this.fx)
    this.pctx = this.pageLayer.getContext('2d')!
    this.cctx = this.committed.getContext('2d')!
    this.lctx = this.live.getContext('2d', { desynchronized: true } as CanvasRenderingContext2DSettings)!
    this.fctx = this.fx.getContext('2d')!
  }

  destroy() {
    for (const c of [this.pageLayer, this.committed, this.live, this.fx]) {
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
    for (const c of [this.pageLayer, this.committed, this.live, this.fx]) {
      c.width = Math.round(this.cssW * scale)
      c.height = Math.round(this.cssH * scale)
      c.style.width = this.cssW + 'px'
      c.style.height = this.cssH + 'px'
    }
    this.liveDrawn = null // 크기 변경 시 캔버스가 자동으로 비워진다
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

  fullRedraw(scene: Scene, cam: Camera) {
    const t0 = performance.now()
    const ctx = this.cctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.committed.width, this.committed.height)
    const v = this.viewBox(cam)
    this.visibleCount = this.drawList(ctx, scene.query(v.minX, v.minY, v.maxX, v.maxY), cam)
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
    this.drawList(ctx, scene.query(x0 / k + cam.x, y0 / k + cam.y, x1 / k + cam.x, y1 / k + cam.y), cam)
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
    const k = cam.zoom * this.scale
    // 입력 레이어에는 지난 프레임에 그린 것만 남아 있다 → 그 영역만 지우면 된다.
    // 캔버스 전체를 매 프레임 지우는 것은 큰 화면에서 수 ms를 쓰므로 지연을 키운다.
    if (this.liveDrawn) {
      const b = this.liveDrawn
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(Math.floor(b.x0) - 2, Math.floor(b.y0) - 2, Math.ceil(b.x1 - b.x0) + 4, Math.ceil(b.y1 - b.y0) + 4)
      this.liveDrawn = null
    }
    const boxes: LiveBox[] = []
    if (overlay?.selection) {
      const { recs, dx, dy, scale, cx, cy } = overlay.selection
      for (const rec of recs) {
        // 월드 좌표: p' = c + (p - c) * scale + d
        const ox = cx + (rec.ox - cx) * scale + dx
        const oy = cy + (rec.oy - cy) * scale + dy
        ctx.setTransform(k * scale, 0, 0, k * scale, (ox - cam.x) * k, (oy - cam.y) * k)
        ctx.fillStyle = rec.stroke.color
        ctx.fill(getPath(rec))
        const it = rec.item
        boxes.push({
          x0: (it.minX + dx - cam.x) * k,
          y0: (it.minY + dy - cam.y) * k,
          x1: (it.maxX + dx - cam.x) * k,
          y1: (it.maxY + dy - cam.y) * k
        })
      }
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
      const b = liveStrokeBox(stroke)
      boxes.push({
        x0: (b.minX - cam.x) * k,
        y0: (b.minY - cam.y) * k,
        x1: (b.maxX - cam.x) * k,
        y1: (b.maxY - cam.y) * k
      })
    }
    if (overlay?.lasso && overlay.lasso.length >= 4) {
      const l = overlay.lasso
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0)
      ctx.beginPath()
      for (let i = 0; i < l.length; i += 2) {
        const sx = (l[i] - cam.x) * cam.zoom
        const sy = (l[i + 1] - cam.y) * cam.zoom
        if (sx < x0) x0 = sx
        if (sy < y0) y0 = sy
        if (sx > x1) x1 = sx
        if (sy > y1) y1 = sy
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
      boxes.push({ x0: x0 * this.scale, y0: y0 * this.scale, x1: x1 * this.scale, y1: y1 * this.scale })
    }
    if (cursor) {
      const s = this.scale
      const r = Math.max(1.5, cursor.radius)
      ctx.setTransform(s, 0, 0, s, 0, 0)
      ctx.beginPath()
      ctx.arc(cursor.sx, cursor.sy, r, 0, Math.PI * 2)
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
      boxes.push({ x0: cursor.sx * s - r * s, y0: cursor.sy * s - r * s, x1: cursor.sx * s + r * s, y1: cursor.sy * s + r * s })
    }
    this.liveDrawn = unionLiveBoxes(boxes)
  }

  // ───────── 인터랙티브 모션그래픽 (INK FX) ─────────

  /** 획이 끝난 지점에 잉크가 잔물결처럼 번지는 버스트를 띄운다 (화면 좌표계) */
  bloom(wx: number, wy: number, color: string, cam: Camera) {
    if (this.fxp.length > 140) return
    const k = cam.zoom * this.scale
    const sx = (wx - cam.x) * k
    const sy = (wy - cam.y) * k
    const n = 9
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.7
      const sp = this.scale * (58 + Math.random() * 120)
      this.fxp.push({
        x: sx,
        y: sy,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        r: this.scale * (1.6 + Math.random() * 2.6),
        life: 1,
        decay: 0.028 + Math.random() * 0.022,
        color
      })
    }
    this.fxp.push({ x: sx, y: sy, vx: 0, vy: 0, r: this.scale * 2.4, life: 1, decay: 0.09, color, ring: true })
    this.fxOn = true
  }

  /** 매 프레임 FX 레이어를 갱신한다. 입자가 없으면 한 번만 지우고 이후 비용은 0 */
  drawFx() {
    const ctx = this.fctx
    if (!this.fxp.length) {
      if (this.fxOn) {
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, this.fx.width, this.fx.height)
        this.fxOn = false
      }
      return
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.fx.width, this.fx.height)
    for (let i = this.fxp.length - 1; i >= 0; i--) {
      const p = this.fxp[i]
      p.life -= p.decay
      if (p.life <= 0) {
        this.fxp.splice(i, 1)
        continue
      }
      p.x += p.vx
      p.y += p.vy
      p.vx *= 0.9
      p.vy *= 0.9
      const e = p.life * p.life
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r * (p.ring ? 1 + (1 - p.life) * 5 : 1), 0, Math.PI * 2)
      if (p.ring) {
        ctx.globalAlpha = Math.min(0.8, e * 1.5)
        ctx.strokeStyle = p.color
        ctx.lineWidth = Math.max(1, this.scale * 1.4)
        ctx.stroke()
      } else {
        ctx.globalAlpha = Math.min(0.85, e)
        ctx.fillStyle = p.color
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
    this.fxOn = true
  }
}

/** 모션그래픽 입자 (화면/기기 픽셀 좌표계, px/frame 속도) */
interface FxParticle {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  life: number
  decay: number
  color: string
  ring?: boolean
}

/** 입력 레이어에 그린 것의 기기 픽셀 영역 */
interface LiveBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** 입력 중인 획이 차지하는 월드 bbox (외곽선 두께·예측 점 포함) */
function liveStrokeBox(stroke: LiveDraw): { minX: number; minY: number; maxX: number; maxY: number } {
  const pts = stroke.points
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < pts.length; i += 4) {
    if (pts[i] < minX) minX = pts[i]
    if (pts[i] > maxX) maxX = pts[i]
    if (pts[i + 1] < minY) minY = pts[i + 1]
    if (pts[i + 1] > maxY) maxY = pts[i + 1]
  }
  for (const p of stroke.predicted) {
    if (p[0] < minX) minX = p[0]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] < minY) minY = p[1]
    if (p[1] > maxY) maxY = p[1]
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  const pad = stroke.width + 2
  return { minX: minX + stroke.ox - pad, minY: minY + stroke.oy - pad, maxX: maxX + stroke.ox + pad, maxY: maxY + stroke.oy + pad }
}

function unionLiveBoxes(list: LiveBox[]): LiveBox | null {
  if (!list.length) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const b of list) {
    if (b.x0 < x0) x0 = b.x0
    if (b.y0 < y0) y0 = b.y0
    if (b.x1 > x1) x1 = b.x1
    if (b.y1 > y1) y1 = b.y1
  }
  return { x0, y0, x1, y1 }
}

function mod(a: number, n: number) {
  return ((a % n) + n) % n
}
