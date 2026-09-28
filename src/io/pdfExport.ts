import { patternGeometry } from '../engine/background'
import { strokeOutline } from '../engine/geometry'
import { closePdf, openPdf } from '../engine/pdf/pdfjs'
import type { Page, Stroke } from '../shared/model'
import { getAsset, loadDocument, type ChunkData } from '../storage/repo'
import { parseChunkKey } from '../engine/layout'
import type { ExportJob, ExportPage, ExportPath, WorkerOut } from './exportTypes'
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
  for (const c of chunks) {
    const arr = strokesByPage.get(c.pageId) ?? []
    for (const e of c.elements) if (e.type === 'stroke') arr.push(e)
    strokesByPage.set(c.pageId, arr)
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
    paths: strokesToPaths(strokesByPage.get(p.id) ?? [], 0, 0)
  }))

  const sources: Record<string, ArrayBuffer> = {}
  for (const p of selected) {
    if (p.pdf && !sources[p.pdf.assetId]) {
      const a = await getAsset(p.pdf.assetId)
      if (!a?.blob) throw new Error('PDF 원본이 이 기기에 없어 내보낼 수 없습니다.')
      sources[p.pdf.assetId] = await a.blob.arrayBuffer()
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
    if (!a?.blob) continue
    let pw = recallPassword(id)
    let pdf
    for (;;) {
      try {
        pdf = await openPdf(await a.blob.arrayBuffer(), pw)
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
  for (const c of chunks) {
    const { ox, oy } = parseChunkKey(c.key)
    for (const e of c.elements) {
      if (e.type !== 'stroke') continue
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
  if (!world.length) {
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
  const page: ExportPage = { w: w * k, h: h * k, paper: [1, 1, 1], pattern: null, paths: strokesToPaths(scaled, 0, 0) }
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
