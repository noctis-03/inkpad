// 동기화: 두 기기(저장소가 따로인 브라우저 컨텍스트)가 가짜 Drive를 함께 쓰며 실제 동기화 코드를 돌린다.
// 기기별 브랜치 + main 따라가기(fast-forward), 갈라짐은 덮지 않음, 클라우드에 맞추기, main 쓰기 실패,
// main이 덮였을 때의 감지, 브랜치 이전 기록 호환, 클라우드 삭제, 버전 기록(되돌리기·고정 해제), 원본 정리
import type { Page } from 'playwright'
import { createFakeDrive } from './fake-drive.ts'
import { addStroke, createDoc, device, logsOf, openEditor, sameSet, strokes, type Ctx } from './lib.ts'

const push = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pushNow())
const pull = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pullNow())
const planPull = (p: Page) =>
  p.evaluate(async () => {
    const plan = await (await import('/src/sync/sync.ts')).planPull()
    return { docs: plan.docs.map((d) => d.docId), local: plan.local.map((d) => ({ id: d.docId, sync: d.sync })) }
  })
const cloudState = (p: Page, docId: string) =>
  p.evaluate(async (docId) => (await (await import('/src/sync/sync.ts')).listCloudNotes()).find((n) => n.docId === docId)?.state, docId)
const cardState = (p: Page, docId: string) => p.evaluate(async (docId) => (await (await import('/src/sync/sync.ts')).cardSyncStates()).get(docId), docId)
const pendingFor = (p: Page, docId: string) => p.evaluate(async (docId) => (await (await import('/src/sync/unchanged.ts')).pendingSeqsFor(docId)).length, docId)
const revisions = (p: Page, docId: string) => p.evaluate(async (docId) => (await import('/src/sync/revisions.ts')).listDocRevisions(docId), docId)
const deviceId = (p: Page) => p.evaluate(async () => (await import('/src/sync/token.ts')).getDeviceId())

export default async function sync(ctx: Ctx) {
  const { base, check } = ctx
  const drive = createFakeDrive()
  const A = await device(ctx, { drive, name: 'A' })
  const B = await device(ctx, { drive, name: 'B' })
  const [devA, devB] = [await deviceId(A), await deviceId(B)]
  const mainProps = (docId: string) => drive.docFile(docId)?.appProperties ?? {}

  // ── 따라가기(fast-forward): 한쪽만 바뀌면 main이 그대로 따라온다 ──
  const D = await createDoc(A, '노트 D')
  await addStroke(A, D, 'a')
  await push(A)
  check('ff: 처음 올리면 main이 생긴다(세대 1)', sameSet(drive.headStrokes(D), ['a']) && mainProps(D).gen === '1')
  check('ff: 이 기기 브랜치도 올라간다', sameSet(drive.fileStrokes(drive.branchOf(D, devA)!), ['a']) && drive.branchOf(D, devA)!.appProperties.seq === '1')
  check('ff: main에 A의 브랜치가 반영됐다(m.A=1)', mainProps(D)[`m.${devA}`] === '1')
  await pull(B)
  check('ff: B가 받았다', sameSet(await strokes(B, D), ['a']))
  check('ff: 받은 뒤 B는 최신', (await cloudState(B, D)) === 'same')
  await addStroke(B, D, 'b')
  check('ff: 고치면 올릴 것', (await cloudState(B, D)) === 'pending')
  await push(B)
  check('ff: B가 올리면 main이 따라온다(세대 2)', sameSet(drive.headStrokes(D), ['a', 'b']) && mainProps(D).gen === '2')
  check('ff: B는 올린 뒤 최신', (await cloudState(B, D)) === 'same')
  check('ff: A의 받기 미리보기에 뜬다', (await planPull(A)).docs.includes(D))
  check('ff: A의 클라우드 목록에서 받을 것', (await cloudState(A, D)) === 'remote-new')
  await pull(A)
  check('ff: A가 받아 따라온다', sameSet(await strokes(A, D), ['a', 'b']))
  check('ff: 받은 뒤 A는 최신이고 받을 것 없음', (await cloudState(A, D)) === 'same' && !(await planPull(A)).docs.includes(D))
  check('ff: 머지 백업 파일을 만들지 않는다', drive.backupsOf(D).length === 0)

  // ── 갈라짐: 양쪽이 각각 고치면 아무것도 덮지 않는다 ──
  await addStroke(A, D, 'c') // A가 고쳐 두고(아직 안 올림)
  await addStroke(B, D, 'd') // B가 고쳐 먼저 올린다
  await push(B)
  await push(A) // A는 main이 바뀐 것을 보고 브랜치에만 올린다
  check('갈라짐: main은 B의 내용 그대로(a,b,d)', sameSet(drive.headStrokes(D), ['a', 'b', 'd']), JSON.stringify(drive.headStrokes(D)))
  check('갈라짐: A의 변경은 A 브랜치에(a,b,c)', sameSet(drive.fileStrokes(drive.branchOf(D, devA)!), ['a', 'b', 'c']))
  check('갈라짐: A 노트는 그대로(a,b,c)', sameSet(await strokes(A, D), ['a', 'b', 'c']))
  check('갈라짐: A의 올리기 대기는 내려간다(브랜치에 있으므로)', (await pendingFor(A, D)) === 0)
  check('갈라짐: A 목록 상태', (await cloudState(A, D)) === 'diverged', String(await cloudState(A, D)))
  check('갈라짐: A 카드 상태', (await cardState(A, D)) === 'diverged', String(await cardState(A, D)))
  const planA = await planPull(A)
  check('갈라짐: 받기 미리보기는 그냥 받지 않고 "이 기기 내용이 덮이는 노트"로 고르게 한다', !planA.docs.includes(D) && planA.local.some((l) => l.id === D && l.sync === 'diverged'))
  await pull(A)
  check('갈라짐: 받기가 A 노트를 덮지 않는다', sameSet(await strokes(A, D), ['a', 'b', 'c']))
  check('갈라짐: main에 A의 두 번째 업로드는 반영되지 않았다', mainProps(D)[`m.${devA}`] === '1' && drive.branchOf(D, devA)!.appProperties.seq === '2')

  // ── 클라우드에 맞추기: main으로 덮고, A 브랜치 내용은 버린 것으로 표시(파일은 남는다) ──
  await A.evaluate(async (D) => (await import('/src/sync/sync.ts')).alignWithCloud(D), D)
  check('맞추기: A가 main 내용(a,b,d)', sameSet(await strokes(A, D), ['a', 'b', 'd']))
  check('맞추기: A는 최신', (await cloudState(A, D)) === 'same', String(await cloudState(A, D)))
  check('맞추기: A 브랜치 파일은 남고 버림 표식', sameSet(drive.fileStrokes(drive.branchOf(D, devA)!), ['a', 'b', 'c']) && drive.branchOf(D, devA)!.appProperties.resolved === '2')
  await addStroke(A, D, 'e')
  await push(A)
  check('맞추기: 그 뒤 A가 고쳐 올리면 다시 따라간다', sameSet(drive.headStrokes(D), ['a', 'b', 'd', 'e']) && mainProps(D)[`m.${devA}`] === '3')

  // 맞추기는 올리지 않은 변경을 먼저 브랜치에 올려 둔다
  await addStroke(A, D, 'lost?')
  await pull(B) // B는 A가 올린 e까지 받은 뒤 고친다 — 한쪽만 바뀐 것이 되어 main이 따라간다
  await addStroke(B, D, 'f')
  await push(B)
  await A.evaluate(async (D) => (await import('/src/sync/sync.ts')).alignWithCloud(D), D)
  check('맞추기: 올리지 않은 변경은 브랜치에 올리지 않는다(데이터 절약)', !drive.fileStrokes(drive.branchOf(D, devA)!).includes('lost?'))
  const snapA = await A.evaluate(async (D) => {
    const sn = await import('/src/sync/snapshots.ts')
    const last = (await sn.listSnapshots(D))[0]
    const file = await sn.loadSnapshot(last.id)
    return { why: last.why, ids: file.chunks.flatMap((c) => c.elements.map((e) => e.id)) }
  }, D)
  check('맞추기: 덮기 전 내용은 이 기기 스냅샷으로 남는다', snapA.why === 'align' && snapA.ids.includes('lost?'), JSON.stringify(snapA))
  check('맞추기: A 노트는 main(f 포함)', (await strokes(A, D)).includes('f') && !(await strokes(A, D)).includes('lost?'))

  // ── main 쓰기 실패: 대기가 남고, 다시 올리면 따라간다 ──
  const E = await createDoc(A, '노트 E')
  await addStroke(A, E, 'x')
  await push(A)
  await pull(B)
  await addStroke(B, E, 'y')
  drive.fail.nextDocUpload = true
  await push(B)
  check('쓰기 실패: main은 그대로(x)', sameSet(drive.headStrokes(E), ['x']))
  check('쓰기 실패: B 브랜치에는 올라갔다(x,y)', sameSet(drive.fileStrokes(drive.branchOf(E, devB)!), ['x', 'y']))
  check('쓰기 실패: B의 올리기 대기는 남는다', (await pendingFor(B, E)) > 0)
  check('쓰기 실패: B는 갈라짐이 아니라 올릴 것', (await cloudState(B, E)) === 'pending', String(await cloudState(B, E)))
  await push(B)
  check('쓰기 실패: 다시 올리면 main이 따라온다(x,y)', sameSet(drive.headStrokes(E), ['x', 'y']))
  await pull(A)
  check('쓰기 실패: A도 x,y를 받는다', sameSet(await strokes(A, E), ['x', 'y']))

  // ── main이 다른 기기에 덮이면(동시에 따라가기) 진 쪽은 갈라짐으로 보인다 ──
  const F = await createDoc(A, '노트 F')
  await addStroke(A, F, 'f1')
  await push(A)
  await addStroke(A, F, 'f2')
  await push(A)
  const fMain = drive.docFile(F)!
  // 다른 기기가 같은 세대에서 동시에 따라가 A의 쓰기를 덮은 것처럼 — 새 신원, A의 두 번째 업로드는 반영 안 됨
  fMain.appProperties = { ...fMain.appProperties, mid: 'someoneelse', midU: fMain.appProperties.updatedAt, [`m.${devA}`]: '1' }
  check('덮임: A는 갈라짐으로 본다', (await cloudState(A, F)) === 'diverged', String(await cloudState(A, F)))
  await pull(A)
  check('덮임: A 노트를 덮지 않는다', sameSet(await strokes(A, F), ['f1', 'f2']))
  check('덮임: A의 내용은 A 브랜치에 있다', sameSet(drive.fileStrokes(drive.branchOf(F, devA)!), ['f1', 'f2']))

  // ── 브랜치 이전 기록 호환: 예전 방식으로 맞춘 노트 ──
  const G = await createDoc(A, '노트 G')
  await addStroke(A, G, 'g1')
  await push(A)
  await pull(B)
  const forgetBranch = (p: Page, docId: string) => p.evaluate(async (docId) => (await import('/src/storage/db.ts')).db.syncState.delete(`br:${docId}`), docId)
  await forgetBranch(B, G)
  check('호환: 브랜치 기록이 없어도 예전 기록으로 최신', (await cloudState(B, G)) === 'same', String(await cloudState(B, G)))
  await addStroke(B, G, 'g2')
  await push(B)
  check('호환: 예전 기록으로 맞춘 노트도 따라간다', sameSet(drive.headStrokes(G), ['g1', 'g2']))
  await forgetBranch(A, G)
  await addStroke(A, G, 'g3') // A의 예전 기록은 B가 올리기 전 것 → 출발점이 main과 다르다
  await push(A)
  check('호환: 출발점이 낡은 기기는 덮지 않고 갈라짐', sameSet(drive.headStrokes(G), ['g1', 'g2']) && (await cloudState(A, G)) === 'diverged')

  // ── 클라우드 삭제는 main과 모든 기기 브랜치를 휴지통으로 ──
  await A.evaluate(async ([E, fileId]) => (await import('/src/sync/sync.ts')).deleteCloudNote({ docId: E, fileId }), [E, drive.docFile(E)!.id] as const)
  check('클라우드 삭제: main·브랜치 모두 휴지통', drive.allTrashed(E))
  check('클라우드 삭제: A 노트는 남는다', sameSet(await strokes(A, E), ['x', 'y']))

  // ── 버전 기록: 되돌리면 '되돌림'으로 main이 따라간다 ──
  const H = await createDoc(A, '노트 H')
  await addStroke(A, H, 'h1')
  await push(A)
  await addStroke(A, H, 'h2')
  await push(A)
  await pull(B)
  const hRevs = await revisions(A, H)
  check('버전 기록: 리비전 2개, 마지막이 헤드', hRevs.length === 2 && hRevs[1].isHead)
  await A.evaluate(async ([H, id]) => (await import('/src/sync/revisions.ts')).restoreDocRevision(H, id), [H, hRevs[0].id] as const)
  check('버전 기록: 되돌리면 A는 그때 내용(h1)', sameSet(await strokes(A, H), ['h1']))
  await push(A)
  check('버전 기록: 올리면 main이 되돌림으로 따라간다', sameSet(drive.headStrokes(H), ['h1']) && mainProps(H).revKind === 'restore')
  await pull(B)
  check('버전 기록: B도 되돌린 내용을 받는다', sameSet(await strokes(B, H), ['h1']))

  // ── 고정 해제가 main을 바꾸지 않는다 ──
  const K = await createDoc(A, '노트 K')
  await addStroke(A, K, 'old')
  await push(A)
  await addStroke(A, K, 'new')
  await push(A)
  await pull(B)
  const kFile = drive.docFile(K)!
  const oldRev = kFile.revisions[0].id
  await A.evaluate(async ([K, r]) => (await import('/src/sync/revisions.ts')).pinDocRevision(K, r), [K, oldRev] as const)
  await A.evaluate(async ([K, r]) => (await import('/src/sync/revisions.ts')).unpinDocRevision(K, r), [K, oldRev] as const)
  check('고정 해제: main 최신본은 그대로(old,new)', sameSet(drive.headStrokes(K), ['new', 'old']), JSON.stringify(drive.headStrokes(K)))
  check('고정 해제: 고정본은 지워지고 옛 내용은 고정 없는 리비전으로 남는다', !kFile.revisions.some((r) => r.id === oldRev) && drive.revisionStrokes(kFile).some((r) => sameSet(r.strokes, ['old']) && !r.keepForever))
  check('고정 해제: A·B 모두 최신', (await cloudState(A, K)) === 'same' && (await cloudState(B, K)) === 'same')

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
  await openEditor(A, base, H)
  await A.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setPanel('history'))
  await A.waitForSelector('#version-panel .rev-row')
  await A.waitForTimeout(500)
  check('버전 기록 화면: 리비전 행이 보인다', (await A.locator('#version-panel .rev-row').count()) >= 2)

  const warn = [...logsOf(A), ...logsOf(B)].filter((t) => /노트 보호\(withDocExclusive\) 밖|미구현/.test(t))
  check('경고 없음: 보호 밖 적용·가짜 Drive 미구현 API', warn.length === 0, warn.join(' | '))
  await A.context().close()
  await B.context().close()
}
