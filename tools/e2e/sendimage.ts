// 이미지로 보내기 — 페이지·올가미 영역을 읽기 좋은 해상도로 다시 그려 복사한다 (AI 앱에 붙여넣기용)
//  - 페이지 전체: 기본 PDF 포함, 화면 줌과 관계없이 같은 크기(긴 변 2000px, 1pt에 4px까지)
//  - 올가미: 감싼 모양 그대로 자른다(고른 획 기준이 아니다). 기본 글씨만, 'PDF·속지 포함'을 켜면 밑의 PDF까지
//  - 자유 / 사각 올가미 (도구창에서 올가미를 한 번 더 눌러 고른다), 획 없이 감싸도 '영역'으로 보낼 수 있다
//  - 요청 문구는 이미지 위쪽 띠에 글자로 — 끄면 띠 없이
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

  // PNG의 크기·색 — pink: PDF 연분홍, ink: 필기(검정), band: 위쪽 문구 띠의 글자(진한 회색) 수
  type Info = { w: number; h: number; pink: number; ink: number; corner: string; inside: string; bandInk: number }
  const measure = `async (blob) => {
    const bmp = await createImageBitmap(blob)
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const g = c.getContext('2d')
    g.drawImage(bmp, 0, 0)
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data
    let pink = 0, ink = 0, bandInk = 0
    const W = bmp.width
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2]
      if (r > 230 && gg > 180 && gg < 230 && b > 180 && b < 230) pink++
      if (r < 90 && gg < 90 && b < 90) { ink++; if ((i / 4) / W < 60) bandInk++ }
    }
    const at = (x, y) => { const j = (Math.floor(y) * W + Math.floor(x)) * 4; return d[j] + ',' + d[j + 1] + ',' + d[j + 2] }
    // inside: 가운데 위쪽(필기가 지나가지 않는 안쪽), corner: 왼쪽 아래 모서리
    return { w: bmp.width, h: bmp.height, pink: pink / (d.length / 4), ink, corner: at(3, bmp.height - 3), inside: at(W / 2, bmp.height * 0.25), bandInk }
  }`
  const readClip = () =>
    p.evaluate(async (m) => {
      const items = await navigator.clipboard.read()
      const it = items.find((i) => i.types.includes('image/png'))
      return it ? (new Function(`return (${m})`)() as (b: Blob) => Promise<Info>)(await it.getType('image/png')) : null
    }, measure)
  // 엔진에서 바로 (문구 띠 없이) — 영역 모양·크기를 잰다
  const raw = (target: unknown, background: boolean) =>
    p.evaluate(
      async ([t, bg, m]) => {
        const e = (window as unknown as { inkpad: { exportImage: (t: unknown, o: object) => Promise<Blob | null> } }).inkpad
        const b = await e.exportImage(t, { background: bg })
        return b ? (new Function(`return (${m})`)() as (b: Blob) => Promise<Info>)(b) : null
      },
      [target, background, measure] as const
    )
  const sheet = p.locator('.modal.send-image')
  const copyFromSheet = async () => {
    await sheet.locator('.send-image-preview img').waitFor({ timeout: 15000 })
    await sheet.getByRole('button', { name: '복사' }).click()
    await sheet.waitFor({ state: 'detached', timeout: 5000 })
    return readClip()
  }
  const lassoDrag = async (pts: number[][]) => {
    await p.mouse.move(pts[0][0], pts[0][1])
    await p.mouse.down()
    for (let i = 1; i < pts.length; i++) await p.mouse.move(pts[i][0], pts[i][1], { steps: 10 })
    await p.mouse.up()
  }

  // ── 페이지 전체 (⋯ 메뉴) — 기본 PDF 포함 + 문구 띠 ──
  await p.click('.toolbar-doc [aria-label="더보기"]')
  await p.locator('.menu').getByRole('menuitem', { name: '이 페이지를 이미지로 보내기' }).click()
  await sheet.waitFor()
  const pageBgOn = await sheet.getByLabel(/PDF·속지 포함/).isChecked()
  const pageCaption = await sheet.getByLabel('요청 문구', { exact: true }).inputValue()
  const page1 = await copyFromSheet()
  const pageRaw = await raw({ page: 0 }, true)
  check('이미지로 보내기: 페이지는 기본 PDF 포함, 요청 문구는 문제·풀이 확인', pageBgOn && pageCaption.includes('문제와 풀이'), JSON.stringify({ pageBgOn, pageCaption }))
  check('이미지로 보내기: 페이지 전체를 고해상도로 (300×400pt → 1200×1600px, 1pt에 4px)', pageRaw?.w === 1200 && pageRaw?.h === 1600, JSON.stringify(pageRaw))
  check('이미지로 보내기: 요청 문구가 이미지 위쪽 띠에 글자로 들어간다', !!page1 && page1.w === 1200 && page1.h > 1600 && page1.bandInk > 50 && page1.pink > 0.6 && page1.ink > 50, JSON.stringify(page1))

  // 화면 줌과 관계없이 같은 크기
  await p.evaluate(() => (window as unknown as { inkpad: { zoomBy: (f: number) => void } }).inkpad.zoomBy(0.4))
  const zoomed = await raw({ page: 0 }, true)
  check('이미지로 보내기: 화면을 줄여도 같은 해상도', zoomed?.w === 1200 && zoomed?.h === 1600, JSON.stringify(zoomed))
  await p.evaluate(() => (window as unknown as { inkpad: { resetView: () => void } }).inkpad.resetView())
  await sleep(400)

  // ── 자유 올가미 (마름모) — 그 모양대로 자르고, 기본은 글씨만 ──
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setTool('lasso'))
  const box = (await p.locator('#canvas-root').boundingBox())!
  const cx = box.x + box.width / 2 - 52
  const cy = box.y + 250
  const R = 130
  await lassoDrag([
    [cx, cy - R],
    [cx + R, cy],
    [cx, cy + R],
    [cx - R, cy],
    [cx, cy - R + 3]
  ])
  await p.waitForSelector('.selection-bar')
  const diaBg = await raw('selection', true)
  const diaInk = await raw('selection', false)
  check('올가미: 감싼 모양대로 자른다 — 마름모 밖(모서리)은 흰 바탕, 안은 PDF', diaBg?.corner === '255,255,255' && /^25\d,2\d\d,2\d\d$/.test(diaBg?.inside ?? '') && Math.abs((diaBg?.w ?? 0) / (diaBg?.h ?? 1) - 1) < 0.1, JSON.stringify(diaBg))
  await p.click('.selection-bar [aria-label="이미지로 보내기"]')
  await sheet.waitFor()
  const selBgOn = await sheet.getByLabel(/PDF·속지 포함/).isChecked()
  const selCaption = await sheet.getByLabel('요청 문구', { exact: true }).inputValue()
  const inkOnly = await copyFromSheet()
  check('올가미: 기본은 글씨만 (PDF 없이), 요청 문구는 손글씨 받아쓰기', !selBgOn && selCaption.includes('손글씨를 그대로') && !!inkOnly && inkOnly.pink < 0.01 && inkOnly.ink > 20 && inkOnly.bandInk > 50, JSON.stringify({ selBgOn, selCaption, inkOnly }))
  check('올가미: 글씨만도 감싼 모양·크기 그대로', !!diaInk && diaInk.w === diaBg?.w && diaInk.h === diaBg?.h && diaInk.pink < 0.01, JSON.stringify(diaInk))

  // PDF·속지 포함을 켜면 밑의 PDF까지 — 고른 값은 기억한다
  await p.click('.selection-bar [aria-label="이미지로 보내기"]')
  await sheet.waitFor()
  await sheet.getByLabel(/PDF·속지 포함/).check()
  await sleep(300)
  const withBg = await copyFromSheet()
  check('올가미: PDF·속지 포함을 켜면 밑의 PDF까지', !!withBg && withBg.pink > 0.1 && withBg.ink > 20, JSON.stringify(withBg))
  // 요청 문구를 끄면 띠 없이 영역 그대로
  await p.click('.selection-bar [aria-label="이미지로 보내기"]')
  await sheet.waitFor()
  const remembered = await sheet.getByLabel(/PDF·속지 포함/).isChecked()
  await sheet.getByLabel('이미지에 요청 문구 넣기').uncheck()
  await sleep(300)
  const noCap = await copyFromSheet()
  check('올가미: PDF 포함은 기억하고, 요청 문구를 끄면 띠 없이', remembered && !!noCap && noCap.w === diaBg?.w && noCap.h === diaBg?.h, JSON.stringify({ remembered, noCap }))
  check('올가미: 선택은 그대로 (보낸 뒤에도 이어서 옮기기·지우기)', (await p.locator('.selection-bar').count()) === 1)

  // ── 사각 올가미 (도구창에서 올가미를 한 번 더 눌러 고른다) ──
  await p.locator('.ft-tool[aria-label="올가미"]').click()
  if (process.env.SHOT) {
    await p.locator('.ft-menu').waitFor()
    await sleep(600)
    await p.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-pop.png') })
  }
  await p.locator('.ft-menu').getByRole('menuitemradio', { name: /사각 올가미/ }).click()
  const shape = await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().settings.lassoShape)
  // 획의 왼쪽 절반만 걸치는 가로로 긴 네모 — 획 기준이면 획 전체 폭이 된다
  const rx0 = cx - 150
  const ry0 = cy - 60
  const rx1 = cx
  const ry1 = cy + 60
  await lassoDrag([
    [rx0, ry0],
    [rx1, ry1]
  ])
  await p.waitForSelector('.selection-bar')
  const rect = await raw('selection', true)
  const ratio = rect ? rect.w / rect.h : 0
  // 화면 1px = 월드 1/zoom — 내보낼 때 둘레에 8pt 흰 여백
  const zoom = await p.evaluate(([x, y]) => {
    const e = (window as unknown as { inkpad: { worldOfClient: (x: number, y: number) => { x: number } } }).inkpad
    return 100 / (e.worldOfClient(x + 100, y).x - e.worldOfClient(x, y).x)
  }, [rx0, ry0])
  const want = ((rx1 - rx0) / zoom + 16) / ((ry1 - ry0) / zoom + 16)
  check('사각 올가미: 도구창에서 고르고, 끈 네모 그대로 자른다 (획 기준 아님)', shape === 'rect' && Math.abs(ratio - want) < 0.04 && /^25\d,2\d\d,2\d\d$/.test(rect!.inside), JSON.stringify({ shape, rect, ratio, want }))

  // ── 획 없이 감싼 영역 — '영역'으로 보내기만 ──
  await lassoDrag([
    [cx - 120, box.y + 420],
    [cx + 120, box.y + 520]
  ])
  await p.waitForSelector('.selection-bar')
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-region.png') })
  const regionLabel = await p.locator('.selection-bar .sel-count').textContent()
  const regionBtns = await p.locator('.selection-bar button').count()
  const region = await raw('selection', true)
  check('영역만: 획 없이 감싸도 보내기 도구 모음이 뜨고(보내기·해제만), PDF를 담는다', regionLabel === '영역' && regionBtns === 2 && !!region && region.pink > 0.5 && region.ink === 0, JSON.stringify({ regionLabel, regionBtns, region }))

  check('이미지로 보내기: 네트워크를 쓰지 않는다', outside.length === 0, outside.join(' '))
  if (process.env.SHOT) {
    await p.click('.selection-bar [aria-label="이미지로 보내기"]')
    await sheet.getByLabel('이미지에 요청 문구 넣기').check()
    await sheet.locator('.send-image-preview img').waitFor()
    await sleep(500)
    await p.screenshot({ path: process.env.SHOT })
  }
  await p.context().close()
}
