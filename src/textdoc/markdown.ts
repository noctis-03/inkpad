// 문서(text 모드) → Markdown. 다른 앱(노션·옵시디언 등)으로 옮기기 쉽게 흔한 문법만 쓴다.
//  - 제목은 맨 위 '# 제목', 블록 제목은 #·##·### (노션 내보내기와 같게)
//  - 목록·할 일·토글은 들여쓰기 3칸씩 중첩, 토글은 글머리 목록으로 (Markdown에 접기가 없다)
//  - 서식: **굵게** *기울임* ~~취소선~~ `코드` [링크](주소), 밑줄은 <u>…</u>
import { numberLabels } from './model'
import { plainText, sanitizeInline } from '../shared/richText'
import type { TextBlock } from '../shared/model'

const LIST_INDENT = '   '

/** Markdown에서 뜻이 있는 글자는 \로 막는다 (줄 맨 앞의 #·>·숫자. 는 블록 접두어가 앞에 붙으므로 따로 막지 않는다) */
const escapeMd = (s: string) => s.replace(/([\\`*_[\]~<>])/g, '\\$1')

/** 인라인 서식 HTML → Markdown. cont는 줄바꿈 뒤 이어지는 줄 앞에 붙일 것(목록 안 들여쓰기) */
export function inlineToMarkdown(html: string, cont = ''): string {
  const t = document.createElement('template')
  t.innerHTML = sanitizeInline(html)
  const walk = (node: Node): string => {
    let out = ''
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        out += escapeMd(n.textContent ?? '')
        continue
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue
      const el = n as HTMLElement
      const tag = el.tagName
      if (tag === 'BR') {
        out += '  \n' + cont
        continue
      }
      if (tag === 'CODE') {
        const code = el.textContent ?? ''
        const fence = code.includes('`') ? '``' : '`'
        out += code ? `${fence}${fence.length > 1 ? ' ' : ''}${code}${fence.length > 1 ? ' ' : ''}${fence}` : ''
        continue
      }
      const inner = walk(el)
      if (!inner.trim()) {
        out += inner
        continue
      }
      // 서식 기호는 글자에 바로 붙어야 한다 — 앞뒤 공백은 기호 밖으로
      const [, lead, body, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!
      const wrap = (a: string, b = a) => `${lead}${a}${body}${b}${trail}`
      if (tag === 'B') out += wrap('**')
      else if (tag === 'I') out += wrap('*')
      else if (tag === 'S') out += wrap('~~')
      else if (tag === 'U') out += wrap('<u>', '</u>')
      else if (tag === 'A') out += `${lead}[${body}](${(el.getAttribute('href') ?? '').replace(/[()]/g, (c) => encodeURIComponent(c))})${trail}`
      else out += inner
    }
    return out
  }
  return walk(t.content)
}

const isList = (b: TextBlock) => b.type === 'bullet' || b.type === 'number' || b.type === 'todo' || b.type === 'toggle'

/** 블록 목록 → Markdown 글 */
export function blocksToMarkdown(title: string, blocks: readonly TextBlock[]): string {
  const live = blocks.filter((b) => !b.deletedAt)
  const nums = numberLabels(live)
  const parts: string[] = []
  if (title.trim()) parts.push(`# ${escapeMd(title.trim())}`)
  let prev: TextBlock | null = null
  for (const b of live) {
    // 빈 문단은 Markdown에서 빈 줄과 같다 — 건너뛴다
    if (b.type === 'p' && !plainText(b.html).trim()) continue
    const ind = isList(b) ? LIST_INDENT.repeat(b.indent) : ''
    let line: string
    switch (b.type) {
      case 'h1':
      case 'h2':
      case 'h3':
        line = `${'#'.repeat(Number(b.type[1]))} ${inlineToMarkdown(b.html)}`
        break
      case 'bullet':
      case 'toggle':
        line = `${ind}- ${inlineToMarkdown(b.html, ind + '  ')}`
        break
      case 'number':
        line = `${ind}${nums.get(b.id) ?? 1}. ${inlineToMarkdown(b.html, ind + LIST_INDENT)}`
        break
      case 'todo':
        line = `${ind}- [${b.checked ? 'x' : ' '}] ${inlineToMarkdown(b.html, ind + '  ')}`
        break
      case 'quote':
        line = `> ${inlineToMarkdown(b.html, '> ')}`
        break
      case 'code': {
        const code = plainText(b.html)
        const fence = code.includes('```') ? '````' : '```'
        line = `${fence}\n${code}\n${fence}`
        break
      }
      case 'divider':
        line = '---'
        break
      default:
        line = inlineToMarkdown(b.html)
    }
    // 이어진 목록 줄은 빈 줄 없이 — 그래야 한 목록이 된다
    const tight = prev && isList(prev) && isList(b)
    parts.push(tight ? '\n' + line : (parts.length ? '\n\n' : '') + line)
    prev = b
  }
  return parts.join('').replace(/^\n+/, '') + '\n'
}
