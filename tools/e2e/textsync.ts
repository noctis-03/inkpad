// 문서(text 모드) 동기화 — 가짜 Drive 위의 두 기기. 올리기·받기, 서로 다른 블록을 고치면 블록 단위로 합침,
// 한쪽만 지운 블록은 지움, 같은 블록 충돌은 머지 화면에서 고름, 열린 문서 보호(받으면 편집 화면이 새 내용으로 다시 연다)
import type { Page } from 'playwright'
import { createFakeDrive } from './fake-drive.ts'
import { device, openEditor, sleep, type Ctx } from './lib.ts'

type TB = { id: string; html: string; pos: string; deletedAt?: number }

const push = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pushNow())
const pull = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pullNow())
const cloudState = (p: Page, docId: string) =>
  p.evaluate(async (docId) => (await (await import('/src/sync/sync.ts')).listCloudNotes()).find((n) => n.docId === docId)?.state, docId)
const deviceId = (p: Page) => p.evaluate(async () => (await import('/src/sync/token.ts')).getDeviceId())

/** 문서 하나를 블록 [id, html]로 만든다 (순서 키는 차례대로) */
const makeText = (p: Page, title: string, blocks: [string, string][]) =>
  p.evaluate(
    async ([title, blocks]) => {
      const r = await import('/src/storage/repo.ts')
      const f = await import('/src/shared/fracIndex.ts')
      const doc = await r.createDocument({ title, mode: 'text', folderId: null, pages: [] })
      const first = await r.loadTextBlocks(doc.id)
      const keys = f.keysBetween(null, null, blocks.length)
      const now = Date.now()
      await r.saveTextBatch({
        documentId: doc.id,
        delete: first.map((b) => b.id),
        upsert: blocks.map(([id, html], i) => ({ id, documentId: doc.id, type: 'p' as const, html, indent: 0, pos: keys[i], createdAt: now, updatedAt: now }))
      })
      return doc.id
    },
    [title, blocks] as const
  )
const editBlock = (p: Page, docId: string, id: string, html: string) =>
  p.evaluate(
    async ([docId, id, html]) => {
      await new Promise((r) => setTimeout(r, 15))
      const r = await import('/src/storage/repo.ts')
      const b = (await r.loadTextBlocks(docId)).find((x) => x.id === id)!
      await r.saveTextBatch({ documentId: docId, upsert: [{ ...b, html, updatedAt: Date.now() }] })
    },
    [docId, id, html] as const
  )
const insertAfter = (p: Page, docId: string, afterId: string, id: string, html: string) =>
  p.evaluate(
    async ([docId, afterId, id, html]) => {
      await new Promise((r) => setTimeout(r, 15))
      const r = await import('/src/storage/repo.ts')
      const f = await import('/src/shared/fracIndex.ts')
      const list = await r.loadTextBlocks(docId)
      const i = list.findIndex((x) => x.id === afterId)
      const now = Date.now()
      await r.saveTextBatch({ documentId: docId, upsert: [{ id, documentId: docId, type: 'p', html, indent: 0, pos: f.keyBetween(list[i].pos, list[i + 1]?.pos ?? null), createdAt: now, updatedAt: now }] })
    },
    [docId, afterId, id, html] as const
  )
const deleteBlock = (p: Page, docId: string, id: string) =>
  p.evaluate(
    async ([docId, id]) => {
      await new Promise((r) => setTimeout(r, 15))
      await (await import('/src/storage/repo.ts')).saveTextBatch({ documentId: docId, delete: [id] })
    },
    [docId, id] as const
  )
/** 이 기기 문서의 살아 있는 블록 글 (순서대로) */
const texts = (p: Page, docId: string) =>
  p.evaluate(async (docId) => (await (await import('/src/storage/repo.ts')).loadTextBlocks(docId)).map((b) => b.html).join('|'), docId)

export default async function textsync(ctx: Ctx) {
  const { base, check } = ctx
  const drive = createFakeDrive()
  const A = await device(ctx, { drive, name: 'PC' })
  const B = await device(ctx, { drive, name: 'iPad' })
  const devA = await deviceId(A)
  /** main(클라우드)의 살아 있는 블록 글 */
  const cloudTexts = (docId: string) => {
    const f = drive.ungz(drive.docFile(docId)!.revisions.at(-1)!.content) as { textBlocks?: TB[]; doc: { mode: string } }
    return { mode: f.doc.mode, text: [...(f.textBlocks ?? [])].filter((b) => !b.deletedAt).sort((x, y) => (x.pos < y.pos ? -1 : x.pos > y.pos ? 1 : x.id < y.id ? -1 : 1)).map((b) => b.html).join('|') }
  }

  // ── 올리기 → 다른 기기에서 받기 ──
  const D = await makeText(A, '회의록', [
    ['a', '하나'],
    ['b', '둘'],
    ['c', '셋']
  ])
  await push(A)
  const c0 = cloudTexts(D)
  check('올리기: 클라우드에 문서와 블록', c0.mode === 'text' && c0.text === '하나|둘|셋', JSON.stringify(c0))
  await pull(B)
  check('받기: 다른 기기에 문서 그대로', (await texts(B, D)) === '하나|둘|셋' && (await B.evaluate(async (id) => (await (await import('/src/storage/db.ts')).db.documents.get(id))?.mode, D)) === 'text')
  check('받기: 양쪽 같음', (await cloudState(A, D)) === 'same' && (await cloudState(B, D)) === 'same')

  // ── 한쪽만 고쳐 올리면 다른 쪽이 따라온다 ──
  await editBlock(B, D, 'c', '셋 (iPad)')
  check('고치면 올릴 것', (await cloudState(B, D)) === 'pending', String(await cloudState(B, D)))
  await push(B)
  await pull(A)
  check('받기: 고친 블록이 따라옴', (await texts(A, D)) === '하나|둘|셋 (iPad)')

  // ── 갈라짐: 서로 다른 블록 고치기 + 한쪽에서 지우기 + 다른 쪽에서 끼워 넣기 → 블록 단위로 합침 ──
  await editBlock(A, D, 'a', '하나 (PC)')
  await deleteBlock(A, D, 'b')
  await editBlock(B, D, 'c', '셋 (iPad 2)')
  await insertAfter(B, D, 'a', 'n', '새 줄 (iPad)')
  await push(B) // iPad가 먼저 → main
  await push(A) // PC는 갈라짐
  check('갈라짐', (await cloudState(A, D)) === 'diverged', String(await cloudState(A, D)))
  const r1 = await B.evaluate(
    async ([docId, dev]) => {
      const s = await import('/src/sync/sync.ts')
      const entry = (await s.listMergeQueue()).find((e) => e.docId === docId && e.deviceId === dev)!
      const session = await s.openMerge(entry)
      const plan = session.plan.items.filter((i) => i.kind === 'tblock').map((i) => `${i.id}:${i.cls}:${i.pick}`)
      const r = await s.commitMerge(session, { discard: new Set(), flip: new Set(), move: new Map(), color: new Map() })
      return { plan, applied: r.applied }
    },
    [D, devA] as const
  )
  check('머지 분류: PC만 고친 a·지운 b는 브랜치 쪽, iPad만 고친 c는 main 쪽', ['a:modified:branch', 'b:modified:branch', 'c:modified:main', 'n:mainOnly:main'].every((x) => r1.plan.includes(x)), r1.plan.join(' '))
  check('머지 결과: 두 기기 변경이 블록 단위로 모두, 지운 블록은 빠짐', cloudTexts(D).text === '하나 (PC)|새 줄 (iPad)|셋 (iPad 2)', cloudTexts(D).text)
  check('머지한 iPad에도 적용', r1.applied && (await texts(B, D)) === '하나 (PC)|새 줄 (iPad)|셋 (iPad 2)')
  await pull(A)
  check('PC가 받아 따라온다', (await texts(A, D)) === '하나 (PC)|새 줄 (iPad)|셋 (iPad 2)' && (await cloudState(A, D)) === 'same')

  // ── 같은 블록 충돌 → 머지 화면에서 '다른 쪽'으로 고른다 ──
  await editBlock(A, D, 'a', '하나 — PC 버전')
  await editBlock(B, D, 'a', '하나 — iPad 버전')
  await push(B)
  await push(A)
  check('충돌: 갈라짐', (await cloudState(A, D)) === 'diverged')
  await A.evaluate(async (docId) => {
    const entry = (await (await import('/src/sync/sync.ts')).listMergeQueue()).find((e) => e.docId === docId && e.mine)!
    ;(await import('/src/ui/merge/MergeView.tsx')).openMergeView(entry)
  }, D)
  await A.waitForSelector('.tm-list .tm-row', { timeout: 15000 })
  const row = A.locator('.tm-row.l-modified', { hasText: '하나 — PC 버전' })
  check('머지 화면: 블록 목록, 양쪽이 고친 블록은 다른 쪽 버전과 함께', (await row.count()) === 1 && (await row.locator('.tm-other').textContent())!.includes('하나 — iPad 버전'))
  check('…머지하는 기기(PC) 쪽이 기본, 양쪽이 고침 표시', (await row.locator('.tm-chip').textContent())!.includes('양쪽이 고침'))
  await row.getByRole('button', { name: /다른 쪽/ }).click()
  check('…다른 쪽으로 바꾸면 iPad 버전', (await A.locator('.tm-row.l-modified .tm-main > .tm-text').first().textContent())!.includes('iPad 버전'))
  check('…결과 요약은 블록 수', (await A.locator('.merge-total').textContent()) === '결과: 블록 3개')
  await A.getByRole('button', { name: '최종 머지' }).click()
  await A.locator('.dialog-host').getByRole('button', { name: '머지', exact: true }).click()
  await A.waitForSelector('.merge-view', { state: 'detached', timeout: 15000 })
  check('화면으로 머지: 고른 iPad 버전이 main에', cloudTexts(D).text.startsWith('하나 — iPad 버전|'), cloudTexts(D).text)
  check('…PC 문서에도', (await texts(A, D)).startsWith('하나 — iPad 버전|'))
  await pull(B)

  // ── 열린 문서 보호: 편집 화면에 열어 둔 채 받으면 새 내용으로 다시 연다 ──
  await openEditor(A, base, D).catch(() => {})
  await A.waitForFunction(() => !!(window as unknown as { inkpadText?: unknown }).inkpadText && !!document.querySelector('.tdoc-blocks .tb-row'))
  await editBlock(B, D, 'n', '새 줄 (열어 둔 사이 iPad)')
  await push(B)
  await pull(A)
  await A.waitForFunction(() => [...document.querySelectorAll('.tdoc-blocks .tb-text')].some((e) => e.textContent === '새 줄 (열어 둔 사이 iPad)'), null, { timeout: 15000 }).catch(() => {})
  const shown = await A.evaluate(() => [...document.querySelectorAll('.tdoc-blocks .tb-text')].map((e) => e.textContent).join('|'))
  check('열어 둔 문서도 받은 내용으로 다시 열림', shown.includes('새 줄 (열어 둔 사이 iPad)'), shown)
  // 열린 화면에서 고치면 다음 올리기에 실린다 (화면이 옛 내용으로 덮지 않는다)
  await A.locator('.tb-row', { hasText: '셋 (iPad 2)' }).locator('.tb-text').click()
  await A.keyboard.press('End')
  await A.keyboard.type(' + PC에서 열어 고침')
  await sleep(1300)
  await push(A)
  check('열린 화면에서 고친 것이 올라감 (받은 내용 위에)', cloudTexts(D).text.includes('새 줄 (열어 둔 사이 iPad)') && cloudTexts(D).text.includes('셋 (iPad 2) + PC에서 열어 고침'), cloudTexts(D).text)

  // ── 이 기기에서 바꾼 것 (비교 화면) ──
  await editBlock(A, D, 'a', '하나 (비교용 고침)')
  await insertAfter(A, D, 'a', 'z', '비교용 새 줄')
  await A.evaluate(async (docId) => (await import('/src/ui/ChangesView.tsx')).openChanges({ docId, title: '회의록', actions: [] }), D)
  await A.waitForSelector('.changes-sheet .tm-row', { timeout: 15000 })
  const chips = (await A.locator('.changes-summary .changes-chip').allTextContents()).join(' ')
  check('비교 화면: 블록으로 센다', chips.includes('새로 쓴 블록 +1') && chips.includes('고친 블록 1'), chips)
  check('…바뀐 블록만 목록에', (await A.locator('.changes-sheet .tm-row').count()) === 2)
  await A.keyboard.press('Escape')

  await A.context().close()
  await B.context().close()
}
