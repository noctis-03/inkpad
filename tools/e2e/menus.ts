// 떠 있는 메뉴(ui/Menu.tsx)는 화면 안에 다 보인다 — 카드가 많아 맨 아랫줄 카드의 ⋯ 메뉴를 열어도 아래가 잘리지 않는다
// 탭 바·듀얼(옆 칸 왼쪽/오른쪽)에서도 누른 버튼 바로 아래에 뜬다 — 카드 ⋯ · 동기화(구름) · 노트 ⋯ · 노트 동기화 칩
import { createFakeDrive } from './fake-drive.ts'
import { createDoc, device, sleep, type Ctx } from './lib.ts'

export default async function menus(ctx: Ctx) {
  const { check } = ctx
  const p = await device(ctx, { drive: createFakeDrive() }) // 노트 동기화 칩은 클라우드에 연결됐을 때만 보인다
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

  // ── 탭 바·듀얼에서도 버튼 바로 아래 ──
  await p.setViewportSize({ width: 1200, height: 900 })
  const A = await createDoc(p, '노트 메뉴')
  const app = await p.evaluate(async () => (await (await import('/src/sync/apps.ts')).addApp(new File(['<title>옆 앱</title>'], 'a.html', { type: 'text/html' }), null)).app.id)
  const ui = (fn: string) => p.evaluate(async (fn) => new Function('s', fn)((await import('/src/app/store.ts')).useUI.getState()), fn)
  // 버튼 오른쪽 아래 모서리에 메뉴 오른쪽 위 모서리를 붙인다(화면 안으로 밀 때만 어긋난다)
  const anchored = async (btnSel: string, label: string) => {
    const btn = p.locator(btnSel).first()
    const b = (await btn.boundingBox())!
    await btn.click()
    const menu = p.locator('.menu[role="menu"]')
    await menu.waitFor()
    await sleep(100)
    const m = (await menu.boundingBox())!
    const back = await p.locator('.menu-backdrop').evaluate((e) => e.getBoundingClientRect().toJSON())
    await p.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
    const pinned = m.x > 8.5 && m.x + m.width < 1191.5 ? Math.abs(m.x + m.width - (b.x + b.width)) < 1.5 : true
    const ok = Math.abs(m.y - (b.y + b.height + 4)) < 1.5 && pinned && back.width === 1200 && back.height === 900 && back.x === 0 && back.y === 0
    return { ok, detail: `${label} ${JSON.stringify({ btn: [b.x + b.width, b.y + b.height], menu: [m.x + m.width, m.y], back: [back.x, back.y, back.width, back.height] })}` }
  }
  await ui(`s.navigate({ name: 'app', appId: '${app}' }); s.openSplit({ name: 'app', appId: '${app}' })`)
  for (const side of ['right', 'left']) {
    if (side === 'left') await ui(`if (s.splitSide !== 'left') s.swapSplit()`)
    await ui(`s.navigate({ name: 'library' })`)
    await p.waitForSelector('.panes.is-split .pane-main .library .doc-more')
    // 위의 맨 아랫줄 검사로 내려 둔 목록을 맨 위로 — 첫 카드가 화면 안에 오게
    const lb = (await p.locator('.pane-main .library').boundingBox())!
    await p.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2)
    for (let i = 0; i < 20; i++) await p.mouse.wheel(0, -800)
    await sleep(500)
    const r = [await anchored('.pane-main .doc-more', '카드 ⋯'), await anchored('.pane-main .sync-btn', '동기화')]
    await ui(`s.navigate({ name: 'editor', docId: '${A}' })`)
    await p.waitForSelector('.pane-main .editor .toolbar-doc')
    await sleep(500)
    r.push(await anchored('.pane-main .toolbar-doc [aria-label="더보기"]', '노트 ⋯'), await anchored('.pane-main .note-sync', '노트 동기화'))
    check(`메뉴: 듀얼(옆 칸 ${side === 'left' ? '왼쪽' : '오른쪽'})에서도 누른 버튼 바로 아래에 뜬다 — 카드·동기화·노트 ⋯·노트 동기화`, r.every((x) => x.ok), r.filter((x) => !x.ok).map((x) => x.detail).join(' | '))
  }
  // 라이브러리 안의 시트(동기화 등)도 화면 전체를 덮는다 — 칸 안에 갇히지 않는다
  await ui(`s.navigate({ name: 'library' })`)
  await p.waitForSelector('.pane-main .library')
  await sleep(400)
  await p.click('.pane-main .sync-btn')
  await p.locator('.menu').getByRole('menuitem').first().click()
  const sheetBack = await p.locator('.modal-backdrop').first().evaluate((e) => e.getBoundingClientRect().toJSON()).catch(() => null)
  check('메뉴: 듀얼에서 라이브러리 시트도 화면 전체를 덮는다', !!sheetBack && sheetBack.x === 0 && sheetBack.y === 0 && sheetBack.width === 1200 && sheetBack.height === 900, JSON.stringify(sheetBack))
  await p.context().close()
}
