// 노트 열기·닫기 원형 리빌 — 라이브러리 카드에서 '편집'을 누르면 편집 화면이 그 카드 한가운데서 원으로 퍼지고
// (라이브러리는 그동안 아래에 그대로), 뒤로 가면 편집 화면이 그 카드로 원을 그리며 줄어든다.
// 예전에는 작은 썸네일을 화면 전체로 키운 고스트가 흐릿하게 덮었다가 겹쳐 사라졌다.
import type { Page } from 'playwright'
import { createDoc, device, logsOf, sleep, type Ctx } from './lib.ts'

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
}
