// 동기화: 두 기기(저장소가 따로인 브라우저 컨텍스트)가 가짜 Drive를 함께 쓰며 실제 동기화 코드를 돌린다.
// 획 단위 머지, 받을 것 판정, 머지 백업 분리, 업로드 실패, 버전 기록(되돌리기·고정 해제), 원본 정리
import type { Page } from 'playwright'
import { createFakeDrive } from './fake-drive.ts'
import { addStroke, createDoc, device, logsOf, openEditor, sameSet, strokes, type Ctx } from './lib.ts'

const push = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pushNow())
const pull = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pullNow())
const planPullIds = (p: Page) => p.evaluate(async () => (await (await import('/src/sync/sync.ts')).planPull()).docs.map((d) => d.docId))
const cloudState = (p: Page, docId: string) =>
  p.evaluate(async (docId) => (await (await import('/src/sync/sync.ts')).listCloudNotes()).find((n) => n.docId === docId)?.state, docId)
const pendingFor = (p: Page, docId: string) => p.evaluate(async (docId) => (await (await import('/src/sync/unchanged.ts')).pendingSeqsFor(docId)).length, docId)
const revisions = (p: Page, docId: string) => p.evaluate(async (docId) => (await import('/src/sync/revisions.ts')).listDocRevisions(docId), docId)

export default async function sync(ctx: Ctx) {
  const { base, check } = ctx
  const drive = createFakeDrive()
  const A = await device(ctx, { drive, name: 'A' })
  const B = await device(ctx, { drive, name: 'B' })

  // ── 획 단위 머지 · 받을 것 판정 ──
  const D = await createDoc(A, '노트 D')
  await addStroke(A, D, 'a')
  await push(A)
  await pull(B)
  check('B가 노트를 받았다', sameSet(await strokes(B, D), ['a']))
  await addStroke(A, D, 'c') // A가 먼저 고쳐 두고(아직 안 올림)
  await addStroke(B, D, 'b') // B가 나중에 고쳐 먼저 올린다
  await push(B)
  await push(A) // A 올리기 → 머지
  check('머지: A에 양쪽 획이 모두 남는다', sameSet(await strokes(A, D), ['a', 'b', 'c']), JSON.stringify(await strokes(A, D)))
  check('머지: 클라우드 최신본 = 머지 결과', sameSet(drive.headStrokes(D), ['a', 'b', 'c']))
  check('판정: B의 받기 미리보기에 머지 결과가 뜬다', (await planPullIds(B)).includes(D))
  check('판정: B의 클라우드 목록에서 "받을 것"', (await cloudState(B, D)) === 'remote-new', String(await cloudState(B, D)))
  await pull(B)
  check('판정: B가 받기로 머지 결과를 받는다', sameSet(await strokes(B, D), ['a', 'b', 'c']), JSON.stringify(await strokes(B, D)))
  check('판정: 받은 뒤 B의 목록은 최신', (await cloudState(B, D)) === 'same')
  check('판정: A의 받기 미리보기에 자기가 올린 머지는 없다', !(await planPullIds(A)).includes(D))

  // ── 머지 백업은 별도 파일 ──
  const revs = drive.revisionStrokes(drive.docFile(D)!)
  check('백업: 노트 파일 리비전에 A의 머지 전 상태(a,c)가 없다', !revs.some((r) => sameSet(r.strokes, ['a', 'c'])), JSON.stringify(revs.map((r) => r.strokes)))
  const backups = drive.backupsOf(D)
  check('백업: 백업 폴더에 A의 머지 전 상태 파일 1개', backups.length === 1 && sameSet(drive.strokeIds(drive.ungz(backups[0].revisions[0].content)), ['a', 'c']))
  check('백업: 파일 표식(docId·기기·종류)', backups[0]?.appProperties?.docId === D && backups[0]?.appProperties?.device === 'A' && backups[0]?.appProperties?.revKind === 'merge-backup')
  const list = await revisions(A, D)
  const bk = list.find((r) => r.backupFileId)
  check('버전 기록: 백업이 함께 보인다', !!bk && bk.revKind === 'merge-backup' && bk.device === 'A')
  check('버전 기록: 마지막은 클라우드 최신(헤드)', list[list.length - 1].isHead === true)
  check('버전 기록: 다른 기기(B)에도 백업이 보인다', (await revisions(B, D)).some((r) => r.backupFileId))

  // 머지 결과 업로드가 실패해도 클라우드 '현재'는 B의 상태로 남는다
  const E = await createDoc(A, '노트 E')
  await addStroke(A, E, 'x')
  await push(A)
  await pull(B)
  await addStroke(A, E, 'z')
  await addStroke(B, E, 'y')
  await push(B)
  drive.fail.nextDocUpload = true
  await push(A)
  check('업로드 실패: 클라우드 최신본은 B의 상태(x,y) 그대로', sameSet(drive.headStrokes(E), ['x', 'y']), JSON.stringify(drive.headStrokes(E)))
  check('업로드 실패: A의 올리기 대기는 남는다', (await pendingFor(A, E)) > 0)
  await push(A)
  check('업로드 실패: 다시 올리면 머지 결과(x,y,z)', sameSet(drive.headStrokes(E), ['x', 'y', 'z']), JSON.stringify(drive.headStrokes(E)))
  await pull(B)
  check('업로드 실패: B도 x,y,z를 받는다', sameSet(await strokes(B, E), ['x', 'y', 'z']))

  if (bk) await A.evaluate(async ([D, id]) => (await import('/src/sync/revisions.ts')).restoreDocRevision(D, id), [D, bk.id] as const)
  check('버전 기록: 백업으로 되돌리면 A는 머지 전 상태(a,c)', sameSet(await strokes(A, D), ['a', 'c']), JSON.stringify(await strokes(A, D)))

  // ── 고정 해제가 클라우드 최신본을 바꾸지 않는다 ──
  const F = await createDoc(A, '노트 F')
  await addStroke(A, F, 'old')
  await push(A)
  await addStroke(A, F, 'new')
  await push(A)
  await pull(B)
  const fFile = drive.docFile(F)!
  const oldRev = fFile.revisions[0].id
  await A.evaluate(async ([F, r]) => (await import('/src/sync/revisions.ts')).pinDocRevision(F, r), [F, oldRev] as const)
  await A.evaluate(async ([F, r]) => (await import('/src/sync/revisions.ts')).unpinDocRevision(F, r), [F, oldRev] as const)
  check('고정 해제: 클라우드 최신본은 그대로(old,new)', sameSet(drive.headStrokes(F), ['new', 'old']), JSON.stringify(drive.headStrokes(F)))
  check('고정 해제: 고정본은 지워지고 옛 내용은 고정 없는 리비전으로 남는다', !fFile.revisions.some((r) => r.id === oldRev) && drive.revisionStrokes(fFile).some((r) => sameSet(r.strokes, ['old']) && !r.keepForever))
  check('고정 해제: A·B 모두 받을 것 없음', !(await planPullIds(A)).includes(F) && !(await planPullIds(B)).includes(F))

  // ── 원본 정리 ──
  const gc = await A.evaluate(async () => {
    const r = await import('/src/storage/repo.ts')
    const m = await import('/src/shared/model.ts')
    const { db } = await import('/src/storage/db.ts')
    const old = Date.now() - 3600_000
    const asset = (id: string, kind: 'pdf' | 'image', createdAt: number) => ({ id, kind, mime: kind === 'pdf' ? 'application/pdf' : 'image/png', size: 1, sha256: id, createdAt, version: 0, blob: new Blob(['x']) })
    await db.assets.bulkPut([asset('IMG-USED', 'image', old), asset('ORPHAN-OLD', 'pdf', old), asset('ORPHAN-NEW', 'image', Date.now())])
    const g = await r.createDocument({ title: '이미지 노트', mode: 'paged', folderId: null, pages: [{ size: { w: 595, h: 842 }, background: m.makeBackground('blank') }] })
    await r.saveBatch({ documentId: g.id, chunks: [{ pageId: g.pageOrder[0], key: '0_0', elements: [{ id: 'IMG-EL', type: 'image', layer: 'main', z: 1, createdAt: 0, assetId: 'IMG-USED', x: 0, y: 0, w: 10, h: 10, rotation: 0 }] }] })
    const h = await r.createDocument({ title: '지울 노트', mode: 'paged', folderId: null, pages: [{ size: { w: 595, h: 842 }, background: m.makeBackground('blank') }] })
    await r.purgeDocument(h.id)
    return (await db.assets.toCollection().primaryKeys()).map(String).sort()
  })
  check('원본 정리: 다른 노트의 이미지 원본은 남는다', gc.includes('IMG-USED'), gc.join())
  check('원본 정리: 아무도 안 쓰는 옛 원본은 지운다', !gc.includes('ORPHAN-OLD'))
  check('원본 정리: 방금 가져온 원본(10분 이내)은 남긴다', gc.includes('ORPHAN-NEW'))

  // ── 버전 기록 화면 ──
  await openEditor(A, base, D)
  await A.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setPanel('history'))
  await A.waitForSelector('#version-panel .rev-row')
  await A.waitForTimeout(500)
  const row = A.locator('#version-panel .rev-row', { hasText: '별도 보관' })
  check('버전 기록 화면: "별도 보관" 행이 있고 고정 버튼은 없다', (await row.count()) === 1 && (await row.getByRole('button', { name: /고정/ }).count()) === 0)

  const warn = [...logsOf(A), ...logsOf(B)].filter((t) => /노트 보호\(withDocExclusive\) 밖|미구현/.test(t))
  check('경고 없음: 보호 밖 적용·가짜 Drive 미구현 API', warn.length === 0, warn.join(' | '))
  await A.context().close()
  await B.context().close()
}
