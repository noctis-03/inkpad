// 문서(text 모드) → PDF. 브라우저 인쇄로 만든다 — 인쇄 창에서 'PDF로 저장'(iPad는 공유 → 파일에 저장).
// pdf-lib로 직접 만들면 한글 글꼴(수 MB)을 넣어야 한다. 인쇄는 기기 글꼴로 그리고 글자를 고를 수 있는 PDF가 된다.
// 인쇄하는 동안만 body 맨 끝에 .tdoc-print를 두고, 인쇄용 CSS가 그것만 보이게 한다(15-textdoc.css @media print).
import { numberLabels } from './model'
import { escapeHtml, plainText, sanitizeInline } from '../shared/richText'
import type { TextBlock } from '../shared/model'

const BULLETS = ['•', '◦', '▪']

/** 인쇄할 HTML (제목 + 블록). 토글은 접혀 있어도 모두 펼쳐 싣는다 */
export function printHtml(title: string, blocks: readonly TextBlock[]): string {
  const live = blocks.filter((b) => !b.deletedAt)
  const nums = numberLabels(live)
  const rows = live.map((b) => {
    const html = b.type === 'code' ? escapeHtml(plainText(b.html)) : sanitizeInline(b.html)
    const style = b.indent ? ` style="--ind:${b.indent}"` : ''
    const marker =
      b.type === 'bullet' ? BULLETS[b.indent % BULLETS.length] : b.type === 'number' ? `${nums.get(b.id) ?? 1}.` : b.type === 'todo' ? (b.checked ? '☑' : '☐') : b.type === 'toggle' ? '▾' : ''
    if (b.type === 'divider') return '<hr>'
    if (b.type === 'code') return `<pre${style}>${html}</pre>`
    if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3') return `<${b.type}>${html}</${b.type}>`
    if (b.type === 'quote') return `<blockquote${style}>${html}</blockquote>`
    if (marker) return `<div class="pr-li${b.type === 'todo' && b.checked ? ' is-done' : ''}"${style}><span class="pr-m">${marker}</span><span class="pr-t">${html}</span></div>`
    return `<p${style}>${html || '&nbsp;'}</p>`
  })
  return `<h1 class="pr-title">${escapeHtml(title.trim() || '제목 없음')}</h1>${rows.join('')}`
}

/** 인쇄 창을 연다. 창이 닫히면(afterprint) 인쇄용 내용을 치운다 */
export function printTextDoc(title: string, blocks: readonly TextBlock[]): void {
  document.querySelector('.tdoc-print')?.remove()
  const root = document.createElement('div')
  root.className = 'tdoc-print'
  root.innerHTML = printHtml(title, blocks)
  document.body.append(root)
  document.documentElement.classList.add('tdoc-printing')
  const prevTitle = document.title
  document.title = title.trim() || '제목 없음' // 저장할 PDF 파일 이름의 기본값이 된다
  const cleanup = () => {
    window.removeEventListener('afterprint', cleanup)
    root.remove()
    document.documentElement.classList.remove('tdoc-printing')
    document.title = prevTitle
  }
  window.addEventListener('afterprint', cleanup)
  window.print()
}
