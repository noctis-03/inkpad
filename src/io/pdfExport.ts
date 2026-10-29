// [규칙] 편집 블록(메모·링크·할 일·타이머·페이지 이동)은 PDF 내보내기에 절대 포함되지 않는다.
// 블록은 Element 청크(chunks)와 별개 테이블(blocks)에 저장되므로 이 파일의 경로는 애초에 블록을 볼 수 없다.
// 회귀 방지: loadDocument 반환값에 blocks 필드가 새로 생겼지만, 아래 어떤 경로도 그 값을 읽지 않는다 —
// 구조 분해에 blocks를 넣지 말 것. ExportJob은 청크의 stroke·사진(+ 고른 경우 보조 용지)으로만 만들어진다.
import { patternGeometry } from '../engine/background'
import { strokeOutline } from '../engine/geometry'
import { closePdf, openPdf } from '../engine/pdf/pdfjs'
import { pageScale, type ImageElement, type Page, type Stroke } from '../shared/model'
import { getAsset, loadDocument, type ChunkData } from '../storage/repo'
import { tryEnsureAssetLocal } from '../sync/assets'
import { parseChunkKey } from '../engine/layout'
import type { ExportImage, ExportJob, ExportPage, ExportPath, ExportSheet, WorkerOut } from './exportTypes'
import { recallPassword } from './passwords'

export interface ExportOptions {
  pageIndices?: number[] // 없으면 전체
  includePattern?: boolean
  /** 페이지 왼쪽·오른쪽에 붙은(snap) 보조 용지를 페이지 옆에 함께 — PDF 페이지가 그만큼 넓어진다. 떠 있는 용지는 넣지 않는다 */
  includeSheets?: boolean
  onProgress?: (done: number, total: number, phase: string) => void
  askPassword?: (incorrect: boolean) => Promise<string | null>
}

export function parseColor(hex: string): { r: number; g: number; b: number; a: number } {
  const h = hex.replace('#', '')
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255
  return { r: n(0), g: n(2), b: n(4), a: h.length >= 8 ? n(6) : 1 }
}

/** perfect-freehand 외곽선 → SVG path (소수점 2자리). k: 페이지 내용 배율(점 × k + d) */
export function strokeToSvgPath(s: Stroke, dx: number, dy: number, k = 1): string {
  const pts = strokeOutline(s.points, s.width, s.opts, true)
  if (pts.length < 3) return ''
  const f = (v: number) => (Math.round(v * 100) / 100).toString()
  const X = (v: number) => f(v * k + dx)
  const Y = (v: number) => f(v * k + dy)
  const n = pts.length
  let d = `M${X((pts[0][0] + pts[1][0]) / 2)} ${Y((pts[0][1] + pts[1][1]) / 2)}`
  for (let i = 1; i <= n; i++) {
    const a = pts[i % n]
    const b = pts[(i + 1) % n]
    d += `Q${X(a[0])} ${Y(a[1])} ${X((a[0] + b[0]) / 2)} ${Y((a[1] + b[1]) / 2)}`
  }
  return d + 'Z'
}

function strokesToPaths(strokes: Stroke[], dx: number, dy: number, k = 1): ExportPath[] {
  const sorted = [...strokes].sort((a, b) => (a.layer === b.layer ? a.z - b.z : a.layer === 'under' ? -1 : 1))
  const out: ExportPath[] = []
  for (const s of sorted) {
    const d = strokeToSvgPath(s, dx, dy, k)
    if (d) out.push({ d, ...parseColor(s.color) })
  }
  return out
}

/** 사진 요소 → 종이 왼쪽 위 기준 pt (k: 페이지 내용 배율, d: 청크 원점) */
function imagesOut(list: ImageElement[], dx: number, dy: number, k = 1): ExportImage[] {
  return [...list]
    .sort((a, b) => a.z - b.z)
    .map((im) => ({ assetId: im.assetId, x: im.x * k + dx, y: im.y * k + dy, w: im.w * k, h: im.h * k }))
}

/** 내보낼 사진 원본 — 이 기기에 없으면 받아 온다. 끝내 못 구한 사진은 빼고 내보낸다 */
async function loadImageSources(pages: ExportPage[]): Promise<Record<string, ArrayBuffer>> {
  const ids = new Set<string>()
  for (const p of pages) {
    for (const im of p.images ?? []) ids.add(im.assetId)
    for (const s of p.sheets ?? []) for (const im of s.images ?? []) ids.add(im.assetId)
  }
  const out: Record<string, ArrayBuffer> = {}
  for (const id of ids) {
    const a = await getAsset(id)
    const src = a ? (a.blob ?? (await tryEnsureAssetLocal(a.id))) : null
    if (src) out[id] = await src.arrayBuffer()
  }
  return out
}

const rgb3 = (hex: string): [number, number, number] => {
  const c = parseColor(hex)
  return [c.r, c.g, c.b]
}

function patternFor(page: Page): ExportPage['pattern'] {
  if (!page.size) return null
  const g = patternGeometry(page.background, page.size.w, page.size.h, pageScale(page))
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

/**
 * 페이지에 붙은 보조 용지를 둘러 PDF 페이지(frame)를 넓힌다. 좌표는 원래 페이지 왼쪽 위 기준으로 모은 뒤
 * frame 왼쪽 위 기준으로 옮긴다 (용지가 페이지보다 위로 올라가 있으면 frame도 위로 늘어난다)
 */
function attachSheets(
  page: Page,
  sheets: Page[],
  strokesByPage: Map<string, Stroke[]>,
  imagesByPage: Map<string, ImageElement[]>,
  includePattern: boolean
): Pick<ExportPage, 'frame' | 'sheets'> {
  const { w, h } = page.size!
  const placed = sheets.map((sh) => {
    const sw = sh.size!.w
    return { sh, x: sh.sheet!.snap === 'left' ? -sw : w, y: sh.sheet!.y, w: sw, h: sh.size!.h }
  })
  const minX = Math.min(0, ...placed.map((r) => r.x))
  const minY = Math.min(0, ...placed.map((r) => r.y))
  const maxX = Math.max(w, ...placed.map((r) => r.x + r.w))
  const maxY = Math.max(h, ...placed.map((r) => r.y + r.h))
  const out: ExportSheet[] = placed.map(({ sh, x, y, w, h }) => {
    const transparent = !!sh.sheet!.transparent
    return {
      x: x - minX,
      y: y - minY,
      w,
      h,
      paper: transparent ? null : rgb3(sh.background.type === 'blank' ? sh.background.color : '#ffffff'),
      pattern: transparent || !includePattern ? null : patternFor(sh),
      border: transparent ? 'dashed' : 'solid',
      images: imagesOut(imagesByPage.get(sh.id) ?? [], 0, 0, pageScale(sh)),
      paths: strokesToPaths(strokesByPage.get(sh.id) ?? [], 0, 0, pageScale(sh))
    }
  })
  return { frame: { w: maxX - minX, h: maxY - minY, ox: -minX, oy: -minY }, sheets: out }
}

/** 문서형 문서 → PDF */
export async function exportDocumentPdf(documentId: string, opts: ExportOptions = {}): Promise<Blob> {
  const { doc, pages, sheets, chunks } = await loadDocument(documentId)
  const strokesByPage = new Map<string, Stroke[]>()
  const imagesByPage = new Map<string, ImageElement[]>()
  for (const c of chunks) {
    const arr = strokesByPage.get(c.pageId) ?? []
    const imgs = imagesByPage.get(c.pageId) ?? []
    for (const e of c.elements) {
      if (e.type === 'stroke') arr.push(e)
      else if (e.type === 'image') imgs.push(e)
    }
    strokesByPage.set(c.pageId, arr)
    imagesByPage.set(c.pageId, imgs)
  }

  if (doc.mode === 'infinite') return exportInfinitePdf(doc.title, chunks, opts)

  // 붙은 용지만 기준 페이지별로 (z순 — 화면과 같은 쌓임)
  const attached = new Map<string, Page[]>()
  if (opts.includeSheets) {
    for (const sh of [...sheets].sort((a, b) => a.sheet!.z - b.sheet!.z)) {
      if (!sh.sheet!.snap || !sh.size) continue
      const arr = attached.get(sh.sheet!.anchorPageId) ?? []
      arr.push(sh)
      attached.set(sh.sheet!.anchorPageId, arr)
    }
  }

  const indices = opts.pageIndices ?? pages.map((_, i) => i)
  const selected = indices.map((i) => pages[i]).filter(Boolean)
  const expPages: ExportPage[] = selected.map((p) => {
    const ep: ExportPage = {
      w: p.size!.w,
      h: p.size!.h,
      paper: p.pdf ? null : rgb3(p.background.type === 'blank' ? p.background.color : '#ffffff'),
      pattern: p.pdf || opts.includePattern === false ? null : patternFor(p),
      pdf: p.pdf ? { ...p.pdf } : undefined,
      images: imagesOut(imagesByPage.get(p.id) ?? [], 0, 0, pageScale(p)),
      paths: strokesToPaths(strokesByPage.get(p.id) ?? [], 0, 0, pageScale(p))
    }
    const sh = attached.get(p.id)
    return sh ? { ...ep, ...attachSheets(p, sh, strokesByPage, imagesByPage, opts.includePattern !== false) } : ep
  })

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

  const job: ExportJob = { title: doc.title, pages: expPages, sources, images: await loadImageSources(expPages) }
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

/** 무한 캔버스: 필기 전체 영역을 PDF 1페이지로. 너무 크면 비율을 유지한 채 줄인다 */
async function exportInfinitePdf(title: string, chunks: ChunkData[], opts: ExportOptions): Promise<Blob> {
  const pad = 24
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const world: Stroke[] = []
  const worldImages: ImageElement[] = []
  for (const c of chunks) {
    const { ox, oy } = parseChunkKey(c.key)
    for (const e of c.elements) {
      if (e.type === 'image') {
        minX = Math.min(minX, e.x + ox)
        minY = Math.min(minY, e.y + oy)
        maxX = Math.max(maxX, e.x + e.w + ox)
        maxY = Math.max(maxY, e.y + e.h + oy)
        worldImages.push({ ...e, x: e.x + ox, y: e.y + oy })
      }
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
  if (!world.length && !worldImages.length) {
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
  const page: ExportPage = {
    w: w * k,
    h: h * k,
    paper: [1, 1, 1],
    pattern: null,
    images: imagesOut(worldImages, (pad - minX) * k, (pad - minY) * k, k),
    paths: strokesToPaths(scaled, 0, 0)
  }
  const result = await runWorker({ title, pages: [page], sources: {}, images: await loadImageSources([page]) }, opts)
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
