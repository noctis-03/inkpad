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

  // ── 설정에서 끄면 ──
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setSettings({ holdToolbar: false }))
  await p.locator('.ft-bar .ft-tool[aria-label="펜"]').click()
  await p.mouse.move(pt.x, pt.y + 100)
  await p.mouse.down()
  await sleep(800)
  check('끄면 불려 오지 않는다', !(await p.locator('.ft-bar[data-summoned]').count()))
  await p.mouse.up()
  await sleep(900)
  check('끄면 꾹 누른 점이 그대로 찍힌다', (await strokes(p, D)).length === 3)
  await p.close()
}
