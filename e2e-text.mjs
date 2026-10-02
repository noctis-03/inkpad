import { chromium } from 'playwright'

const URL = 'http://127.0.0.1:5199'
const results = []
const errors = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`) }
const ink = () => {
  const c = document.querySelector('.layer-committed')
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let n = 0
  for (let i = 0; i < d.length; i += 4) if (d[i] < 128 && d[i + 3] > 40) n++
  return n
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
const page = await ctx.newPage()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 200)) })

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#new-doc-btn', { timeout: 30000 })
  check('앱 로드 (문서 목록)', true)
  await page.click('#new-doc-btn')
  await page.waitForSelector('#create-doc-btn', { timeout: 10000 })
  await page.click('#create-doc-btn')
  await page.waitForSelector('#canvas-root', { timeout: 15000 })
  await page.waitForFunction(() => !!window.inkpad, null, { timeout: 20000 })
  await page.waitForTimeout(600)
  check('문서 생성 → 에디터 진입', true)

  await page.click('button[aria-label="텍스트"]')
  const tool = await page.evaluate(() => window.inkpad.tool)
  check('텍스트 도구 선택', tool === 'text', `tool=${tool}`)

  const geo = await page.evaluate(() => {
    const e = window.inkpad
    const p = e.layout.pages[0]
    const r = e.layout.rects.get(p.id)
    const s = e.cam.worldToScreen(r.x + 60, r.y + 140)
    const cr = document.querySelector('#canvas-root').getBoundingClientRect()
    return { x: cr.left + s.x, y: cr.top + s.y }
  })
  await page.mouse.click(geo.x, geo.y)
  await page.waitForTimeout(500)
  check('페이지 탭 → 오버레이 표시', (await page.locator('.text-overlay').count()) === 1)
  const focused = await page.evaluate(() => document.activeElement?.className || '')
  check('오버레이 자동 포커스', focused.includes('text-overlay'), `activeElement=${focused}`)

  const TEXT = '한글 텍스트 박스 E2E 검증'
  await page.keyboard.type(TEXT, { delay: 15 })
  await page.waitForTimeout(300)
  const v = await page.locator('.text-overlay').inputValue()
  check('한글 입력 반영', v === TEXT, `value="${v}"`)

  const before = await page.evaluate(ink)
  await page.keyboard.press('Control+Enter')
  await page.waitForTimeout(1000)
  check('커밋 후 오버레이 사라짐', (await page.locator('.text-overlay').count()) === 0)
  const c = await page.evaluate(() => {
    const xs = window.inkpad.scene.extraEntries()
    return { n: xs.length, type: xs[0]?.element?.type, text: xs[0]?.element?.text, x: xs[0]?.element?.x, y: xs[0]?.element?.y }
  })
  check('모델에 텍스트 박스 저장', c.n === 1 && c.type === 'text', JSON.stringify(c))
  check('저장 문자열 일치', c.text === TEXT, `text="${c.text}"`)
  check('좌표가 페이지 상대좌표', c.x < 300 && c.y < 300, `x=${c.x} y=${c.y}`)
  const after = await page.evaluate(ink)
  check('확정 레이어에 렌더', after > 0, `ink ${before} → ${after}`)

  await page.keyboard.press('Control+z'); await page.waitForTimeout(600)
  const u = await page.evaluate(() => window.inkpad.scene.extraEntries().length)
  check('Ctrl+Z 되돌리기', u === 0, `extraEntries=${u}`)
  await page.keyboard.press('Control+Shift+z'); await page.waitForTimeout(600)
  const r = await page.evaluate(() => window.inkpad.scene.extraEntries().length)
  check('Ctrl+Shift+Z 다시 실행', r === 1, `extraEntries=${r}`)

  await page.mouse.click(geo.x, geo.y); await page.waitForTimeout(500)
  const ov = await page.locator('.text-overlay').count()
  const ovv = ov ? await page.locator('.text-overlay').inputValue() : ''
  check('확정 텍스트 재편집 진입', ov === 1 && ovv === TEXT, `overlay=${ov} value="${ovv}"`)
  await page.keyboard.press('Escape'); await page.waitForTimeout(500)
  const esc = await page.evaluate(() => { const xs = window.inkpad.scene.extraEntries(); return { n: xs.length, text: xs[0]?.element?.text } })
  check('Esc 취소 시 원본 유지', esc.n === 1 && esc.text === TEXT, JSON.stringify(esc))

  await page.click('button[aria-label="올가미"]')
  const poly = await page.evaluate(() => {
    const e = window.inkpad, x = e.scene.extraEntries()[0], el = x.element
    const gx = el.x + x.ox, gy = el.y + x.oy, gw = Math.max(24, el.w)
    const cr = document.querySelector('#canvas-root').getBoundingClientRect()
    return [[gx - 28, gy - 28], [gx + gw + 28, gy - 28], [gx + gw + 28, gy + 280], [gx - 28, gy + 280]]
      .map(([wx, wy]) => { const s = e.cam.worldToScreen(wx, wy); return [cr.left + s.x, cr.top + s.y] })
  })
  await page.mouse.move(poly[0][0], poly[0][1]); await page.mouse.down()
  for (const [x, y] of poly.slice(1)) await page.mouse.move(x, y, { steps: 6 })
  await page.mouse.move(poly[0][0], poly[0][1], { steps: 6 }); await page.mouse.up()
  await page.waitForTimeout(600)
  const sel = await page.evaluate(() => ({ has: window.inkpad.hasSelection, ex: window.inkpad.selectionExtras.length, n: window.inkpad.selection.length }))
  check('올가미가 텍스트 선택', sel.has === true && sel.ex === 1, JSON.stringify(sel))
  const selBar = await page.locator('.selection-bar').count()
  check('선택 도구막대 표시', selBar === 1, `.selection-bar=${selBar}`)

  const b2 = await page.evaluate(() => { const el = window.inkpad.scene.extraEntries()[0].element; return { x: el.x, y: el.y } })
  await page.mouse.move(geo.x, geo.y); await page.mouse.down()
  await page.mouse.move(geo.x, geo.y + 90, { steps: 8 }); await page.mouse.up()
  await page.waitForTimeout(800)
  const m2 = await page.evaluate(() => { const el = window.inkpad.scene.extraEntries()[0].element; return { x: el.x, y: el.y } })
  check('드래그로 텍스트 이동', Math.abs(m2.y - b2.y) > 5, `y ${b2.y} → ${m2.y}`)
  await page.keyboard.press('Control+z'); await page.waitForTimeout(700)
  const u2 = await page.evaluate(() => { const xs = window.inkpad.scene.extraEntries(); return { y: xs[0]?.element?.y, n: xs.length } })
  check('이동 되돌리기', u2.n === 1 && Math.abs(u2.y - b2.y) < 0.5, `y ${m2.y} → ${u2.y}, n=${u2.n}`)

  await page.click('button[aria-label="올가미"]')
  await page.waitForTimeout(200)
} catch (e) {
  check('예외 없이 완주', false, e.message)
} finally {
  const passed = results.filter((x) => x.ok).length
  console.log(`\n===== ${passed}/${results.length} 통과 =====`)
  if (errors.length) { console.log('--- JS 오류 ---'); for (const x of [...new Set(errors)].slice(0, 12)) console.log(x) }
  else console.log('JS 오류 없음')
  await browser.close()
}
