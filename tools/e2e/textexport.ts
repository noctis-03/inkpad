// 문서(text 모드) 내보내기 — Markdown(.md 내려받기, 글 그대로 비교) · PDF(인쇄 — 실제 인쇄 PDF를 만들어 글자를 읽어 본다)
import { readFileSync } from 'node:fs'
import { device, openEditor, sleep, type Ctx } from './lib.ts'

export default async function textexport(ctx: Ctx) {
  const { base, check } = ctx
  const p = await device(ctx)
  const errs: string[] = []
  p.on('pageerror', (e) => errs.push(String(e)))

  const docId = await p.evaluate(async () => {
    const r = await import('/src/storage/repo.ts')
    const f = await import('/src/shared/fracIndex.ts')
    const doc = await r.createDocument({ title: '보고서', mode: 'text', folderId: null, pages: [] })
    const first = await r.loadTextBlocks(doc.id)
    type T = import('/src/shared/model.ts').TextBlockType
    const spec: [T, string, number, Record<string, unknown>?][] = [
      ['h1', '개요', 0],
      ['p', '본문 <b>굵게</b>와 <i>기울임</i>, <s>취소</s>, <u>밑줄</u>, <code>코드</code>, <a href="https://example.com/a">링크</a>', 0],
      ['p', '', 0],
      ['bullet', '사과', 0],
      ['bullet', '안쪽 배', 1],
      ['number', '첫째', 0],
      ['number', '둘째', 0],
      ['todo', '끝낸 일', 0, { checked: true }],
      ['todo', '남은 일', 0, { checked: false }],
      ['toggle', '접은 토글', 0, { collapsed: true }],
      ['p', '토글 안쪽', 1],
      ['quote', '인용문', 0],
      ['code', 'let a = 1\nlet b = a * 2', 0],
      ['divider', '', 0],
      ['h2', '특수 글자', 0],
      ['p', '*별* _밑줄_ [괄호] 와 줄<br>바꿈', 0]
    ]
    const keys = f.keysBetween(null, null, spec.length)
    const now = Date.now()
    await r.saveTextBatch({
      documentId: doc.id,
      delete: first.map((b) => b.id),
      upsert: spec.map(([type, html, indent, extra], i) => ({ id: `t${String(i).padStart(2, '0')}`, documentId: doc.id, type, html, indent, pos: keys[i], createdAt: now, updatedAt: now, ...(extra ?? {}) }))
    })
    return doc.id
  })
  await openEditor(p, base, docId).catch(() => {})
  await p.waitForFunction(() => !!(window as unknown as { inkpadText?: unknown }).inkpadText && !!document.querySelector('.tdoc-blocks .tb-row'))

  // ── 내보내기 화면 ──
  await p.getByRole('button', { name: '더보기' }).click()
  await p.getByRole('menuitem', { name: '내보내기' }).click()
  await p.waitForSelector('#export-panel')
  check('문서 ⋯ 메뉴 → 내보내기 화면 (Markdown·PDF·.inkpad)', (await p.locator('#export-panel h3').allTextContents()).join() === 'Markdown,PDF,Inkpad 파일')

  // ── Markdown ──
  // 헤드리스 Chromium은 한글 파일 이름의 blob 내려받기를 'download'로 바꿔 알려 준다 — 링크에 단 이름을 직접 본다
  await p.evaluate(() => {
    const click = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      ;(window as unknown as { __dlName: string }).__dlName = this.download
      click.call(this)
    }
  })
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#export-md-btn')])
  const md = readFileSync((await dl.path())!, 'utf8')
  const want = [
    '# 보고서',
    '',
    '# 개요',
    '',
    '본문 **굵게**와 *기울임*, ~~취소~~, <u>밑줄</u>, `코드`, [링크](https://example.com/a)',
    '',
    '- 사과',
    '   - 안쪽 배',
    '1. 첫째',
    '2. 둘째',
    '- [x] 끝낸 일',
    '- [ ] 남은 일',
    '- 접은 토글',
    '',
    '토글 안쪽',
    '',
    '> 인용문',
    '',
    '```',
    'let a = 1',
    'let b = a * 2',
    '```',
    '',
    '---',
    '',
    '## 특수 글자',
    '',
    '\\*별\\* \\_밑줄\\_ \\[괄호\\] 와 줄  ',
    '바꿈',
    ''
  ].join('\n')
  const dlName = await p.evaluate(() => (window as unknown as { __dlName: string }).__dlName)
  check('Markdown 파일 이름', dlName === '보고서.md', dlName)
  check('Markdown: 블록·서식·목록 중첩·번호·할 일·인용·코드·구분선·특수 글자', md === want, '\n' + md)

  // ── PDF (인쇄) ──
  await p.evaluate(() => {
    ;(window as unknown as { __printed: number }).__printed = 0
    window.print = () => void ((window as unknown as { __printed: number }).__printed += 1)
  })
  await p.click('#export-pdf-btn')
  const st = await p.evaluate(() => ({
    printed: (window as unknown as { __printed: number }).__printed,
    root: !!document.querySelector('body > .tdoc-print'),
    cls: document.documentElement.classList.contains('tdoc-printing'),
    title: document.title,
    screenHidden: getComputedStyle(document.querySelector('.tdoc-print')!).display === 'none'
  }))
  check('PDF: 인쇄 창을 연다 (인쇄용 내용은 화면에선 숨김)', st.printed === 1 && st.root && st.cls && st.screenHidden, JSON.stringify(st))
  check('…PDF 파일 이름 기본값 = 문서 제목', st.title === '보고서')
  await p.emulateMedia({ media: 'print' })
  const inPrint = await p.evaluate(() => ({
    app: getComputedStyle(document.querySelector('#root')!).display,
    doc: getComputedStyle(document.querySelector('.tdoc-print')!).display
  }))
  check('인쇄 때는 문서만 보이고 앱 화면은 숨김', inPrint.app === 'none' && inPrint.doc === 'block', JSON.stringify(inPrint))
  // page.pdf는 흉내 낸 미디어로 그린다 — 인쇄 미디어 그대로 만든 뒤 화면으로 돌린다
  const pdf = await p.pdf({ format: 'A4' })
  await p.emulateMedia({ media: 'screen' })
  const text = await p.evaluate(async (b64) => {
    const pdfjs = await import('/src/engine/pdf/pdfjs.ts')
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const doc = await pdfjs.openPdf(bytes)
    let out = ''
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent()
      out += tc.items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n'
    }
    await pdfjs.closePdf(doc)
    return out
  }, pdf.toString('base64'))
  const has = (s: string) => text.replace(/\s+/g, '').includes(s.replace(/\s+/g, ''))
  check('인쇄 PDF: 제목·제목 블록·본문 글자 (글자로 읽힘)', has('보고서') && has('개요') && has('본문굵게와기울임'), text.slice(0, 200))
  check('…앱 화면(내보내기 창 등)은 실리지 않음', !has('Markdown으로 내보내기') && !has('저장됨'))
  check('…접어 둔 토글 안쪽도 실림', has('토글 안쪽'))
  check('…목록·할 일·코드', has('안쪽 배') && has('2.둘째') && has('남은 일') && has('let b = a * 2'))
  await p.evaluate(() => window.dispatchEvent(new Event('afterprint')))
  const after = await p.evaluate(() => ({ root: !!document.querySelector('.tdoc-print'), cls: document.documentElement.classList.contains('tdoc-printing'), title: document.title }))
  check('인쇄 창을 닫으면 인쇄용 내용을 치운다', !after.root && !after.cls && after.title !== '보고서', JSON.stringify(after))

  await sleep(100)
  check('내보내기: 페이지 오류 없음', errs.length === 0, errs.join(' | '))
  await p.context().close()
}
