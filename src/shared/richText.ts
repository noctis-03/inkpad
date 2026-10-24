// 문서 블록의 인라인 서식 HTML — 허용하는 태그는 b·i·u·s·code·a·br뿐이다.
// 편집 중에는 contenteditable이 만든 HTML을 그대로 들고 있다가, 저장·불러오기·붙여넣기 때 이 함수로 정리한다.
// (그 밖의 태그는 벗기고 글자만 남긴다. 링크는 http·https·mailto·tel만)
const TAG: Record<string, string> = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', S: 's', STRIKE: 's', DEL: 's', CODE: 'code', A: 'a' }
const SAFE_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:']

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function safeHref(raw: string | null): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw, 'https://x.invalid/')
    return SAFE_SCHEMES.includes(u.protocol) && !u.href.startsWith('https://x.invalid/') ? u.href : null
  } catch {
    return null
  }
}

function walk(node: Node, out: string[], inside: Set<string>) {
  for (const n of node.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) {
      out.push(escapeHtml(n.textContent ?? ''))
      continue
    }
    if (n.nodeType !== Node.ELEMENT_NODE) continue
    const el = n as HTMLElement
    if (el.tagName === 'BR') {
      out.push('<br>')
      continue
    }
    let tag = TAG[el.tagName]
    // 굵게·기울임이 style로 들어온 경우(일부 브라우저의 execCommand·붙여넣기)
    if (!tag && el.tagName === 'SPAN') {
      const st = el.style
      if (st.fontWeight === 'bold' || Number(st.fontWeight) >= 600) tag = 'b'
      else if (st.fontStyle === 'italic') tag = 'i'
    }
    // 같은 서식 안에 같은 서식은 한 번만
    if (!tag || inside.has(tag)) {
      walk(el, out, inside)
      // 줄 단위 요소(div·p)를 벗기면 줄바꿈을 남긴다
      if (/^(DIV|P|LI|H[1-6])$/.test(el.tagName) && el.nextSibling) out.push('<br>')
      continue
    }
    if (tag === 'a') {
      const href = safeHref(el.getAttribute('href'))
      if (!href) {
        walk(el, out, inside)
        continue
      }
      out.push(`<a href="${escapeHtml(href)}">`)
    } else out.push(`<${tag}>`)
    inside.add(tag)
    walk(el, out, inside)
    inside.delete(tag)
    out.push(`</${tag}>`)
  }
}

/** 허용한 인라인 서식만 남긴 HTML. 끝의 빈 줄바꿈(contenteditable이 넣는 <br>)은 뺀다 */
export function sanitizeInline(html: string): string {
  if (!html) return ''
  const t = document.createElement('template')
  t.innerHTML = html
  const out: string[] = []
  walk(t.content, out, new Set())
  return out.join('').replace(/(<br>)+$/, '').replace(/<(b|i|u|s|code)><\/\1>/g, '')
}

/** 글자만 (줄바꿈은 \n) */
export function plainText(html: string): string {
  if (!html) return ''
  const t = document.createElement('template')
  t.innerHTML = html.replace(/<br\s*\/?>/gi, '\n')
  return t.content.textContent ?? ''
}
