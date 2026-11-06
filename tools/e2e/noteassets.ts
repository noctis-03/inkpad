// 빠진 노트 원본 받기: "받기"는 메타데이터만 받으므로 다른 기기에서 온 PDF 노트는 원본이 없다.
// 동기화 메뉴의 '빠진 노트 원본 받기'는 노트(휴지통 제외)가 쓰는 원본만 한 번에 받고, 그 노트의 카드 미리보기를 다시 만든다
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { createFakeDrive } from './fake-drive.ts'
import { device, sleep, type Ctx } from './lib.ts'

async function pdfBase64(title: string) {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595, 842])
  page.drawText(title, { x: 50, y: 770, size: 24, font: await pdf.embedFont(StandardFonts.HelveticaBold) })
  return Buffer.from(await pdf.save()).toString('base64')
}

export default async function noteassets(ctx: Ctx) {
  const { check } = ctx
  const drive = createFakeDrive()
  const A = await device(ctx, { drive, name: 'A' })
  const B = await device(ctx, { drive, name: 'B' })
  const pdfs = [await pdfBase64('Lecture 1'), await pdfBase64('Lecture 2'), await pdfBase64('Trashed'), await pdfBase64('Orphan')]

  // A: PDF 노트 3개(하나는 B에서 휴지통으로 — 휴지통은 기기마다 따로다) + 어느 노트도 쓰지 않는 원본 1개
  const made = await A.evaluate(async (pdfs) => {
    const repo = await import('/src/storage/repo.ts')
    const m = await import('/src/shared/model.ts')
    const put = (b64: string, name: string) =>
      repo.putAsset(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'application/pdf' }), { kind: 'pdf', mime: 'application/pdf', name })
    const note = async (title: string, assetId: string) =>
      (await repo.createDocument({ title, mode: 'paged', folderId: null, pages: [{ size: { w: 595, h: 842 }, background: m.makeBackground('blank'), pdf: { assetId, pageIndex: 0, rotation: 0 } }] })).id
    const a1 = await put(pdfs[0], '1.pdf')
    const a2 = await put(pdfs[1], '2.pdf')
    const a3 = await put(pdfs[2], '3.pdf')
    const a4 = await put(pdfs[3], '4.pdf')
    const d1 = await note('강의 1', a1.id)
    const d2 = await note('강의 2', a2.id)
    const d3 = await note('버린 노트', a3.id)
    // 원본 두 개를 쓰는 노트 — 원본 파일 저장 창에 줄마다 보인다
    const both = (
      await repo.createDocument({
        title: 'Bundle',
        mode: 'paged',
        folderId: null,
        pages: [a1.id, a2.id].map((assetId, i) => ({ size: { w: 595, h: 842 }, background: m.makeBackground('blank'), pdf: { assetId, pageIndex: 0, rotation: 0 } }))
      })
    ).id
    await (await import('/src/sync/sync.ts')).pushNow()
    return { live: [a1.id, a2.id], trashed: a3.id, orphan: a4.id, docs: [d1, d2], trashDoc: d3, both }
  }, pdfs)

  // B: 받기 — 메타만 온다. 원본만 있는 에셋(a4)은 노트가 없어 B에 행조차 없을 수 있다
  await B.evaluate(async (d3) => {
    await (await import('/src/sync/sync.ts')).pullNow()
    await (await import('/src/storage/repo.ts')).trashDocument(d3)
  }, made.trashDoc)
  await B.reload()
  await B.waitForSelector('.doc-card')
  const before = await B.evaluate(async () => (await import('/src/storage/db.ts')).db.assets.filter((a) => !!a.blob).count())
  check('노트 원본: 받기는 원본을 받지 않는다', before === 0, String(before))

  // ── 노트 카드 ⋯ → 원본 파일 저장: 그 노트의 원본을 줄마다 「기기에 저장」(원본 관리 시트의 '기기에 저장'과 같다) ──
  const openSheet = async (title: string) => {
    await B.locator('.doc-card', { hasText: title }).getByRole('button', { name: '더보기' }).click()
    const item = B.getByRole('menuitem', { name: '원본 파일 저장' })
    const label = await item.innerText()
    await item.click()
    const sheet = B.locator('.note-assets')
    await sheet.locator('.note-assets-row:not(.skel)').first().waitFor({ timeout: 5000 })
    return { label, sheet }
  }
  let driveReqs = 0
  B.on('request', (r) => {
    if (r.url().includes('googleapis.com')) driveReqs++
  })
  const saveRow = async (sheet: ReturnType<typeof B.locator>, name: string) => {
    const dl = B.waitForEvent('download', { timeout: 15000 })
    await sheet.locator('.note-assets-row', { hasText: name }).getByRole('button', { name: /기기에 저장/ }).click()
    const ask = B.locator('.dialog-host').getByRole('button', { name: '다운로드' })
    if (await ask.waitFor({ timeout: 2000 }).then(() => true, () => false)) await ask.click()
    const d = await dl
    const path = await d.path()
    const head = path ? (await import('node:fs')).readFileSync(path).subarray(0, 4).toString('latin1') : ''
    return { name: d.suggestedFilename(), head }
  }
  const first = await openSheet('Bundle')
  check('원본 파일 저장: 메뉴는 개수 없이 「원본 파일 저장」', first.label.trim() === '원본 파일 저장', first.label)
  check('원본 파일 저장: 그 노트가 쓰는 원본이 줄마다 「기기에 저장」과 함께', (await first.sheet.locator('.note-assets-row').count()) === 2 && (await first.sheet.getByRole('button', { name: /기기에 저장/ }).count()) === 2)
  if (process.env.MERGE_SHOT_DIR) await B.screenshot({ path: `${process.env.MERGE_SHOT_DIR}/note-assets.png` })
  const saved = await saveRow(first.sheet, '1.pdf')
  check('원본 파일 저장: 그 원본 파일을 기기에 저장한다(1.pdf, PDF 내용)', saved.name === '1.pdf' && saved.head === '%PDF', JSON.stringify(saved))
  const kept = await B.evaluate(async () => (await import('/src/storage/db.ts')).db.assets.filter((a) => !!a.blob).count())
  check('원본 파일 저장: 이 기기에 없던 원본은 받아 저장만 하고 앱에는 남기지 않는다', kept === 0, String(kept))
  await B.keyboard.press('Escape')
  await first.sheet.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})

  const openMenu = async () => {
    await B.locator('.sync-btn').click()
    await B.getByRole('menuitem', { name: '빠진 노트 원본 받기' }).click()
  }
  await openMenu()
  // 큰 전송 확인 — 다른 받기와 같은 기준으로 묻는다
  const asked = await B.locator('.dialog-host').getByRole('button', { name: '다운로드' }).waitFor({ timeout: 3000 }).then(() => true, () => false)
  if (asked) await B.locator('.dialog-host').getByRole('button', { name: '다운로드' }).click()
  const done = await B.locator('.toast', { hasText: '노트 원본 2개를 모두 받았습니다' }).waitFor({ timeout: 10000 }).then(() => true, () => false)
  const after = await B.evaluate(async (ids) => {
    const { db } = await import('/src/storage/db.ts')
    const has = async (id: string) => !!(await db.assets.get(id))?.blob
    return { live: await Promise.all(ids.live.map(has)), trashed: await has(ids.trashed), orphan: await has(ids.orphan) }
  }, made)
  check('노트 원본: 노트가 쓰는 원본을 한 번에 받는다', done && after.live.every(Boolean), JSON.stringify(after))
  check('노트 원본: 휴지통 노트와 어느 노트도 쓰지 않는 원본은 받지 않는다', !after.trashed && !after.orphan, JSON.stringify(after))

  let thumbs = 0
  for (let i = 0; i < 20 && thumbs < 2; i++) {
    await sleep(250)
    thumbs = await B.evaluate(async (docs) => {
      const { db } = await import('/src/storage/db.ts')
      return (await db.thumbnails.bulkGet(docs)).filter(Boolean).length
    }, made.docs)
  }
  check('노트 원본: 받은 노트의 카드 미리보기를 만든다', thumbs === 2, String(thumbs))

  const local = await openSheet('강의 2')
  driveReqs = 0
  const saved2 = await saveRow(local.sheet, '2.pdf')
  check('원본 파일 저장: 이 기기에 있는 원본은 네트워크 없이 저장한다', saved2.name === '2.pdf' && saved2.head === '%PDF' && driveReqs === 0, JSON.stringify({ ...saved2, driveReqs }))
  await B.keyboard.press('Escape')
  await local.sheet.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})

  await openMenu()
  const nothing = await B.locator('.toast', { hasText: '노트가 쓰는 원본이 모두 이 기기에 있습니다' }).waitFor({ timeout: 5000 }).then(() => true, () => false)
  check('노트 원본: 받을 것이 없으면 알리기만 한다', nothing)

  await A.context().close()
  await B.context().close()
}
