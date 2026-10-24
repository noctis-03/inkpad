// contenteditable 블록의 캐럿 다루기 — 글자 수(offset) 기준. <br>은 글자로 세지 않는다(Range.toString과 같게).

function selIn(el: HTMLElement): Selection | null {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return null
  return el.contains(sel.anchorNode) ? sel : null
}

/** 블록 시작부터 캐럿(선택의 끝)까지 글자 수. 캐럿이 이 블록에 없으면 -1 */
export function caretOffset(el: HTMLElement): number {
  const sel = selIn(el)
  if (!sel) return -1
  const r = document.createRange()
  r.selectNodeContents(el)
  r.setEnd(sel.focusNode!, sel.focusOffset)
  return r.toString().length
}

export const textLength = (el: HTMLElement) => (el.textContent ?? '').length

/** 글자 offset 자리를 (노드, 노드 안 offset)으로 */
function pointAt(el: HTMLElement, offset: number): [Node, number] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let left = offset
  let last: Text | null = null
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.data.length
    if (left <= len) return [n, left]
    left -= len
    last = n
  }
  return last ? [last, last.data.length] : [el, el.childNodes.length]
}

/** 캐럿을 놓는다 — offset: 글자 수, 'start', 'end' */
export function setCaret(el: HTMLElement, offset: number | 'start' | 'end') {
  const sel = window.getSelection()
  if (!sel) return
  const r = document.createRange()
  if (offset === 'start' || offset === 0) {
    r.selectNodeContents(el)
    r.collapse(true)
  } else if (offset === 'end' || offset >= textLength(el)) {
    r.selectNodeContents(el)
    r.collapse(false)
  } else {
    const [n, o] = pointAt(el, offset)
    r.setStart(n, o)
    r.collapse(true)
  }
  sel.removeAllRanges()
  sel.addRange(r)
}

/** 글자 [from, to) 를 지운다 (마크다운 접두어·슬래시 명령 지우기) */
export function deleteRange(el: HTMLElement, from: number, to: number) {
  if (to <= from) return
  const [sn, so] = pointAt(el, from)
  const [en, eo] = pointAt(el, to)
  const r = document.createRange()
  r.setStart(sn, so)
  r.setEnd(en, eo)
  r.deleteContents()
  setCaret(el, from)
}

const htmlOf = (frag: DocumentFragment) => {
  const d = document.createElement('div')
  d.append(frag)
  return d.innerHTML
}

/** 캐럿(선택이 있으면 지운 뒤)에서 둘로 — 앞·뒤 HTML. 서식은 양쪽에 그대로 남는다 */
export function splitAtCaret(el: HTMLElement): { head: string; tail: string } {
  const sel = selIn(el)
  if (!sel) return { head: el.innerHTML, tail: '' }
  const r = sel.getRangeAt(0)
  if (!r.collapsed) r.deleteContents()
  const tail = document.createRange()
  tail.setStart(r.endContainer, r.endOffset)
  tail.setEnd(el, el.childNodes.length)
  const tailHtml = htmlOf(tail.extractContents())
  return { head: el.innerHTML, tail: tailHtml }
}

/** 한 줄짜리 블록인가 (캐럿 사각형을 못 잴 때의 판단) */
const singleLine = (el: HTMLElement) => el.scrollHeight <= lineHeight(el) * 1.6

/** 캐럿이 첫 줄(위 화살표로 위 블록에 갈 자리)인가 */
export function caretOnFirstLine(el: HTMLElement): boolean {
  const rect = caretRect(el)
  if (!rect) return caretOffset(el) <= 0 || singleLine(el)
  return rect.top - el.getBoundingClientRect().top < lineHeight(el) * 0.8
}

export function caretOnLastLine(el: HTMLElement): boolean {
  const rect = caretRect(el)
  if (!rect) return caretOffset(el) >= textLength(el) || singleLine(el)
  return el.getBoundingClientRect().bottom - rect.bottom < lineHeight(el) * 0.8
}

function lineHeight(el: HTMLElement) {
  const lh = parseFloat(getComputedStyle(el).lineHeight)
  return Number.isFinite(lh) ? lh : 24
}

/** 캐럿 자리 사각형 — 빈 줄·줄 끝처럼 브라우저가 사각형을 주지 않으면 null */
export function caretRect(el: HTMLElement): DOMRect | null {
  const sel = selIn(el)
  if (!sel) return null
  const r = sel.getRangeAt(0).cloneRange()
  r.collapse(false)
  const rects = r.getClientRects()
  return rects.length ? rects[rects.length - 1] : null
}
