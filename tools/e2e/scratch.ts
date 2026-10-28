// 낙서 모드: 카드에서 '낙서모드'로 열면 쓸 수는 있지만 아무것도 저장하지 않는다 — 나가면 사라진다
import type { Page } from 'playwright'
import { addStroke, createDoc, device, drawStroke, logsOf, openEditor, sameSet, sleep, strokes, type Ctx } from './lib.ts'

const sceneSize = (p: Page) => p.evaluate(() => (window as unknown as { inkpad?: { scene: { size: number } } }).inkpad?.scene.size ?? -1)
const pendingOf = (p: Page, docId: string) => p.evaluate(async (D) => (await (await import('/src/sync/unchanged.ts')).pendingSeqsFor(D)).length, docId)
// 카드에서 열면 편집 화면이 서서히 나타나는 동안(.pane-leaving) 라이브러리가 아래 남아 있다 — 다 바뀐 뒤에 쓴다
const waitEngine = (p: Page) => p.waitForFunction(() => !!(window as unknown as { inkpad?: unknown }).inkpad && !document.querySelector('.doc-skeleton, .pane-leaving'), null, { timeout: 15000 })

export default async function scratch(ctx: Ctx) {
  const { base, check } = ctx
  const A = await device(ctx, { name: 'iPad' })
  const D = await createDoc(A, '낙서 노트')
  await addStroke(A, D, 'kept')
  const before = await pendingOf(A, D)

  // ── 카드에서 낙서모드로 연다 ──
  await A.goto(base + '/')
  await A.waitForSelector('.doc-card')
  await A.locator('.doc-card', { hasText: '낙서 노트' }).click()
  await sleep(500)
  if (process.env.MERGE_SHOT_DIR) await A.locator('.doc-card.is-revealed').screenshot({ path: `${process.env.MERGE_SHOT_DIR}/card-scratch.png` })
  await A.locator('.doc-card.is-revealed').getByRole('button', { name: '낙서모드' }).click()
  await waitEngine(A)
  check('낙서 모드: 안내가 보인다', (await A.locator('.scratch-banner').innerText()).includes('저장되지 않'))
  check('낙서 모드: 툴바에 "저장 안 됨"', (await A.locator('.save-state.scratch').count()) === 1)
  check('낙서 모드: 노트 동기화 칩·이름 바꾸기 없음', (await A.locator('.note-sync').count()) === 0 && (await A.locator('.doc-title-edit').count()) === 0)
  check('낙서 모드: 모두 지우기는 처음엔 꺼져 있다', await A.locator('.scratch-clear').isDisabled())

  // ── 쓸 수 있지만 저장되지 않는다 ──
  const n0 = await sceneSize(A)
  await drawStroke(A)
  await drawStroke(A, 80)
  await sleep(1200) // 평소라면 저장(0.5초)이 끝났을 시간
  if (process.env.MERGE_SHOT_DIR) await A.screenshot({ path: `${process.env.MERGE_SHOT_DIR}/scratch.png` })
  check('낙서 모드: 쓸 수 있다', (await sceneSize(A)) === n0 + 2, `${n0} → ${await sceneSize(A)}`)
  check('낙서 모드: DB에는 그대로', sameSet(await strokes(A, D), ['kept']))
  check('낙서 모드: 올리기 대기도 생기지 않는다', (await pendingOf(A, D)) === before)

  // ── 모두 지우기 = 처음 연 상태로 ──
  await A.locator('.scratch-clear').click()
  await waitEngine(A)
  await A.waitForFunction((n) => (window as unknown as { inkpad?: { scene: { size: number } } }).inkpad?.scene.size === n, n0, { timeout: 15000 })
  check('낙서 모드: 모두 지우기로 처음 상태', (await sceneSize(A)) === n0 && (await A.locator('.scratch-clear').isDisabled()))

  // ── 나가면 사라진다 ──
  await drawStroke(A)
  await sleep(300)
  await A.getByRole('button', { name: '문서 목록' }).click()
  await A.locator('.toast', { hasText: '낙서는 저장하지 않았습니다' }).waitFor({ timeout: 5000 })
  check('낙서 모드: 나가면 알린다', true)
  check('낙서 모드: 닫을 때 "올리지 않은 변경" 알림은 없다', (await A.locator('.toast', { hasText: '올리지 않은 변경' }).count()) === 0)
  await sleep(800)
  check('낙서 모드: 나간 뒤에도 DB는 그대로', sameSet(await strokes(A, D), ['kept']))

  // ── 다시 편집모드로 열면 평소처럼 저장된다 ──
  await openEditor(A, base, D)
  check('편집모드: 낙서 안내 없음', (await A.locator('.scratch-banner').count()) === 0)
  await drawStroke(A)
  await sleep(1200)
  check('편집모드: 저장된다', (await strokes(A, D)).length === 2)

  const warn = logsOf(A).filter((t) => /노트 보호\(withDocExclusive\) 밖|미구현/.test(t))
  check('경고 없음', warn.length === 0, warn.join(' | '))
  await A.context().close()
}
