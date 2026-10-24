// 펜 입력 위치: 노트를 여는 애니메이션이 끝난 뒤에도 획이 누른 자리에 찍혀야 한다.
// (엔진이 열리는 도중의 캔버스 위치를 기억해 두고 고치지 않아 획이 몇 px 어긋났던 문제)
import { createDoc, device, openEditor, sleep, type Ctx } from './lib.ts'

type W = { inkpad: any }

export default async function inputpos(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  const docId = await createDoc(p, '입력 위치')
  for (const round of ['처음 열기', '다시 열기']) {
    await openEditor(p, base, docId)
    await sleep(1200) // 여는 애니메이션이 끝난 뒤
    const box = (await p.locator('#canvas-root').last().boundingBox())!
    const sx = box.x + box.width / 2
    const sy = box.y + box.height / 2
    await p.mouse.move(sx, sy)
    await p.mouse.down()
    for (let i = 1; i <= 8; i++) await p.mouse.move(sx + i * 10, sy + i * 4)
    await p.mouse.up()
    await sleep(100)
    const r = await p.evaluate(([sx, sy]) => {
      const e = (window as unknown as W).inkpad
      const b = e.root.getBoundingClientRect()
      const want = { x: (sx - b.left) / e.cam.zoom + e.cam.x, y: (sy - b.top) / e.cam.zoom + e.cam.y }
      const recs = [...e.scene.recs.values()]
      const rec = recs[recs.length - 1]
      const got = { x: rec.stroke.points[0] + rec.ox, y: rec.stroke.points[1] + rec.oy }
      return { dx: (got.x - want.x) * e.cam.zoom, dy: (got.y - want.y) * e.cam.zoom }
    }, [sx, sy])
    check(`${round}: 획이 누른 자리에서 시작 (화면 1px 이내)`, Math.abs(r.dx) <= 1 && Math.abs(r.dy) <= 1, JSON.stringify(r))
  }
  await p.context().close()
}
