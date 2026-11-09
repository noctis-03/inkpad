// 꾹 눌러 도구창 부르기 (settings.holdToolbar): 펜·마우스로 캔버스를 누른 채 가만히 있으면 도구창이 그 곁으로 오고,
// 누른 채 도구 버튼에 머물거나 그 위에서 떼면 그 도구가 켜진다. 떼면 도구창은 제자리로. 누른 자리엔 아무것도 남지 않는다.
import type { Page } from 'playwright'
import { createDoc, device, drawStroke, openEditor, sleep, strokes, type Ctx } from './lib.ts'

const toolOf = (p: Page) => p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().tool)
const barBox = async (p: Page) => (await p.locator('.ft-bar').boundingBox())!
const center = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

export default async function holdbar(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  const D = await createDoc(p, '꾹 누르기 노트')
  await openEditor(p, base, D)
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setSettings({ holdToolbarShape: 'bar' }))
  await sleep(600)
  const home = await barBox(p)
  const box = (await p.locator('#canvas-root').boundingBox())!
  const pt = { x: box.x + box.width / 2 + 40, y: box.y + box.height / 2 + 60 }
  const shot = process.env.HOLD_SHOTS

  // ── 가만히 누르면 도구창이 곁으로 ──
  await p.mouse.move(pt.x, pt.y)
  await p.mouse.down()
  await sleep(250)
  check('누르자마자는 그대로', !(await p.locator('.ft-bar[data-summoned]').count()))
  await sleep(700)
  check('잠시 누르고 있으면 도구창이 불려 온다', (await p.locator('.ft-bar[data-summoned]').count()) === 1)
  const near = await barBox(p)
  const c = center(near)
  check('도구창이 누른 점 가까이 (가리지 않고)', Math.hypot(c.x - pt.x, c.y - pt.y) < Math.hypot(center(home).x - pt.x, center(home).y - pt.y) && near.y + near.height <= pt.y, JSON.stringify({ near, pt }))
  if (shot) await p.screenshot({ path: `${shot}/hold-1-summoned.png` })

  // 누른 채 형광펜 버튼에 머문다 → 떼지 않아도 켜진다
  const hl = center((await p.locator('.ft-bar .ft-tool[aria-label="형광펜"]').boundingBox())!)
  await p.mouse.move(hl.x, hl.y, { steps: 6 })
  await sleep(120)
  check('누른 채 버튼 위: 강조', (await p.locator('.ft-bar .ft-tool.is-hover[aria-label="형광펜"]').count()) === 1)
  await sleep(250)
  check('누른 채 도구 버튼에 머물면 그 도구가 켜진다', (await toolOf(p)) === 'highlighter')
  if (shot) await p.screenshot({ path: `${shot}/hold-2-hover.png` })
  // 지우개 위에서 뗀다 → 지우개
  const er = center((await p.locator('.ft-bar .ft-tool[aria-label="지우개"]').boundingBox())!)
  await p.mouse.move(er.x, er.y, { steps: 4 })
  await p.mouse.up()
  await sleep(50)
  check('버튼 위에서 떼면 그 도구가 켜진다', (await toolOf(p)) === 'eraser')
  await sleep(600)
  check('떼면 도구창은 제자리로', !(await p.locator('.ft-bar[data-summoned]').count()) && Math.abs((await barBox(p)).y - home.y) < 2)
  await sleep(900)
  check('누른 자리·지나간 길에 획이 남지 않는다', (await strokes(p, D)).length === 0)

  // ── 움직이며 그리면 부르지 않는다 ──
  await p.locator('.ft-bar .ft-tool[aria-label="펜"]').click()
  await drawStroke(p)
  await sleep(900)
  check('그리던 획은 그대로 남는다', (await strokes(p, D)).length === 1 && !(await p.locator('.ft-bar[data-summoned]').count()))

  // 그리다 멈춰도(처음 자리에서 벗어난 뒤) 부르지 않는다
  await p.mouse.move(pt.x - 200, pt.y - 120)
  await p.mouse.down()
  for (let i = 1; i <= 6; i++) await p.mouse.move(pt.x - 200 + i * 10, pt.y - 120 + i * 4)
  await sleep(800)
  check('그리다 멈춘 것은 꾹 누르기가 아니다', !(await p.locator('.ft-bar[data-summoned]').count()))
  await p.mouse.up()
  await sleep(900)
  check('그 획도 남는다', (await strokes(p, D)).length === 2)

  // ── 지우개로 꾹 누르면 지운 획을 되살린다 ──
  await p.locator('.ft-bar .ft-tool[aria-label="지우개"]').click()
  const s0 = (await p.locator('#canvas-root').boundingBox())!
  const sx = s0.x + s0.width / 2 - 100 + 48 // drawStroke가 지나간 자리
  const sy = s0.y + 250 + Math.sin(3) * 20
  await p.mouse.move(sx, sy)
  await p.mouse.down()
  await sleep(800)
  check('지우개로도 불려 온다', (await p.locator('.ft-bar[data-summoned]').count()) === 1)
  await p.mouse.move(sx, sy + 300, { steps: 3 }) // 도구창 밖에서 뗀다
  await p.mouse.up()
  await sleep(900)
  check('지우개로 꾹 누른 자리의 획은 되살린다', (await strokes(p, D)).length === 2)
  check('도구창 밖에서 떼면 도구는 그대로', (await toolOf(p)) === 'eraser')

  // ── 원형: 누른 점 둘레로 동그랗게 말린다 ──
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setSettings({ holdToolbarShape: 'ring' }))
  await p.locator('.ft-bar .ft-tool[aria-label="펜"]').click()
  const before = (await strokes(p, D)).length
  const rp = { x: pt.x - 150, y: pt.y + 40 }
  const itemCenters = () =>
    p.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.ft-bar :is(.ft-tool, .ft-sw, .ft-wbtn, .ft-lasso-btn, .ft-k-undo, .ft-k-redo)')]
        .filter((e) => e.getClientRects().length)
        .map((e) => {
          const r = e.getBoundingClientRect()
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: e.getAttribute('aria-label') ?? '' }
        })
    )
  await p.mouse.move(rp.x, rp.y)
  await p.mouse.down()
  await sleep(450 + 150)
  if (shot) await p.screenshot({ path: `${shot}/ring-1-curling.png` })
  await sleep(500)
  if (shot) await p.screenshot({ path: `${shot}/ring-2-open.png` })
  check('원형: 불려 오면 판(띠)이 보인다', (await p.locator('.ft-ring-band[data-on]').count()) === 1 && (await p.locator('.ft-bar[data-ring]').count()) === 1)
  const dc = center((await p.locator('.ft-ring-band circle.c').boundingBox())!)
  const bandBox = (await p.locator('.ft-ring-band path.f').boundingBox())!
  // 판이 버튼을 따라 고리로 말렸다 — 판의 크기가 원 지름 + 버튼 폭 정도이고, 가운데 둘레(가운데 점 주변)는 비어 있다
  const pathHits = await p.evaluate(([x, y]) => {
    const path = document.querySelector<SVGPathElement>('.ft-ring-band path.f')!
    const svg = path.ownerSVGElement!
    const r = svg.getBoundingClientRect()
    const pt = svg.createSVGPoint()
    const at = (dx: number, dy: number) => {
      pt.x = x - r.left + dx
      pt.y = y - r.top + dy
      return path.isPointInStroke(pt)
    }
    return { center: at(0, 0) || at(20, 0) || at(0, -20), ring: [at(0, 100), at(-100, 0), at(100, 0)] }
  }, [dc.x, dc.y] as const)
  const pts = await itemCenters()
  const ds = pts.map((q) => Math.hypot(q.x - dc.x, q.y - dc.y))
  check('원형: 버튼이 한 원 위에 고르게', ds.length >= 6 && Math.max(...ds) - Math.min(...ds) < 2, JSON.stringify(ds.map(Math.round)))
  check('원형: 원의 가운데가 누른 점', Math.hypot(dc.x - rp.x, dc.y - rp.y) < 2, JSON.stringify({ dc, rp }))
  check('원형: 판도 고리로 말린다 (가운데가 빈다)', !pathHits.center && pathHits.ring.every(Boolean) && bandBox.width > 200 && Math.abs(bandBox.width - bandBox.height) < 30, JSON.stringify({ pathHits, bandBox }))
  const R0 = ds[0]
  // 형광펜 쪽으로 펜을 옮기기만 해도(버튼 위까지 가지 않아도) 고른다
  const hlp = pts.find((q) => q.label === '형광펜')!
  const toward = (q: { x: number; y: number }, f: number) => ({ x: rp.x + (q.x - rp.x) * f, y: rp.y + (q.y - rp.y) * f })
  const h1 = toward(hlp, 0.7)
  await p.mouse.move(h1.x, h1.y, { steps: 5 })
  await sleep(100)
  check('원형: 방향으로 고른다 (강조)', (await p.locator('.ft-bar .ft-tool.is-hover[aria-label="형광펜"]').count()) === 1)
  await sleep(250)
  check('원형: 머물면 그 도구가 켜진다', (await toolOf(p)) === 'highlighter')
  if (shot) await p.screenshot({ path: `${shot}/ring-3-pick.png` })
  const pts2 = await itemCenters()
  const ds2 = pts2.map((q) => Math.hypot(q.x - dc.x, q.y - dc.y))
  check('원형: 도구가 바뀌어도 원 모양 그대로', Math.max(...ds2) - Math.min(...ds2) < 2, JSON.stringify(ds2.map(Math.round)))
  check('원형: 도구가 바뀌어도 원 크기 그대로', Math.abs(ds2[0] - R0) < 1, `${R0} → ${ds2[0]}`)
  const hl2 = pts2.find((q) => q.label === '형광펜')!
  check('원형: 도구가 바뀌어도 도구 버튼 자리 그대로', Math.hypot(hl2.x - hlp.x, hl2.y - hlp.y) < 1)
  // 가운데로 돌아와 떼면 취소
  await p.mouse.move(rp.x + 3, rp.y + 2, { steps: 4 })
  await p.mouse.up()
  await sleep(450)
  check('원형: 가운데에서 떼면 아무것도 바뀌지 않는다', (await toolOf(p)) === 'highlighter')
  check(
    '원형: 떼면 일자로 풀려 제자리',
    !(await p.locator('.ft-bar[data-ring], .ft-bar[data-summoned], .ft-ring-disc[data-on]').count()) &&
      (await p.evaluate(() => [...document.querySelectorAll<HTMLElement>('.ft-bar button')].every((b) => !b.style.transform)))
  )
  // 색 쪽으로 옮겨 떼면 그 색
  await p.locator('.ft-bar .ft-tool[aria-label="펜"]').click()
  await p.mouse.move(rp.x, rp.y)
  await p.mouse.down()
  await sleep(1000)
  const sw = (await itemCenters()).filter((q) => q.label.startsWith('색상'))[2]
  const s1 = toward(sw, 1.3) // 버튼을 지나쳐도 방향이 같으면 그 버튼
  await p.mouse.move(s1.x, s1.y, { steps: 5 })
  await p.mouse.up()
  await sleep(450)
  const penColor = await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().style.pen.color)
  check('원형: 색 쪽으로 옮겨 떼면 그 색', sw.label.includes(penColor.slice(0, 7)) || (await p.locator('.ft-bar .ft-sw.is-active').getAttribute('aria-label')) === sw.label, `${sw.label} / ${penColor}`)
  await sleep(600)
  check('원형: 누른 자리에 획이 남지 않는다', (await strokes(p, D)).length === before)

  // 버튼이 적은 도구(지우개)로 열어도 원 크기는 같다
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setTool('eraser'))
  await p.mouse.move(rp.x, rp.y)
  await p.mouse.down()
  await sleep(1000)
  const ec = center((await p.locator('.ft-ring-band circle.c').boundingBox())!)
  const eds = (await itemCenters()).map((q) => Math.hypot(q.x - ec.x, q.y - ec.y))
  if (shot) await p.screenshot({ path: `${shot}/ring-4-eraser.png` })
  check('원형: 지우개로 열어도 원 크기가 같다', eds.length < 14 && eds.every((d) => Math.abs(d - R0) < 1), JSON.stringify(eds.map(Math.round)))
  await p.mouse.move(rp.x, rp.y + 2)
  await p.mouse.up()
  await sleep(450)

  // ── 설정에서 끄면 ──
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setSettings({ holdToolbar: false }))
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setTool('pen'))
  const n0 = (await strokes(p, D)).length
  await p.mouse.move(pt.x, pt.y + 100)
  await p.mouse.down()
  await sleep(800)
  check('끄면 불려 오지 않는다', !(await p.locator('.ft-bar[data-summoned]').count()))
  await p.mouse.up()
  await sleep(900)
  check('끄면 꾹 누른 점이 그대로 찍힌다', (await strokes(p, D)).length === n0 + 1, String((await strokes(p, D)).length - n0))
  await p.close()
}
