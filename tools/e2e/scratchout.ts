// 지그재그로 지우기 (settings.scratchErase): 펜으로 글씨 위를 지그재그로 그으면 그 아래 획이 지워지고 지그재그 선은 남지 않는다.
// 되돌리기 한 번에 살아난다. 아래에 지울 획이 없거나 설정을 끄면 평범한 선으로 남는다.
import type { Page } from 'playwright'
import { createDoc, device, drawStroke, openEditor, sleep, strokes, type Ctx } from './lib.ts'

/** drawStroke가 지나간 자리(가로 96px, 위아래 ±20px)를 덮는 지그재그 */
async function zigzag(p: Page, dx = 0, dy = 0) {
  const box = (await p.locator('#canvas-root').boundingBox())!
  const x = box.x + box.width / 2 - 110 + dx
  const y = box.y + 250 + dy
  await p.mouse.move(x, y - 28)
  await p.mouse.down()
  for (let i = 1; i <= 14; i++) {
    const tx = x + i * 9
    const ty = i % 2 ? y + 28 : y - 28
    const [fx, fy] = [x + (i - 1) * 9, i % 2 ? y - 28 : y + 28]
    for (let s = 1; s <= 4; s++) await p.mouse.move(fx + ((tx - fx) * s) / 4, fy + ((ty - fy) * s) / 4)
  }
  await p.mouse.up()
}

export default async function scratchout(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  const D = await createDoc(p, '지그재그 노트')
  await openEditor(p, base, D)
  await sleep(500)

  await drawStroke(p)
  await sleep(700)
  check('글씨 한 획', (await strokes(p, D)).length === 1)
  await zigzag(p)
  await sleep(900)
  check('글씨 위를 지그재그로 그으면 지워지고 지그재그도 남지 않는다', (await strokes(p, D)).length === 0)
  if (process.env.SCRATCH_SHOTS) await p.screenshot({ path: `${process.env.SCRATCH_SHOTS}/scratch-after.png` })
  await p.keyboard.press('Control+z')
  await sleep(900)
  check('되돌리기 한 번에 살아난다', (await strokes(p, D)).length === 1)

  // 빈 자리의 지그재그는 평범한 선
  await zigzag(p, 0, 200)
  await sleep(900)
  check('아래에 지울 것이 없으면 선으로 남는다', (await strokes(p, D)).length === 2)

  // 설정을 끄면 지우지 않는다
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setSettings({ scratchErase: false }))
  await sleep(300)
  await zigzag(p)
  await sleep(900)
  check('끄면 지우지 않고 선으로 남는다', (await strokes(p, D)).length === 3)
  await p.close()
}
