import { patternGeometry } from '../engine/background'
import { strokeOutline } from '../engine/geometry'
import { closePdf, openPdf } from '../engine/pdf/pdfjs'
import type { LinkElement, MemoElement, Page, Stroke, TextBox } from '../shared/model'
import { getAsset, loadDocument, type ChunkData } from '../storage/repo'
import { tryEnsureAssetLocal } from '../sync/assets'
import { parseChunkKey } from '../engine/layout'
import type { ExportImage, ExportJob, ExportPage, ExportPath, WorkerOut } from './exportTypes'
import { recallPassword } from './passwords'

export interface ExportOptions {
  pageIndices?: number[] // 없으면 전체
  includePattern?: boolean
  onProgress?: (done: number, total: number, phase: string) => void
  askPassword?: (incorrect: boolean) => Promise<string | null>
}

export function parseColor(hex: string): { r: number; g: number; b: number; a: number } {
  const h = hex.replace('#', '')
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255
  return { r: n(0), g: n(2), b: n(4), a: h.length >= 8 ? n(6) : 1 }
}

/** perfect-freehand 외곽선 → SVG path (소수점 2자리) */
export function strokeToSvgPath(s: Stroke, dx: number, dy: number): string {
  const pts = strokeOutline(s.points, s.width, s.opts, true)
  if (pts.length < 3) return ''
  const f = (v: number) => (Math.round(v * 100) / 100).toString()
  const n = pts.length
  let d = `M${f((pts[0][0] + pts[1][0]) / 2 + dx)} ${f((pts[0][1] + pts[1][1]) / 2 + dy)}`
  for (let i = 1; i <= n; i++) {
    const a = pts[i % n]
    const b = pts[(i + 1) % n]
    d += `Q${f(a[0] + dx)} ${f(a[1] + dy)} ${f((a[0] + b[0]) / 2 + dx)} ${f((a[1] + b[1]) / 2 + dy)}`
  }
  return d + 'Z'
}

function strokesToPaths(strokes: Stroke[], dx: number, dy: number): ExportPath[] {
  const sorted = [...strokes].sort((a, b) => (a.layer === b.layer ? a.z - b.z : a.layer === 'under' ? -1 : 1))
  const out: ExportPath[] = []
  for (const s of sorted) {
    const d = strokeToSvgPath(s, dx, dy)
    if (d) out.push({ d, ...parseColor(s.color) })
  }
  return out
}

// ───────── 텍스트·링크 블록 (블록 편집 모드) ─────────

/** 블록 높이 추정 — 저장된 h가 없으면 줄 수로 (선택 박스·썸네일과 같은 규약) */
const blockH = (el: TextBox | LinkElement | MemoElement): number =>
  el.h ?? el.fontSize * 1.35 * Math.max(1, (el.type === 'link' ? el.label : el.text).split('\n').length)

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (!para) {
      out.push('')
      continue
    }
    let line = ''
    for (const ch of para) {
      const next = line + ch
      if (line && ctx.measureText(next).width > maxW) {
        out.push(line)
        line = ch
      } else line = next
    }
    out.push(line)
  }
  return out
}

/** 블록을 캔버스에 그린다 (썸네일과 같은 규약: baseline top, 줄 간격 1.35) */
function drawTextBlock(ctx: CanvasRenderingContext2D, el: TextBox | LinkElement, ox: number, oy: number) {
  ctx.font = `${el.fontSize}px ${el.fontFamily ?? 'sans-serif'}`
  ctx.fillStyle = el.color
  ctx.textBaseline = 'top'
  ctx.textAlign = el.align ?? 'left'
  const lh = el.fontSize * 1.35
  const lines = wrapLines(ctx, el.type === 'link' ? el.label : el.text, el.w)
  const tx = ox + (el.align === 'center' ? el.w / 2 : el.align === 'right' ? el.w : 0)
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], tx, oy + i * lh)
  if (el.type === 'link' && el.url && el.label) {
    const last = lines[lines.length - 1] ?? ''
    const wpx = ctx.measureText(last).width
    const ux = ox + (el.align === 'center' ? (el.w - wpx) / 2 : el.align === 'right' ? el.w - wpx : 0)
    const uy = oy + (lines.length - 1) * lh + el.fontSize * 1.15
    ctx.beginPath()
    ctx.moveTo(ux, uy)
    ctx.lineTo(ux + wpx, uy)
    ctx.strokeStyle = el.color
    ctx.lineWidth = Math.max(0.5, el.fontSize / 14)
    ctx.stroke()
  }
}

/** 둥근 사각형 경로 (반경 r) */
function rrPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** 메모 블록을 카드(헤더 밴드 + 흰 본문)로 그린다 — 화면의 .block-memo와 같은 규약 (헤더 34, 모서리 12, 본문 패딩 12) */
function drawMemoBlock(ctx: CanvasRenderingContext2D, el: MemoElement, ox: number, oy: number) {
  const R = 10
  const HEAD = 34
  const pad = 12
  // 카드 본체 + 테두리
  rrPath(ctx, ox + 0.5, oy + 0.5, el.w - 1, el.h - 1, R)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.strokeStyle = '#e4e9f0'
  ctx.lineWidth = 1
  ctx.stroke()
  // 헤더 밴드 (카드 모서리에 맞춰 클리핑)
  ctx.save()
  rrPath(ctx, ox + 0.5, oy + 0.5, el.w - 1, el.h - 1, R)
  ctx.clip()
  ctx.fillStyle = '#eef1f4'
  ctx.fillRect(ox, oy, el.w, HEAD)
  ctx.restore()
  // 헤더: 문서 아이콘(단순화) + 제목
  ctx.fillStyle = '#6b7a90'
  rrPath(ctx, ox + 12, oy + 9.5, 15, 15, 3)
  ctx.fill()
  ctx.strokeStyle = '#eef1f4'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(ox + 15.5, oy + 13.5)
  ctx.lineTo(ox + 23.5, oy + 13.5)
  ctx.moveTo(ox + 15.5, oy + 17)
  ctx.lineTo(ox + 21.5, oy + 17)
  ctx.stroke()
  ctx.fillStyle = '#46536a'
  ctx.font = `600 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillText('메모', ox + 33, oy + HEAD / 2 + 1)
  // 본문 텍스트 (헤더 아래, 카드 안에 클리핑)
  ctx.save()
  rrPath(ctx, ox + 0.5, oy + 0.5, el.w - 1, el.h - 1, R)
  ctx.clip()
  ctx.font = `${el.fontSize}px ${el.fontFamily ?? 'sans-serif'}`
  ctx.fillStyle = el.color
  ctx.textBaseline = 'top'
  ctx.textAlign = el.align ?? 'left'
  const lh = el.fontSize * 1.35
  const lines = wrapLines(ctx, el.text, el.w - pad * 2)
  const tx = ox + pad + (el.align === 'center' ? (el.w - pad * 2) / 2 : el.align === 'right' ? el.w - pad * 2 : 0)
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], tx, oy + HEAD + 10 + i * lh)
  ctx.restore()
}

/**
 * 텍스트 블록을 투명 배경 PNG(3배)로 만든다.
 * 워커(pdf-lib)에 한글 글꼴을 싣지 않고도 화면과 같은 모양을 내보내기 위한 것 — 표준 폰트로는 라틴 문자만 그릴 수 있다.
 */
function rasterBlockImage(el: TextBox | LinkElement | MemoElement): { data: ArrayBuffer; w: number; h: number } | null {
  const scale = 3
  const measure = document.createElement('canvas').getContext('2d')
  if (!measure) return null
  // 메모: 카드 크기 그대로 (헤더·본문 포함)
  if (el.type === 'memo') {
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round((el.w + 2) * scale))
    c.height = Math.max(1, Math.round((el.h + 2) * scale))
    const ctx = c.getContext('2d')
    if (!ctx) return null
    ctx.scale(scale, scale)
    drawMemoBlock(ctx, el, 0, 0)
    const b64 = c.toDataURL('image/png').split(',')[1] ?? ''
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return { data: bytes.buffer, w: el.w + 2, h: el.h + 2 }
  }
  measure.font = `${el.fontSize}px ${el.fontFamily ?? 'sans-serif'}`
  const lines = wrapLines(measure, el.type === 'link' ? el.label : el.text, el.w)
  const lh = el.fontSize * 1.35
  const h = Math.max(lh, lines.length * lh + el.fontSize * 0.4)
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round((el.w + 2) * scale))
  c.height = Math.max(1, Math.round(h * scale))
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.scale(scale, scale)
  // 블록 원점 (0,0) 기준으로 그린다 — 배치는 호출부에서 el.x·el.y로 한다
  drawTextBlock(ctx, el, 0, 0)
  const b64 = c.toDataURL('image/png').split(',')[1] ?? ''
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return { data: bytes.buffer, w: el.w + 2, h }
}

const rgb3 = (hex: string): [number, number, number] => {
  const c = parseColor(hex)
  return [c.r, c.g, c.b]
}

function patternFor(page: Page): ExportPage['pattern'] {
  if (!page.size) return null
  const g = patternGeometry(page.background, page.size.w, page.size.h)
  if (!g) return null
  return {
    lines: g.lines,
    dots: g.dots,
    lineWidth: g.lineWidth,
    dotRadius: g.dotRadius,
    color: rgb3(g.color),
    accent: g.accent ? { lines: g.accent.lines, color: rgb3(g.accent.color), width: g.accent.width } : undefined
  }
}

/** 문서형 문서 → PDF (FR-IO-03) */
export async function exportDocumentPdf(documentId: string, opts: ExportOptions = {}): Promise<Blob> {
  const { doc, pages, chunks } = await loadDocument(documentId)
  const strokesByPage = new Map<string, Stroke[]>()
  const blocksByPage = new Map<string, (TextBox | LinkElement | MemoElement)[]>()
  for (const c of chunks) {
    const arr = strokesByPage.get(c.pageId) ?? []
    const blocks = blocksByPage.get(c.pageId) ?? []
    for (const e of c.elements) {
      if (e.type === 'stroke') arr.push(e)
      else if (e.type === 'text' || e.type === 'link' || e.type === 'memo') blocks.push(e)
    }
    strokesByPage.set(c.pageId, arr)
    blocksByPage.set(c.pageId, blocks)
  }

  if (doc.mode === 'infinite') return exportInfinitePdf(doc.title, chunks, opts)

  const indices = opts.pageIndices ?? pages.map((_, i) => i)
  const selected = indices.map((i) => pages[i]).filter(Boolean)
  const expPages: ExportPage[] = selected.map((p) => ({
    w: p.size!.w,
    h: p.size!.h,
    paper: p.pdf ? null : rgb3(p.background.type === 'blank' ? p.background.color : '#ffffff'),
    pattern: p.pdf || opts.includePattern === false ? null : patternFor(p),
    pdf: p.pdf ? { ...p.pdf } : undefined,
    paths: strokesToPaths(strokesByPage.get(p.id) ?? [], 0, 0),
    images: (blocksByPage.get(p.id) ?? [])
      .map((el) => {
        const img = rasterBlockImage(el)
        return img ? { data: img.data, x: el.x, y: el.y, w: img.w, h: img.h } : null
      })
      .filter((v): v is ExportImage => !!v)
  }))

  const sources: Record<string, ArrayBuffer> = {}
  for (const p of selected) {
    if (p.pdf && !sources[p.pdf.assetId]) {
      const a = await getAsset(p.pdf.assetId)
      if (!a) throw new Error('PDF 원본 정보를 찾을 수 없습니다.')
      // 지연 로딩: 이 기기에 원본이 없으면 지금 받아온다
      const src = a.blob ?? (await tryEnsureAssetLocal(a.id))
      if (!src) throw new Error('PDF 원본이 이 기기에 없어 내보낼 수 없습니다. 설정 > 동기화에서 원본을 받은 뒤 다시 시도하세요.')
      sources[p.pdf.assetId] = await src.arrayBuffer()
    }
  }

  const job: ExportJob = { title: doc.title, pages: expPages, sources }
  let result = await runWorker(job, opts)
  if (result.type === 'need-raster') {
    // 암호가 걸린 PDF 등: 해당 페이지를 pdf.js로 이미지로 만들어 대체 (벡터 필기는 그대로)
    opts.onProgress?.(0, expPages.length, '원본 페이지를 이미지로 변환 중')
    await rasterize(job, selected, result.assetIds, opts)
    for (const id of result.assetIds) delete job.sources[id]
    result = await runWorker(job, opts)
  }
  if (result.type !== 'done') throw new Error('PDF를 만들지 못했습니다.')
  return new Blob([result.bytes], { type: 'application/pdf' })
}

async function rasterize(job: ExportJob, pages: Page[], assetIds: string[], opts: ExportOptions) {
  const need = new Set(assetIds)
  for (const id of need) {
    const a = await getAsset(id)
    if (!a) continue
    const src = a.blob ?? (await tryEnsureAssetLocal(a.id))
    if (!src) continue
    let pw = recallPassword(id)
    let pdf
    for (;;) {
      try {
        pdf = await openPdf(await src.arrayBuffer(), pw)
        break
      } catch {
        const next = opts.askPassword ? await opts.askPassword(!!pw) : null
        if (next == null) throw new Error('암호를 입력하지 않아 내보내기를 취소했습니다.')
        pw = next
      }
    }
    let done = 0
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i]
      if (p.pdf?.assetId !== id) continue
      const page = await pdf.getPage(p.pdf.pageIndex + 1)
      const vp = page.getViewport({ scale: 2, rotation: (page.rotate + p.pdf.rotation) % 360 }) // 144 dpi
      const c = document.createElement('canvas')
      c.width = Math.round(vp.width)
      c.height = Math.round(vp.height)
      await page.render({ canvas: null, canvasContext: c.getContext('2d')!, viewport: vp, background: '#ffffff' }).promise
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.9))
      c.width = c.height = 0
      if (blob) job.pages[i].raster = { jpeg: await blob.arrayBuffer() }
      opts.onProgress?.(++done, pages.length, '원본 페이지를 이미지로 변환 중')
    }
    await closePdf(pdf)
  }
}

/** 무한 캔버스: 필기 전체 영역을 PDF 1페이지로 (14.3). 너무 크면 비율을 유지한 채 줄인다 */
async function exportInfinitePdf(title: string, chunks: ChunkData[], opts: ExportOptions): Promise<Blob> {
  const pad = 24
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const world: Stroke[] = []
  const blocksWorld: { el: TextBox | LinkElement | MemoElement; ox: number; oy: number }[] = []
  for (const c of chunks) {
    const { ox, oy } = parseChunkKey(c.key)
    for (const e of c.elements) {
      if (e.type !== 'stroke') {
        if (e.type === 'text' || e.type === 'link' || e.type === 'memo') {
          blocksWorld.push({ el: e, ox, oy })
          minX = Math.min(minX, e.x + ox)
          minY = Math.min(minY, e.y + oy)
          maxX = Math.max(maxX, e.x + ox + e.w)
          maxY = Math.max(maxY, e.y + oy + blockH(e))
        }
        continue
      }
      minX = Math.min(minX, e.bbox[0] + ox)
      minY = Math.min(minY, e.bbox[1] + oy)
      maxX = Math.max(maxX, e.bbox[2] + ox)
      maxY = Math.max(maxY, e.bbox[3] + oy)
      const pts = e.points.slice()
      for (let i = 0; i < pts.length; i += 4) {
        pts[i] += ox
        pts[i + 1] += oy
      }
      world.push({ ...e, points: pts })
    }
  }
  if (!world.length && !blocksWorld.length) {
    minX = minY = 0
    maxX = 595
    maxY = 842
  }
  const w = maxX - minX + pad * 2
  const h = maxY - minY + pad * 2
  const k = Math.min(1, 14400 / Math.max(w, h)) // PDF 페이지 최대 200in
  const scaled = world.map((s) => {
    const pts = s.points.slice()
    for (let i = 0; i < pts.length; i += 4) {
      pts[i] = (pts[i] - minX + pad) * k
      pts[i + 1] = (pts[i + 1] - minY + pad) * k
    }
    return { ...s, points: pts, width: s.width * k }
  })
  const images: ExportImage[] = []
  for (const b of blocksWorld) {
    const img = rasterBlockImage(b.el)
    if (!img) continue
    images.push({
      data: img.data,
      x: (b.el.x + b.ox - minX + pad) * k,
      y: (b.el.y + b.oy - minY + pad) * k,
      w: img.w * k,
      h: img.h * k
    })
  }
  const page: ExportPage = { w: w * k, h: h * k, paper: [1, 1, 1], pattern: null, paths: strokesToPaths(scaled, 0, 0), images }
  const result = await runWorker({ title, pages: [page], sources: {} }, opts)
  if (result.type !== 'done') throw new Error('PDF를 만들지 못했습니다.')
  return new Blob([result.bytes], { type: 'application/pdf' })
}

function runWorker(job: ExportJob, opts: ExportOptions): Promise<Extract<WorkerOut, { type: 'done' | 'need-raster' }>> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (ev: MessageEvent<WorkerOut>) => {
      const m = ev.data
      if (m.type === 'progress') opts.onProgress?.(m.done, m.total, 'PDF 만드는 중')
      else {
        w.terminate()
        if (m.type === 'error') reject(new Error(m.message))
        else resolve(m)
      }
    }
    w.onerror = (e) => {
      w.terminate()
      reject(new Error(e.message || '내보내기 Worker 오류'))
    }
    // 원본 버퍼는 복사해서 넘긴다 (래스터 대체 시 다시 쓰일 수 있음)
    w.postMessage(job)
  })
}
