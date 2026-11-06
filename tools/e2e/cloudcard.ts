// 클라우드에만 있는 노트 카드: 다른 기기가 새로 만들어 올렸지만 이 기기에 받은 적 없는 노트를 라이브러리에 카드로 보인다.
// 이 기기에서 지운 노트(deleted-local)는 카드로 내지 않는다. 라이브러리를 열 때 네트워크는 쓰지 않는다(마지막 클라우드 확인의 캐시).
// 카드를 누르면 받아서 열고, ⋯ 메뉴로 받기만·클라우드에서 삭제
import type { Page } from 'playwright'
import { createFakeDrive } from './fake-drive.ts'
import { addStroke, device, sleep, strokes, type Ctx } from './lib.ts'

const push = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pushNow())
const pull = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pullNow())
const listCloud = (p: Page) => p.evaluate(async () => void (await (await import('/src/sync/sync.ts')).listCloudNotes()))
const mk = (p: Page, title: string, category: string | null) =>
  p.evaluate(
    async ([title, category]) => {
      const r = await import('/src/storage/repo.ts')
      const m = await import('/src/shared/model.ts')
      return (await r.createDocument({ title: title as string, mode: 'paged', folderId: null, category: category as string | null, pages: [{ size: { w: 595.28, h: 841.89 }, background: m.makeBackground('blank') }] })).id
    },
    [title, category] as const
  )

export default async function cloudcard(ctx: Ctx) {
  const { check } = ctx
  const drive = createFakeDrive()
  const A = await device(ctx, { drive, name: '노트북' })
  const B = await device(ctx, { drive, name: '아이패드' })

  // B는 W를 받아 두었다가 이 기기에서 지운다(휴지통) — 클라우드에는 남아 있다
  const W = await mk(A, '지운 노트', null)
  await addStroke(A, W, 'w')
  await push(A)
  await pull(B)
  await B.evaluate(async (id) => (await import('/src/storage/repo.ts')).trashDocument(id), W)
  // A가 새 노트 둘을 올린다 — B에는 없다
  const X = await mk(A, '미적분 정리', '수학')
  await addStroke(A, X, 'x')
  const Y = await mk(A, '영어 단어장', '영어')
  await addStroke(A, Y, 'y')
  await push(A)
  await listCloud(B) // 동기화 창 새로 고침(또는 앱을 열 때 확인)과 같은 확인 — 판정을 캐시한다

  // 라이브러리를 다시 열어도 Drive 요청 없이 카드가 보인다
  let reqs = 0
  B.on('request', (r) => {
    if (r.url().includes('googleapis.com')) reqs++
  })
  await B.reload()
  await B.waitForSelector('.doc-card')
  await B.locator('.cloud-card').first().waitFor({ timeout: 5000 }).catch(() => {})
  await sleep(500)
  const titles = await B.locator('.cloud-card .doc-title').allInnerTexts()
  check('클라우드 카드: 받을 수 있는 새 노트가 카드로 보인다', titles.includes('미적분 정리') && titles.includes('영어 단어장'), JSON.stringify(titles))
  check('클라우드 카드: 이 기기에서 지운 노트는 카드로 내지 않는다', !titles.includes('지운 노트'), JSON.stringify(titles))
  check('클라우드 카드: 라이브러리를 열 때 Drive 요청 0', reqs === 0, String(reqs))
  const tag = await B.locator('.cloud-card', { hasText: '미적분 정리' }).locator('.sync-tag').first().getAttribute('title')
  check('클라우드 카드: 꼬리표 "클라우드에만 있음 · 노트북"', tag === '클라우드에만 있음 · 노트북', String(tag))

  if (process.env.MERGE_SHOT_DIR) {
    await B.screenshot({ path: `${process.env.MERGE_SHOT_DIR}/cloudcard-grid.png` })
    await B.locator('.cloud-card', { hasText: '영어 단어장' }).click()
    await sleep(300)
    await B.screenshot({ path: `${process.env.MERGE_SHOT_DIR}/cloudcard-open.png` })
    await B.keyboard.press('Escape')
    await B.mouse.click(5, 895)
    await sleep(300)
  }
  // 고르기(여러 장 선택)의 전체 선택에 들어가지 않는다
  const localCards = await B.locator('.doc-card:not(.cloud-card)').count()

  // 누르면 받아서 연다 (격자: 오버레이 → 받아서 열기)
  await B.locator('.cloud-card', { hasText: '미적분 정리' }).click()
  await B.locator('.cloud-card', { hasText: '미적분 정리' }).getByRole('button', { name: /받아서 열기/ }).click()
  const opened = await B.waitForFunction((id) => location.hash.includes(id) || !!document.querySelector('.editor'), X, { timeout: 15000 }).then(() => true, () => false)
  check('클라우드 카드: 누르면 받아서 연다', opened && (await strokes(B, X)).includes('x'))
  await B.goto(ctx.base + '/')
  await B.waitForSelector('.doc-card')
  await sleep(400)
  const after = await B.locator('.cloud-card .doc-title').allInnerTexts()
  check('클라우드 카드: 받은 노트는 일반 카드로 바뀐다', !after.includes('미적분 정리') && (await B.locator('.doc-card:not(.cloud-card)', { hasText: '미적분 정리' }).count()) === 1, JSON.stringify(after))
  check('클라우드 카드: 받은 만큼 일반 카드가 는다', (await B.locator('.doc-card:not(.cloud-card)').count()) === localCards + 1)

  // ⋯ → 클라우드에서 삭제
  await B.locator('.cloud-card', { hasText: '영어 단어장' }).getByRole('button', { name: '더보기' }).click()
  await B.getByRole('menuitem', { name: '클라우드에서 삭제' }).click()
  await B.locator('.dialog-host').getByRole('button', { name: '삭제', exact: true }).click()
  const gone = await B.waitForFunction(() => ![...document.querySelectorAll('.cloud-card')].some((c) => c.textContent?.includes('영어 단어장')), null, { timeout: 15000 }).then(() => true, () => false)
  check('클라우드 카드: ⋯ 클라우드에서 삭제 — 카드가 빠지고 Drive에서도 지워진다', gone && !drive.docFile(Y))

  await A.context().close()
  await B.context().close()
}
