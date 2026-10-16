// 보관함: 로컬 스냅샷(덮이기 직전 저장·중복 건너뛰기·되돌리기), 자동 고정(필요할 때만, 기록·정리),
// 되돌림 업로드는 고정하지 않음, 보관함 보고서와 정리(머지 끝난 브랜치·기기 퇴역·옛 백업·스냅샷), 화면
import type { Page } from 'playwright'
import { createFakeDrive } from './fake-drive.ts'
import { addStroke, createDoc, device, logsOf, openEditor, sameSet, strokes, type Ctx } from './lib.ts'

const push = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pushNow())
const pull = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pullNow())
const snaps = (p: Page, docId: string) => p.evaluate(async (docId) => (await import('/src/sync/snapshots.ts')).listSnapshots(docId), docId)
const deviceId = (p: Page) => p.evaluate(async () => (await import('/src/sync/token.ts')).getDeviceId())
const report = (p: Page) => p.evaluate(async () => (await import('/src/sync/archive.ts')).loadArchive())

export default async function archive(ctx: Ctx) {
  const { base, check } = ctx
  const drive = createFakeDrive()
  const A = await device(ctx, { drive, name: 'PC' })
  const B = await device(ctx, { drive, name: 'iPad' })
  const [devA, devB] = [await deviceId(A), await deviceId(B)]

  // ── 로컬 스냅샷: 받기로 덮이기 직전에 남는다 ──
  const D = await createDoc(A, '보관 노트')
  await addStroke(A, D, 'a')
  await push(A)
  await pull(B)
  check('스냅샷: 처음 받은 노트는 덮을 것이 없어 남기지 않는다', (await snaps(B, D)).length === 0)
  await addStroke(A, D, 'b')
  await push(A)
  await pull(B)
  const s1 = await snaps(B, D)
  check('스냅샷: 받기 직전 내용(a)이 남는다', s1.length === 1 && s1[0].why === 'pull' && s1[0].strokes === 1, JSON.stringify(s1))
  await pull(B)
  check('스냅샷: 바뀐 게 없으면 더 남기지 않는다', (await snaps(B, D)).length === 1)
  await addStroke(A, D, 'c')
  await push(A)
  await pull(B)
  check('스냅샷: 또 받으면 하나 더', (await snaps(B, D)).length === 2)

  // ── 스냅샷으로 되돌리기 (네트워크 없이) ──
  const oldest = (await snaps(B, D)).at(-1)!
  await B.evaluate(async ([D, id]) => (await import('/src/sync/revisions.ts')).restoreVersion(D, { kind: 'snapshot', id }), [D, oldest.id] as const)
  check('스냅샷 되돌리기: 그때 내용(a)', sameSet(await strokes(B, D), ['a']))
  const s2 = await snaps(B, D)
  check('스냅샷 되돌리기: 되돌리기 직전 내용도 스냅샷으로', s2[0].why === 'restore' && s2[0].strokes === 3, JSON.stringify(s2[0]))
  await push(B)
  const head = drive.docFile(D)!
  check('되돌림 업로드: main이 되돌린 내용으로 따라간다', sameSet(drive.headStrokes(D), ['a']) && head.appProperties.revKind === 'restore')
  check('되돌림 업로드: 고정하지 않는다', !head.revisions.at(-1)!.keepForever)

  // ── 자동 고정: 옛 리비전은 Drive가 요구할 때만 고정하고 기록한다 ──
  const firstRev = head.revisions[0].id
  const pinErr = await B.evaluate(
    async ([D, id]) => {
      try {
        await (await import('/src/sync/revisions.ts')).loadVersionFile(D, { kind: 'rev', id })
        return 'ok'
      } catch (e) {
        return (e as Error).name
      }
    },
    [D, firstRev] as const
  )
  check('미리보기: 고정이 필요한 옛 리비전은 고정하지 않고 알린다', pinErr === 'PinRequiredError', pinErr)
  check('미리보기: 고정하지 않았다', !head.revisions[0].keepForever)
  await pull(A)
  await A.evaluate(async ([D, id]) => (await import('/src/sync/revisions.ts')).restoreVersion(D, { kind: 'rev', id }), [D, firstRev] as const)
  check('자동 고정: 되돌리기는 필요해서 고정했다', head.revisions[0].keepForever)
  const r1 = await report(A)
  check('자동 고정: 기록이 보관함에 보인다', r1.autoPins.length === 1 && r1.autoPins[0].revId === firstRev)

  // ── 보관함 보고서 ──
  check('보고서: 기기 두 대, 이 기기가 먼저', r1.devices.length === 2 && r1.devices[0].mine && r1.devices[0].deviceId === devA && r1.devices[1].device === 'iPad')
  check('보고서: 브랜치는 모두 머지 끝남', r1.branches.length === 2 && r1.branches.every((b) => b.merged))
  check('보고서: 스냅샷 사용량', r1.snapshots.count >= 1)

  // 옛 머지 백업 하나 (예전 앱이 만든 것처럼)
  await A.evaluate(async (D) => {
    const f = await import('/src/sync/folders.ts')
    const drive = await import('/src/sync/drive.ts')
    const folder = await f.ensureStoreFolder('backups', 'backupsFolderId')
    await drive.upload(new Blob(['{}']), { name: `backups/${D}-1.json`, mimeType: 'application/json', appProperties: { docId: D, revKind: 'merge-backup' } }, folder)
  }, D)
  const r2 = await report(A)
  check('보고서: 옛 머지 백업', r2.backups.length === 1 && !r2.backups[0].orphan)

  // ── 정리 ──
  const pins = await A.evaluate(async (pins) => (await import('/src/sync/archive.ts')).releaseAutoPins(pins), r2.autoPins)
  check('정리: 자동 고정 풀기', pins.released === 1 && !drive.docFile(D)!.revisions.some((r) => r.keepForever))
  check('정리: 자동 고정 기록도 지운다', (await report(A)).autoPins.length === 0)
  const seqBefore = Number(drive.branchOf(D, devA)!.appProperties.seq)
  const merged = (await report(A)).branches.filter((b) => b.merged)
  await A.evaluate(async (list) => (await import('/src/sync/archive.ts')).trashBranches(list), merged)
  check('정리: 머지 끝난 브랜치를 휴지통으로', drive.branchesOf(D).length === 0)
  await push(A) // A는 되돌린 내용을 올린다 — 새 브랜치 파일, seq는 이어 센다
  check('정리 뒤 올리기: 새 브랜치, seq는 이어진다', Number(drive.branchOf(D, devA)?.appProperties.seq) === seqBefore + 1, String(drive.branchOf(D, devA)?.appProperties.seq))
  check('정리 뒤 올리기: main도 따라간다', sameSet(drive.headStrokes(D), ['a']))

  // 기기 퇴역 — 머지 안 된 브랜치가 있어도 지운다(화면이 경고한다)
  await addStroke(B, D, 'pad') // B는 A의 올리기 전에서 출발 → 갈라짐
  await push(B)
  const r3 = await report(A)
  const ipad = r3.devices.find((d) => d.deviceId === devB)!
  check('퇴역: iPad 브랜치는 머지 안 됨으로 보인다', ipad.unmerged === 1)
  await A.evaluate(async (list) => (await import('/src/sync/archive.ts')).trashBranches(list), r3.branches.filter((b) => b.deviceId === devB))
  check('퇴역: iPad 브랜치가 휴지통으로', !drive.branchOf(D, devB))
  const queue = await A.evaluate(async () => (await import('/src/sync/sync.ts')).listMergeQueue())
  check('퇴역: 머지 관리에서도 사라진다', queue.length === 0)

  await A.evaluate(async (ids) => (await import('/src/sync/archive.ts')).trashFiles(ids), r3.backups.map((b) => b.fileId))
  check('정리: 옛 머지 백업을 휴지통으로', (await report(A)).backups.length === 0)
  const removed = await B.evaluate(async () => (await import('/src/sync/snapshots.ts')).pruneSnapshots(undefined, 1))
  check('정리: 스냅샷 노트당 1개만', removed >= 1 && (await snaps(B, D)).length === 1)

  // ── 화면: 버전 기록의 스냅샷·브랜치, 미리보기, 보관함 관리 ──
  await openEditor(A, base, D)
  await A.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setPanel('history'))
  await A.waitForSelector('#version-panel .rev-section-title')
  await A.waitForTimeout(400)
  const titles = await A.locator('#version-panel .rev-section-title').allInnerTexts()
  check('버전 기록 화면: 기기 브랜치·이 기기 스냅샷 섹션', titles.some((t) => t.includes('기기 브랜치')) && titles.some((t) => t.includes('이 기기 스냅샷')), JSON.stringify(titles))
  const snapRow = A.locator('#version-panel .rev-row', { hasText: '되돌리기 전' }).first()
  await snapRow.getByRole('button', { name: '미리보기' }).click()
  await A.waitForSelector('#version-panel .rev-diff')
  check('버전 기록 화면: 미리보기에 획 증감', /획 \+\d+/.test(await A.locator('#version-panel .rev-diff').innerText()))
  if (process.env.MERGE_SHOT_DIR) await A.screenshot({ path: `${process.env.MERGE_SHOT_DIR}/history.png` })
  await A.evaluate(async () => (await import('/src/app/store.ts')).useUI.getState().setPanel('none'))
  await A.evaluate(async () => (await import('/src/ui/ArchiveSheet.tsx')).openArchive())
  await A.waitForSelector('.archive-sheet .archive-row', { timeout: 15000 })
  check('보관함 화면: 기기 목록', (await A.locator('.archive-sheet .archive-row').count()) >= 1)
  check('보관함 화면: 정리 버튼들', (await A.locator('.archive-sheet').innerText()).includes('머지 끝난 브랜치 지우기'))
  check('보관함 화면: 항목마다 클라우드·이 기기 표시', (await A.locator('.archive-sheet .archive-where.cloud').count()) === 4 && (await A.locator('.archive-sheet .archive-where.device').count()) === 1)
  if (process.env.MERGE_SHOT_DIR) await A.screenshot({ path: `${process.env.MERGE_SHOT_DIR}/archive.png` })

  const warn = [...logsOf(A), ...logsOf(B)].filter((t) => /노트 보호\(withDocExclusive\) 밖|미구현|스냅샷을 남기지 못했/.test(t))
  check('경고 없음', warn.length === 0, warn.join(' | '))
  await A.context().close()
  await B.context().close()
}
