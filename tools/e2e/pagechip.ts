// 페이지 칩 — 페이지 노트에서 페이지마다 바깥 왼쪽 위(회색 여백)에 '번호 ⋯'. 누르면 그 페이지 메뉴
//  - 페이지 위에는 얹지 않는다 (왼쪽 여백 → 모자라면 페이지 위쪽 틈 → 그래도 모자라면 숨김)
//  - 폭 맞춤은 넓은 화면에서 칩 자리만큼 양옆을 비운다
//  - 긴 페이지를 내려 읽는 동안 화면 위에 붙어 따라온다
//  - '페이지 n' 아래에 버튼 한 줄: ⋯ 페이지 메뉴 · 100(폭 맞춤 배율 = 페이지 노트의 100%) · 화면에 맞춤(페이지 전체)
//  - 칩은 배율과 관계없이 같은 크기, 많이 축소하면 단계별로 작게
//  - 메뉴: 이미지로·AI로 보내기(상단 ⋯에서 옮겨 옴) + 페이지 더하기·복제·보조 용지·순서·삭제
import type { Page } from 'playwright'
import { createDoc, device, logsOf, openEditor, sleep, type Ctx } from './lib.ts'

type Box = { l: number; t: number; r: number; b: number }
/** 화면에 보이는 칩과 그 페이지의 화면 사각형 (#canvas-root 기준이 아닌 창 기준) */
const layout = (p: Page) =>
  p.evaluate(() => {
    const e = (window as unknown as { inkpad: { cam: { x: number; y: number; zoom: number }; pages: { id: string }[]; layout: { rects: Map<string, { x: number; y: number; w: number; h: number }> }; sheets: { id: string }[] } }).inkpad
    const host = document.querySelector('#canvas-root')!.getBoundingClientRect()
    const { x, y, zoom } = e.cam
    const box = (r: { x: number; y: number; w: number; h: number }) => ({ l: host.left + (r.x - x) * zoom, t: host.top + (r.y - y) * zoom, r: host.left + (r.x + r.w - x) * zoom, b: host.top + (r.y + r.h - y) * zoom })
    const chips = [...document.querySelectorAll<HTMLElement>('.page-chip')]
      .filter((c) => c.style.display !== 'none')
      .map((c) => {
        const r = c.getBoundingClientRect()
        const m = c.querySelector('.page-chip-menu')!.getBoundingClientRect()
        return { i: Number(c.dataset.index), text: c.querySelector('.page-chip-label')?.textContent, chip: { l: r.left, t: r.top, r: r.right, b: r.bottom }, menu: { l: m.left, t: m.top, r: m.right, b: m.bottom } }
      })
    return {
      zoom,
      host: { l: host.left, t: host.top, r: host.right, b: host.bottom },
      pages: e.pages.map((pg) => box(e.layout.rects.get(pg.id)!)),
      sheets: e.sheets.map((s) => box(e.layout.rects.get(s.id)!)),
      chips
    }
  })
const overlaps = (a: Box, b: Box) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t

export default async function pagechip(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  const docId = await createDoc(p, '칩 노트', 3)
  await openEditor(p, base, docId)
  await sleep(500)

  // ── 자리: 첫 페이지 바깥 왼쪽 위, 페이지와 겹치지 않는다 ──
  let L = await layout(p)
  const c1 = L.chips.find((c) => c.i === 0)
  check('폭 맞춤: 넓은 화면은 칩 자리만큼 양옆을 비운다', L.pages[0].l - L.host.l >= 56, JSON.stringify({ host: L.host, page: L.pages[0] }))
  check('칩: 페이지 번호, 그 아래 메뉴 버튼', c1?.text === '페이지 1' && c1.menu.t >= c1.chip.t + 10, JSON.stringify(L.chips))
  check('…첫 페이지 바깥 왼쪽, 위 끝에 맞춰', !!c1 && c1.chip.r <= L.pages[0].l && Math.abs(c1.chip.t - L.pages[0].t) <= 1 && c1.chip.l >= L.host.l, JSON.stringify({ c1, page: L.pages[0] }))
  check('…어느 칩도 페이지 위에 얹히지 않는다', L.chips.every((c) => L.pages.every((pg) => !overlaps(c.chip, pg))), JSON.stringify(L))
  check('…누르기 쉬운 크기 (32px 이상)', !!c1 && c1.menu.b - c1.menu.t >= 32 && c1.menu.r - c1.menu.l >= 32)

  // ── 상단 ⋯에는 '이 페이지를 …'이 없다 (페이지 칩으로 옮김) ──
  await p.click('.toolbar-doc [aria-label="더보기"]')
  const top = await p.locator('.menu .menu-item').allTextContents()
  check('상단 ⋯: 이 페이지를 이미지로·AI로 보내기는 빠졌다', !top.some((t) => /이 페이지를|(이미지|AI)로 보내기/.test(t)), JSON.stringify(top))
  await p.keyboard.press('Escape')

  // ── 메뉴 ──
  await p.click('.page-chip[data-index="0"] .page-chip-menu')
  const items = await p.locator('.menu .menu-item').allTextContents()
  const want = ['이미지로 보내기', 'AI로 보내기', '앞에 새 페이지', '뒤에 새 페이지', '복제', '왼쪽에 보조 용지', '오른쪽에 보조 용지', '아래로', '삭제']
  check('메뉴: 이 페이지 보내기 + 페이지 다루기', want.every((w) => items.some((t) => t.trim() === w)) && !items.some((t) => t.trim() === '위로'), JSON.stringify(items))
  check('…메뉴 제목은 페이지 번호', (await p.locator('.menu .menu-label').textContent()) === '1페이지')
  const mb = await p.locator('.menu').boundingBox()
  check('…메뉴는 메뉴 버튼 아래에', !!mb && !!c1 && mb.y >= c1.menu.b - 1 && Math.abs(mb.x - c1.menu.l) < 12, JSON.stringify({ mb, c1 }))
  await p.locator('.menu').getByRole('menuitem', { name: '뒤에 새 페이지' }).click()
  await sleep(300)
  const n = await p.evaluate(() => (window as unknown as { inkpad: { pages: unknown[] } }).inkpad.pages.length)
  check('…뒤에 새 페이지 → 4쪽', n === 4 && (await p.locator('.page-chip').count()) === 4)

  // 둘째 칩 → 이미지로 보내기는 그 페이지
  await p.evaluate(() => (window as unknown as { inkpad: { scrollToPage: (i: number) => void } }).inkpad.scrollToPage(1))
  await sleep(400)
  await p.click('.page-chip[data-index="1"] .page-chip-menu')
  await p.locator('.menu').getByRole('menuitem', { name: '이미지로 보내기' }).click()
  await p.locator('.modal.send-image .send-image-preview img').waitFor({ timeout: 15000 })
  check('…이미지로 보내기는 칩의 페이지 (2쪽)', (await p.locator('.modal.send-image .send-image-preview img').getAttribute('alt')) === '2쪽')
  await p.keyboard.press('Escape')
  await p.click('.page-chip[data-index="1"] .page-chip-menu')
  await p.locator('.menu').getByRole('menuitem', { name: 'AI로 보내기' }).click()
  await p.locator('.modal.ai-send .send-image-preview img').waitFor({ timeout: 15000 })
  check('…AI로 보내기도 칩의 페이지', (await p.locator('.modal.ai-send .send-image-preview img').getAttribute('alt')) === '2쪽')
  await p.keyboard.press('Escape')
  await sleep(200)

  // ── 100(폭 맞춤 배율) · 화면에 맞춤(페이지 전체) ──
  type E = { cam: { x: number; y: number; zoom: number }; fitWidthZoom: () => number; zoomBy: (f: number) => void }
  const cam = () => p.evaluate(() => { const e = (window as unknown as { inkpad: E }).inkpad; return { ...e.cam, fit: e.fitWidthZoom() } })
  const btnTops = await p.locator('.page-chip[data-index="1"] .page-chip-btn').evaluateAll((bs) => bs.map((b) => Math.round(b.getBoundingClientRect().top)))
  check("버튼 셋은 '페이지 n' 아래 한 줄로", btnTops.length === 3 && new Set(btnTops).size === 1, JSON.stringify(btnTops))
  check('배율 표시: 폭 맞춤이 100%', (await p.locator('.page-indicator [aria-label="보기 옵션"]').textContent())?.trim() === '100%')
  await p.evaluate(() => (window as unknown as { inkpad: E }).inkpad.zoomBy(0.8))
  await sleep(100)
  await p.click('.page-chip[data-index="1"] [aria-label="배율 100% (폭 맞춤)"]')
  await sleep(150)
  let c = await cam()
  L = await layout(p)
  const pc = (L.pages[1].l + L.pages[1].r) / 2 - (L.host.l + L.host.r) / 2
  check('100: 폭 맞춤 배율로, 페이지는 가로 가운데', Math.abs(c.zoom - c.fit) < 1e-6 && Math.abs(pc) < 2, JSON.stringify({ c, pc }))
  check('…100 버튼이 켜진 모양, 배율 표시 100%', (await p.locator('.page-chip-layer[data-z100]').count()) === 1 && (await p.locator('.page-indicator [aria-label="보기 옵션"]').textContent())?.trim() === '100%')
  await p.click('.page-chip[data-index="1"] [aria-label="화면에 맞춤"]')
  await sleep(150)
  c = await cam()
  L = await layout(p)
  const pg = L.pages[1]
  check('화면에 맞춤: 페이지 한 장이 화면에 다 들어온다', c.zoom < c.fit && pg.t >= L.host.t - 1 && pg.b <= L.host.b + 1 && pg.l >= L.host.l && pg.r <= L.host.r, JSON.stringify({ c, pg, host: L.host }))
  check('…100 버튼은 꺼진 모양', (await p.locator('.page-chip-layer[data-z100]').count()) === 0)

  // ── 배율에 따라 칩 크기는 그대로, 많이 축소하면 단계별로 작게 ──
  const sizeAt = async (rel: number) => {
    await p.evaluate((rel) => { const e = (window as unknown as { inkpad: E }).inkpad; e.zoomBy((e.fitWidthZoom() * rel) / e.cam.zoom) }, rel)
    await sleep(100)
    const L2 = await layout(p)
    const b = await p.locator('.page-chip-layer .page-chip[data-index="1"] .page-chip-menu').boundingBox()
    return { size: await p.locator('.page-chip-layer').getAttribute('data-size'), w: b?.width, clean: L2.chips.every((ch) => L2.pages.every((pg) => !overlaps(ch.chip, pg))) }
  }
  const s100 = await sizeAt(1)
  const s60 = await sizeAt(0.6)
  const s30 = await sizeAt(0.3)
  check('칩 크기: 100%에서 32px, 축소하면 28 → 22px', s100.size === null && s100.w === 32 && s60.size === 's' && s60.w === 28 && s30.size === 'xs' && s30.w === 22, JSON.stringify({ s100, s60, s30 }))
  check('…어느 크기에서도 페이지 위에 얹히지 않는다', s100.clean && s60.clean && s30.clean)
  await p.evaluate(() => (window as unknown as { inkpad: { fitWidth: (p: number) => void } }).inkpad.fitWidth(0))
  await sleep(100)

  // ── 내려 읽는 동안: 위가 화면 밖으로 나간 페이지의 칩은 화면 위에 붙어 따라온다 ──
  await p.evaluate(() => {
    const e = (window as unknown as { inkpad: { cam: { y: number; zoom: number }; layout: { rects: Map<string, { y: number }> }; pages: { id: string }[]; onCameraMoved: () => void } }).inkpad
    e.cam.y = e.layout.rects.get(e.pages[0].id)!.y + 300
    e.onCameraMoved()
  })
  await sleep(100)
  L = await layout(p)
  const s1 = L.chips.find((c) => c.i === 0)
  check('내려 읽는 동안: 칩이 화면 위에 붙어 따라온다', !!s1 && L.pages[0].t < L.host.t && s1.chip.t >= L.host.t && s1.chip.t <= L.host.t + 8 && s1.chip.r <= L.pages[0].l, JSON.stringify({ s1, page: L.pages[0], host: L.host }))

  // ── 왼쪽에 보조 용지가 붙으면 그 바깥으로 비켜 선다 ──
  await p.evaluate(() => {
    const e = (window as unknown as { inkpad: { addSheet: (i: number, side: string) => void; fitAll: () => void } }).inkpad
    e.addSheet(0, 'left')
    e.fitAll()
  })
  await sleep(300)
  L = await layout(p)
  check('보조 용지: 칩이 왼쪽 용지와도 겹치지 않는다', L.sheets.length === 1 && L.chips.every((c) => L.sheets.every((s) => !overlaps(c.chip, s)) && L.pages.every((pg) => !overlaps(c.chip, pg))), JSON.stringify(L))

  // ── 휴대폰 폭: 여백이 없으면 페이지 위쪽 틈으로, 그래도 모자라면 숨긴다 — 페이지 위에는 얹지 않는다 ──
  await p.setViewportSize({ width: 390, height: 844 })
  await sleep(400)
  await p.evaluate(() => (window as unknown as { inkpad: { fitWidth: (k: boolean) => void } }).inkpad.fitWidth(false))
  await sleep(200)
  L = await layout(p)
  check('휴대폰: 칩이 페이지·용지 위에 얹히지 않는다', L.chips.every((c) => [...L.pages, ...L.sheets].every((b) => !overlaps(c.chip, b))), JSON.stringify(L))
  await p.mouse.move(195, 500)
  await p.mouse.wheel(0, 0) // 칩 레이어가 캔버스 휠을 막지 않는다 — 오류만 없으면 된다

  check('페이지 칩: 콘솔 오류 없음', !logsOf(p).some((l) => /error/i.test(l) && !/favicon|401|Failed to load resource/.test(l)), logsOf(p).join('\n'))
  await p.context().close()
}
