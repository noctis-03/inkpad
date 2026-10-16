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
        const r = await s.commitMerge(session, { discard: new Set(discard as string[]), flip: new Set(), move: new Map(), color: new Map() })
        return { ...r, plan: session.plan.items.filter((i) => i.kind === 'el').map((i) => ({ id: i.id, cls: i.cls, pick: i.pick })) }
      } catch (e) {
        return { error: (e as Error).name }
      }
    },
    [docId, deviceIdOfBranch, discard] as const
  )

/** 첫 페이지의 정한 자리(페이지 좌표)에 획 하나를 더한다 — 화면에서 올가미·지우개로 집을 수 있게 */
const addStrokeAt = (p: Page, docId: string, sid: string, x: number, y: number) =>
  p.evaluate(
    async ([docId, sid, x, y]) => {
      await new Promise((r) => setTimeout(r, 15))
      const r = await import('/src/storage/repo.ts')
      const d = await r.loadDocument(docId)
      const pageId = d.pages[0].id
      const els = d.chunks.find((c) => c.pageId === pageId)?.elements ?? []
      const pts = [x, y, 0.5, 0, x + 6, y + 8, 0.5, 16, x + 12, y + 16, 0.5, 16]
      els.push({ id: sid, type: 'stroke', layer: 'main', z: els.length + 1, createdAt: Date.now(), tool: 'pen', color: '#000000ff', width: 3, points: pts, bbox: [x - 2, y - 2, x + 14, y + 18], opts: { thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false } })
      await r.saveBatch({ documentId: docId, chunks: [{ pageId, key: '0_0', elements: els }] })
    },
    [docId, sid, x, y] as const
  )
const openMergeOf = (p: Page, docId: string) =>
  p.evaluate(async (docId) => {
    const entry = (await (await import('/src/sync/sync.ts')).listMergeQueue()).find((e) => e.docId === docId && e.mine)!
    ;(await import('/src/ui/merge/MergeView.tsx')).openMergeView(entry)
  }, docId)

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
      await s.commitMerge((window as unknown as { __session: Parameters<typeof s.commitMerge>[0] }).__session, { discard: new Set(), flip: new Set(), move: new Map(), color: new Map() })
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
  if (process.env.MERGE_SHOT_DIR) await A.screenshot({ path: `${process.env.MERGE_SHOT_DIR}/merge-wide.png` })
  const branchLayer = A.locator('.merge-layer.l-branchOnly')
  check('화면: 브랜치에만 레이어에 획 1', (await branchLayer.innerText()).includes('획 1'))
  check('화면: 페이지 캔버스를 그린다', (await A.locator('.merge-view .merge-canvas').count()) >= 1)
  check('화면: 바뀐 획은 빛 테두리로', (await A.locator('.merge-view .merge-glow').count()) >= 1)
  await A.getByRole('button', { name: '결과만 보기' }).click()
  check('화면: 결과만 보기에서는 빛 테두리를 끈다', (await A.locator('.merge-view .merge-glow').count()) === 0)
  await A.getByRole('button', { name: '결과만 보기' }).click()
  const common = A.locator('.merge-layer.l-common')
  check('화면: 공통 레이어 이름은 "원래 있던 내용"', (await common.innerText()).includes('원래 있던 내용'))
  // 원래 있던 내용을 고르면 그 획만 흐림 없이 — 다른 레이어 획은 그리지 않는다
  const inkOf = () =>
    A.evaluate(() => {
      const c = document.querySelector('.merge-view .merge-canvas') as HTMLCanvasElement
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
      let dark = 0
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128 && d[i + 1] < 128 && d[i + 2] < 128) dark++
      return dark
    })
  const inkAll = await inkOf()
  await common.locator('.merge-layer-main').click()
  await A.waitForTimeout(300)
  if (process.env.MERGE_SHOT_DIR) await A.screenshot({ path: `${process.env.MERGE_SHOT_DIR}/merge-common.png`, clip: { x: 0, y: 120, width: 400, height: 200 } })
  const inkCommon = await inkOf()
  check('화면: 원래 있던 내용을 고르면 그것만 진하게 보인다', inkCommon > 0 && inkCommon < inkAll, JSON.stringify({ inkAll, inkCommon }))
  await common.locator('.merge-layer-main').click()
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

  // ── 머지 편집기: 레이어 안에서 올가미로 옮기기, 지우개, 되돌리기, 작업본 유지 ──
  // 앞에서 연 동기화 패널이 머지 뒤 목록을 다시 읽는 중일 수 있다 — 끝나고 닫은 뒤 이동한다(요청이 끊기지 않게)
  await A.waitForFunction(() => ![...document.querySelectorAll('.merge-queue-row')].some((r) => r.textContent?.includes('화면 노트')), null, { timeout: 15000 })
  await A.waitForSelector('.cloud-icon-btn:not(.spinning)')
  await A.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setPanel('none'))
  await A.goto(base + '/')
  await A.waitForSelector('#root *')
  const K = await createDoc(A, '편집 노트')
  await addStrokeAt(A, K, 'k0', 100, 100)
  await push(A)
  await pull(B)
  await addStrokeAt(A, K, 'k-pc', 100, 300) // PC(브랜치)에만
  await addStrokeAt(B, K, 'k-pad1', 300, 300) // iPad(main)에만
  await addStrokeAt(B, K, 'k-pad2', 300, 380) // 화면 아래 버튼 막대에 가리지 않는 높이
  await push(B)
  await push(A) // PC 갈라짐
  await openMergeOf(A, K)
  await A.waitForSelector('.merge-tools', { timeout: 15000 })
  const overlay = A.locator('.merge-overlay').first()
  await overlay.scrollIntoViewIfNeeded()
  const box = (await overlay.boundingBox())!
  const k = box.width / 595.28 // 페이지 좌표 → 화면
  const at = (x: number, y: number) => ({ x: box.x + x * k, y: box.y + y * k })
  const dragPath = async (pts: { x: number; y: number }[]) => {
    await A.mouse.move(pts[0].x, pts[0].y)
    await A.mouse.down()
    for (const q of pts.slice(1)) await A.mouse.move(q.x, q.y, { steps: 4 })
    await A.mouse.up()
  }
  await A.getByRole('radio', { name: '올가미' }).click()
  await dragPath([at(80, 280), at(130, 280), at(130, 335), at(80, 335), at(80, 282)]) // k-pc 둘레
  check('편집기: 올가미로 브랜치 획 하나를 고른다', (await A.locator('.merge-selcount').innerText()).includes('1'))
  if (process.env.MERGE_SHOT_DIR) await A.screenshot({ path: `${process.env.MERGE_SHOT_DIR}/merge-editor.png` })
  await dragPath([at(106, 308), at(156, 308), at(206, 308)]) // 고른 획을 끌어 오른쪽으로 100pt
  await A.getByRole('radio', { name: '지우개' }).click()
  check('편집기: 지우개로 바꾸면 선택이 풀린다', (await A.locator('.merge-selbar').count()) === 0)
  await dragPath([at(290, 388), at(320, 388)]) // k-pad2 위를 긋는다
  const mainOnly = A.locator('.merge-layer.l-mainOnly')
  check('편집기: 지우개로 지운 획은 버림', (await mainOnly.innerText()).includes('버림 1'))
  await A.getByRole('button', { name: '되돌리기' }).click()
  check('편집기: 되돌리기', !(await mainOnly.innerText()).includes('버림'))
  await A.getByRole('button', { name: '다시 하기' }).click()
  check('편집기: 다시 하기', (await mainOnly.innerText()).includes('버림 1'))
  await A.waitForTimeout(300)
  const redPx = await A.evaluate(() => {
    let n = 0
    for (const c of document.querySelectorAll<HTMLCanvasElement>('.merge-view .merge-canvas')) {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
      for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 190 && d[i + 2] < 190 && d[i] - d[i + 1] > 40) n++
    }
    return n
  })
  check('편집기: 버린 획은 연한 빨간 테두리로', redPx > 0, String(redPx))
  if (process.env.MERGE_SHOT_DIR) {
    const p0 = at(270, 370)
    await A.screenshot({ path: `${process.env.MERGE_SHOT_DIR}/merge-erased.png`, clip: { x: p0.x, y: p0.y, width: 160, height: 60 } })
  }
  await dragPath([at(90, 108), at(120, 108)]) // 공통 획 k0는 지워지지 않는다
  check('편집기: 공통 획은 지우개로 버려지지 않는다', !(await A.locator('.merge-layer.l-common').innerText()).includes('버림'))
  await A.waitForTimeout(500) // 작업본 저장(0.3초 뒤)
  await A.getByRole('button', { name: '나중에' }).click()
  await A.waitForSelector('.merge-view', { state: 'detached' })
  const drafts = await A.evaluate(async () => [...(await (await import('/src/sync/mergeDraft.ts')).mergeDraftKeys())])
  check('작업본: 닫아도 이 기기에 남는다', drafts.some((d) => d.startsWith(K + '@')))
  await openMergeOf(A, K)
  await A.waitForSelector('.merge-layer.l-mainOnly', { timeout: 15000 })
  check('작업본: 다시 열면 이어진다', (await A.locator('.merge-layer.l-mainOnly').innerText()).includes('버림 1'))
  await A.getByRole('button', { name: '최종 머지' }).click()
  await A.locator('.dialog-host').getByRole('button', { name: '머지', exact: true }).click()
  await A.waitForSelector('.merge-view', { state: 'detached', timeout: 15000 })
  check('편집기 결과: 지운 획은 빠지고 나머지는 남는다', sameSet(drive.headStrokes(K), ['k0', 'k-pc', 'k-pad1']), JSON.stringify(drive.headStrokes(K)))
  const kpc = (drive.ungz(drive.docFile(K)!.revisions.at(-1)!.content) as { chunks: { elements: { id: string; points: number[] }[] }[] }).chunks
    .flatMap((c) => c.elements)
    .find((e) => e.id === 'k-pc')!
  check('편집기 결과: 끌어 옮긴 획은 옮긴 자리에', Math.abs(kpc.points[0] - 200) < 3 && Math.abs(kpc.points[1] - 300) < 3, JSON.stringify(kpc.points.slice(0, 2)))
  const left = await A.evaluate(async () => [...(await (await import('/src/sync/mergeDraft.ts')).mergeDraftKeys())])
  check('작업본: 최종 머지 뒤 지워진다', !left.some((d) => d.startsWith(K + '@')))

  const warn = [...logsOf(A), ...logsOf(B)].filter((t) => /노트 보호\(withDocExclusive\) 밖|미구현|Error/.test(t) && !/favicon/.test(t))
  check('경고 없음', warn.length === 0, warn.join(' | '))
  await A.context().close()
  await B.context().close()
}
