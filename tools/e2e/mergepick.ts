// 머지 화면에서 페이지·보조 용지·편집 블록을 하나씩 고르기 — 두 기기가 같은 노트의 메모·속지·용지를 각각 고친 뒤
// 패널 목록에서 어느 쪽을 쓸지·버릴지 고르고, 미리보기에 블록이 그려지고, 고른 대로 최종 머지된다
import type { Page } from 'playwright'
import { createFakeDrive } from './fake-drive.ts'
import { addStroke, createDoc, device, sleep, type Ctx } from './lib.ts'

const push = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pushNow())
const pull = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pullNow())

type Blk = { id: string; type: string; pageId: string; x: number; y: number; w: number; data: Record<string, unknown>; deletedAt?: number }
type Pg = { id: string; background: { type: string }; sheet?: { title: string } }

/** 편집 블록을 저장한다 (없으면 만든다) */
const putBlock = (p: Page, docId: string, id: string, patch: Record<string, unknown>) =>
  p.evaluate(
    async ([docId, id, patch]) => {
      await new Promise((r) => setTimeout(r, 15))
      const r = await import('/src/storage/repo.ts')
      const d = await r.loadDocument(docId)
      const cur = (await r.loadBlocks(docId)).find((b) => b.id === id)
      const now = Date.now()
      const base = cur ?? { id, documentId: docId, pageId: d.pages[0].id, schemaVersion: 1, type: 'memo', x: 60, y: 60, w: 200, z: 1, createdAt: now, data: { text: '', color: 'yellow', collapsed: false } }
      await r.saveBatch({ documentId: docId, blocksUpsert: [{ ...base, ...patch, updatedAt: now } as never] })
    },
    [docId, id, patch] as const
  )
/** 첫 페이지의 속지(bg) 또는 보조 용지의 제목(title)을 바꿔 저장한다 */
const putPage = (p: Page, docId: string, which: 'first' | string, change: { bg?: 'lined' | 'grid'; title?: string }) =>
  p.evaluate(
    async ([docId, which, change]) => {
      await new Promise((r) => setTimeout(r, 15))
      const r = await import('/src/storage/repo.ts')
      const m = await import('/src/shared/model.ts')
      const d = await r.loadDocument(docId)
      const pg = which === 'first' ? d.pages[0] : d.sheets.find((s) => s.id === which)!
      const next = { ...pg, updatedAt: Date.now() }
      if (change.bg) next.background = m.makeBackground(change.bg)
      if (change.title !== undefined) next.sheet = { ...pg.sheet!, title: change.title }
      await r.saveBatch({ documentId: docId, pagesUpsert: [next] })
    },
    [docId, which, change] as const
  )

export default async function mergepick(ctx: Ctx) {
  const { base, check } = ctx
  const drive = createFakeDrive()
  const A = await device(ctx, { drive, name: 'PC' })
  const B = await device(ctx, { drive, name: 'iPad' })
  const errs: string[] = []
  for (const p of [A, B]) p.on('pageerror', (e) => errs.push(String(e)))
  const cloud = (docId: string) => drive.ungz(drive.docFile(docId)!.revisions.at(-1)!.content) as { blocks?: Blk[]; pages: Pg[] }

  // ── 같은 노트: 메모 둘·할 일 하나·보조 용지 하나 ──
  const D = await createDoc(A, '고르기 노트')
  await addStroke(A, D, 's1')
  await putBlock(A, D, 'm1', { x: 60, y: 120, data: { text: '처음 메모', color: 'yellow', collapsed: false } })
  await putBlock(A, D, 't1', { type: 'todo', x: 320, y: 120, w: 210, data: { items: [{ id: 'i1', text: '장보기', done: false }] } })
  const sheetId = await A.evaluate(async (docId) => {
    const r = await import('/src/storage/repo.ts')
    const m = await import('/src/shared/model.ts')
    const d = await r.loadDocument(docId)
    const now = Date.now()
    const sheet = { id: 'sh1', documentId: docId, schemaVersion: m.SCHEMA_VERSION, size: { w: 300, h: 400 }, background: m.makeBackground('blank'), sheet: { anchorPageId: d.pages[0].id, x: 0, y: 0, snap: 'right' as const, title: '연습장', z: 1 }, createdAt: now, updatedAt: now, version: 1 }
    await r.saveBatch({ documentId: docId, pagesUpsert: [sheet] })
    return sheet.id
  }, D)
  await push(A)
  await pull(B)

  // ── 갈라짐 ──
  // iPad(먼저 올림 → main): 메모 글, 속지(줄), 할 일 옮김, 새 메모 n2
  await putBlock(B, D, 'm1', { data: { text: 'iPad 메모', color: 'yellow', collapsed: false } })
  await putPage(B, D, 'first', { bg: 'lined' })
  await putBlock(B, D, 't1', { x: 340, y: 300 })
  await putBlock(B, D, 'n2', { x: 60, y: 500, data: { text: 'iPad 새 메모', color: 'blue', collapsed: false } })
  // PC(브랜치, 머지하는 기기): 같은 메모 글, 속지(모눈), 용지 제목, 새 메모 n1
  await putBlock(A, D, 'm1', { data: { text: 'PC 메모', color: 'yellow', collapsed: false } })
  await putPage(A, D, 'first', { bg: 'grid' })
  await putPage(A, D, sheetId, { title: 'PC 연습장' })
  await putBlock(A, D, 'n1', { x: 60, y: 300, data: { text: 'PC 새 메모', color: 'pink', collapsed: false } })
  await push(B)
  await push(A)

  // ── PC에서 머지 화면 ──
  await A.goto(base + '/')
  await A.waitForSelector('#root *')
  await A.evaluate(async (docId) => {
    const entry = (await (await import('/src/sync/sync.ts')).listMergeQueue()).find((e) => e.docId === docId && e.mine)!
    ;(await import('/src/ui/merge/MergeView.tsx')).openMergeView(entry)
  }, D)
  await A.waitForSelector('.merge-items .merge-item', { timeout: 15000 })
  const rows = async () =>
    A.evaluate(() =>
      [...document.querySelectorAll('.merge-items .merge-item')].map((r) => ({
        name: r.querySelector('.merge-item-name')?.textContent ?? '',
        info: r.querySelector('.merge-item-info')?.textContent ?? '',
        side: r.querySelector('[role=radio][aria-checked=true]')?.textContent ?? '',
        discarded: r.classList.contains('discarded')
      }))
    )
  const r0 = await rows()
  const row = (name: string) => r0.find((r) => r.name.startsWith(name))
  check('패널: 페이지·용지·블록 목록 (공통은 빼고 6개)', r0.length === 6, JSON.stringify(r0))
  check('…페이지: 속지 다름 · 양쪽이 고침, 기본은 머지하는 기기(브랜치)', row('p.1 페이지')?.info === '속지 다름 · 양쪽이 고침' && row('p.1 페이지')?.side === '브랜치', JSON.stringify(row('p.1 페이지')))
  check('…보조 용지: 제목 다름, 한쪽만 고침 → 브랜치 (이름은 고른 쪽 제목)', row('보조 용지 · PC 연습장')?.info === '제목 다름' && row('보조 용지')?.side === '브랜치', JSON.stringify(row('보조 용지')))
  check('…메모(양쪽이 고침): 내용 다름 · 기본 브랜치', !!r0.find((r) => r.name === '메모 “PC 메모”' && r.info === 'p.1 · 내용 다름 · 양쪽이 고침' && r.side === '브랜치'), JSON.stringify(r0))
  check('…할 일(main만 옮김): 위치 다름 → main', !!r0.find((r) => r.name === '할 일 “장보기”' && r.info === 'p.1 · 위치 다름' && r.side === 'main'), JSON.stringify(r0))
  check('…한쪽에만 있는 새 메모 둘', !!r0.find((r) => r.name === '메모 “PC 새 메모”' && r.info.endsWith('PC 브랜치에만')) && !!r0.find((r) => r.name === '메모 “iPad 새 메모”' && r.info.includes('main')), JSON.stringify(r0))

  // 미리보기에 블록이 그려진다 — 분홍 메모(n1) 자리의 색
  await sleep(600)
  const pink = await A.evaluate(() => {
    const c = document.querySelector('.merge-page canvas.merge-canvas') as HTMLCanvasElement
    const k = c.width / 595.28
    const d = c.getContext('2d')!.getImageData(Math.round((60 + 200 - 14) * k), Math.round((300 + 50) * k), 1, 1).data
    return [d[0], d[1], d[2]]
  })
  check('미리보기: 편집 블록을 상자로 그린다 (분홍 메모 색)', pink[0] > 230 && pink[1] > 195 && pink[1] < 230 && pink[2] > 210, pink.join(','))

  // ── 고르기 ──
  const item = (name: string) => A.locator('.merge-items .merge-item', { has: A.locator('.merge-item-name', { hasText: name }) })
  await item('메모 “PC 메모”').getByRole('radio', { name: 'main' }).click()
  await item('메모 “iPad 새 메모”').getByRole('button', { name: '버리기' }).click()
  await item('보조 용지').getByRole('radio', { name: 'main' }).click()
  const r1 = await rows()
  check('메모를 main 쪽으로(이름도 고른 쪽 글), 새 메모 하나 버림, 용지를 main 쪽으로', !!r1.find((r) => r.name === '메모 “iPad 메모”' && r.side === 'main') && !!r1.find((r) => r.name.startsWith('메모 “iPad 새 메모”') && r.discarded) && r1.find((r) => r.name === '보조 용지 · 연습장')?.side === 'main', JSON.stringify(r1))
  // 페이지 머리의 '다른 쪽으로'
  const head = A.locator('.merge-page-head').first()
  check('페이지 머리: 무엇이 다른지와 고른 쪽', ((await head.locator('.merge-chip').textContent()) ?? '').startsWith('속지 다름 → PC 브랜치'), (await head.locator('.merge-chip').textContent()) ?? '')
  await head.getByRole('button', { name: '다른 쪽으로' }).click()
  check('…다른 쪽으로 → main, 패널 목록도 따라감', ((await head.locator('.merge-chip').textContent()) ?? '').includes('→ main') && (await rows()).find((r) => r.name === 'p.1 페이지')?.side === 'main')
  // 되돌리기
  await A.keyboard.press('Control+z')
  check('되돌리기 → 페이지는 다시 브랜치', (await rows()).find((r) => r.name === 'p.1 페이지')?.side === '브랜치')
  check('일괄 스위치 이름: 고친 항목 모두', (await A.locator('.merge-layer [role=radiogroup]').getAttribute('aria-label')) === '고친 항목 모두(획·페이지·블록)를 어느 쪽으로')

  // ── 최종 머지 ──
  await A.getByRole('button', { name: '최종 머지' }).click()
  await A.locator('.dialog-host').getByRole('button', { name: '머지', exact: true }).click()
  await A.waitForSelector('.merge-view', { state: 'detached', timeout: 15000 })
  const f = cloud(D)
  const live = (f.blocks ?? []).filter((b) => !b.deletedAt)
  const byId = new Map(live.map((b) => [b.id, b]))
  check('결과: 메모는 고른 main(iPad) 글', (byId.get('m1')?.data as { text?: string })?.text === 'iPad 메모', JSON.stringify(byId.get('m1')))
  check('…버린 새 메모는 없음, 다른 새 메모는 있음', !byId.has('n2') && byId.has('n1'), [...byId.keys()].join())
  check('…할 일은 main이 옮긴 자리', byId.get('t1')?.y === 300)
  check('…페이지 속지는 기본(브랜치 = PC의 모눈)', f.pages.find((p) => !p.sheet)?.background.type === 'grid', JSON.stringify(f.pages.map((p) => p.background.type)))
  check('…보조 용지 제목은 고른 main 쪽', f.pages.find((p) => p.sheet)?.sheet?.title === '연습장')

  await sleep(100)
  check('머지 고르기: 페이지 오류 없음', errs.length === 0, errs.join(' | '))
  await A.context().close()
  await B.context().close()
}
