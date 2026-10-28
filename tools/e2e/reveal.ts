// 노트 열기·닫기 크로스페이드 — 홈(라이브러리)에서 노트를 열면 라이브러리 위로 편집 화면이 서서히 나타나고,
// 돌아가면 편집 화면이 라이브러리 위에서 서서히 사라진다. 그동안 바뀌기 전 화면을 잠깐 남겨 겹쳐 바꾼다.
// (예전에는 원형 리빌·카드 이동이었다)
import type { Page } from 'playwright'
import { createDoc, device, logsOf, sleep, type Ctx } from './lib.ts'

const now = '.pane-main:not(.pane-leaving)'
const opacityOf = (p: Page, sel: string) => p.evaluate((sel) => { const el = document.querySelector(sel); return el ? Number(getComputedStyle(el).opacity) : null }, sel)

export default async function reveal(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  const shot = process.env.REVEAL_SHOTS
  const snap = async (name: string) => shot && (await p.screenshot({ path: `${shot}/${name}.png` }))
  await createDoc(p, '페이드 노트', 2)
  const other = await createDoc(p, '다른 노트')
  await p.goto(base + '/')
  const card = p.locator('.doc-card', { hasText: '페이드 노트' })
  await card.waitFor()

  // ── 열기 ──
  await card.locator('.doc-thumb').click()
  await p.locator('.doc-card.is-revealed').getByRole('button', { name: '편집모드' }).waitFor()
  await sleep(450)
  await p.locator('.doc-card.is-revealed').getByRole('button', { name: '편집모드' }).click()
  // 표본 시각은 부하에 따라 밀리므로 칸에 걸린 애니메이션 자체도 본다
  const anim = await p.evaluate((sel) => {
    const a = document.querySelector(sel)?.getAnimations()[0]
    const k = a ? ((a.effect as KeyframeEffect).getKeyframes() as { opacity?: string }[]) : []
    return a ? { from: k[0]?.opacity, to: k.at(-1)?.opacity, ms: Number((a.effect as KeyframeEffect).getTiming().duration) } : null
  }, now)
  const ops: number[] = []
  let under = 0
  for (let i = 0; i < 6; i++) {
    const o = await opacityOf(p, now)
    if (o !== null) ops.push(o)
    if (i === 0) under = await p.locator('.pane-leaving .library').count()
    if (i === 2) await snap('1-open-mid')
    await sleep(40)
  }
  check('열기: 라이브러리는 그동안 아래에 그대로', under === 1)
  check('…편집 화면이 서서히 나타난다', anim?.from === '0' && anim.to === '1' && anim.ms >= 200 && ops.some((o) => o < 0.95), JSON.stringify({ anim, ops }))
  check('…예전 원형 리빌·카드 이동은 없다', (await p.evaluate((sel) => getComputedStyle(document.querySelector(sel)!).clipPath, now)) === 'none' && (await p.locator('.doc-fly, .doc-open-ghost').count()) === 0)
  await sleep(500)
  const opened = await p.evaluate(() => ({ leaving: document.querySelectorAll('.pane-leaving').length, op: getComputedStyle(document.querySelector('.pane-main')!).opacity, editor: document.querySelectorAll('.pane-main .editor').length, library: document.querySelectorAll('.library').length, enter: document.querySelector('.editor.doc-enter') !== null }))
  check('열기가 끝나면 라이브러리를 치우고 편집 화면만', opened.leaving === 0 && opened.op === '1' && opened.editor === 1 && opened.library === 0, JSON.stringify(opened))
  check('…편집 화면 자체의 페이드업은 겹치지 않는다', !opened.enter)

  // ── 닫기 ──
  await p.click(`${now} [aria-label="문서 목록"]`)
  const fades: number[] = []
  let over = 0
  for (let i = 0; i < 6; i++) {
    const o = await opacityOf(p, '.pane-leaving')
    if (o !== null) fades.push(o)
    if (i === 0) over = await p.locator('.pane-leaving .editor').count()
    if (i === 2) await snap('2-close-mid')
    await sleep(35)
  }
  check('닫기: 편집 화면이 라이브러리 위에 남아', over === 1)
  check('…서서히 사라진다', fades.length >= 2 && fades.some((o) => o > 0.05 && o < 0.95), JSON.stringify(fades))
  await sleep(600)
  const closed = await p.evaluate(() => ({ leaving: document.querySelectorAll('.pane-leaving').length, editor: document.querySelectorAll('.editor').length, library: document.querySelectorAll('.pane-main .library').length }))
  check('닫기가 끝나면 편집 화면을 치운다', closed.leaving === 0 && closed.editor === 0 && closed.library === 1, JSON.stringify(closed))

  // ── 탭 전환(노트 → 노트)은 겹쳐 바꾸지 않는다 ──
  await p.evaluate(async (id) => (await import('/src/app/store.ts')).useUI.getState().navigate({ name: 'editor', docId: id }), other)
  await sleep(600)
  const first = await p.evaluate(async () => (await import('/src/storage/repo.ts')).listDocuments().then((ds) => ds.find((d) => d.title === '페이드 노트')!.id))
  await p.evaluate(async (id) => (await import('/src/app/store.ts')).useUI.getState().navigate({ name: 'editor', docId: id }), first)
  await sleep(30)
  check('노트 → 노트(탭 전환)는 남겨 두는 칸 없이', (await p.locator('.pane-leaving').count()) === 0)
  await sleep(400)

  // ── 모션 끄기 ──
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setSettings({ motion: 'off' }))
  await p.click(`${now} [aria-label="문서 목록"]`)
  await sleep(30)
  check('모션 끄기: 닫을 때 남겨 두지 않는다', (await p.locator('.pane-leaving').count()) === 0)
  await card.locator('.doc-thumb').click()
  await p.locator('.doc-card.is-revealed').getByRole('button', { name: '편집모드' }).click()
  await sleep(30)
  check('모션 끄기: 열 때도 바로', (await p.locator('.pane-leaving').count()) === 0 && (await opacityOf(p, now)) === 1)
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setSettings({ motion: 'auto' }))

  check('크로스페이드: 콘솔 오류 없음', !logsOf(p).some((l) => /error/i.test(l) && !/favicon|401|Failed to load resource/.test(l)), logsOf(p).join('\n'))
  await p.context().close()
}
