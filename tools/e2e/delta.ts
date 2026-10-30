// 바뀐 페이지만 오가기 (sync/objects.ts): 노트는 조각(페이지 하나 = 조각 하나) + 매니페스트로 올라간다.
// 획 하나를 고치면 그 페이지 조각 하나만 올라가고, 받는 기기도 그 조각 하나만 받는다.
import { gunzipSync, gzipSync } from 'node:zlib'
import type { Page } from 'playwright'
import { createFakeDrive, type FakeDrive } from './fake-drive.ts'
import { addStroke, createDoc, device, logsOf, sameSet, strokes, type Ctx } from './lib.ts'

const push = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pushNow())
const pull = (p: Page) => p.evaluate(async () => (await import('/src/sync/sync.ts')).pullNow())

/** 페이지마다 그럴듯한 손글씨 획을 채운다 */
const fill = (p: Page, docId: string, perPage: number) =>
  p.evaluate(
    async ([docId, perPage]) => {
      const r = await import('/src/storage/repo.ts')
      const d = await r.loadDocument(docId as string)
      const q2 = (v: number) => Math.round(v * 100) / 100
      for (const pg of d.pages) {
        const els = []
        for (let i = 0; i < (perPage as number); i++) {
          let x = Math.random() * 500
          let y = Math.random() * 760
          let pr = 0.5
          const pts: number[] = []
          for (let k = 0; k < 40; k++) {
            x += (Math.random() - 0.5) * 6 + 1.5
            y += (Math.random() - 0.5) * 6
            pr = Math.min(1, Math.max(0.1, pr + (Math.random() - 0.5) * 0.1))
            pts.push(q2(x), q2(y), q2(pr), 8 + Math.floor(Math.random() * 3))
          }
          els.push({
            id: `${pg.id}-${i}`,
            type: 'stroke' as const,
            layer: 'main' as const,
            z: i + 1,
            createdAt: Date.now(),
            tool: 'pen' as const,
            color: '#1a1a1aff',
            width: 2,
            points: pts,
            bbox: [0, 0, 600, 800] as [number, number, number, number],
            opts: { thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false }
          })
        }
        await r.saveBatch({ documentId: docId as string, chunks: [{ pageId: pg.id, key: '0_0', elements: els }] })
      }
    },
    [docId, perPage] as const
  )

function meter(drive: FakeDrive) {
  const s = drive.stats
  let up0 = 0
  let down0 = 0
  return {
    reset: () => ((up0 = s.upBytes), (down0 = s.downBytes)),
    up: () => s.upBytes - up0,
    down: () => s.downBytes - down0
  }
}

const kb = (n: number) => `${(n / 1024).toFixed(1)}KB`

export default async function delta(ctx: Ctx) {
  const { check } = ctx
  const drive = createFakeDrive()
  const A = await device(ctx, { drive, name: 'iPad' })
  const B = await device(ctx, { drive, name: 'PC' })
  const m = meter(drive)

  const D = await createDoc(A, '큰 노트', 10)
  await fill(A, D, 80)
  m.reset()
  await push(A)
  const full = drive.objects().reduce((n, f) => n + f.revisions.at(-1)!.content.length, 0)
  const first = m.up()
  check('첫 올리기: 페이지마다 조각 하나', drive.objects().length === 10, String(drive.objects().length))
  check('첫 올리기: 노트를 한 번만 올린다(브랜치·main이 조각을 함께 쓴다)', first < full * 1.15, `${kb(first)} / 조각 ${kb(full)}`)
  const main = drive.ungz(drive.docFile(D)!.revisions.at(-1)!.content)
  check(
    'main 본문은 매니페스트 — 옛 앱은 노트로 읽지 않는다',
    JSON.parse(gunzipSync(drive.docFile(D)!.revisions.at(-1)!.content).toString()).kind === 'inkpad-doc-m'
  )
  check('매니페스트를 풀면 모든 획', drive.strokeIds(main).length === 800)

  // ── 획 하나: 그 페이지 조각 하나만 ──
  await addStroke(A, D, 'one')
  m.reset()
  await push(A)
  const one = m.up()
  check(
    '획 하나 올리기: 바뀐 페이지 조각 하나 + 매니페스트만',
    one < full * 0.2 && drive.objects().length === 11,
    `${kb(one)} (전체 ${kb(full)}), 조각 ${drive.objects().length}`
  )

  // ── 받기: 처음엔 전부, 그다음엔 바뀐 조각만 ──
  m.reset()
  await pull(B)
  check('처음 받기: 노트 전체를 받는다', sameSet(await strokes(B, D), await strokes(A, D)) && m.down() >= full * 0.9, kb(m.down()))
  await addStroke(A, D, 'two')
  await push(A)
  m.reset()
  await pull(B)
  const got = m.down()
  check('다음 받기: 바뀐 페이지 조각 하나 + 매니페스트만', got < full * 0.2 && (await strokes(B, D)).includes('two'), `${kb(got)} (전체 ${kb(full)})`)

  console.log(`  · 10쪽·획 800개 노트: 전체 조각 ${kb(full)} · 첫 올리기 ${kb(first)} · 획 하나 올리기 ${kb(one)} · 획 하나 받기 ${kb(got)}`)

  // ── 받기 목록: 마지막으로 본 뒤 바뀐 파일만 ──
  for (let i = 0; i < 20; i++) await createDoc(A, `작은 노트 ${i}`)
  await push(A)
  await pull(B) // 하루 한 번·처음은 전체 목록
  drive.advance(2 * 3600_000) // 두 시간 뒤 — 작은 노트들은 목록 여유(한 시간)보다 앞이 된다
  await addStroke(A, D, 'list-0')
  await push(A)
  await pull(B) // 이번 목록이 '바뀐 시각'을 D 쪽으로 옮긴다
  await addStroke(A, D, 'list-1')
  await push(A)
  const listed0 = drive.stats.listedFiles
  const urls: string[] = []
  const onReq = (r: { url: () => string }) => r.url().includes('/drive/v3/files?') && urls.push(decodeURIComponent(r.url()))
  B.on('request', onReq)
  await pull(B)
  B.off('request', onReq)
  const docsList = urls.filter((u) => u.includes('modifiedTime >'))
  check('받기 목록: 바뀐 뒤의 파일만 묻는다', docsList.length === 1, urls.join(' | ').slice(0, 300))
  check(
    '받기 목록: 노트 21개 중 바뀐 것만 돌아온다',
    drive.stats.listedFiles - listed0 < 8 && (await strokes(B, D)).includes('list-1'),
    String(drive.stats.listedFiles - listed0)
  )

  // ── 갈라짐 → 머지: 결과도 바뀐 조각만 올린다 ──
  await addStroke(A, D, 'a-side')
  await push(A)
  await addStroke(B, D, 'b-side')
  await push(B) // 갈라짐 — B 브랜치에만
  const queued = await A.evaluate(async () => (await import('/src/sync/sync.ts')).listMergeQueue())
  const entry = queued.find((q: { docId: string }) => q.docId === D)
  m.reset()
  const r = await A.evaluate(async (entry) => {
    const s = await import('/src/sync/sync.ts')
    const mg = await import('/src/sync/merge.ts')
    const session = await s.openMerge(entry)
    return s.commitMerge(session, mg.emptyDraft())
  }, entry)
  check('머지: 결과에 양쪽 획', r.applied && ['a-side', 'b-side'].every((x) => drive.headStrokes(D).includes(x)))
  check('머지: 열기·쓰기 모두 바뀐 페이지만 오간다', m.down() < full * 0.35 && m.up() < full * 0.2, `받음 ${kb(m.down())} 올림 ${kb(m.up())}`)

  // ── 버전 되돌리기: 옛 매니페스트 리비전도 풀린다 ──
  const revs = await A.evaluate(async (D) => (await import('/src/sync/revisions.ts')).listDocRevisions(D), D)
  const old = revs[0]
  await A.evaluate(async ([D, id]) => (await import('/src/sync/revisions.ts')).restoreVersion(D, { kind: 'rev', id }), [D, old.id] as const)
  const restored = await strokes(A, D)
  check('버전 되돌리기: 첫 리비전(매니페스트) 내용으로', restored.length === 800 && !restored.includes('one'), String(restored.length))

  // ── 안 쓰는 조각 정리 (보관함 관리) — 표식 → 45일 뒤 휴지통, 고정한 버전이 쓰는 조각은 남긴다 ──
  await push(A) // 되돌림 올리기
  const scan = (p: Page) => p.evaluate(async () => (await import('/src/sync/archive.ts')).scanObjects())
  const pinnedRev = (await A.evaluate(async (D) => (await import('/src/sync/revisions.ts')).listDocRevisions(D), D)).at(-3)!
  await A.evaluate(async ([D, id]) => (await import('/src/sync/revisions.ts')).pinDocRevision(D, id), [D, pinnedRev.id] as const)
  const s1 = (await scan(A))!
  const pinnedObjs = new Set(
    (drive.ungz(drive.docFile(D)!.revisions.find((r) => r.id === pinnedRev.id)!.content) as { objs?: { f: string }[] }).objs?.map((o) => o.f) ?? []
  )
  check('조각 검사: 안 쓰는 옛 조각이 보인다', s1.unused.length > 0 && s1.ready === 0, JSON.stringify({ total: s1.total, unused: s1.unused.length }))
  check('조각 검사: 고정한 버전이 쓰는 조각은 안 쓰는 것이 아니다', pinnedObjs.size > 0 && s1.unused.every((u) => !pinnedObjs.has(u.id)))
  const c1 = await A.evaluate(async (scan) => (await import('/src/sync/archive.ts')).cleanObjects(scan), s1)
  check('조각 정리(처음): 휴지통으로 보내지 않고 표식만', c1.marked === s1.unused.length && c1.trashed === 0 && drive.objects().every((o) => !o.trashed))
  for (const o of drive.objects()) if (Number(o.appProperties.unref) > 0) o.appProperties.unref = String(Date.now() - 46 * 24 * 3600_000) // 46일 전에 표시한 것으로
  const s2 = (await scan(A))!
  const c2 = await A.evaluate(async (scan) => (await import('/src/sync/archive.ts')).cleanObjects(scan), s2)
  check(
    '조각 정리(45일 뒤): 여전히 안 쓰는 조각만 휴지통으로',
    c2.trashed === s1.unused.length && drive.objects().filter((o) => o.trashed).length === s1.unused.length
  )
  check('조각 정리 뒤: 노트는 그대로 받아진다', drive.headStrokes(D).length === 800)

  // ── 검사 중 노트 파일을 읽지 못하면 정리하지 않는다 — 못 읽은 노트의 최신 조각을 '안 씀'으로 잘못 세서 지우던 구멍 ──
  // 가장 나쁜 경우: 그 조각을 가리키는 파일(main·기기 브랜치)을 모두 못 읽고, 예전 검사에서도 못 읽어 최신 조각에 46일 전 표식이 붙어 있다
  const liveMain = drive.docFile(D)!
  const liveObjs = new Set(
    (JSON.parse(gunzipSync(liveMain.revisions.at(-1)!.content).toString()) as { objs: { f: string }[] }).objs.map((o) => o.f)
  )
  for (const id of liveObjs) drive.files.get(id)!.appProperties.unref = String(Date.now() - 46 * 24 * 3600_000)
  const unreadIds = [liveMain.id, ...drive.branchesOf(D).map((b) => b.id)]
  for (const id of unreadIds) drive.fail.download.add(id)
  const s3 = (await scan(A))!
  check('못 읽은 노트 파일: 검사 결과에 이름이 남는다', s3.unreadable.length === unreadIds.length, JSON.stringify(s3.unreadable))
  check('못 읽은 노트 파일: 이번 정리에 휴지통으로 갈 조각이 없다고 본다', s3.ready === 0, JSON.stringify({ ready: s3.ready, unused: s3.unused.length }))
  const c3 = await A.evaluate(async (scan) => (await import('/src/sync/archive.ts')).cleanObjects(scan), s3)
  check(
    '못 읽은 노트 파일: 정리는 표식도 휴지통도 하지 않는다 — 최신 조각이 남는다',
    c3.blocked === unreadIds.length && c3.trashed === 0 && c3.marked === 0 && [...liveObjs].every((id) => !drive.files.get(id)!.trashed),
    JSON.stringify(c3)
  )
  drive.fail.download.clear()
  // 버전 목록을 못 읽어도(고정한 버전이 가리키는 조각을 모른다) 같다
  drive.fail.revisionList.add(liveMain.id)
  const s4 = (await scan(A))!
  const c4 = await A.evaluate(async (scan) => (await import('/src/sync/archive.ts')).cleanObjects(scan), s4)
  check('못 읽은 버전 목록: 정리하지 않는다', s4.unreadable.some((n) => n.includes('버전 목록')) && c4.blocked === 1 && c4.trashed === 0, JSON.stringify({ u: s4.unreadable, c4 }))
  drive.fail.revisionList.delete(liveMain.id)
  // 다시 읽히면 최신 조각의 잘못된 표식을 지운다
  const s5 = (await scan(A))!
  const c5 = await A.evaluate(async (scan) => (await import('/src/sync/archive.ts')).cleanObjects(scan), s5)
  check(
    '다시 읽히면: 최신 조각의 표식을 지우고 아무것도 휴지통으로 보내지 않는다',
    s5.unreadable.length === 0 && c5.trashed === 0 && [...liveObjs].every((id) => drive.files.get(id)!.appProperties.unref === '0' && !drive.files.get(id)!.trashed),
    JSON.stringify(c5)
  )
  check('…노트는 그대로 받아진다', drive.headStrokes(D).length === 800)

  // 휴지통의 조각은 다시 가리키지 않는다 — 알고 있던 조각이 휴지통에 있으면 새로 올린다
  const live = drive.ungz(drive.docFile(D)!.revisions.at(-1)!.content)
  const rawMain = JSON.parse(gunzipSync(drive.docFile(D)!.revisions.at(-1)!.content).toString()) as { objs: { f: string; pageId: string }[] }
  const victim = rawMain.objs[3]
  drive.files.get(victim.f)!.trashed = true
  await A.evaluate(async () => (await import('/src/sync/objects.ts')).forgetTrashedObjects())
  await addStroke(A, D, 'after-trash')
  await push(A)
  const after = JSON.parse(gunzipSync(drive.docFile(D)!.revisions.at(-1)!.content).toString()) as { objs: { f: string; pageId: string }[] }
  check(
    '휴지통 조각: 다시 가리키지 않고 새로 올린다',
    !after.objs.some((o) => o.f === victim.f) && after.objs.some((o) => o.pageId === victim.pageId),
    JSON.stringify(after.objs.map((o) => o.f))
  )
  check('휴지통 조각: 내용은 그대로', drive.strokeIds(live).length + 1 === drive.headStrokes(D).length)
  await pull(B)

  // ── 옛 앱이 올린 전체 파일(조각 없음)도 그대로 받고, 이 기기가 다시 올리면 조각으로 바뀐다 ──
  const docsFolder = [...drive.files.values()].find((f) => f.name === 'docs' && f.mimeType === 'application/vnd.google-apps.folder')!
  const E = 'legacy-doc-1'
  const now = Date.now()
  const v1 = {
    kind: 'inkpad-doc',
    schemaVersion: 1,
    doc: { id: E, schemaVersion: 1, title: '옛 앱 노트', mode: 'paged', category: null, pageOrder: ['lp1'], createdAt: now, updatedAt: now },
    pages: [{ id: 'lp1', documentId: E, size: { w: 595.28, h: 841.89 }, background: { kind: 'blank' }, createdAt: now, updatedAt: now, version: 1 }],
    chunks: [
      {
        pageId: 'lp1',
        key: '0_0',
        elements: [
          {
            id: 'old-app-stroke',
            type: 'stroke',
            layer: 'main',
            z: 1,
            createdAt: now,
            tool: 'pen',
            color: '#000000ff',
            width: 2,
            points: [10, 10, 0.5, 0, 20, 20, 0.5, 16],
            bbox: [9, 9, 21, 21],
            opts: { thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false }
          }
        ]
      }
    ],
    blocks: [],
    assets: []
  }
  drive.files.set('legacyfile1', {
    id: 'legacyfile1',
    name: `docs/${E}.json`,
    mimeType: 'application/json',
    parents: [docsFolder.id],
    appProperties: { docId: E, updatedAt: String(now), title: '옛 앱 노트', enc: 'gzip' },
    trashed: false,
    version: 1,
    revisions: [
      {
        id: 'legacyrev1',
        content: gzipSync(Buffer.from(JSON.stringify(v1))),
        modifiedTime: new Date(Date.parse('2030-01-01T00:00:00Z')).toISOString(),
        keepForever: false
      }
    ]
  })
  await B.evaluate(async () => (await import('/src/sync/sync.ts')).listCloudNotes()) // 목록을 새로(전체) — 하루 한 번처럼
  await pull(B)
  check('옛 전체 파일: 받아진다', sameSet(await strokes(B, E), ['old-app-stroke']))
  await addStroke(B, E, 'new-app-stroke')
  await push(B)
  check(
    '옛 전체 파일: 다시 올리면 조각 + 매니페스트로',
    JSON.parse(gunzipSync(drive.files.get('legacyfile1')!.revisions.at(-1)!.content).toString()).kind === 'inkpad-doc-m' &&
      sameSet(drive.headStrokes(E), ['new-app-stroke', 'old-app-stroke'])
  )

  // ── 조각이 망가졌으면 받지 않는다(이 기기 노트는 그대로) ──
  await addStroke(A, D, 'broken')
  await push(A)
  const before = await strokes(B, D)
  const obj = drive.objects().at(-1)!
  obj.revisions.at(-1)!.content = gzipSync(Buffer.from('[]'))
  const res = await B.evaluate(async () => {
    try {
      await (await import('/src/sync/sync.ts')).pullNow()
      return 'ok'
    } catch (e) {
      return String(e)
    }
  })
  check('망가진 조각: 이 기기 노트를 덮지 않는다', sameSet(await strokes(B, D), before), res)
  check('망가진 조각: 알린다', logsOf(B).some((t) => /노트 조각을 읽지 못했/.test(t)) || /조각/.test(res), logsOf(B).slice(-3).join(' | '))

  await A.context().close()
  await B.context().close()
}
