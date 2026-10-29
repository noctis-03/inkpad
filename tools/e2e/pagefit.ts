// 페이지 크기 맞추기 — 크기가 제각각인 PDF 페이지를 A4 폭에 맞춘다 (Page.scale)
//  - PDF를 가져올 때 페이지 폭이 A4에서 많이 벗어나면 '원본 크기 / A4 폭에 맞춤'을 묻는다 (A4쯤이면 묻지 않는다)
//  - 맞추면 페이지 크기와 내용 배율만 바뀌고 획 좌표는 그대로 — 원래 크기로 돌리면 정확히 원래대로
//  - 맞춘 페이지에 쓴 획은 펜 끝 자리에 찍히고 화면 굵기도 그대로, 지우개·올가미도 같은 자리에서 잡힌다
//  - 보던 자리(화면 가운데의 페이지 위 지점, 폭 맞춤 대비 배율)는 그대로, 되돌리기 한 번에 원래대로
//  - PDF·이미지로 내보내도 맞춘 크기로, 다시 열어도 그대로
import { device, openEditor, sleep, type Ctx } from './lib.ts'

type W = { inkpad: any }

export default async function pagefit(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  await p.waitForSelector('.library')

  // 라이브러리에 PDF를 끌어 놓는다 — 큰 스캔(1240×1754pt, A4의 2.1배, 연분홍)과 A4 한 쪽
  const dropPdf = (name: string, w: number, h: number) =>
    p.evaluate(
      async ([name, w, h]) => {
        const { PDFDocument, rgb } = await import('/node_modules/pdf-lib/dist/pdf-lib.esm.js')
        const pdf = await PDFDocument.create()
        const page = pdf.addPage([w as number, h as number])
        page.drawRectangle({ x: 0, y: 0, width: w as number, height: h as number, color: rgb(1, 0.8, 0.8) })
        const dt = new DataTransfer()
        dt.items.add(new File([await pdf.save()], name as string, { type: 'application/pdf' }))
        const el = document.querySelector('.library-header')!
        for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }))
      },
      [name, w, h] as const
    )
  const docOf = async (title: string) => {
    for (let i = 0; i < 60; i++) {
      const r = await p.evaluate(async (title) => {
        const { db } = await import('/src/storage/db.ts')
        const d = (await db.documents.toArray()).find((d) => !d.deletedAt && d.title === title)
        if (!d) return null
        const pages = await db.pages.where('documentId').equals(d.id).toArray()
        return { id: d.id, pages: pages.map((pg) => ({ size: pg.size, scale: pg.scale })) }
      }, title)
      if (r) return r
      await sleep(150)
    }
    return null
  }

  // 가져오기는 PDF 하나면 그 노트를 연다 — 열릴 때까지 기다린다(늦게 열리면 다음 단계에서 연 노트를 바꿔 버린다)
  const opened = (id: string) => p.waitForFunction((id) => location.hash.includes(id), id, { timeout: 15000 }).catch(() => {})
  const dialog = p.locator('.dialog-host')

  // A4 한 쪽 — 묻지 않고 원본 크기 그대로 (묻는 창이 뜨면 노트가 만들어지지 않아 docOf가 null)
  await dropPdf('보통.pdf', 595.28, 841.89)
  const a4 = await docOf('보통')
  const askedA4 = await dialog.getByRole('button', { name: 'A4 폭에 맞춤' }).count()
  check('가져오기: A4쯤인 PDF는 묻지 않고 원본 크기 그대로', askedA4 === 0 && !!a4 && a4.pages[0].scale === undefined, JSON.stringify({ askedA4, a4 }))
  if (a4) await opened(a4.id)
  await p.goto(base + '/')
  await p.waitForSelector('.library')

  await dropPdf('스캔.pdf', 1240, 1754)
  const asked = await dialog.getByRole('button', { name: 'A4 폭에 맞춤' }).waitFor({ timeout: 8000 }).then(
    () => true,
    () => false
  )
  const msg = asked ? await dialog.locator('.modal-message').textContent() : ''
  check('가져오기: A4에서 많이 벗어난 PDF는 원본 크기 / A4 폭에 맞춤을 묻는다', asked && /A4의 2\.1배/.test(msg ?? ''), msg ?? '')
  if (asked) await dialog.getByRole('button', { name: 'A4 폭에 맞춤' }).click()
  const scan = await docOf('스캔')
  const f = 595.28 / 1240
  const pg = scan?.pages[0]
  check(
    'A4 폭에 맞춤: 페이지 폭 595.28pt, 내용 배율 = 595.28 / 1240',
    !!pg && Math.abs(pg.size!.w - 595.28) < 0.01 && Math.abs(pg.size!.h - 1754 * f) < 0.01 && Math.abs((pg.scale ?? 1) - f) < 1e-9,
    JSON.stringify(pg)
  )
  if (scan) await opened(scan.id)

  // ── 맞춘 페이지에 쓰기 ──
  await openEditor(p, base, scan!.id)
  await sleep(1200)
  const box = (await p.locator('#canvas-root').last().boundingBox())!
  const sx = box.x + box.width / 2 - 60
  const sy = box.y + 260
  await p.mouse.move(sx, sy)
  await p.mouse.down()
  for (let i = 1; i <= 12; i++) await p.mouse.move(sx + i * 10, sy + Math.sin(i / 2) * 15)
  await p.mouse.up()
  await sleep(200)
  const drawn = await p.evaluate(
    ([sx, sy]) => {
      const e = (window as unknown as W).inkpad
      const b = e.root.getBoundingClientRect()
      const want = { x: (sx - b.left) / e.cam.zoom + e.cam.x, y: (sy - b.top) / e.cam.zoom + e.cam.y }
      const rec = [...e.scene.recs.values()].pop()
      const got = { x: rec.stroke.points[0] * rec.os + rec.ox, y: rec.stroke.points[1] * rec.os + rec.oy }
      return { dx: (got.x - want.x) * e.cam.zoom, dy: (got.y - want.y) * e.cam.zoom, os: rec.os, width: rec.stroke.width, pen: e.style.pen.width }
    },
    [sx, sy] as const
  )
  check('맞춘 페이지: 획이 펜 끝 자리에 찍힌다 (화면 1px 이내)', Math.abs(drawn.dx) <= 1 && Math.abs(drawn.dy) <= 1, JSON.stringify(drawn))
  check('맞춘 페이지: 화면 굵기가 고른 펜 굵기 그대로 (저장 굵기 = 펜 굵기 ÷ 배율)', Math.abs(drawn.width * drawn.os - drawn.pen) < 0.01, JSON.stringify(drawn))

  // ── 원래 크기로 → 되돌리기 → 다시 ──
  type State = { size: { w: number; h: number }; scale?: number; pts: string; rel: { x: number; y: number }; fx: number; fy: number; relZoom: number }
  const state = () =>
    p.evaluate(() => {
      const e = (window as unknown as W).inkpad
      const page = e.pages[0]
      const r = e.layout.rects.get(page.id)
      const rec = [...e.scene.recs.values()].pop()
      const c = e.cam.screenToWorld(e.renderer.cssW / 2, e.renderer.cssH / 2)
      return {
        size: page.size,
        scale: page.scale,
        pts: JSON.stringify(rec.stroke.points) + rec.stroke.width,
        // 획 시작점의 페이지 안 위치(페이지 크기 비율)
        rel: { x: (rec.item.minX - r.x) / r.w, y: (rec.item.minY - r.y) / r.h },
        fx: (c.x - r.x) / r.w,
        fy: (c.y - r.y) / r.h,
        relZoom: e.cam.zoom / e.fitWidthZoom()
      }
    }) as Promise<State>
  const s0 = await state()
  await p.evaluate(() => (window as unknown as W).inkpad.fitPages('original', [0]))
  await sleep(150)
  const s1 = await state()
  const near = (a: number, b: number, t = 1e-3) => Math.abs(a - b) < t
  check('원래 크기로: 페이지가 정확히 1240×1754pt, 내용 배율 없음', s1.size.w === 1240 && s1.size.h === 1754 && s1.scale === undefined, JSON.stringify(s1.size) + s1.scale)
  check('원래 크기로: 획 좌표·굵기는 하나도 바뀌지 않는다', s1.pts === s0.pts)
  check('원래 크기로: 필기가 페이지와 함께 커져 페이지 위 같은 자리에 있다', near(s1.rel.x, s0.rel.x) && near(s1.rel.y, s0.rel.y), JSON.stringify([s0.rel, s1.rel]))
  check(
    '원래 크기로: 보던 자리(화면 가운데의 페이지 위 지점·폭 맞춤 대비 배율)가 그대로',
    near(s1.fx, s0.fx) && near(s1.fy, s0.fy) && near(s1.relZoom, s0.relZoom),
    JSON.stringify([s0, s1].map((s) => [s.fx, s.fy, s.relZoom]))
  )
  await p.evaluate(() => (window as unknown as W).inkpad.undo())
  await sleep(150)
  const s2 = await state()
  check('되돌리기 한 번에 A4 폭으로 (획 그대로, 보던 자리 그대로)', s2.size.w === s0.size.w && s2.scale === s0.scale && s2.pts === s0.pts && near(s2.fy, s0.fy), JSON.stringify(s2.size))
  await p.evaluate(() => (window as unknown as W).inkpad.redo())
  await p.evaluate(() => (window as unknown as W).inkpad.fitPages('a4', [0]))
  await sleep(150)
  const s3 = await state()
  check('A4 폭에 맞추기를 다시 해도 같은 크기·같은 획 (몇 번을 오가도 차이 없음)', s3.size.w === s0.size.w && s3.size.h === s0.size.h && s3.scale === s0.scale && s3.pts === s0.pts, JSON.stringify(s3.size))

  // ── 지우개·올가미가 맞춘 페이지 위 같은 자리에서 잡힌다 ──
  const setTool = (t: string) => p.evaluate(async (t) => (await import('/src/app/store.ts')).useUI.getState().setTool(t as 'lasso'), t)
  const strokeBox = () =>
    p.evaluate(() => {
      const e = (window as unknown as W).inkpad
      const b = e.root.getBoundingClientRect()
      const it = [...e.scene.recs.values()].pop().item
      const S = (x: number, y: number) => ({ x: (x - e.cam.x) * e.cam.zoom + b.left, y: (y - e.cam.y) * e.cam.zoom + b.top })
      return { a: S(it.minX, it.minY), b: S(it.maxX, it.maxY) }
    })
  const sb = await strokeBox()
  await setTool('lasso')
  const pad = 20
  const poly = [
    [sb.a.x - pad, sb.a.y - pad],
    [sb.b.x + pad, sb.a.y - pad],
    [sb.b.x + pad, sb.b.y + pad],
    [sb.a.x - pad, sb.b.y + pad],
    [sb.a.x - pad, sb.a.y - pad + 1]
  ]
  await p.mouse.move(poly[0][0], poly[0][1])
  await p.mouse.down()
  for (const [x, y] of poly.slice(1)) {
    for (let k = 1; k <= 6; k++) await p.mouse.move(x, y, { steps: 1 })
  }
  await p.mouse.up()
  await sleep(150)
  const picked = await p.evaluate(() => (window as unknown as W).inkpad.selection.length)
  check('맞춘 페이지: 올가미로 감싸면 그 획이 골라진다', picked === 1, String(picked))
  await p.keyboard.press('Escape')
  await setTool('eraser')
  const mid = { x: (sb.a.x + sb.b.x) / 2, y: (sb.a.y + sb.b.y) / 2 }
  await p.mouse.move(mid.x, sb.a.y - 30)
  await p.mouse.down()
  for (let k = 1; k <= 12; k++) await p.mouse.move(mid.x, sb.a.y - 30 + k * ((sb.b.y - sb.a.y + 60) / 12))
  await p.mouse.up()
  await sleep(150)
  const left = await p.evaluate(() => (window as unknown as W).inkpad.scene.size)
  check('맞춘 페이지: 지우개로 지나가면 그 획이 지워진다', left === 0, String(left))
  await p.evaluate(() => (window as unknown as W).inkpad.undo())
  await setTool('pen')

  // ── 내보내기 ──
  const s4 = await state()
  const out = await p.evaluate(async (id) => {
    const e = (window as unknown as W).inkpad
    await e.flush()
    // 그림에서 연분홍(PDF) 비율과 필기(검정) 상자 — 페이지 크기 비율로
    const measure = (src: CanvasImageSource, w: number, h: number) => {
      const c = new OffscreenCanvas(w, h)
      const g = c.getContext('2d')!
      g.drawImage(src, 0, 0)
      const d = g.getImageData(0, 0, w, h).data
      let pink = 0
      let x0 = w, y0 = h, x1 = 0, y1 = 0
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 230 && d[i + 1] > 180 && d[i + 1] < 230) pink++
        if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) {
          const x = (i / 4) % w
          const y = Math.floor(i / 4 / w)
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
        }
      }
      return { w, h, pink: pink / (d.length / 4), ink: { x0: x0 / w, y0: y0 / h, x1: x1 / w, y1: y1 / h } }
    }
    const { exportDocumentPdf } = await import('/src/io/pdfExport.ts')
    const { PDFDocument } = await import('/node_modules/pdf-lib/dist/pdf-lib.esm.js')
    const bytes = await (await exportDocumentPdf(id)).arrayBuffer()
    const size = (await PDFDocument.load(bytes.slice(0))).getPage(0).getSize()
    // 내보낸 PDF를 pdf.js로 그려 본다 — 원본 PDF가 페이지를 채우고 필기가 화면과 같은 자리에 있는지
    const { openPdf } = await import('/src/engine/pdf/pdfjs.ts')
    const doc = await openPdf(bytes)
    const pg = await doc.getPage(1)
    const vp = pg.getViewport({ scale: 2 })
    const cv = document.createElement('canvas')
    cv.width = Math.round(vp.width)
    cv.height = Math.round(vp.height)
    await pg.render({ canvas: null, canvasContext: cv.getContext('2d')!, viewport: vp }).promise
    const pdfImg = measure(cv, cv.width, cv.height)
    const blob = await e.exportImage({ page: 0 })
    const bmp = await createImageBitmap(blob)
    const img = measure(bmp, bmp.width, bmp.height)
    return { size, pdfImg, img }
  }, scan!.id)
  // 화면에서 획 상자(굵기 포함 bbox는 외곽선보다 조금 넓다)의 페이지 안 위치
  const inkNear = (ink: { x0: number; y0: number }) => near(ink.x0, s4.rel.x, 0.02) && near(ink.y0, s4.rel.y, 0.02)
  check('PDF로 내보내기: 맞춘 크기(595×843pt)로', near(out.size.width, 595.28, 0.05) && near(out.size.height, 1754 * f, 0.05), JSON.stringify(out.size))
  check('PDF로 내보내기: 원본 PDF가 페이지를 꽉 채우고 필기가 화면과 같은 자리에', out.pdfImg.pink > 0.95 && inkNear(out.pdfImg.ink), JSON.stringify({ pdf: out.pdfImg, rel: s4.rel }))
  check('이미지로 내보내기: PDF가 맞춘 페이지를 꽉 채우고 필기가 화면과 같은 자리에', out.img.pink > 0.95 && near(out.img.w / out.img.h, 1240 / 1754, 0.01) && inkNear(out.img.ink), JSON.stringify({ img: out.img, rel: s4.rel }))

  // ── 다시 열기 ──
  await openEditor(p, base, scan!.id)
  await sleep(800)
  const again = await p.evaluate(() => {
    const e = (window as unknown as W).inkpad
    const rec = [...e.scene.recs.values()].pop()
    return { scale: e.pages[0].scale, w: e.pages[0].size.w, os: rec?.os }
  })
  check('다시 열어도 맞춘 크기·배율 그대로', near(again.scale ?? 1, f, 1e-9) && near(again.w, 595.28) && near(again.os ?? 1, f, 1e-9), JSON.stringify(again))
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT })
  await p.context().close()
}
