// 이미지로 보내기 — 페이지·올가미 영역을 읽기 좋은 해상도로 다시 그려 복사한다 (AI 앱에 붙여넣기용)
//  - 페이지 전체: PDF 배경 + 필기, 화면 줌과 관계없이 같은 크기(긴 변 2000px, 1pt에 4px까지)
//  - 올가미: 고른 획만이 아니라 올가미로 감싼 영역 전체(그 밑의 PDF까지)
//  - 복사하면 클립보드에 PNG — 네트워크는 쓰지 않는다
import { device, drawStroke, openEditor, sleep, type Ctx } from './lib.ts'

export default async function sendimage(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  await p.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
  // 밖으로 나간 요청 — 미리보기의 blob:·data: 주소는 이 기기 안이므로 세지 않는다
  const outside: string[] = []
  p.context().on('request', (r) => {
    const u = r.url()
    if (/^https?:/.test(u) && !u.startsWith(base)) outside.push(u)
  })

  // 연분홍으로 가득 찬 300×400pt PDF 한 쪽으로 노트를 만든다 — 어디를 잘라도 PDF가 그려졌는지 색으로 안다
  const docId = await p.evaluate(async () => {
    const { PDFDocument, rgb } = await import('/node_modules/pdf-lib/dist/pdf-lib.esm.js')
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([300, 400])
    page.drawRectangle({ x: 0, y: 0, width: 300, height: 400, color: rgb(1, 0.8, 0.8) })
    const bytes = await pdf.save()
    const im = await import('/src/io/pdfImport.ts')
    const info = await im.readPdf(new File([bytes], '문제지.pdf', { type: 'application/pdf' }), '문제지.pdf', async () => null)
    return (await im.createDocumentFromPdf(info, null)).id
  })
  await openEditor(p, base, docId)
  await sleep(800)
  await drawStroke(p)
  await sleep(500)

  // 클립보드의 PNG를 읽어 크기·색을 잰다
  const readClip = () =>
    p.evaluate(async () => {
      const items = await navigator.clipboard.read()
      const it = items.find((i) => i.types.includes('image/png'))
      if (!it) return null
      const bmp = await createImageBitmap(await it.getType('image/png'))
      const c = new OffscreenCanvas(bmp.width, bmp.height)
      const g = c.getContext('2d')!
      g.drawImage(bmp, 0, 0)
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data
      let pink = 0
      let ink = 0
      for (let i = 0; i < d.length; i += 4) {
        const [r, gg, b] = [d[i], d[i + 1], d[i + 2]]
        if (r > 230 && gg > 180 && gg < 230 && b > 180 && b < 230) pink++
        if (r < 90 && gg < 90 && b < 90) ink++
      }
      return { w: bmp.width, h: bmp.height, pink: pink / (d.length / 4), ink }
    })
  const sheet = p.locator('.modal.send-image')

  // ── 페이지 전체 (⋯ 메뉴) ──
  await p.click('.toolbar-doc [aria-label="더보기"]')
  await p.locator('.menu').getByRole('menuitem', { name: '이 페이지를 이미지로 보내기' }).click()
  await sheet.locator('.send-image-preview img').waitFor({ timeout: 15000 })
  await sheet.getByRole('button', { name: '복사' }).click()
  await sheet.waitFor({ state: 'detached', timeout: 5000 })
  const page1 = await readClip()
  check('이미지로 보내기: 페이지 전체를 고해상도로 (300×400pt → 1200×1600px, 1pt에 4px)', !!page1 && page1.w === 1200 && page1.h === 1600, JSON.stringify(page1))
  check('이미지로 보내기: PDF 배경과 필기를 함께 그린다', !!page1 && page1.pink > 0.8 && page1.ink > 50, JSON.stringify(page1))

  // 화면 줌과 관계없이 같은 크기
  const zoomed = await p.evaluate(async () => {
    const e = (window as unknown as { inkpad: { zoomBy: (f: number) => void; exportImage: (t: unknown) => Promise<Blob | null> } }).inkpad
    e.zoomBy(0.4)
    const b = await e.exportImage({ page: 0 })
    if (!b) return null
    const bmp = await createImageBitmap(b)
    return { w: bmp.width, h: bmp.height }
  })
  check('이미지로 보내기: 화면을 줄여도 같은 해상도', zoomed?.w === 1200 && zoomed?.h === 1600, JSON.stringify(zoomed))
  await p.evaluate(() => (window as unknown as { inkpad: { resetView: () => void } }).inkpad.resetView())
  await sleep(400)

  // ── 올가미 영역 — 고른 획보다 넓게 감싸면 감싼 영역 전체(밑의 PDF까지) ──
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setTool('lasso'))
  const box = (await p.locator('#canvas-root').boundingBox())!
  const cx = box.x + box.width / 2 - 52
  const cy = box.y + 250
  const half = 120
  const corners = [
    [cx - half, cy - half],
    [cx + half, cy - half],
    [cx + half, cy + half],
    [cx - half, cy + half],
    [cx - half, cy - half + 4]
  ]
  await p.mouse.move(corners[0][0], corners[0][1])
  await p.mouse.down()
  for (let i = 1; i < corners.length; i++) await p.mouse.move(corners[i][0], corners[i][1], { steps: 10 })
  await p.mouse.up()
  await p.waitForSelector('.selection-bar')
  await p.click('.selection-bar [aria-label="이미지로 보내기"]')
  await sheet.locator('.send-image-preview img').waitFor({ timeout: 15000 })
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT })
  await sheet.getByRole('button', { name: '복사' }).click()
  await sheet.waitFor({ state: 'detached', timeout: 5000 })
  const part = await readClip()
  // 획은 약 100×40 화면 px(가로로 긴 모양) — 올가미는 240×240 정사각형이므로 비율이 1에 가까워야 한다
  const ratio = part ? part.w / part.h : 0
  check('이미지로 보내기: 올가미로 감싼 영역 전체를 담는다 (획 크기만이 아니라)', Math.abs(ratio - 1) < 0.12, JSON.stringify({ part, ratio }))
  check('이미지로 보내기: 올가미 영역에도 PDF 배경과 필기', !!part && part.pink > 0.5 && part.ink > 20, JSON.stringify(part))
  check('이미지로 보내기: 선택은 그대로 (보낸 뒤에도 이어서 옮기기·지우기)', (await p.locator('.selection-bar').count()) === 1)

  check('이미지로 보내기: 네트워크를 쓰지 않는다', outside.length === 0, outside.join(' '))
  await p.context().close()
}
