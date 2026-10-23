// 보조 용지: 페이지 옆에 붙는 추가 필기 용지. 필기·옮기기(붙기)·크기·제목·가림·지우개 범위·Undo·저장·페이지 삭제·복제·내보내기·동기화 묶음
import { createDoc, device, openEditor, sleep, type Ctx } from './lib.ts'

type Rect = { x: number; y: number; w: number; h: number }
type W = { inkpad: any }

export default async function sheets(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  const errs: string[] = []
  p.on('pageerror', (e) => errs.push(String(e)))
  const docId = await createDoc(p, '보조 용지', 2)
  await openEditor(p, base, docId)
  // 첫 페이지와 오른쪽 여백이 함께 보이게
  await p.evaluate(() => {
    const e = (window as unknown as W).inkpad
    e.cam.zoom = 0.7
    e.cam.x = -560
    e.cam.y = -120
    e.zoomBy(1)
  })
  await sleep(150)

  const eng = <T,>(fn: string, ...args: unknown[]) =>
    p.evaluate(([fn, args]) => (window as unknown as W).inkpad[fn as string](...(args as unknown[])), [fn, args] as const) as Promise<T>
  const rectOf = (id: string) => p.evaluate((id) => (window as unknown as W).inkpad.layout.rects.get(id) as Rect, id)
  const sheetOf = (id: string) => p.evaluate((id) => (window as unknown as W).inkpad.sheet(id) ?? null, id)
  const screen = (wx: number, wy: number) =>
    p.evaluate(
      ([wx, wy]) => {
        const e = (window as unknown as W).inkpad
        const b = e.root.getBoundingClientRect()
        return { x: (wx - e.cam.x) * e.cam.zoom + b.left, y: (wy - e.cam.y) * e.cam.zoom + b.top }
      },
      [wx, wy]
    )
  const strokePages = () => p.evaluate(() => [...(window as unknown as W).inkpad.scene.recs.values()].map((r: { pageId: string }) => r.pageId) as string[])
  const draw = async (a: { x: number; y: number }, b: { x: number; y: number }) => {
    await p.mouse.move(a.x, a.y)
    await p.mouse.down()
    for (let i = 1; i <= 12; i++) await p.mouse.move(a.x + ((b.x - a.x) * i) / 12, a.y + ((b.y - a.y) * i) / 12 + Math.sin(i) * 5)
    await p.mouse.up()
    await sleep(50)
  }
  /** 확정 레이어의 화면 점 색 (r,g,b,a) */
  const pixel = (pt: { x: number; y: number }) =>
    p.evaluate(([x, y]) => {
      const c = (window as unknown as W).inkpad.root.querySelector('.layer-committed') as HTMLCanvasElement
      const b = c.getBoundingClientRect()
      const k = c.width / b.width
      return [...c.getContext('2d')!.getImageData(Math.round((x - b.left) * k), Math.round((y - b.top) * k), 1, 1).data]
    }, [pt.x, pt.y])
  const dragEl = async (sel: string, dx: number, dy: number, at: 'center' | 'title' = 'center') => {
    const box = (await p.locator(sel).boundingBox())!
    const sx = at === 'title' ? box.x + 30 : box.x + box.width / 2
    const sy = box.y + box.height / 2
    await p.mouse.move(sx, sy)
    await p.mouse.down()
    await p.mouse.move(sx + dx, sy + dy, { steps: 12 })
    await p.mouse.up()
    await sleep(100)
  }

  const page0 = await p.evaluate(() => (window as unknown as W).inkpad.pages[0].id as string)
  const p0 = await rectOf(page0)

  // ── 추가: 오른쪽에 붙고, 페이지 수·순서는 그대로 ──
  const id = await eng<string>('addSheet', 0, 'right')
  await sleep(150)
  let r = await rectOf(id)
  check('용지 추가 → 페이지 오른쪽에 붙음', Math.abs(r.x - (p0.x + p0.w)) < 0.01 && r.y === p0.y, JSON.stringify(r))
  check('용지는 페이지 수에 들지 않음', (await p.evaluate(() => (window as unknown as W).inkpad.pages.length)) === 2)
  check('제목 줄이 보임', (await p.locator(`.sheet-frame[data-sheet-id="${id}"] .sheet-head`).count()) === 1)

  // ── 필기: 용지 위 획은 용지 소속 ──
  await draw(await screen(r.x + 40, r.y + 120), await screen(r.x + 220, r.y + 160))
  check('용지 위 획 → 용지 소속', (await strokePages()).filter((x) => x === id).length === 1)

  // ── 페이지 획 하나 (용지를 그 위로 옮겨 가림 확인) ──
  const pageStrokeAt = { x: p0.x + 120, y: p0.y + 300 }
  await draw(await screen(pageStrokeAt.x - 60, pageStrokeAt.y), await screen(pageStrokeAt.x + 60, pageStrokeAt.y))
  check('페이지 위 획 → 페이지 소속', (await strokePages()).filter((x) => x === page0).length === 1)

  // ── 제목 줄 끌기: 페이지 위로 → 떨어져 떠 있음, 용지 획이 함께 감 ──
  const strokeOx0 = await p.evaluate((id) => [...(window as unknown as W).inkpad.scene.recs.values()].find((r: { pageId: string }) => r.pageId === id).ox as number, id)
  const head = `.sheet-frame[data-sheet-id="${id}"] .sheet-head`
  // 용지 왼쪽 위가 페이지 획보다 100pt 왼쪽·200pt 위에 오도록 끈다
  const zoom = await p.evaluate(() => (window as unknown as W).inkpad.cam.zoom as number)
  await dragEl(head, (pageStrokeAt.x - 100 - r.x) * zoom, (pageStrokeAt.y - 200 - r.y) * zoom)
  let s = await sheetOf(id)
  r = await rectOf(id)
  const strokeOx1 = await p.evaluate((id) => [...(window as unknown as W).inkpad.scene.recs.values()].find((r: { pageId: string }) => r.pageId === id).ox as number, id)
  check('끌어서 페이지 위로 → 떨어짐(snap 없음)', s.sheet.snap === null && r.x < p0.x + p0.w - 100, JSON.stringify(s.sheet))
  check('…용지 획도 함께 옮겨 감', Math.abs(strokeOx1 - strokeOx0 - (r.x - (p0.x + p0.w))) < 0.5, JSON.stringify([strokeOx0, strokeOx1, r.x]))

  // ── 가림: 용지 아래 페이지 획은 보이지 않는다(용지 종이가 덮음), 지우개도 용지 획만 ──
  const covered = r.x <= pageStrokeAt.x - 60 && r.x + r.w >= pageStrokeAt.x + 60 && r.y <= pageStrokeAt.y - 20 && r.y + r.h >= pageStrokeAt.y + 20
  if (covered) {
    const px = await pixel(await screen(pageStrokeAt.x, pageStrokeAt.y))
    check('용지가 아래 페이지 획을 가림', px[0] > 240 && px[1] > 240 && px[2] > 240 && px[3] === 255, JSON.stringify(px))
    await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setTool('eraser'))
    await draw(await screen(pageStrokeAt.x - 70, pageStrokeAt.y), await screen(pageStrokeAt.x + 70, pageStrokeAt.y))
    check('용지 위 지우개는 가려진 페이지 획을 지우지 않음', (await strokePages()).filter((x) => x === page0).length === 1)
    await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setTool('pen'))
  } else check('용지가 페이지 획을 덮도록 옮겨짐', false, JSON.stringify(r))

  // ── 다시 페이지 오른쪽 가장자리 가까이로 → 붙음 ──
  const toEdge = await screen(p0.x + p0.w + 4, p0.y + 10)
  const cur = await screen(r.x, r.y)
  await dragEl(head, toEdge.x - cur.x, toEdge.y - cur.y, 'title')
  s = await sheetOf(id)
  r = await rectOf(id)
  check('가장자리 가까이 놓으면 오른쪽에 붙음', s.sheet.snap === 'right' && Math.abs(r.x - (p0.x + p0.w)) < 0.01 && s.sheet.y === 0, JSON.stringify(s.sheet))

  // ── Undo/Redo: 끌기 한 번 = 기록 한 번 ──
  await eng('undo')
  check('Undo → 떨어진 자리로', (await sheetOf(id)).sheet.snap === null)
  await eng('redo')
  check('Redo → 다시 붙음', (await sheetOf(id)).sheet.snap === 'right')

  // ── 크기 조절 ──
  const w0 = (await sheetOf(id)).size
  await dragEl(`.sheet-frame[data-sheet-id="${id}"] .sheet-resize`, 70, -140)
  const w1 = (await sheetOf(id)).size
  check('모서리 끌기 → 폭·높이 변경', w1.w > w0.w + 50 && w1.h < w0.h - 100, JSON.stringify([w0, w1]))
  check('…붙은 채로', (await sheetOf(id)).sheet.snap === 'right')

  // ── 제목 ──
  const hb = (await p.locator(head).boundingBox())!
  await p.mouse.click(hb.x + 40, hb.y + hb.height / 2)
  await p.locator(`${head} .sheet-title-input`).fill('풀이')
  await p.keyboard.press('Enter')
  await sleep(100)
  check('제목을 눌러 이름 바꾸기', (await sheetOf(id)).sheet.title === '풀이' && (await p.locator(`${head} .sheet-title`).textContent()) === '풀이')

  // ── 저장 후 다시 열기 ──
  await eng('flush')
  const saved = await p.evaluate(async (docId) => {
    const r = await import('/src/storage/repo.ts')
    const d = await r.loadDocument(docId)
    return { pages: d.pages.length, order: d.doc.pageOrder.length, sheets: d.sheets.map((s) => s.sheet), chunks: d.chunks.map((c) => c.pageId) }
  }, docId)
  check('저장: 용지는 sheets로, 페이지 순서 밖', saved.pages === 2 && saved.order === 2 && saved.sheets.length === 1 && saved.sheets[0]!.title === '풀이', JSON.stringify(saved))
  check('저장: 용지 획 청크', saved.chunks.includes(id))
  await openEditor(p, base, docId)
  await sleep(200)
  check('다시 열면 용지와 그 획이 그대로', !!(await sheetOf(id)) && (await strokePages()).includes(id) && (await p.locator('.sheet-frame').count()) === 1)

  // ── 페이지 복제 → 용지도 복제, 페이지 삭제 → 용지도 삭제, Undo → 함께 복원 ──
  await eng('duplicatePage', 0)
  const afterDup = await p.evaluate(() => {
    const e = (window as unknown as W).inkpad
    return { sheets: e.sheets.map((s: { sheet: { anchorPageId: string } }) => s.sheet.anchorPageId), pages: e.pages.map((x: { id: string }) => x.id) }
  })
  check('페이지 복제 → 보조 용지도 새 페이지에 복제', afterDup.sheets.length === 2 && afterDup.sheets.includes(afterDup.pages[1]), JSON.stringify(afterDup))
  await eng('undo')
  await eng('deletePage', 0)
  check('페이지 삭제 → 붙은 용지와 그 획도 삭제', (await p.evaluate(() => (window as unknown as W).inkpad.sheets.length)) === 0 && !(await strokePages()).includes(id))
  await eng('undo')
  check('Undo → 용지와 획 복원', !!(await sheetOf(id)) && (await strokePages()).includes(id))

  // ── 메뉴: 왼쪽에 붙이기, 복제, 삭제 ──
  await p.locator(`${head} .sheet-menu-btn`).click()
  await p.getByRole('button', { name: '페이지 왼쪽에 붙이기' }).click()
  r = await rectOf(id)
  check('메뉴 → 왼쪽에 붙이기', (await sheetOf(id)).sheet.snap === 'left' && Math.abs(r.x + r.w - p0.x) < 0.01)
  // 왼쪽 용지가 보이게 화면을 옮긴다
  await p.evaluate((x) => {
    const e = (window as unknown as W).inkpad
    e.cam.x = x - 40
    e.zoomBy(1)
  }, r.x)
  await sleep(100)
  await p.locator(`${head} .sheet-menu-btn`).click()
  await p.getByRole('button', { name: '복제' }).click()
  check('메뉴 → 복제 (획 포함)', (await p.evaluate(() => (window as unknown as W).inkpad.sheets.length)) === 2 && (await strokePages()).length === 3)
  await eng('undo')

  // ── 동기화 묶음·머지·문서 복제: 용지는 pageOrder에 들지 않는다 ──
  await eng('flush')
  const sync = await p.evaluate(async (docId) => {
    const pack = await import('/src/sync/pack.ts')
    const merge = await import('/src/sync/merge.ts')
    const repo = await import('/src/storage/repo.ts')
    const f = await pack.packDocument(docId)
    const plan = merge.classify(f, f, { modified: {}, hasBase: true, prefer: 'main' })
    const out = merge.compose(f, f, plan, merge.emptyDraft())
    const dup = await repo.duplicateDocument(docId)
    const d2 = await repo.loadDocument(dup.id)
    return {
      packed: f.pages.filter((x) => x.sheet).length,
      order: f.doc.pageOrder.length,
      merged: out.pages.filter((x) => x.sheet).length,
      mergedOrder: out.doc.pageOrder.length,
      dupSheets: d2.sheets.length,
      dupAnchorOk: d2.sheets.every((s) => d2.pages.some((pg) => pg.id === s.sheet!.anchorPageId)),
      dupChunk: d2.chunks.some((c) => d2.sheets.some((s) => s.id === c.pageId))
    }
  }, docId)
  check('동기화 파일에 용지 포함, 순서에는 없음', sync.packed === 1 && sync.order === 2, JSON.stringify(sync))
  check('머지 결과도 용지 유지, 순서에는 없음', sync.merged === 1 && sync.mergedOrder === 2, JSON.stringify(sync))
  check('노트 복제 → 용지·획이 새 페이지에 이어짐', sync.dupSheets === 1 && sync.dupAnchorOk && sync.dupChunk, JSON.stringify(sync))

  // ── 속지 고르기 + 투명(테두리만) 용지 ──
  await p.evaluate((y) => {
    const e = (window as unknown as W).inkpad
    e.cam.zoom = 0.7
    e.cam.x = -340
    e.cam.y = y + 400
    e.zoomBy(1)
  }, p0.y)
  await sleep(150)
  const inkAt = { x: p0.x + 200, y: p0.y + 600 }
  await draw(await screen(inkAt.x - 60, inkAt.y), await screen(inkAt.x + 60, inkAt.y))
  const pageStrokes = async () => (await strokePages()).filter((x) => x === page0).length
  const pageInk0 = await pageStrokes()
  /** 획 가운데 둘레(가로 ±10·세로 ±30px — 가는 획의 흐린 가장자리도 잡게)에서 가장 진한 값 (작을수록 진함, 없으면 255) */
  const darkest = (pt: { x: number; y: number }) =>
    p.evaluate(([x, y]) => {
      const c = (window as unknown as W).inkpad.root.querySelector('.layer-committed') as HTMLCanvasElement
      const b = c.getBoundingClientRect()
      const k = c.width / b.width
      const d = c.getContext('2d')!.getImageData(Math.round((x - b.left) * k) - 10, Math.round((y - b.top) * k) - 30, 21, 60).data
      let min = 255
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 80) min = Math.min(min, d[i])
      return min
    }, [pt.x, pt.y])
  check('페이지 획이 보임 (가림 확인의 기준)', (await darkest(await screen(inkAt.x, inkAt.y))) < 120)
  const id2 = await eng<string>('addSheet', 0, 'right')
  await eng('moveSheet', id2, inkAt.x - 150, inkAt.y - 150)
  await sleep(150)
  check('새 용지는 무지·불투명', (await sheetOf(id2)).background.type === 'blank' && !(await sheetOf(id2)).sheet.transparent)
  check('불투명 용지 → 아래 획 가림', (await darkest(await screen(inkAt.x, inkAt.y))) > 240)
  const head2 = `.sheet-frame[data-sheet-id="${id2}"] .sheet-head`
  await p.locator(`${head2} .sheet-menu-btn`).click()
  await p.getByRole('button', { name: '속지 줄' }).click()
  check('메뉴 → 속지 줄', (await sheetOf(id2)).background.type === 'lined' && (await p.getByRole('button', { name: '속지 줄' }).getAttribute('aria-pressed')) === 'true')
  await p.getByRole('button', { name: '속지 투명' }).click()
  await p.keyboard.press('Escape')
  await sleep(150)
  check('메뉴 → 투명 (속지는 기억)', (await sheetOf(id2)).sheet.transparent === true && (await sheetOf(id2)).background.type === 'lined')
  check('투명 용지 → 아래 획이 비쳐 보임', (await darkest(await screen(inkAt.x, inkAt.y))) < 120)
  await draw(await screen(inkAt.x - 40, inkAt.y + 60), await screen(inkAt.x + 40, inkAt.y + 80))
  check('투명 용지 위 획 → 용지 소속', (await strokePages()).filter((x) => x === id2).length === 1)
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setTool('eraser'))
  await draw(await screen(inkAt.x - 70, inkAt.y), await screen(inkAt.x + 70, inkAt.y))
  await p.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setTool('pen'))
  check('투명 용지 위 지우개 → 비쳐 보이는 페이지 획도 지움', (await pageStrokes()) === pageInk0 - 1)
  await eng('undo')
  check('Undo → 페이지 획 복원', (await pageStrokes()) === pageInk0)
  await eng('undo')
  await eng('undo')
  check('Undo → 다시 불투명·줄', !(await sheetOf(id2)).sheet.transparent && (await sheetOf(id2)).background.type === 'lined')
  await eng('flush')
  const persisted = await p.evaluate(async ([docId, id2]) => {
    const r = await import('/src/storage/repo.ts')
    const s = (await r.loadDocument(docId)).sheets.find((x) => x.id === id2)
    return s ? { bg: s.background.type, tr: !!s.sheet!.transparent } : null
  }, [docId, id2] as const)
  check('속지 저장', persisted?.bg === 'lined' && !persisted.tr, JSON.stringify(persisted))

  check('보조 용지: 페이지 오류 없음', errs.length === 0, errs.join(' | '))
  await p.context().close()
}

