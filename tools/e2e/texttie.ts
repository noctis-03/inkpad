// 문서(text 모드) 같은 자리 동시 끼워 넣기 — 두 기기가 같은 줄 뒤에 따로 새 줄을 넣고 합친 뒤,
// 순서가 두 기기에서 같고, 순서 키가 같은 두 줄 사이에도 Enter·옮기기·복제·붙여넣기·새 줄이 된다
import type { Page } from 'playwright'
import { createFakeDrive } from './fake-drive.ts'
import { device, openEditor, sleep, type Ctx } from './lib.ts'

const push = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pushNow())
const pull = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pullNow())
const deviceId = (p: Page) => p.evaluate(async () => (await import('/src/sync/token.ts')).getDeviceId())
const texts = (p: Page, docId: string) =>
  p.evaluate(async (docId) => (await (await import('/src/storage/repo.ts')).loadTextBlocks(docId)).map((b) => b.html).join('|'), docId)
/** 예전 앱처럼 무작위 글자 없이 이웃 사이 키로 끼워 넣는다 — 두 기기에서 같은 키가 나온다 */
const legacyInsertAfter = (p: Page, docId: string, afterId: string, id: string, html: string) =>
  p.evaluate(
    async ([docId, afterId, id, html]) => {
      await new Promise((r) => setTimeout(r, 15))
      const r = await import('/src/storage/repo.ts')
      const f = await import('/src/shared/fracIndex.ts')
      const list = await r.loadTextBlocks(docId)
      const i = list.findIndex((x) => x.id === afterId)
      const now = Date.now()
      const pos = f.keyBetween(list[i].pos, list[i + 1]?.pos ?? null)
      await r.saveTextBatch({ documentId: docId, upsert: [{ id, documentId: docId, type: 'p', html, indent: 0, pos, createdAt: now, updatedAt: now }] })
      return pos
    },
    [docId, afterId, id, html] as const
  )
const mergeFrom = (p: Page, docId: string, dev: string) =>
  p.evaluate(
    async ([docId, dev]) => {
      const s = await import('/src/sync/sync.ts')
      const entry = (await s.listMergeQueue()).find((e) => e.docId === docId && e.deviceId === dev)!
      const session = await s.openMerge(entry)
      return (await s.commitMerge(session, { discard: new Set(), flip: new Set(), move: new Map(), color: new Map() })).applied
    },
    [docId, dev] as const
  )
const openText = async (p: Page, base: string, docId: string) => {
  await openEditor(p, base, docId).catch(() => {})
  await p.waitForFunction(() => !!(window as unknown as { inkpadText?: unknown }).inkpadText && !!document.querySelector('.tdoc-blocks .tb-row'))
}
const typeAfter = async (p: Page, rowText: string, add: string) => {
  await p.locator('.tb-row', { hasText: rowText }).locator('.tb-text').click()
  await p.keyboard.press('End')
  await p.keyboard.press('Enter')
  await p.keyboard.type(add)
  await sleep(300)
  await p.evaluate(() => (window as unknown as { inkpadText: { commitTyping(): void; flush(): Promise<void> } }).inkpadText.flush())
}

export default async function texttie(ctx: Ctx) {
  const { base, check } = ctx
  const drive = createFakeDrive()
  const A = await device(ctx, { drive, name: 'PC' })
  const B = await device(ctx, { drive, name: 'iPad' })
  const errs: string[] = []
  for (const p of [A, B]) p.on('pageerror', (e) => errs.push(String(e)))
  const devA = await deviceId(A)

  // ── 모델: 순서 키가 같은 두 블록 사이에 끼우기 (Enter·새 줄·옮기기·복제·붙여넣기, 되돌리기) ──
  const model = await A.evaluate(async () => {
    const { TextDocModel } = await import('/src/textdoc/model.ts')
    type TB = import('/src/shared/model.ts').TextBlock
    const mk = (id: string, pos: string): TB => ({ id, documentId: 'd', type: 'p', html: id, indent: 0, pos, createdAt: 0, updatedAt: 0 })
    const fresh = () => new TextDocModel('d', [mk('a', 'i'), mk('X', 'n'), mk('Y', 'n'), mk('c', 'r')], async () => {})
    const ids = (m: InstanceType<typeof TextDocModel>) => m.blocks.map((b) => (/^[aXYc]$/.test(b.id) ? b.id : b.html || '_')).join(' ')
    const out: Record<string, string> = {}
    const run = (name: string, f: (m: InstanceType<typeof TextDocModel>) => void) => {
      const m = fresh()
      try {
        f(m)
        out[name] = ids(m)
        m.undo()
        out[name + ':undo'] = ids(m) + (m.blocks.find((b) => b.id === 'X')!.pos === 'n' ? '' : ' (X 키 안 돌아옴)')
      } catch (e) {
        out[name] = '오류: ' + (e as Error).message
      }
    }
    out.start = ids(fresh())
    run('split', (m) => m.split('X', 'X', 'new'))
    run('makeBlock', (m) => m.exec([{ before: null, after: m.makeBlock('X', { html: 'new' }) }]))
    run('move', (m) => m.move('a', 'Y'))
    run('duplicate', (m) => m.duplicate('X'))
    run('paste', (m) => m.pasteLines('X', 'X', '', [{ type: 'p', html: 'p1' }, { type: 'p', html: 'p2' }]))
    run('after Y', (m) => m.split('Y', 'Y', 'new'))
    return out
  })
  check('모델: 출발 — X·Y 키가 같다', model.start === 'a X Y c', model.start)
  check('모델: X 끝에서 Enter(나누기) → X 새 줄 Y', model.split === 'a X new Y c' && model['split:undo'] === 'a X Y c', `${model.split} / ${model['split:undo']}`)
  check('모델: X 뒤에 새 줄(+ 단추·구분선 등)', model.makeBlock === 'a X new Y c' && model['makeBlock:undo'] === 'a X Y c', `${model.makeBlock} / ${model['makeBlock:undo']}`)
  check('모델: X·Y 사이로 끌어 옮기기', model.move === 'X a Y c' && model['move:undo'] === 'a X Y c', `${model.move} / ${model['move:undo']}`)
  check('모델: X 복제 → 복사본이 X 바로 뒤', model.duplicate === 'a X X Y c' && model['duplicate:undo'] === 'a X Y c', `${model.duplicate} / ${model['duplicate:undo']}`)
  check('모델: X에 여러 줄 붙여넣기', model.paste === 'a X p2 Y c' && model['paste:undo'] === 'a X Y c', `${model.paste} / ${model['paste:undo']}`)
  check('모델: 같은 키가 아닌 자리(Y 뒤)는 그대로', model['after Y'] === 'a X Y new c', model['after Y'])

  // ── 두 기기 — 예전 키로 같은 자리에 끼워 넣어 키가 같아진 문서 ──
  const D = await A.evaluate(async () => {
    const r = await import('/src/storage/repo.ts')
    const f = await import('/src/shared/fracIndex.ts')
    const doc = await r.createDocument({ title: '같은 자리', mode: 'text', folderId: null, pages: [] })
    const first = await r.loadTextBlocks(doc.id)
    const keys = f.keysBetween(null, null, 2)
    const now = Date.now()
    await r.saveTextBatch({
      documentId: doc.id,
      delete: first.map((b) => b.id),
      upsert: [['a', '하나'], ['b', '둘']].map(([id, html], i) => ({ id, documentId: doc.id, type: 'p' as const, html, indent: 0, pos: keys[i], createdAt: now, updatedAt: now }))
    })
    return doc.id
  })
  await push(A)
  await pull(B)
  const pa = await legacyInsertAfter(A, D, 'a', 't1', 'PC 줄')
  const pb = await legacyInsertAfter(B, D, 'a', 't2', 'iPad 줄')
  check('예전 키: 두 기기가 같은 자리에 넣은 줄의 키가 같다', pa === pb, `${pa} ${pb}`)
  await push(B)
  await push(A)
  check('합치기: 두 줄 모두 남음', (await mergeFrom(B, D, devA)) && (await texts(B, D)) === '하나|PC 줄|iPad 줄|둘', await texts(B, D))
  await pull(A)
  check('…두 기기 순서가 같음', (await texts(A, D)) === (await texts(B, D)), await texts(A, D))

  // 키가 같은 두 줄 사이에서 Enter
  await openText(A, base, D)
  await typeAfter(A, 'PC 줄', '사이에 새 줄')
  check('같은 키 두 줄 사이에서 Enter → 새 줄이 그 사이에', (await texts(A, D)) === '하나|PC 줄|사이에 새 줄|iPad 줄|둘', await texts(A, D))
  await push(A)
  await pull(B)
  check('…다른 기기도 같은 순서', (await texts(B, D)) === '하나|PC 줄|사이에 새 줄|iPad 줄|둘', await texts(B, D))

  // ── 두 기기 — 지금 편집기로 같은 줄 뒤에 Enter → 합쳐도 둘 다 남고 같은 순서, 그 사이에서도 Enter ──
  await openText(B, base, D)
  await typeAfter(A, '하나', 'PC가 Enter')
  await typeAfter(B, '하나', 'iPad가 Enter')
  await push(B)
  await push(A)
  check('편집기로 같은 자리: 합치기', await mergeFrom(B, D, devA))
  await pull(A)
  const ta = await texts(A, D)
  const tb = await texts(B, D)
  check('…두 줄 모두 "하나" 바로 뒤에, 두 기기 순서가 같음', ta === tb && /^하나\|(PC가 Enter\|iPad가 Enter|iPad가 Enter\|PC가 Enter)\|PC 줄\|/.test(ta), `${ta} / ${tb}`)
  await A.waitForFunction(() => [...document.querySelectorAll('.tdoc-blocks .tb-text')].some((e) => e.textContent === 'iPad가 Enter'), null, { timeout: 15000 }).catch(() => {})
  const firstNew = ta.split('|')[1]
  await typeAfter(A, firstNew, '그 사이')
  const t2 = (await texts(A, D)).split('|')
  check('…그 둘 사이에서도 Enter', t2[1] === firstNew && t2[2] === '그 사이' && t2.length === ta.split('|').length + 1, t2.join('|'))

  await sleep(100)
  check('같은 자리 끼워 넣기: 페이지 오류 없음', errs.length === 0, errs.join(' | '))
  await A.context().close()
  await B.context().close()
}
