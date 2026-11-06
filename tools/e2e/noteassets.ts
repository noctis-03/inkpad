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
    // 원본 두 개를 쓰는 노트 — 원본 파일 저장이 zip 하나로 묶는지 본다.
    // 제목은 영문: 헤드리스 Chromium은 <a download>의 한글 이름을 'download'로 바꿔 알린다(실제 브라우저는 한글 그대로 — .inkpad 내보내기와 같은 saveFile)
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

  // ── 노트 카드 ⋯ → 원본 파일 저장: 앱이 아니라 기기 파일로. 이 기기에 없는 원본은 받아서 저장만 한다 ──
  const cardMenu = async (title: string) => {
    await B.locator('.doc-card', { hasText: title }).getByRole('button', { name: '더보기' }).click()
    const item = B.getByRole('menuitem', { name: /^원본 파일 저장/ })
    await B.waitForFunction(() => [...document.querySelectorAll('.menu-item')].some((e) => /원본 파일 저장 · /.test(e.textContent ?? '')), null, { timeout: 5000 }).catch(() => {})
    return item
  }
  const saveVia = async (title: string) => {
    const item = await cardMenu(title)
    const label = await item.innerText()
    const dl = B.waitForEvent('download', { timeout: 15000 })
    await item.click()
    const ask = B.locator('.dialog-host').getByRole('button', { name: '다운로드' })
    if (await ask.waitFor({ timeout: 2000 }).then(() => true, () => false)) await ask.click()
    const d = await dl
    const path = await d.path()
    const bytes = path ? (await import('node:fs')).readFileSync(path) : Buffer.alloc(0)
    return { label, name: d.suggestedFilename(), head: bytes.subarray(0, 4).toString('latin1') }
  }
  const one = await saveVia('강의 1')
  check('원본 파일 저장: ⋯ 메뉴에 그 노트의 원본 수', one.label.includes('원본 파일 저장 · PDF 1') && !one.label.includes('zip'), one.label)
  check('원본 파일 저장: 하나면 그 파일 그대로(1.pdf, PDF 내용)', one.name === '1.pdf' && one.head === '%PDF', JSON.stringify(one))
  const many = await saveVia('Bundle')
  // 이름은 알림으로 본다 — 헤드리스는 한글이 든 다운로드 이름을 'download'로 알린다(위 설명)
  const zipToast = await B.locator('.toast', { hasText: '"Bundle 원본.zip"' }).waitFor({ timeout: 5000 }).then(() => true, () => false)
  check('원본 파일 저장: 여럿이면 「제목 원본.zip」 하나로', many.label.includes('PDF 2') && many.label.includes('zip') && zipToast && many.head === 'PK\u0003\u0004', JSON.stringify({ ...many, zipToast }))
  const kept = await B.evaluate(async () => (await import('/src/storage/db.ts')).db.assets.filter((a) => !!a.blob).count())
  check('원본 파일 저장: 받은 원본은 앱에 남기지 않는다', kept === 0, String(kept))

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

  await openMenu()
  const nothing = await B.locator('.toast', { hasText: '노트가 쓰는 원본이 모두 이 기기에 있습니다' }).waitFor({ timeout: 5000 }).then(() => true, () => false)
  check('노트 원본: 받을 것이 없으면 알리기만 한다', nothing)

  await A.context().close()
  await B.context().close()
}
