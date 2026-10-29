// 미니맵 — 확대해 좌우가 화면 밖일 때 왼쪽 위에 가는 막대 하나로 지금 보는 줄의 전체 폭을 보여 준다
//  - 폭 맞춤(100%)처럼 좌우가 다 보이면 숨는다, 확대해 좌우가 잘리면 나타난다
//  - 화면 밖 왼쪽·오른쪽에 쓴 필기가 파란 '보이는 부분' 구간 바깥에 진한 눈금으로 찍힌다
//  - 누르거나 그 위에 써도 아무 반응이 없다 — 그 자리에 평소처럼 필기된다. 그 아래에서 쓰는 동안은 흐려진다
//  - 도구창이 왼쪽 위에 있으면 겹치지 않게 비켜 선다, 설정에서 끌 수 있다, 무한 캔버스에서도 나온다
import { createDoc, device, openEditor, sleep, type Ctx } from './lib.ts'

type W = { inkpad: any }

export default async function minimap(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  const docId = await createDoc(p, '미니맵')
  await openEditor(p, base, docId)
  await sleep(1200)
  const mm = p.locator('.minimap')
  const visible = () => mm.evaluate((el) => !(el as HTMLElement).hidden).catch(() => false)

  // 페이지 왼쪽 끝과 오른쪽 끝 가까이에 짧은 획 하나씩 (월드 좌표로 찍는다)
  const toScreen = (wx: number, wy: number) =>
    p.evaluate(
      ([wx, wy]) => {
        const e = (window as unknown as W).inkpad
        const b = e.root.getBoundingClientRect()
        return { x: (wx - e.cam.x) * e.cam.zoom + b.left, y: (wy - e.cam.y) * e.cam.zoom + b.top }
      },
      [wx, wy] as const
    )
  const page = await p.evaluate(() => {
    const e = (window as unknown as W).inkpad
    return e.layout.rects.get(e.pages[0].id)
  })
  const stroke = async (wx: number, wy: number, len = 40) => {
    const a = await toScreen(wx, wy)
    const b = await toScreen(wx + len, wy)
    await p.mouse.move(a.x, a.y)
    await p.mouse.down()
    for (let i = 1; i <= 8; i++) await p.mouse.move(a.x + ((b.x - a.x) * i) / 8, a.y + Math.sin(i) * 3)
    await p.mouse.up()
  }
  const midY = page.y + 300
  await stroke(page.x + 30, midY)
  await stroke(page.x + page.w - 80, midY)
  await sleep(300)
  check('폭 맞춤(100%)에서 좌우가 다 보이면 미니맵이 숨는다', !(await visible()))

  // 페이지 가운데를 4배로 확대 — 좌우 끝의 획이 화면 밖으로
  await p.evaluate((midY) => {
    const e = (window as unknown as W).inkpad
    const r = e.layout.rects.get(e.pages[0].id)
    const W = e.root.clientWidth
    const H = e.root.clientHeight
    e.cam.zoom = e.fitWidthZoom() * 4
    e.cam.x = r.x + r.w / 2 - W / 2 / e.cam.zoom
    e.cam.y = midY - H / 2 / e.cam.zoom
    e.onCameraMoved()
  }, midY)
  await sleep(300)
  check('확대해 좌우가 잘리면 미니맵이 나타난다', await visible())

  // 막대: 파란 '보이는 부분' 구간의 왼쪽·오른쪽 바깥에 진한 눈금(화면 밖 필기)이 있다
  const pic = await mm.locator('canvas').evaluate((c) => {
    const cv = c as HTMLCanvasElement
    const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data
    const y = Math.floor(cv.height / 2)
    let bx0 = cv.width
    let bx1 = 0
    const dark: number[] = []
    for (let x = 0; x < cv.width; x++) {
      const i = (y * cv.width + x) * 4
      const [r, g, b, a] = [d[i], d[i + 1], d[i + 2], d[i + 3]]
      if (a > 200 && r < 40 && g < 40 && b < 60) dark.push(x)
      else if (b > r + 60) {
        bx0 = Math.min(bx0, x)
        bx1 = Math.max(bx1, x)
      }
    }
    return { w: cv.width, h: cv.height, bx0, bx1, left: dark.filter((x) => x < bx0).length, right: dark.filter((x) => x > bx1).length }
  })
  check('막대: 화면 밖 왼쪽·오른쪽 필기가 파란 구간 바깥에 진한 눈금으로', pic.left > 0 && pic.right > 0 && pic.bx0 > 0 && pic.bx1 < pic.w - 1, JSON.stringify(pic))
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-zoom.png') })
  const area = (await p.locator('.editor-area').boundingBox())!
  const mb = (await mm.boundingBox())!
  check('미니맵: 왼쪽 위의 가는 막대', mb.x - area.x < 40 && mb.y - area.y < 120 && mb.width <= 172 && mb.height <= 24, JSON.stringify({ mb, area }))

  // 미니맵 위에서 긋기 — 아무 반응 없이 그 자리에 필기된다, 긋는 동안은 흐려진다
  const before = await p.evaluate(() => (window as unknown as W).inkpad.scene.size)
  const sx = mb.x + mb.width / 2
  const sy = mb.y + mb.height / 2
  await p.mouse.move(sx, sy)
  await p.mouse.down()
  for (let i = 1; i <= 6; i++) await p.mouse.move(sx + i * 6, sy + i * 2)
  const faded = await mm.evaluate((el) => el.classList.contains('is-faded'))
  await p.mouse.up()
  await sleep(100)
  const drew = await p.evaluate(
    ([sx, sy]) => {
      const e = (window as unknown as W).inkpad
      const b = e.root.getBoundingClientRect()
      const rec = [...e.scene.recs.values()].pop()
      const want = { x: (sx - b.left) / e.cam.zoom + e.cam.x, y: (sy - b.top) / e.cam.zoom + e.cam.y }
      const got = { x: rec.stroke.points[0] * rec.os + rec.ox, y: rec.stroke.points[1] * rec.os + rec.oy }
      return { n: e.scene.size, dx: (got.x - want.x) * e.cam.zoom, dy: (got.y - want.y) * e.cam.zoom }
    },
    [sx, sy] as const
  )
  check('미니맵 위에 그어도 그 자리에 평소처럼 필기된다', drew.n === before + 1 && Math.abs(drew.dx) <= 1 && Math.abs(drew.dy) <= 1, JSON.stringify(drew))
  check('미니맵 아래에서 쓰는 동안은 흐려진다', faded)
  await sleep(900)
  check('…다 쓰고 나면 다시 또렷해진다', !(await mm.evaluate((el) => el.classList.contains('is-faded'))))

  // 도구창을 왼쪽 위로 — 미니맵이 겹치지 않게 비켜 선다
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setToolbarPos('top-left'))
  await sleep(900)
  const bar = (await p.locator('.ft-bar').boundingBox())!
  const mb2 = (await mm.boundingBox())!
  const overlap = mb2.x < bar.x + bar.width && mb2.x + mb2.width > bar.x && mb2.y < bar.y + bar.height && mb2.y + mb2.height > bar.y
  check('도구창이 왼쪽 위에 있으면 미니맵이 겹치지 않게 비켜 선다', !overlap, JSON.stringify({ bar, mb2 }))
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setToolbarPos('top'))

  // 설정에서 끄기
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setSettings({ minimap: false }))
  await sleep(150)
  check('설정에서 끄면 미니맵이 없다', (await mm.count()) === 0)
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setSettings({ minimap: true }))

  // 무한 캔버스: 화면 밖 왼쪽에 필기가 있으면 나온다
  const inf = await p.evaluate(async () => {
    const r = await import('/src/storage/repo.ts')
    return (await r.createDocument({ title: '무한 미니맵', mode: 'infinite', folderId: null, pages: [] })).id
  })
  await openEditor(p, base, inf)
  await sleep(800)
  await stroke(0, 0, 60)
  await sleep(150)
  const hiddenFirst = !(await visible())
  await p.evaluate(() => {
    const e = (window as unknown as W).inkpad
    e.cam.x += 2000 // 필기가 왼쪽 화면 밖으로
    e.onCameraMoved()
  })
  await sleep(300)
  check('무한 캔버스: 필기가 다 보이면 숨고, 화면 밖 왼쪽에 있으면 나타난다', hiddenFirst && (await visible()))
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT })
  await p.context().close()
}
