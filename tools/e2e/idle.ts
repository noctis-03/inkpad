// 편집 화면 배터리·되돌리기: 가만히 있으면 프레임을 돌리지 않고, 동기화 시점으로 되돌리면 '올리기 필요'가 내려간다
import { createDoc, device, drawStroke, openEditor, sleep, type Ctx } from './lib.ts'

export default async function idle(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  await p.addInitScript(() => {
    const w = window as unknown as { __raf: number }
    w.__raf = 0
    const orig = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = (cb) => {
      w.__raf++
      return orig(cb)
    }
  })
  await p.reload() // 위 계측 스크립트는 다음 페이지 로드부터 붙는다
  await p.waitForSelector('#root *')
  const docId = await createDoc(p, 'idle', 1, 'lined')
  // 방금 동기화한 것처럼 base를 남기고 올리기 대기를 비운다
  await p.evaluate(async (id) => {
    const base = await import('/src/sync/base.ts')
    const pack = await import('/src/sync/pack.ts')
    const un = await import('/src/sync/unchanged.ts')
    const { db } = await import('/src/storage/db.ts')
    await base.saveBase(id, await pack.packDocument(id))
    await db.outbox.bulkDelete(await un.pendingSeqsFor(id))
  }, docId)
  await openEditor(p, base, docId)
  await sleep(1000)
  const raf = () => p.evaluate(() => (window as unknown as { __raf: number }).__raf)
  let before = await raf()
  await sleep(2000)
  check('배터리: 가만히 있는 2초 동안 프레임 요청 0회', (await raf()) - before === 0, String((await raf()) - before))

  await drawStroke(p)
  await sleep(1200)
  const pending = () => p.evaluate(async (id) => (await (await import('/src/sync/unchanged.ts')).pendingSeqsFor(id)).length, docId)
  check('되돌리기: 획을 그으면 올리기 대기가 생긴다', (await pending()) > 0)
  before = await raf()
  await sleep(2000)
  check('배터리: 그린 뒤 다시 가만히 있으면 프레임 요청 0회', (await raf()) - before === 0)
  await p.keyboard.press('Control+z')
  await sleep(2500) // 되돌리기가 멈추고 약 1.2초 뒤 한 번 확인한다
  check('되돌리기: 동기화 시점으로 되돌리면 올리기 대기가 내려간다', (await pending()) === 0)
  await p.context().close()
}
