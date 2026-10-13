// 큰 원본(21MB): 이어 올리기로 올리며 중간에 연결을 끊어 이어 가는지, 다른 기기에서 받은 바이트가 같은지
import { createFakeDrive } from './fake-drive.ts'
import { device, type Ctx } from './lib.ts'

export default async function bigfile(ctx: Ctx) {
  const { check } = ctx
  const drive = createFakeDrive()
  const A = await device(ctx, { drive, name: 'A' })
  const B = await device(ctx, { drive, name: 'B' })
  const SIZE = 21 * 1024 * 1024 + 12345 // 8MB 조각 3개(마지막은 덜 참)

  const made = await A.evaluate(async (SIZE) => {
    const repo = await import('/src/storage/repo.ts')
    const m = await import('/src/shared/model.ts')
    const bytes = new Uint8Array(SIZE)
    for (let i = 0; i < SIZE; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, SIZE)))
    const asset = await repo.putAsset(new Blob([bytes], { type: 'application/pdf' }), { kind: 'pdf', mime: 'application/pdf', name: 'big.pdf' })
    await repo.createDocument({ title: '큰 PDF', mode: 'paged', folderId: null, pages: [{ size: { w: 595, h: 842 }, background: m.makeBackground('blank'), pdf: { assetId: asset.id, pageIndex: 0, rotation: 0 } }] })
    return { assetId: asset.id, sha: asset.sha256 }
  }, SIZE)

  drive.fail.abortChunk = 2 // 두 번째 조각을 보내는 중에 연결을 끊는다
  await A.evaluate(async () => (await import('/src/sync/sync.ts')).pushNow())
  const assetFile = [...drive.files.values()].find((f) => f.name.startsWith('assets/'))
  check('큰 파일: 원본이 같은 크기로 올라갔다', assetFile?.revisions[0].content.length === SIZE, String(assetFile?.revisions[0].content.length))
  check('큰 파일: 조각으로 나눠 보냈다(이어 올리기)', drive.stats.chunkPuts >= 3, JSON.stringify(drive.stats))
  check('큰 파일: 연결이 끊긴 뒤 처음부터가 아니라 이어서 보냈다', drive.stats.aborted === 1 && drive.stats.uploadedBytes === SIZE, `${drive.stats.uploadedBytes} vs ${SIZE}`)
  check('큰 파일: 노트 파일(작은 JSON)은 한 번에 올렸다', [...drive.files.values()].some((f) => f.name.startsWith('docs/')))

  await B.evaluate(async () => (await import('/src/sync/sync.ts')).pullNow())
  const got = await B.evaluate(async (assetId) => {
    const a = await import('/src/sync/assets.ts')
    const util = await import('/src/shared/util.ts')
    let last = 0
    a.onAssetProgress((e) => (last = e.loaded))
    const blob = await a.ensureAssetLocal(assetId, { skipGate: true })
    return { size: blob.size, sha: await util.sha256Hex(await blob.arrayBuffer()), progress: last }
  }, made.assetId)
  check('큰 파일: 다른 기기가 받은 바이트가 원본과 같다(sha256)', got.size === SIZE && got.sha === made.sha)
  check('큰 파일: 내려받기 진행률이 끝까지 보고됐다', got.progress === SIZE, String(got.progress))
  await A.context().close()
  await B.context().close()
}
