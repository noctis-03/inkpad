// 편집 블록 위 화면 이동·확대: 블록 DOM은 #canvas-root 밖이라 BlockLayer가 손가락·휠·가운데 버튼을 엔진에 넘긴다
import { createDoc, device, openEditor, sleep, type Ctx } from './lib.ts'

type Pt = { x: number; y: number; id: number }

export default async function blockgesture(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx, { touch: true })
  const errs: string[] = []
  p.on('pageerror', (e) => errs.push(String(e)))
  const docId = await createDoc(p, '블록 제스처')
  await openEditor(p, base, docId)
  const cdp = await p.context().newCDPSession(p)
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', pts: Pt[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q) => ({ ...q, radiusX: 2, radiusY: 2 })) })
  const cam = () =>
    p.evaluate(() => {
      const c = (window as unknown as { inkpad: { cam: { x: number; y: number; zoom: number } } }).inkpad.cam
      return { x: c.x, y: c.y, zoom: c.zoom }
    })
  const memoId = await p.evaluate(async () => {
    const eng = (window as unknown as { inkpad: any }).inkpad
    const B = await import('/src/engine/blocks.ts')
    const b = B.createBlock('memo', eng.doc.id, eng.pages[0].id, 80, 80, 1)
    b.w = 400
    if (b.type === 'memo') b.data.text = '첫 줄\n둘\n셋\n넷\n다섯\n여섯'
    eng.addBlock(b)
    return b.id as string
  })
  await sleep(300)
  const rect = async (sel: string) => (await p.locator(`.blk[data-blk-id="${memoId}"] ${sel}`).boundingBox())!
  const blkPos = () =>
    p.evaluate((id) => {
      const b = (window as unknown as { inkpad: any }).inkpad.blocks.get(id)
      return { x: b.x as number, y: b.y as number }
    }, memoId)
  const center = (r: { x: number; y: number; width: number; height: number }) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })

  // ── 휠 ──
  let c = center(await rect('.blk-body'))
  let c0 = await cam()
  await p.mouse.move(c.x, c.y)
  await p.mouse.wheel(0, 120)
  await sleep(100)
  let c1 = await cam()
  check('블록 위 휠 → 화면 이동', c1.y > c0.y + 1, JSON.stringify([c0.y, c1.y]))
  await p.keyboard.down('Control')
  await p.mouse.wheel(0, -200)
  await p.keyboard.up('Control')
  await sleep(100)
  const c2 = await cam()
  check('블록 위 Ctrl+휠 → 확대', c2.zoom > c1.zoom * 1.05, JSON.stringify([c1.zoom, c2.zoom]))

  // ── 한 손가락 팬 (블록 본문) ──
  c = center(await rect('.blk-body'))
  c0 = await cam()
  await touch('touchStart', [{ ...c, id: 1 }])
  for (let i = 1; i <= 10; i++) await touch('touchMove', [{ x: c.x - i * 8, y: c.y - i * 6, id: 1 }])
  await touch('touchEnd', [])
  await sleep(400)
  c1 = await cam()
  check('블록 본문 한 손가락 드래그 → 화면 이동', c1.x > c0.x + 10 && c1.y > c0.y + 10, JSON.stringify([c0, c1]))

  // ── 두 손가락 모두 블록 위 핀치 ──
  c = center(await rect('.blk-body'))
  c0 = await cam()
  await touch('touchStart', [{ x: c.x - 30, y: c.y, id: 1 }])
  await touch('touchStart', [{ x: c.x - 30, y: c.y, id: 1 }, { x: c.x + 30, y: c.y, id: 2 }])
  for (let i = 1; i <= 10; i++) await touch('touchMove', [{ x: c.x - 30 - i * 6, y: c.y, id: 1 }, { x: c.x + 30 + i * 6, y: c.y, id: 2 }])
  await touch('touchEnd', [])
  await sleep(200)
  c1 = await cam()
  check('블록 위 두 손가락 핀치 → 확대', c1.zoom > c0.zoom * 1.5, JSON.stringify([c0.zoom, c1.zoom]))
  // 크게 확대된 화면을 페이지 폭 맞춤으로 되돌린다
  await p.evaluate(() => (window as unknown as { inkpad: { fitWidth: (keepPage?: boolean) => void } }).inkpad.fitWidth(false))
  await sleep(200)

  // ── 헤더 드래그 중 두 번째 손가락(캔버스) → 드래그 취소, 핀치로 이어짐 ──
  const before = await blkPos()
  let h = await rect('.blk-head')
  const hx = h.x + 60
  const hy = h.y + h.height / 2
  c0 = await cam()
  await touch('touchStart', [{ x: hx, y: hy, id: 1 }])
  for (let i = 1; i <= 3; i++) await touch('touchMove', [{ x: hx + i * 6, y: hy, id: 1 }])
  const dragging = await p.evaluate((id) => document.querySelector(`.blk[data-blk-id="${id}"]`)!.classList.contains('is-drag'), memoId)
  await touch('touchStart', [{ x: hx + 18, y: hy, id: 1 }, { x: 900, y: 700, id: 2 }])
  for (let i = 1; i <= 10; i++) await touch('touchMove', [{ x: hx + 18 - i * 6, y: hy - i * 4, id: 1 }, { x: 900 + i * 6, y: 700 + i * 4, id: 2 }])
  await touch('touchEnd', [])
  await sleep(200)
  c1 = await cam()
  const after = await blkPos()
  check('헤더 드래그 중 두 번째 손가락 → 핀치 확대', dragging && c1.zoom > c0.zoom * 1.2, JSON.stringify({ dragging, zoom: [c0.zoom, c1.zoom] }))
  check('…그때 블록은 제자리', before.x === after.x && before.y === after.y, JSON.stringify([before, after]))

  // ── 한 손가락 헤더 드래그는 블록 이동 (화면은 그대로) ──
  h = await rect('.blk-head')
  const sx = h.x + 60
  const sy = h.y + h.height / 2
  const b0 = await blkPos()
  c0 = await cam()
  await touch('touchStart', [{ x: sx, y: sy, id: 1 }])
  for (let i = 1; i <= 10; i++) await touch('touchMove', [{ x: sx + i * 5, y: sy + i * 5, id: 1 }])
  await touch('touchEnd', [])
  await sleep(200)
  const b1 = await blkPos()
  c1 = await cam()
  check('한 손가락 헤더 드래그 → 블록 이동, 화면은 그대로', b1.x > b0.x + 5 && b1.y > b0.y + 5 && c1.x === c0.x && c1.y === c0.y, JSON.stringify([b0, b1]))

  // ── 마우스: 왼쪽 버튼은 블록 몫, 가운데 버튼은 팬 ──
  let r = await rect('.blk-body')
  c0 = await cam()
  await p.mouse.move(r.x + 50, r.y + 20)
  await p.mouse.down()
  await p.mouse.move(r.x + 150, r.y + 80, { steps: 5 })
  await p.mouse.up()
  c1 = await cam()
  check('블록 위 마우스 왼쪽 드래그는 화면을 움직이지 않음', c0.x === c1.x && c0.y === c1.y)
  r = await rect('.blk-body')
  c0 = await cam()
  await p.mouse.move(r.x + 50, r.y + 20)
  await p.mouse.down({ button: 'middle' })
  await p.mouse.move(r.x + 150, r.y + 80, { steps: 5 })
  await p.mouse.up({ button: 'middle' })
  c1 = await cam()
  check('블록 위 가운데 버튼 드래그 → 화면 이동', c1.x < c0.x - 5, JSON.stringify([c0.x, c1.x]))

  check('블록 제스처: 페이지 오류 없음', errs.length === 0, errs.join(' | '))
  await p.context().close()
}

