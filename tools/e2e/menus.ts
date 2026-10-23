// 떠 있는 메뉴(ui/Menu.tsx)는 화면 안에 다 보인다 — 카드가 많아 맨 아랫줄 카드의 ⋯ 메뉴를 열어도 아래가 잘리지 않는다
import { createDoc, device, sleep, type Ctx } from './lib.ts'

export default async function menus(ctx: Ctx) {
  const { check } = ctx
  const p = await device(ctx)
  for (let i = 0; i < 30; i++) await createDoc(p, `노트 ${String(i + 1).padStart(2, '0')}`)
  for (const [w, h] of [
    [1200, 900],
    [820, 1180],
    [390, 700]
  ]) {
    await p.setViewportSize({ width: w, height: h })
    await p.reload()
    await p.waitForSelector('.doc-more')
    await sleep(600)
    const more = p.locator('.doc-more').last()
    // 사용자처럼 목록을 끝까지 굴린다 (scrollIntoView는 앱 바깥 문서까지 밀어 올려 재현이 안 된다)
    await p.mouse.move(w / 2, h / 2)
    for (let i = 0; i < 20; i++) await p.mouse.wheel(0, 600)
    await sleep(500)
    // 버튼이 화면 맨 아래에 오도록 — 아래 공간이 가장 모자란 경우
    const btn = await more.boundingBox()
    await more.click()
    const menu = p.locator('.menu[role="menu"]')
    await menu.waitFor()
    const r = await menu.boundingBox()
    const items = await menu.locator('.menu-item').count()
    const last = await menu.locator('.menu-item').last().boundingBox()
    // 화면 밖으로 나간 메뉴에 focus()하면 Chromium은 앱 전체를 밀어 올리고(Safari는 그냥 잘린다) — 밀리지도 않아야 한다
    // 스크롤되면 안 되는 바깥 상자(문서·#root·그 바로 아래)가 밀렸는지 — 목록 자체의 스크롤은 뺀다
    const shifted = await p.evaluate(() => {
      const outer = [document.scrollingElement, document.body, document.getElementById('root'), ...Array.from(document.getElementById('root')?.children ?? [])]
      return outer.reduce((n, el) => n + (el?.scrollTop ?? 0), 0)
    })
    const fits = !!r && !!last && r.y >= 0 && r.x >= 0 && r.x + r.width <= w && r.y + r.height <= h && last.y + last.height <= h
    check(`메뉴: ${w}×${h} 맨 아랫줄 카드의 ⋯ 메뉴가 화면 안에 다 보이고 앱이 밀려 올라가지 않는다 (항목 ${items}개)`, fits && shifted === 0, JSON.stringify({ btn, r, last, shifted }))
    if (process.env.SHOT) await p.screenshot({ path: `${process.env.SHOT}-${w}.png` })
    await p.keyboard.press('Escape')
  }
  await p.context().close()
}
