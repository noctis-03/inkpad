/// <reference lib="webworker" />
// PDF 내보내기 Worker: 원본 PDF 페이지 위에 필기를 벡터 경로로 합친다.
import { PDFDocument, rgb, degrees, EncryptedPDFError, clip, endPath, popGraphicsState, pushGraphicsState, rectangle, type PDFEmbeddedPage, type PDFImage, type PDFPage } from 'pdf-lib'
import type { ExportImage, ExportJob, ExportPath, ExportPattern, WorkerOut } from './exportTypes'

/** 속지 무늬. (ox, oy) = 그 종이의 왼쪽 위(PDF 페이지 위쪽 기준), H = PDF 페이지 높이 */
function drawPattern(page: PDFPage, g: ExportPattern, ox: number, oy: number, H: number) {
  for (const [x1, y1, x2, y2] of g.lines) {
    page.drawLine({ start: { x: ox + x1, y: H - oy - y1 }, end: { x: ox + x2, y: H - oy - y2 }, thickness: g.lineWidth, color: rgb(...g.color) })
  }
  for (const [x, y] of g.dots) page.drawCircle({ x: ox + x, y: H - oy - y, size: g.dotRadius, color: rgb(...g.color) })
  if (g.accent) {
    for (const [x1, y1, x2, y2] of g.accent.lines) {
      page.drawLine({ start: { x: ox + x1, y: H - oy - y1 }, end: { x: ox + x2, y: H - oy - y2 }, thickness: g.accent.width, color: rgb(...g.accent.color) })
    }
  }
}

function drawPaths(page: PDFPage, paths: ExportPath[], ox: number, oy: number, H: number) {
  for (const path of paths) {
    // drawSvgPath는 SVG 좌표(y 아래로)를 (x, y) 기준으로 뒤집어 그린다
    page.drawSvgPath(path.d, { x: ox, y: H - oy, color: rgb(path.r, path.g, path.b), opacity: path.a, borderWidth: 0 })
  }
}

/** 사진 — 같은 원본은 한 번만 넣는다. PNG·JPEG가 아니거나 못 읽으면 건너뛴다 */
async function drawImages(out: PDFDocument, cache: Map<string, Promise<PDFImage | null>>, job: ExportJob, page: PDFPage, list: ExportImage[], ox: number, oy: number, H: number) {
  for (const im of list) {
    let p = cache.get(im.assetId)
    if (!p) {
      const bytes = job.images?.[im.assetId]
      p = !bytes
        ? Promise.resolve(null)
        : (isPng(bytes) ? out.embedPng(bytes) : out.embedJpg(bytes)).catch((e) => {
            console.warn('[export] 사진을 넣지 못했습니다.', im.assetId, e)
            return null
          })
      cache.set(im.assetId, p)
    }
    const img = await p
    if (img) page.drawImage(img, { x: ox + im.x, y: H - oy - im.y - im.h, width: im.w, height: im.h })
  }
}

const isPng = (b: ArrayBuffer) => {
  const u = new Uint8Array(b, 0, Math.min(4, b.byteLength))
  return u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47
}

const post = (m: WorkerOut, transfer?: Transferable[]) => (self as unknown as Worker).postMessage(m, transfer ?? [])

self.onmessage = async (ev: MessageEvent<ExportJob>) => {
  try {
    const job = ev.data
    const out = await PDFDocument.create()
    out.setTitle(job.title)
    out.setCreator('Inkpad')
    out.setProducer('Inkpad (pdf-lib)')

    // 1) 원본 PDF 로드. 못 읽으면 메인 스레드에 래스터 대체를 요청한다
    const srcDocs = new Map<string, PDFDocument>()
    const failed: string[] = []
    const needed = new Set(job.pages.filter((p) => p.pdf && !p.raster).map((p) => p.pdf!.assetId))
    for (const id of needed) {
      try {
        srcDocs.set(id, await PDFDocument.load(job.sources[id], { updateMetadata: false }))
      } catch (e) {
        if (e instanceof EncryptedPDFError || e instanceof Error) failed.push(id)
      }
    }
    if (failed.length) return post({ type: 'need-raster', assetIds: failed })

    // 2) 필요한 원본 페이지만 임베드 (같은 원본은 한 번에)
    const embedded = new Map<string, PDFEmbeddedPage>()
    for (const [id, src] of srcDocs) {
      const idx = [...new Set(job.pages.filter((p) => p.pdf?.assetId === id && !p.raster).map((p) => p.pdf!.pageIndex))]
      const srcPages = idx.map((i) => src.getPage(i))
      const boxes = srcPages.map((p) => {
        const c = p.getCropBox()
        return { left: c.x, bottom: c.y, right: c.x + c.width, top: c.y + c.height }
      })
      const emb = await out.embedPages(srcPages, boxes)
      idx.forEach((i, k) => embedded.set(`${id}:${i}`, emb[k]))
    }

    // 3) 페이지 조립
    const imgCache = new Map<string, Promise<PDFImage | null>>()
    let done = 0
    for (const p of job.pages) {
      // 보조 용지를 함께 내보내면 PDF 페이지가 넓어지고 원래 페이지는 (ox, oy)에 놓인다
      const H = p.frame?.h ?? p.h
      const ox = p.frame?.ox ?? 0
      const oy = p.frame?.oy ?? 0
      const x0 = ox
      const y0 = H - oy - p.h // 원래 페이지의 왼쪽 아래 (PDF 좌표)
      const page = out.addPage([p.frame?.w ?? p.w, H])
      if (p.paper) page.drawRectangle({ x: x0, y: y0, width: p.w, height: p.h, color: rgb(...p.paper) })
      if (p.raster) {
        const img = await out.embedJpg(p.raster.jpeg)
        page.drawImage(img, { x: x0, y: y0, width: p.w, height: p.h })
      } else if (p.pdf) {
        const src = srcDocs.get(p.pdf.assetId)!
        const emb = embedded.get(`${p.pdf.assetId}:${p.pdf.pageIndex}`)!
        const rot = (((src.getPage(p.pdf.pageIndex).getRotation().angle + p.pdf.rotation) % 360) + 360) % 360
        // /Rotate는 시계 방향 표시 회전. drawPage의 rotate는 (x, y) 기준 반시계 회전
        // 페이지 크기 맞추기(내용 배율)로 페이지가 원본과 크기가 다르면 원본을 그만큼 키우거나 줄여 채운다
        const k = p.w / (rot === 90 || rot === 270 ? emb.height : emb.width)
        const sc = Math.abs(k - 1) < 1e-6 ? {} : { xScale: k, yScale: k }
        const EW = emb.width * (sc.xScale ?? 1)
        const EH = emb.height * (sc.yScale ?? 1)
        if (rot === 90) page.drawPage(emb, { x: x0, y: y0 + EW, rotate: degrees(-90), ...sc })
        else if (rot === 180) page.drawPage(emb, { x: x0 + EW, y: y0 + EH, rotate: degrees(180), ...sc })
        else if (rot === 270) page.drawPage(emb, { x: x0 + EH, y: y0, rotate: degrees(90), ...sc })
        else page.drawPage(emb, { x: x0, y: y0, ...sc })
      }
      if (p.pattern) drawPattern(page, p.pattern, ox, oy, H)
      if (p.images?.length) {
        page.pushOperators(pushGraphicsState(), rectangle(x0, y0, p.w, p.h), clip(), endPath())
        await drawImages(out, imgCache, job, page, p.images, ox, oy, H)
        page.pushOperators(popGraphicsState())
      }
      drawPaths(page, p.paths, ox, oy, H)
      // 보조 용지 (z순): 종이 → 무늬 → 테두리 → 용지 안으로 자른 필기
      for (const s of p.sheets ?? []) {
        const sy0 = H - s.y - s.h
        if (s.paper) page.drawRectangle({ x: s.x, y: sy0, width: s.w, height: s.h, color: rgb(...s.paper) })
        if (s.pattern) drawPattern(page, s.pattern, s.x, s.y, H)
        page.drawRectangle({
          x: s.x,
          y: sy0,
          width: s.w,
          height: s.h,
          borderWidth: 0.6,
          borderColor: s.border === 'dashed' ? rgb(0.45, 0.58, 0.85) : rgb(0.78, 0.78, 0.78),
          borderDashArray: s.border === 'dashed' ? [4, 3] : undefined
        })
        if (!s.paths.length && !s.images?.length) continue
        page.pushOperators(pushGraphicsState(), rectangle(s.x, sy0, s.w, s.h), clip(), endPath())
        if (s.images?.length) await drawImages(out, imgCache, job, page, s.images, s.x, s.y, H)
        drawPaths(page, s.paths, s.x, s.y, H)
        page.pushOperators(popGraphicsState())
      }
      done++
      if (done % 5 === 0 || done === job.pages.length) post({ type: 'progress', done, total: job.pages.length })
    }
    const bytes = await out.save({ useObjectStreams: true })
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    post({ type: 'done', bytes: buf }, [buf])
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
