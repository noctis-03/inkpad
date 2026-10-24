// PDF 내보내기 "보조 용지 포함": 페이지에 붙은 용지만 페이지 옆에 붙여 넓은 PDF 페이지로. 떠 있는 용지·끄면 빠진다
import { createDoc, device, openEditor, sleep, type Ctx } from './lib.ts'

const PW = 595.28
const PH = 841.89

export default async function sheetpdf(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  const errs: string[] = []
  p.on('pageerror', (e) => errs.push(String(e)))
  const docId = await createDoc(p, '보조 용지 PDF', 2)

  // 노트를 DB로 바로 만든다: 페이지 획, 오른쪽에 붙은 줄 용지, 왼쪽에 붙은 투명 용지(획이 용지 밖으로 삐져나감), 떠 있는 용지
  await p.evaluate(async (docId) => {
    const r = await import('/src/storage/repo.ts')
    const m = await import('/src/shared/model.ts')
    const d = await r.loadDocument(docId)
    const page = d.pages[0]
    let z = 0
    const line = (x0: number, x1: number, y: number) => {
      const pts: number[] = []
      for (let x = x0; x <= x1; x += 10) pts.push(x, y, 0.5, 16)
      return { id: `s${++z}`, type: 'stroke' as const, layer: 'main' as const, z, createdAt: Date.now(), tool: 'pen' as const, color: '#000000ff', width: 6, points: pts, bbox: [x0 - 4, y - 4, x1 + 4, y + 4] as [number, number, number, number], opts: { thinning: 0, smoothing: 0.5, streamline: 0.5, simulatePressure: false } }
    }
    const now = Date.now()
    const sheet = (id: string, info: Partial<import('/src/shared/model.ts').SheetInfo>, bg: import('/src/shared/model.ts').BackgroundType) => ({
      id,
      documentId: docId,
      schemaVersion: m.SCHEMA_VERSION,
      size: { w: 300, h: 500 },
      background: m.makeBackground(bg),
      sheet: { anchorPageId: page.id, x: 0, y: 0, snap: null, title: '', z: ++z, ...info },
      createdAt: now,
      updatedAt: now,
      version: 0
    })
    // 붙은 용지의 x는 쓰지 않는다 (페이지 가장자리에서 정해진다)
    const right = sheet('sheetR', { snap: 'right', y: 100 }, 'lined')
    const left = sheet('sheetL', { snap: 'left', y: -60, transparent: true }, 'grid')
    const floating = sheet('sheetF', { x: 100, y: 300 }, 'blank')
    await r.saveBatch({
      documentId: docId,
      pagesUpsert: [right, left, floating] as never,
      chunks: [
        { pageId: page.id, key: m.PAGE_CHUNK_KEY, elements: [line(80, 200, 400)] },
        { pageId: 'sheetR', key: m.PAGE_CHUNK_KEY, elements: [line(40, 200, 50)] },
        { pageId: 'sheetL', key: m.PAGE_CHUNK_KEY, elements: [line(150, 420, 150)] }, // 용지(폭 300) 밖으로 120pt
        { pageId: 'sheetF', key: m.PAGE_CHUNK_KEY, elements: [line(20, 150, 20)] }
      ]
    })
  }, docId)

  /** 내보낸 PDF를 pdf.js로 열어 페이지 크기와 첫 페이지 그림(1pt = 1px)을 돌려준다 */
  const exportAndRender = (includeSheets: boolean) =>
    p.evaluate(
      async ([docId, includeSheets]) => {
        const ex = await import('/src/io/pdfExport.ts')
        const pdfjs = await import('/src/engine/pdf/pdfjs.ts')
        const blob = await ex.exportDocumentPdf(docId as string, { includeSheets: includeSheets as boolean })
        const pdf = await pdfjs.openPdf(await blob.arrayBuffer())
        const sizes: [number, number][] = []
        for (let i = 1; i <= pdf.numPages; i++) {
          const vp = (await pdf.getPage(i)).getViewport({ scale: 1 })
          sizes.push([Math.round(vp.width * 100) / 100, Math.round(vp.height * 100) / 100])
        }
        const pg = await pdf.getPage(1)
        const vp = pg.getViewport({ scale: 1 })
        const c = document.createElement('canvas')
        c.width = Math.ceil(vp.width)
        c.height = Math.ceil(vp.height)
        const g = c.getContext('2d')!
        await pg.render({ canvas: null, canvasContext: g, viewport: vp, background: '#ffffff' }).promise
        ;(window as unknown as { __pdfCanvas: HTMLCanvasElement }).__pdfCanvas = c
        await pdfjs.closePdf(pdf)
        return sizes
      },
      [docId, includeSheets] as const
    )
  /** 그린 PDF 첫 페이지 (x, y) 둘레 ±4px에서 가장 진한 빨강 값 (작을수록 진함) */
  const ink = (x: number, y: number) =>
    p.evaluate(
      ([x, y]) => {
        const c = (window as unknown as { __pdfCanvas: HTMLCanvasElement }).__pdfCanvas
        const d = c.getContext('2d')!.getImageData(Math.round(x) - 4, Math.round(y) - 4, 9, 9).data
        let min = 255
        for (let i = 0; i < d.length; i += 4) min = Math.min(min, d[i])
        return min
      },
      [x, y]
    )
  /** 세로 한 줄에서 속지 선처럼 옅게 칠해진 픽셀 수 */
  const ruled = (x: number, y0: number, y1: number) =>
    p.evaluate(
      ([x, y0, y1]) => {
        const c = (window as unknown as { __pdfCanvas: HTMLCanvasElement }).__pdfCanvas
        const d = c.getContext('2d')!.getImageData(Math.round(x), Math.round(y0), 1, Math.round(y1 - y0)).data
        let n = 0
        for (let i = 0; i < d.length; i += 4) if (d[i] < 245 && d[i] > 120) n++
        return n
      },
      [x, y0, y1]
    )

  // ── 끄면: 페이지 크기 그대로, 용지 없음 ──
  let sizes = await exportAndRender(false)
  check('보조 용지 빼고 → 페이지 크기 그대로', sizes[0][0] === PW && sizes[0][1] === PH, JSON.stringify(sizes))
  check('…원래 페이지 획은 있음', (await ink(140, 400)) < 80)

  // ── 켜면: 왼쪽 300 + 페이지 + 오른쪽 300, 위로 60 / 아래로는 오른쪽 용지(100+500)까지 ──
  sizes = await exportAndRender(true)
  const W = 300 + PW + 300
  const top = 60 // 왼쪽 용지가 페이지보다 60pt 위에서 시작
  const H = Math.max(PH, 100 + 500) + top
  check('보조 용지 포함 → PDF 페이지가 붙은 용지만큼 넓어짐', Math.abs(sizes[0][0] - W) < 0.02 && Math.abs(sizes[0][1] - H) < 0.02, JSON.stringify([sizes[0], W, H]))
  check('…붙은 용지가 없는 페이지는 그대로', sizes[1][0] === PW && sizes[1][1] === PH, JSON.stringify(sizes[1]))
  const ox = 300
  check('원래 페이지 획이 왼쪽 용지 폭만큼 옮겨 감', (await ink(ox + 140, top + 400)) < 80 && (await ink(140, top + 400)) > 200)
  check('오른쪽 용지 획', (await ink(ox + PW + 120, top + 100 + 50)) < 80)
  check('오른쪽 용지 줄 속지', (await ruled(ox + PW + 250, top + 100 + 80, top + 100 + 480)) > 10)
  check('왼쪽 투명 용지 획', (await ink(220, 0 + 150)) < 80)
  check('…투명 용지는 속지 없음 (모눈이어도)', (await ruled(60, 200, 400)) === 0)
  check('…용지 밖으로 삐져나간 획은 잘림', (await ink(ox + 60, 150)) > 200)
  check('떠 있는 용지는 넣지 않음', (await ink(ox + 100 + 80, top + 300 + 20)) > 200)

  // ── 내보내기 화면: 붙은 용지가 있을 때만 켤 수 있고, 떠 있는 용지 수를 알려 준다 ──
  await openEditor(p, base, docId)
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setPanel('export'))
  await sleep(200)
  const panel = p.locator('#export-panel')
  check('내보내기 화면에 "보조 용지 포함"', (await panel.getByText('보조 용지 포함').count()) === 1)
  const hint = (await panel.locator('.hint').allTextContents()).join(' ')
  check('…붙은 2장·떠 있는 1장 안내', hint.includes('붙은 용지 2장') && hint.includes('떠 있는 용지 1장'), hint)

  check('보조 용지 PDF: 페이지 오류 없음', errs.length === 0, errs.join(' | '))
  await p.context().close()
}
