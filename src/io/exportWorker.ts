/// <reference lib="webworker" />
// PDF 내보내기 Worker (14.2): 원본 PDF 페이지 위에 필기를 벡터 경로로 합친다.
import { PDFDocument, rgb, degrees, EncryptedPDFError, type PDFEmbeddedPage } from 'pdf-lib'
import type { ExportJob, WorkerOut } from './exportTypes'

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
    let done = 0
    for (const p of job.pages) {
      const page = out.addPage([p.w, p.h])
      if (p.paper) page.drawRectangle({ x: 0, y: 0, width: p.w, height: p.h, color: rgb(...p.paper) })
      if (p.raster) {
        const img = await out.embedJpg(p.raster.jpeg)
        page.drawImage(img, { x: 0, y: 0, width: p.w, height: p.h })
      } else if (p.pdf) {
        const src = srcDocs.get(p.pdf.assetId)!
        const emb = embedded.get(`${p.pdf.assetId}:${p.pdf.pageIndex}`)!
        const rot = (((src.getPage(p.pdf.pageIndex).getRotation().angle + p.pdf.rotation) % 360) + 360) % 360
        const W = emb.width
        const H = emb.height
        // /Rotate는 시계 방향 표시 회전. drawPage의 rotate는 (x, y) 기준 반시계 회전
        if (rot === 90) page.drawPage(emb, { x: 0, y: W, rotate: degrees(-90) })
        else if (rot === 180) page.drawPage(emb, { x: W, y: H, rotate: degrees(180) })
        else if (rot === 270) page.drawPage(emb, { x: H, y: 0, rotate: degrees(90) })
        else page.drawPage(emb, { x: 0, y: 0 })
      }
      if (p.pattern) {
        const g = p.pattern
        for (const [x1, y1, x2, y2] of g.lines) {
          page.drawLine({ start: { x: x1, y: p.h - y1 }, end: { x: x2, y: p.h - y2 }, thickness: g.lineWidth, color: rgb(...g.color) })
        }
        for (const [x, y] of g.dots) page.drawCircle({ x, y: p.h - y, size: g.dotRadius, color: rgb(...g.color) })
        if (g.accent) {
          for (const [x1, y1, x2, y2] of g.accent.lines) {
            page.drawLine({ start: { x: x1, y: p.h - y1 }, end: { x: x2, y: p.h - y2 }, thickness: g.accent.width, color: rgb(...g.accent.color) })
          }
        }
      }
      for (const path of p.paths) {
        // drawSvgPath는 SVG 좌표(y 아래로)를 (x, y) 기준으로 뒤집어 그린다
        page.drawSvgPath(path.d, { x: 0, y: p.h, color: rgb(path.r, path.g, path.b), opacity: path.a, borderWidth: 0 })
      }
      // 텍스트·링크 블록 — 투명 배경 PNG로 얹는다 (좌표계는 paths와 같은 y-아래 기준)
      for (const img of p.images ?? []) {
        const embedded = await out.embedPng(img.data)
        page.drawImage(embedded, { x: img.x, y: p.h - img.y - img.h, width: img.w, height: img.h })
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
