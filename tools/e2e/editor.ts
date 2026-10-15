// 편집 화면: 탭 잠금(Web Locks), 열린 노트 보호(동기화 적용 중 멈췄다 다시 열기), 마이그레이션 백업
import type { Page } from 'playwright'
import { createDoc, device, drawStroke, logsOf, openEditor, sleep, type Ctx } from './lib.ts'

export default async function editor(ctx: Ctx) {
  const { base, check } = ctx
  const boot = await device(ctx)
  const context = boot.context()
  const docId = await createDoc(boot, '검증 노트')
  await boot.close()

  const tab = async () => {
    const p = await context.newPage()
    p.on('console', (m) => {
      if (m.type() === 'warning' || m.type() === 'error') ((p as Page & { logs: string[] }).logs ||= []).push(m.text())
    })
    await openEditor(p, base, docId)
    return p
  }
  const readOnly = (p: Page) => p.evaluate(() => (window as unknown as { inkpad: { readOnly: boolean } }).inkpad.readOnly)

  // ── 탭 잠금 ──
  const a = await tab()
  const b = await tab()
  check('탭 잠금: 먼저 연 탭은 편집 가능', !(await readOnly(a)))
  check('탭 잠금: 나중에 연 탭은 읽기 전용', await readOnly(b))
  check('탭 잠금: 읽기 전용 탭에는 펜 도구 막대가 없다', (await b.locator('[role="toolbar"]').count()) === 0 && (await a.locator('[role="toolbar"]').count()) > 0)
  await a.close()
  await sleep(300)
  const c = await tab()
  check('탭 잠금: 편집하던 탭을 닫으면 새로 연 탭이 편집 가능', !(await readOnly(c)))
  await b.close()
  await c.close()
  await sleep(300)
  const [d1, d2] = await Promise.all([tab(), tab()])
  const ro = [await readOnly(d1), await readOnly(d2)]
  check('탭 잠금: 동시에 연 두 탭 중 정확히 하나만 편집 가능', ro.filter((v) => !v).length === 1, JSON.stringify(ro))
  const editable = ro[0] ? d2 : d1
  await (ro[0] ? d1 : d2).close()
  await editable.evaluate(async (id) => {
    const { useUI } = await import('/src/app/store.ts')
    useUI.getState().navigate({ name: 'library' })
    await new Promise((r) => setTimeout(r, 30))
    useUI.getState().navigate({ name: 'editor', docId: id })
  }, docId)
  await editable.waitForFunction(() => !!(window as unknown as { inkpad?: unknown }).inkpad && !document.querySelector('.doc-skeleton'))
  await sleep(200)
  check('탭 잠금: 같은 탭에서 닫고 곧바로 다시 열어도 편집 가능', !(await readOnly(editable)))
  await editable.close()
  await sleep(300)

  // ── 열린 노트 보호 ──
  const p = await tab()
  await drawStroke(p) // 획 A — 저장 대기(0.5초)가 끝나기 전에 곧바로 동기화가 들어온다
  const oldEngine = await p.evaluateHandle(() => (window as unknown as { inkpad: unknown }).inkpad)
  const result = await p.evaluate(async (id) => {
    const g = await import('/src/storage/docGuard.ts')
    const ap = await import('/src/sync/apply.ts')
    const pk = await import('/src/sync/pack.ts')
    return g.withDocExclusive(id, async () => {
      const f = await pk.packDocument(id)
      const localIds = f.chunks.flatMap((ch) => ch.elements.map((e) => e.id))
      const pageId = f.pages[0].id
      const remote = { id: 'REMOTE-STROKE', type: 'stroke' as const, layer: 'main' as const, z: 999, createdAt: 0, tool: 'pen' as const, color: '#c4302bff', width: 3, points: [100, 400, 0.5, 0, 300, 420, 0.5, 16], bbox: [97, 397, 303, 423] as [number, number, number, number], opts: { thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false } }
      let chunk = f.chunks.find((ch) => ch.pageId === pageId)
      if (!chunk) f.chunks.push((chunk = { pageId, key: '0_0', elements: [] }))
      chunk.elements.push(remote)
      await ap.applyDocFile(f, { force: true })
      const eng = (window as unknown as { inkpad?: { destroyed?: boolean; readOnly?: boolean } }).inkpad
      return { localIds, suspendedDuring: !eng || eng.destroyed === true || eng.readOnly === true }
    })
  }, docId)
  check('노트 보호: 동기화가 읽은 이 기기 상태에 막 그린 획이 들어 있다', result.localIds.length === 1, JSON.stringify(result.localIds))
  check('노트 보호: 적용하는 동안 편집 화면은 멈춰 있다', result.suspendedDuring)
  await p.waitForFunction((old) => {
    const w = window as unknown as { inkpad?: unknown }
    return !!w.inkpad && w.inkpad !== old && !document.querySelector('.doc-skeleton')
  }, oldEngine, { timeout: 10000 })
  const count = () => p.evaluate(() => (window as unknown as { inkpad: { scene: { size: number } } }).inkpad.scene.size)
  check('노트 보호: 적용 뒤 편집 화면이 다시 열려 받은 획이 보인다', (await count()) === 2, String(await count()))
  check('노트 보호: 다시 연 편집 화면은 편집 가능', !(await readOnly(p)))
  await drawStroke(p, 60) // 획 B
  await sleep(1200)
  const saved = await p.evaluate(async (id) => {
    const r = await import('/src/storage/repo.ts')
    return (await r.loadDocument(id)).chunks.flatMap((ch) => ch.elements.map((e) => e.id))
  }, docId)
  check('노트 보호: 이후 편집을 저장해도 받은 획이 덮이지 않는다', saved.length === 3 && saved.includes('REMOTE-STROKE'), JSON.stringify(saved))
  const warn = logsOf(p).filter((t) => t.includes('노트 보호(withDocExclusive) 밖'))
  check('노트 보호: 보호 밖 적용 경고 없음', warn.length === 0, warn.join(' | '))

  const q = await context.newPage()
  await q.goto(base + '/')
  await q.waitForSelector('#root *')
  const busy = await q.evaluate(async (id) => {
    const g = await import('/src/storage/docGuard.ts')
    try {
      await g.withDocExclusive(id, async () => 'ran')
      return 'ran'
    } catch (e) {
      return (e as Error).name
    }
  }, docId)
  check('노트 보호: 다른 탭에서 편집 중인 노트는 건너뛴다(DocBusyError)', busy === 'DocBusyError', busy)

  // ── 마이그레이션 백업 ──
  const backup = await q.evaluate(async () => {
    const r = await import('/src/storage/repo.ts')
    const m = await import('/src/shared/model.ts')
    const { db } = await import('/src/storage/db.ts')
    const { gzipJson, gunzipJson } = await import('/src/storage/compress.ts')
    const doc = await r.createDocument({ title: '옛 스키마', mode: 'paged', folderId: null, pages: [{ size: { w: 595.28, h: 841.89 }, background: m.makeBackground('blank') }] })
    const pageId = doc.pageOrder[0]
    const el = [{ id: 'OLD', type: 'stroke', layer: 'main', z: 1, createdAt: 0, tool: 'pen', color: '#000000ff', width: 2, points: [0, 0, 0.5, 0], bbox: [0, 0, 1, 1], opts: {} }]
    await db.chunks.put({ pageId, key: '0_0', documentId: doc.id, schemaVersion: 1, data: await gzipJson(el), count: 1, updatedAt: 0 } as never)
    await r.loadDocument(doc.id)
    await r.loadDocument(doc.id) // 두 번 열어도 백업은 하나
    const rows = (await db.backups.toArray()).filter((b) => b.id.startsWith('pre-migration:' + doc.id))
    const payload = JSON.parse(await rows[0].data.text())
    const bin = Uint8Array.from(atob(payload.chunks[0].data), (ch) => ch.charCodeAt(0))
    const restored = await gunzipJson<{ id: string }[]>(new Blob([bin]))
    return { count: rows.length, restoredId: restored[0]?.id }
  })
  check('마이그레이션 백업: 노트마다 한 번만', backup.count === 1, String(backup.count))
  check('마이그레이션 백업: 원래 획을 복원할 수 있다', backup.restoredId === 'OLD', String(backup.restoredId))
  await context.close()
}
