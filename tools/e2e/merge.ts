// 머지 관리: 두 기기가 같은 노트를 각각 고쳐 갈라진 뒤, 머지 화면(또는 같은 API)으로 직접 합친다 — 가짜 Drive 위에서.
// 모두 살리기 · 한쪽만 고친 획은 고친 쪽 · 낡은 머지 거부 · 이 기기 브랜치가 남았으면 노트를 덮지 않음 · 화면 조작
import type { Page } from 'playwright'
import { createFakeDrive } from './fake-drive.ts'
import { addStroke, createDoc, device, logsOf, openEditor, sameSet, strokes, type Ctx } from './lib.ts'

const push = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pushNow())
const pull = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pullNow())
const cloudState = (p: Page, docId: string) =>
  p.evaluate(async (docId) => (await (await import('/src/sync/sync.ts')).listCloudNotes()).find((n) => n.docId === docId)?.state, docId)
const queueOf = (p: Page, docId: string) =>
  p.evaluate(async (docId) => (await (await import('/src/sync/sync.ts')).listMergeQueue()).filter((e) => e.docId === docId), docId)
const deviceId = (p: Page) => p.evaluate(async () => (await import('/src/sync/token.ts')).getDeviceId())

/** 획 색을 바꿔 저장한다 (올가미 색 바꾸기와 같은 '고침') */
const recolor = (p: Page, docId: string, sid: string, color: string) =>
  p.evaluate(
    async ([docId, sid, color]) => {
      await new Promise((r) => setTimeout(r, 15)) // updatedAt이 겹치지 않게
      const r = await import('/src/storage/repo.ts')
      const d = await r.loadDocument(docId)
      const c = d.chunks.find((c) => c.elements.some((e) => e.id === sid))!
      const elements = c.elements.map((e) => (e.id === sid ? { ...e, color } : e))
      await r.saveBatch({ documentId: docId, chunks: [{ pageId: c.pageId, key: c.key, elements }] })
    },
    [docId, sid, color] as const
  )

/** 머지할 것 하나를 열어 작업본(버릴 키)을 얹고 최종 머지한다 — 결과 또는 오류 이름 */
const mergeVia = (p: Page, docId: string, deviceIdOfBranch: string, discard: string[] = []) =>
  p.evaluate(
    async ([docId, dev, discard]) => {
      const s = await import('/src/sync/sync.ts')
      const entry = (await s.listMergeQueue()).find((e) => e.docId === docId && e.deviceId === dev)
      if (!entry) return { error: 'no-entry' }
      const session = await s.openMerge(entry)
      try {
        const r = await s.commitMerge(session, { discard: new Set(discard as string[]), flip: new Set() })
        return { ...r, plan: session.plan.items.filter((i) => i.kind === 'el').map((i) => ({ id: i.id, cls: i.cls, pick: i.pick })) }
      } catch (e) {
        return { error: (e as Error).name }
      }
    },
    [docId, deviceIdOfBranch, discard] as const
  )

export default async function merge(ctx: Ctx) {
  const { base, check } = ctx
  const drive = createFakeDrive()
  const A = await device(ctx, { drive, name: 'PC' })
  const B = await device(ctx, { drive, name: 'iPad' })
  const [devA, devB] = [await deviceId(A), await deviceId(B)]
  const colorOf = (docId: string, sid: string) =>
    (drive.ungz(drive.docFile(docId)!.revisions.at(-1)!.content) as { chunks: { elements: { id: string; color?: string }[] }[] }).chunks.flatMap((c) => c.elements).find((e) => e.id === sid)?.color

  // ── 갈라짐 → 다른 기기(iPad)에서 머지 ──
  const D = await createDoc(A, '물리 노트')
  await addStroke(A, D, 'a')
  await push(A)
  await pull(B)
  await addStroke(A, D, 'pc1')
  await recolor(A, D, 'a', '#ff0000ff') // PC만 a의 색을 바꿈
  await addStroke(B, D, 'pad1')
  await push(B) // iPad가 먼저 → main이 따라간다
  await push(A) // PC는 갈라짐 → PC 브랜치에만
  check('갈라짐: PC 상태', (await cloudState(A, D)) === 'diverged')
  const qa = await queueOf(A, D)
  const qb = await queueOf(B, D)
  check('목록: PC에서 자기 브랜치가 머지할 것으로 보인다', qa.length === 1 && qa[0].mine && qa[0].deviceId === devA)
  check('목록: iPad에서도 PC 브랜치가 보인다', qb.length === 1 && !qb[0].mine && qb[0].device === 'PC')

  const r1 = await mergeVia(B, D, devA)
  const cls = Object.fromEntries((r1.plan ?? []).map((i) => [i.id, i]))
  check('분류: PC만 고친 획은 브랜치 쪽', cls.a?.cls === 'modified' && cls.a?.pick === 'branch', JSON.stringify(cls.a))
  check('분류: 양쪽 새 획', cls.pad1?.cls === 'mainOnly' && cls.pc1?.cls === 'branchOnly')
  check('머지: main = 양쪽 획 모두(모두 살리기)', sameSet(drive.headStrokes(D), ['a', 'pad1', 'pc1']), JSON.stringify(drive.headStrokes(D)))
  check('머지: 고친 획은 PC 쪽 색', colorOf(D, 'a') === '#ff0000ff')
  check('머지: main 표식 — 머지 리비전, PC 브랜치 반영', drive.docFile(D)!.appProperties.revKind === 'merge' && drive.docFile(D)!.appProperties[`m.${devA}`] === drive.branchOf(D, devA)!.appProperties.seq)
  check('머지: 머지한 iPad 노트에도 적용', r1.applied === true && sameSet(await strokes(B, D), ['a', 'pad1', 'pc1']))
  check('머지: 머지할 것이 비었다(양쪽)', (await queueOf(A, D)).length === 0 && (await queueOf(B, D)).length === 0)
  check('머지: PC는 받을 것으로 본다', (await cloudState(A, D)) === 'remote-new', String(await cloudState(A, D)))
  await pull(A)
  check('머지: PC가 받아 따라온다', sameSet(await strokes(A, D), ['a', 'pad1', 'pc1']) && (await cloudState(A, D)) === 'same')
  check('머지: iPad는 최신', (await cloudState(B, D)) === 'same')

  // ── 낡은 머지는 거부, 다시 열어 버리기까지 ──
  await addStroke(A, D, 'x')
  await addStroke(B, D, 'y')
  await push(B)
  await push(A) // PC 갈라짐
  const stale = await A.evaluate(async (docId) => {
    const s = await import('/src/sync/sync.ts')
    const entry = (await s.listMergeQueue()).find((e) => e.docId === docId && e.mine)!
    return s.openMerge(entry).then((session) => ({ ok: true, session: session.mainMid }))
  }, D)
  check('낡음: 머지 화면을 열 수 있다', stale.ok)
  // 연 상태 그대로 두고 iPad가 하나 더 올린 뒤 머지하면 거부된다
  const blocked = await A.evaluate(async (docId) => {
    const s = await import('/src/sync/sync.ts')
    const entry = (await s.listMergeQueue()).find((e) => e.docId === docId && e.mine)!
    const session = await s.openMerge(entry)
    ;(window as unknown as { __session: unknown }).__session = session
    return true
  }, D)
  await addStroke(B, D, 'z')
  await push(B) // iPad는 main 그대로였으므로 따라간다 → main이 바뀜
  const headBefore = drive.headStrokes(D)
  const staleErr = await A.evaluate(async () => {
    const s = await import('/src/sync/sync.ts')
    try {
      await s.commitMerge((window as unknown as { __session: Parameters<typeof s.commitMerge>[0] }).__session, { discard: new Set(), flip: new Set() })
      return 'ok'
    } catch (e) {
      return (e as Error).name
    }
  })
  check('낡음: 연 뒤 main이 바뀌면 MergeStaleError', blocked && staleErr === 'MergeStaleError', staleErr)
  check('낡음: main은 그대로', sameSet(drive.headStrokes(D), headBefore))
  const r2 = await mergeVia(A, D, devA, ['el:z']) // 다시 열어 iPad의 z는 버린다
  check('버리기: 결과에서 빠진다', !drive.headStrokes(D).includes('z') && drive.headStrokes(D).includes('x') && drive.headStrokes(D).includes('y'), JSON.stringify(drive.headStrokes(D)))
  check('버리기: 자기 브랜치를 머지한 PC 노트에 적용', r2.applied === true && !(await strokes(A, D)).includes('z'))
  await pull(B)
  check('버리기: iPad도 받아 따라온다(z 없음)', !(await strokes(B, D)).includes('z') && (await cloudState(B, D)) === 'same')

  // ── 이 기기에 머지 안 된 자기 브랜치가 있으면 머지 결과로 노트를 덮지 않는다 ──
  await addStroke(A, D, 'p2')
  await addStroke(B, D, 'q2')
  await push(B)
  await push(A) // PC 갈라짐
  const before = await strokes(B, D)
  await B.evaluate(
    async ([docId]) => {
      const { db } = await import('/src/storage/db.ts')
      const row = await db.syncState.get(`br:${docId}`)
      await db.syncState.put({ key: `br:${docId}`, value: { ...(row?.value as object), seq: 999 } }) // iPad에도 머지 안 된 브랜치가 있는 것처럼
    },
    [D] as const
  )
  const r3 = await mergeVia(B, D, devA)
  check('남은 브랜치: iPad 노트는 그대로 두고 알린다', r3.keptLocal === true && r3.applied === false && sameSet(await strokes(B, D), before))
  check('남은 브랜치: main에는 PC 브랜치가 머지됐다', drive.headStrokes(D).includes('p2'))
  void devB

  // ── 머지 화면 (실제 클릭) ──
  const H = await createDoc(A, '화면 노트')
  await addStroke(A, H, 'h0')
  await push(A)
  await pull(B)
  await addStroke(A, H, 'h-pc')
  await addStroke(B, H, 'h-pad')
  await push(B)
  await push(A) // PC 갈라짐
  await openEditor(A, base, H)
  await A.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setPanel('sync'))
  await A.waitForSelector('.merge-queue-row', { timeout: 15000 })
  check('화면: 동기화 패널에 머지 관리 카드', (await A.locator('.merge-queue-row').count()) >= 1)
  await A.locator('.merge-queue-row', { hasText: '화면 노트' }).click()
  await A.waitForSelector('.merge-view .merge-layer.l-branchOnly', { timeout: 15000 })
  await A.waitForTimeout(400)
  await A.screenshot({ path: process.env.MERGE_SHOT_DIR ? `${process.env.MERGE_SHOT_DIR}/merge-wide.png` : undefined as unknown as string, fullPage: false }).catch(() => {})
  const branchLayer = A.locator('.merge-layer.l-branchOnly')
  check('화면: 브랜치에만 레이어에 획 1', (await branchLayer.innerText()).includes('획 1'))
  check('화면: 페이지 캔버스를 그린다', (await A.locator('.merge-view .merge-canvas').count()) >= 1)
  await branchLayer.getByRole('button', { name: '모두 버리기' }).click()
  check('화면: 버린 개수가 보인다', (await branchLayer.innerText()).includes('버림 1'))
  check('화면: 결과 합계', (await A.locator('.merge-total').innerText()).includes('획 2개'))
  await A.setViewportSize({ width: 700, height: 900 })
  await A.waitForTimeout(300)
  if (process.env.MERGE_SHOT_DIR) await A.screenshot({ path: `${process.env.MERGE_SHOT_DIR}/merge-narrow.png` })
  await A.setViewportSize({ width: 1200, height: 900 })
  await A.getByRole('button', { name: '최종 머지' }).click()
  await A.waitForSelector('.dialog-host .modal')
  await A.locator('.dialog-host').getByRole('button', { name: '머지', exact: true }).click()
  await A.waitForSelector('.merge-view', { state: 'detached', timeout: 15000 })
  check('화면: 최종 머지 — 버린 PC 획은 main에 없다', sameSet(drive.headStrokes(H), ['h0', 'h-pad']), JSON.stringify(drive.headStrokes(H)))
  check('화면: PC 노트도 결과로', sameSet(await strokes(A, H), ['h0', 'h-pad']))

  const warn = [...logsOf(A), ...logsOf(B)].filter((t) => /노트 보호\(withDocExclusive\) 밖|미구현|Error/.test(t) && !/favicon/.test(t))
  check('경고 없음', warn.length === 0, warn.join(' | '))
  await A.context().close()
  await B.context().close()
}
