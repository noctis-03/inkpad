// 사진 넣기 — 편집 화면 ⋯ 메뉴 '사진 넣기'(사진 보관함·카메라·파일)와 붙여넣기(⌘V)
//  - 줄여서 원본(에셋)으로 저장하고 화면 가운데에 놓는다. 넣으면 올가미로 바뀌고 그 사진이 골라져 있다
//  - 사진은 획 아래 — 위에 필기할 수 있다
//  - 올가미로 누르면 사진을 고르고, 끌어 옮기고, 모서리로 크기를 바꾸고, 지운다 (모두 되돌리기)
//  - 저장·다시 열기, 이미지로 보내기, PDF 내보내기에 함께 담긴다. 낙서 모드에는 메뉴가 없다
import { createDoc, device, openEditor, sleep, type Ctx } from './lib.ts'
import type { Page } from 'playwright'

interface Img {
  id: string
  assetId: string
  x: number
  y: number
  w: number
  h: number
  /** 화면(페이지 기준 client) 상자 */
  sx: number
  sy: number
  sw: number
  sh: number
}

/** 엔진의 사진 목록 + 화면 위치 */
const images = (p: Page) =>
  p.evaluate(() => {
    type R = { image: { id: string; assetId: string; x: number; y: number; w: number; h: number }; box: { minX: number; minY: number; maxX: number; maxY: number } }
    const e = (window as unknown as { inkpad: { scene: { images: Map<string, R> }; cam: { worldToScreen: (x: number, y: number) => { x: number; y: number } } } }).inkpad
    const root = document.querySelector('#canvas-root')!.getBoundingClientRect()
    return [...e.scene.images.values()].map((r) => {
      const a = e.cam.worldToScreen(r.box.minX, r.box.minY)
      const b = e.cam.worldToScreen(r.box.maxX, r.box.maxY)
      const { id, assetId, x, y, w, h } = r.image
      return { id, assetId, x, y, w, h, sx: root.left + a.x, sy: root.top + a.y, sw: b.x - a.x, sh: b.y - a.y }
    })
  }) as Promise<Img[]>

/** 저장된 노트(DB)의 사진 요소 */
const savedImages = (p: Page, docId: string) =>
  p.evaluate(async (docId) => {
    const r = await import('/src/storage/repo.ts')
    return (await r.loadDocument(docId)).chunks.flatMap((c) => c.elements).filter((e) => e.type === 'image') as { id: string; assetId: string; x: number; w: number }[]
  }, docId)

/** 단색 PNG (브라우저에서 만들어 바이트로) */
const pngOf = (p: Page, w: number, h: number, color: string) =>
  p.evaluate(
    async ([w, h, color]) => {
      const c = new OffscreenCanvas(w as number, h as number)
      const g = c.getContext('2d')!
      g.fillStyle = color as string
      g.fillRect(0, 0, w as number, h as number)
      const b = await c.convertToBlob({ type: 'image/png' })
      return [...new Uint8Array(await b.arrayBuffer())]
    },
    [w, h, color] as const
  ).then((a) => Buffer.from(a))

/** 페이지 1쪽을 이미지로 — 빨강(사진) 비율과 검정(필기) 픽셀 수 */
const pageColors = (p: Page) =>
  p.evaluate(async () => {
    const e = (window as unknown as { inkpad: { exportImage: (t: unknown, o: object) => Promise<Blob | null> } }).inkpad
    const blob = await e.exportImage({ page: 0 }, { background: true })
    if (!blob) return null
    const bmp = await createImageBitmap(blob)
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const g = c.getContext('2d')!
    g.drawImage(bmp, 0, 0)
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data
    let red = 0, ink = 0
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) red++
      if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) ink++
    }
    return { red: red / (d.length / 4), ink }
  })

const tool = (p: Page) => p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().tool)
const selection = (p: Page) =>
  p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().selection) as Promise<{ count: number; images: number } | null>

async function drag(p: Page, x0: number, y0: number, x1: number, y1: number) {
  await p.mouse.move(x0, y0)
  await p.mouse.down()
  for (let i = 1; i <= 10; i++) await p.mouse.move(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10)
  await p.mouse.up()
}

export default async function photo(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  const docId = await createDoc(p, '사진 노트')
  await openEditor(p, base, docId)
  await sleep(500)

  // ── ⋯ 메뉴 → 사진 넣기 → 파일 고르기 ──
  const bar = p.locator('.ft-bar')
  await bar.getByRole('button', { name: '더보기' }).click()
  const item = p.locator('.ft-pop').getByRole('button', { name: '사진 넣기' })
  check('⋯ 메뉴에 사진 넣기', (await item.count()) === 1)
  const [chooser] = await Promise.all([p.waitForEvent('filechooser'), item.click()])
  check('사진 고르기: 여러 장 · 사진만', chooser.isMultiple() && (await chooser.element().getAttribute('accept')) === 'image/*')
  await chooser.setFiles({ name: '빨강.png', mimeType: 'image/png', buffer: await pngOf(p, 400, 300, '#ff0000') })
  await p.waitForFunction(() => (window as unknown as { inkpad: { scene: { images: Map<string, unknown> } } }).inkpad.scene.images.size === 1, null, { timeout: 5000 })
  let [img] = await images(p)
  check('넣은 사진: 원래 비율(4:3) 그대로', Math.abs(img.w / img.h - 4 / 3) < 0.01, `${img.w}×${img.h}`)
  check('넣은 사진: 원래 크기(1px = 1pt)보다 키우지 않는다', img.w <= 400.01)
  check('넣으면 올가미로 바뀐다', (await tool(p)) === 'lasso')
  const sel0 = await selection(p)
  check('넣은 사진이 골라져 있다', sel0?.count === 1 && sel0.images === 1, JSON.stringify(sel0))
  check('사진만 골랐으면 색 바꾸기가 없다', (await p.locator('.selection-bar .color-swatch').count()) === 0)
  const asset = await p.evaluate(async (id) => {
    const a = await (await import('/src/storage/repo.ts')).getAsset(id)
    return a && { kind: a.kind, mime: a.mime, blob: !!a.blob }
  }, img.assetId)
  check('원본은 사진 에셋으로 저장', asset?.kind === 'image' && asset.mime === 'image/png' && asset.blob, JSON.stringify(asset))
  await sleep(900)
  check('노트에 저장된다 (청크의 사진 요소)', (await savedImages(p, docId)).length === 1)
  const c0 = await pageColors(p)
  check('이미지로 보내기에 사진이 담긴다', !!c0 && c0.red > 0.05, JSON.stringify(c0))

  // ── 사진 위에 필기 ──
  await p.keyboard.press('Escape')
  await p.keyboard.press('p')
  await sleep(100)
  await drag(p, img.sx + img.sw * 0.2, img.sy + img.sh * 0.5, img.sx + img.sw * 0.8, img.sy + img.sh * 0.55)
  await sleep(300)
  const c1 = await pageColors(p)
  check('사진 위에 필기가 보인다 (사진은 획 아래)', !!c1 && c1.ink > 50 && c1.red > 0.04, JSON.stringify(c1))

  // ── 올가미로 눌러 고르고 옮기기 ──
  await p.keyboard.press('l')
  await sleep(100)
  await p.mouse.click(img.sx + img.sw * 0.5, img.sy + img.sh * 0.2)
  await sleep(200)
  const sel1 = await selection(p)
  check('올가미로 사진을 누르면 그 사진만 고른다', sel1?.count === 1 && sel1.images === 1, JSON.stringify(sel1))
  const before = img
  await drag(p, img.sx + img.sw * 0.5, img.sy + img.sh * 0.2, img.sx + img.sw * 0.5 + 100, img.sy + img.sh * 0.2 + 40)
  await sleep(200)
  ;[img] = await images(p)
  check('끌면 사진이 옮겨진다', Math.abs(img.sx - before.sx - 100) < 3 && Math.abs(img.sy - before.sy - 40) < 3, `${img.sx - before.sx}, ${img.sy - before.sy}`)
  check('옮긴 뒤에도 골라져 있다', (await selection(p))?.images === 1)
  await p.keyboard.press('Meta+z')
  await sleep(200)
  ;[img] = await images(p)
  check('되돌리면 제자리', Math.abs(img.sx - before.sx) < 1 && Math.abs(img.sy - before.sy) < 1)

  // ── 모서리로 크기 조절 ──
  await p.mouse.click(img.sx + img.sw * 0.5, img.sy + img.sh * 0.2)
  await sleep(200)
  const w0 = img.w
  await drag(p, img.sx + img.sw, img.sy + img.sh, img.sx + img.sw * 1.5, img.sy + img.sh * 1.5)
  await sleep(200)
  ;[img] = await images(p)
  check('오른쪽 아래 모서리를 끌면 정비율로 커진다', img.w > w0 * 1.3 && Math.abs(img.w / img.h - 4 / 3) < 0.02, `${w0} → ${img.w}×${img.h}`)
  check('크기 조절: 왼쪽 위는 그대로', Math.abs(img.sx - before.sx) < 2 && Math.abs(img.sy - before.sy) < 2)

  // ── 지우기 · 되돌리기 ──
  await p.keyboard.press('Delete')
  await sleep(200)
  check('Delete로 사진을 지운다', (await images(p)).length === 0)
  await p.keyboard.press('Meta+z')
  await sleep(900)
  check('되돌리면 사진이 돌아온다', (await images(p)).length === 1 && (await savedImages(p, docId)).length === 1)

  // ── 올가미로 감싸면 획과 함께 고른다 ──
  await p.keyboard.press('Escape')
  ;[img] = await images(p)
  const pad = 30
  await p.mouse.move(img.sx - pad, img.sy - pad)
  await p.mouse.down()
  for (const [x, y] of [[img.sx + img.sw + pad, img.sy - pad], [img.sx + img.sw + pad, img.sy + img.sh + pad], [img.sx - pad, img.sy + img.sh + pad], [img.sx - pad, img.sy - pad + 2]]) {
    await p.mouse.move(x, y, { steps: 8 })
  }
  await p.mouse.up()
  await sleep(200)
  const sel2 = await selection(p)
  check('올가미로 감싸면 사진과 그 위 필기를 함께 고른다', sel2?.count === 2 && sel2.images === 1, JSON.stringify(sel2))
  await p.locator('.selection-bar').getByRole('button', { name: '복제' }).click()
  await sleep(900)
  check('복제하면 사진도 새로 하나 (원본은 같은 에셋)', (await savedImages(p, docId)).length === 2 && new Set((await savedImages(p, docId)).map((e) => e.assetId)).size === 1)
  await p.keyboard.press('Meta+z')
  await sleep(900)

  // ── 붙여넣기 ──
  await p.keyboard.press('Escape')
  await p.evaluate(async () => {
    const c = new OffscreenCanvas(120, 120)
    const g = c.getContext('2d')!
    g.fillStyle = '#0000ff'
    g.fillRect(0, 0, 120, 120)
    const blob = await c.convertToBlob({ type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'image.png', { type: 'image/png' }))
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }))
  })
  await p.waitForFunction(() => (window as unknown as { inkpad: { scene: { images: Map<string, unknown> } } }).inkpad.scene.images.size === 2, null, { timeout: 5000 }).catch(() => {})
  check('사진을 붙여 넣으면 노트에 들어간다', (await images(p)).length === 2)
  await p.keyboard.press('Meta+z')
  await sleep(900)

  // ── 다시 열기 · PDF ──
  await openEditor(p, base, docId)
  await sleep(600)
  check('다시 열어도 사진이 있다', (await images(p)).length === 1)
  const c2 = await pageColors(p)
  check('다시 연 노트: 저장된 원본으로 그린다', !!c2 && c2.red > 0.04, JSON.stringify(c2))
  const pdf = await p.evaluate(async (id) => {
    const ex = await import('/src/io/pdfExport.ts')
    const blob = await ex.exportDocumentPdf(id)
    const { PDFDocument, PDFName, PDFRawStream } = await import('/node_modules/pdf-lib/dist/pdf-lib.esm.js')
    const doc = await PDFDocument.load(await blob.arrayBuffer())
    let imgs = 0
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) imgs++
    }
    return { pages: doc.getPageCount(), imgs }
  }, docId)
  check('PDF 내보내기에 사진이 담긴다', pdf.pages === 1 && pdf.imgs >= 1, JSON.stringify(pdf))

  // ── 낙서 모드: 메뉴 없음 ──
  await p.goto(base + '/')
  await p.waitForSelector('.doc-card')
  await p.locator('.doc-card', { hasText: '사진 노트' }).click()
  await sleep(500)
  await p.locator('.doc-card.is-revealed').getByRole('button', { name: '낙서모드' }).click()
  await p.waitForFunction(() => !!(window as unknown as { inkpad?: unknown }).inkpad && !!document.querySelector('.scratch-banner'), null, { timeout: 15000 })
  await sleep(400)
  await p.locator('.ft-bar').getByRole('button', { name: '더보기' }).click()
  check('낙서 모드에는 사진 넣기가 없다', (await p.locator('.ft-pop').getByRole('button', { name: '사진 넣기' }).count()) === 0)

  await p.context().close()
}
