// 노트 열기·닫기 원형 리빌 — 라이브러리 카드에서 '편집'을 누르면 편집 화면이 그 카드 한가운데서 원으로 퍼지고
// (라이브러리는 그동안 아래에 그대로), 뒤로 가면 편집 화면이 그 카드로 원을 그리며 줄어든다.
// 예전에는 작은 썸네일을 화면 전체로 키운 고스트가 흐릿하게 덮었다가 겹쳐 사라졌다.
import type { Page } from 'playwright'
import { addStroke, createDoc, device, logsOf, sleep, type Ctx } from './lib.ts'

/** 지금 칸(남겨 둔 칸 말고)의 clip-path 원 — 반지름·중심 */
const clipOf = (p: Page, sel: string) =>
  p.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel)
    if (!el) return null
    const m = getComputedStyle(el).clipPath.match(/circle\(([\d.]+)px at ([\d.]+)px ([\d.]+)px\)/)
    const box = el.getBoundingClientRect()
    return m ? { r: +m[1], x: +m[2] + box.left, y: +m[3] + box.top } : null
  }, sel)

export default async function reveal(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  const shot = process.env.REVEAL_SHOTS
  const snap = async (name: string) => shot && (await p.screenshot({ path: `${shot}/${name}.png` }))
  await createDoc(p, '원 노트', 2)
  await createDoc(p, '다른 노트')
  await p.goto(base + '/')
  const card = p.locator('.doc-card', { hasText: '원 노트' })
  await card.waitFor()

  // ── 열기 ──
  await card.locator('.doc-thumb').click()
  await p.locator('.doc-card.is-revealed').getByRole('button', { name: '편집모드' }).waitFor()
  await sleep(450)
  const thumb = (await card.locator('.doc-thumb').boundingBox())! // 판이 뜬 카드 그대로 — 누른 순간의 자리
  const cx = thumb.x + thumb.width / 2
  const cy = thumb.y + thumb.height / 2
  await p.locator('.doc-card.is-revealed').getByRole('button', { name: '편집모드' }).click()
  const now = '.pane-main:not(.pane-leaving)'
  const samples: { r: number; x: number; y: number }[] = []
  let under = 0
  for (let i = 0; i < 6; i++) {
    const c = await clipOf(p, now)
    if (c) samples.push(c)
    if (i === 0) under = await p.locator('.pane-leaving .library').count()
    if (i === 2) await snap('1-open-mid')
    await sleep(60)
  }
  check('열기: 라이브러리는 그동안 아래에 그대로', under === 1)
  check('열기: 편집 화면이 원으로 드러난다', samples.length >= 2, JSON.stringify(samples))
  const c0 = samples[0]
  check('…원의 중심은 누른 카드 한가운데', !!c0 && Math.abs(c0.x - cx) < 2 && Math.abs(c0.y - cy) < 2, JSON.stringify({ c0, cx, cy }))
  check('…원이 점점 커진다', samples.every((s, i) => i === 0 || s.r >= samples[i - 1].r) && samples.at(-1)!.r > samples[0].r + 50, JSON.stringify(samples.map((s) => Math.round(s.r))))
  check('…예전 고스트는 없다', (await p.locator('.doc-open-ghost').count()) === 0)
  await sleep(700)
  const settled = await p.evaluate(() => ({
    leaving: document.querySelectorAll('.pane-leaving').length,
    clip: getComputedStyle(document.querySelector('.pane-main')!).clipPath,
    editor: document.querySelectorAll('.pane-main .editor').length,
    library: document.querySelectorAll('.library').length
  }))
  check('열기가 끝나면 남겨 둔 라이브러리를 치우고 편집 화면만', settled.leaving === 0 && settled.clip === 'none' && settled.editor === 1 && settled.library === 0, JSON.stringify(settled))
  await snap('2-open-done')

  // ── 닫기 ──
  await p.click(`${now} [aria-label="문서 목록"]`)
  await sleep(30)
  const over = await p.locator('.pane-leaving .editor').count()
  check('닫기: 편집 화면이 위에 남아 있다가', over === 1)
  const shrink: { r: number; x: number; y: number }[] = []
  for (let i = 0; i < 10 && shrink.length < 4; i++) {
    const c = await clipOf(p, '.pane-leaving')
    if (c) shrink.push(c)
    if (shrink.length === 2) await snap('3-close-mid')
    await sleep(50)
  }
  const s0 = shrink[0]
  check('…그 카드로 원이 줄어든다', shrink.length >= 2 && shrink.at(-1)!.r < shrink[0].r - 50, JSON.stringify(shrink.map((s) => Math.round(s.r))))
  await sleep(1200) // 다 줄어든 뒤 카드의 settle까지 끝나게 — 그때의 카드 자리와 견준다
  const back = (await p.locator('.doc-card', { hasText: '원 노트' }).locator('.doc-thumb').boundingBox())!
  check('…원의 중심은 그 카드 한가운데', !!s0 && Math.abs(s0.x - (back.x + back.width / 2)) < 2 && Math.abs(s0.y - (back.y + back.height / 2)) < 2, JSON.stringify({ s0, back }))
  const closed = await p.evaluate(() => ({ leaving: document.querySelectorAll('.pane-leaving').length, editor: document.querySelectorAll('.editor').length, target: 0 }))
  check('닫기가 끝나면 편집 화면을 치운다', closed.leaving === 0 && closed.editor === 0, JSON.stringify(closed))
  check('…남은 복귀 자리가 없다', await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().returnTarget === null))

  // ── 카드 없이 열기(탭·빠른 전환)는 원형 리빌이 아니다 ──
  const other = await p.evaluate(async () => (await import('/src/storage/repo.ts')).listDocuments().then((ds) => ds.find((d) => d.title === '다른 노트')!.id))
  await p.evaluate(async (id) => (await import('/src/app/store.ts')).useUI.getState().navigate({ name: 'editor', docId: id }), other)
  await sleep(40)
  check('카드 없이 열면: 남겨 두는 칸 없이 바로', (await p.locator('.pane-leaving').count()) === 0 && (await clipOf(p, now)) === null)
  await sleep(300)

  // ── 모션 끄기 ──
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setSettings({ motion: 'off' }))
  await p.click(`${now} [aria-label="문서 목록"]`)
  await sleep(30)
  check('모션 끄기: 닫을 때 남겨 두지 않는다', (await p.locator('.pane-leaving').count()) === 0)
  await card.locator('.doc-thumb').click()
  await p.locator('.doc-card.is-revealed').getByRole('button', { name: '편집모드' }).click()
  await sleep(30)
  check('모션 끄기: 열 때도 바로', (await p.locator('.pane-leaving').count()) === 0 && (await clipOf(p, now)) === null)
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setSettings({ motion: 'auto' }))

  check('원형 리빌: 콘솔 오류 없음', !logsOf(p).some((l) => /error/i.test(l) && !/favicon|401|Failed to load resource/.test(l)), logsOf(p).join('\n'))
  await p.context().close()
  await cardMode(ctx)
}

type Box = { left: number; top: number; width: number; height: number }
const near = (a: Box | null, b: Box | null, px = 2) =>
  !!a && !!b && Math.abs(a.left - b.left) < px && Math.abs(a.top - b.top) < px && Math.abs(a.width - b.width) < px

/** 설정 > 노트 열기 > 카드 이동 — 카드 미리보기가 첫 페이지 자리로 날아가 그 페이지가 되고, 닫으면 카드로 돌아간다 */
async function cardMode(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  const shot = process.env.REVEAL_SHOTS
  const snap = async (name: string) => shot && (await p.screenshot({ path: `${shot}/${name}.png` }))
  const D = await createDoc(p, '날 노트', 2)
  await addStroke(p, D, 's1')
  await p.evaluate(async (id) => (await import('/src/io/docThumb.ts')).regenerateThumbnail(id), D)
  const T = await p.evaluate(async () => (await (await import('/src/storage/repo.ts')).createDocument({ title: '글 문서', mode: 'text', folderId: null, pages: [] })).id)
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setSettings({ openMotion: 'card' }))
  await p.goto(base + '/')
  const card = p.locator('.doc-card', { hasText: '날 노트' })
  await card.locator('.doc-thumb img').waitFor()
  const openFrom = async (title: string) => {
    const c = p.locator('.doc-card', { hasText: title })
    await c.locator('.doc-thumb').click()
    await p.locator('.doc-card.is-revealed').getByRole('button', { name: '편집모드' }).waitFor()
    await sleep(450)
    const box = await c.locator('.doc-thumb').evaluate((e) => e.getBoundingClientRect().toJSON() as Box)
    await p.locator('.doc-card.is-revealed').getByRole('button', { name: '편집모드' }).click()
    return box
  }
  const ghost = () =>
    p.evaluate(() => {
      const g = document.querySelector<HTMLElement>('.doc-fly')
      if (!g) return null
      const a = g.getAnimations()[0]
      const k = a ? ((a.effect as KeyframeEffect).getKeyframes() as { transform?: string }[]) : []
      return { placed: { left: parseFloat(g.style.left), top: parseFloat(g.style.top), width: parseFloat(g.style.width), height: parseFloat(g.style.height) }, now: g.getBoundingClientRect().toJSON() as Box, img: g.style.backgroundImage, frames: k.map((f) => f.transform ?? '') }
    })
  const pageRect = () => p.evaluate(() => (window as unknown as { inkpad?: { pageScreenRect: (i?: number) => DOMRect | null } }).inkpad?.pageScreenRect(0)?.toJSON() as Box | null)

  // ── 열기 ──
  const thumb = await openFrom('날 노트')
  let first: Awaited<ReturnType<typeof ghost>> = null
  let flying = null as Awaited<ReturnType<typeof ghost>>
  for (let i = 0; i < 20 && !flying?.frames.length; i++) {
    const g = await ghost()
    if (g && !first) first = g
    if (g?.frames.length) flying = g
    await sleep(25)
  }
  await snap('4-card-open-mid')
  check('카드 이동(열기): 카드 미리보기 그림으로 고스트가 뜬다', !!first && first.img.includes('blob:'), JSON.stringify(first))
  check('…카드 자리에서 출발한다', !!first && near(first.now, thumb), JSON.stringify({ first: first?.now, thumb }))
  check('…원래 카드 미리보기는 비워 둔다', (await p.locator('.pane-leaving .doc-card.is-flying').count()) === 1)
  await sleep(900)
  const page = await pageRect()
  check('…첫 페이지 자리에 내려앉는다', !!flying && near(flying.placed, page), JSON.stringify({ placed: flying?.placed, page }))
  const opened = await p.evaluate(() => ({ ghost: document.querySelectorAll('.doc-fly').length, leaving: document.querySelectorAll('.pane-leaving').length, op: getComputedStyle(document.querySelector('.pane-main')!).opacity }))
  check('…끝나면 고스트·남겨 둔 라이브러리를 치우고 편집 화면이 다 보인다', opened.ghost === 0 && opened.leaving === 0 && opened.op === '1', JSON.stringify(opened))

  // ── 닫기 ──
  const pageBefore = await pageRect()
  await p.click('.pane-main:not(.pane-leaving) [aria-label="문서 목록"]')
  let back = null as Awaited<ReturnType<typeof ghost>>
  for (let i = 0; i < 30 && !back?.frames.length; i++) {
    back = await ghost()
    await sleep(20)
  }
  await snap('5-card-close-mid')
  check('카드 이동(닫기): 보던 페이지 자리에서 고스트가 출발한다', !!back && near(back.placed, pageBefore), JSON.stringify({ placed: back?.placed, pageBefore }))
  check('…돌아갈 카드 미리보기는 비워 둔다', (await p.locator('.pane-main:not(.pane-leaving) .doc-card.is-flying').count()) === 1)
  await sleep(1300)
  const home = await card.locator('.doc-thumb').evaluate((e) => e.getBoundingClientRect().toJSON() as Box)
  const m = back?.frames.at(-1)?.match(/translate\(([-\d.e+]+)px, ([-\d.e+]+)px\) scale\(([\d.e+-]+)\)/)
  const land = m && back ? { left: back.placed.left + +m[1], top: back.placed.top + +m[2], width: back.placed.width * +m[3], height: 0 } : null
  check('…그 카드 자리에 내려앉는다', near(land, home), JSON.stringify({ land, home, frames: back?.frames }))
  const closed = await p.evaluate(() => ({ ghost: document.querySelectorAll('.doc-fly').length, leaving: document.querySelectorAll('.pane-leaving').length, flying: document.querySelectorAll('.is-flying').length }))
  check('…끝나면 고스트를 치우고 카드를 다시 보인다', closed.ghost === 0 && closed.leaving === 0 && closed.flying === 0, JSON.stringify(closed))

  // ── 페이지가 없는 문서는 원형 리빌로 ──
  await openFrom('글 문서')
  let circled = false
  for (let i = 0; i < 30 && !circled; i++) {
    circled = await p.evaluate(() => /circle/.test(getComputedStyle(document.querySelector('.pane-main:not(.pane-leaving)')!).clipPath))
    await sleep(30)
  }
  check('카드 이동: 페이지가 없는 문서는 원형 리빌로', circled)
  await sleep(900)
  check('…끝나면 고스트가 남지 않는다', (await p.locator('.doc-fly, .pane-leaving').count()) === 0)
  void T

  check('카드 이동: 콘솔 오류 없음', !logsOf(p).some((l) => /error/i.test(l) && !/favicon|401|Failed to load resource/.test(l)), logsOf(p).join('\n'))
  await p.context().close()
}
