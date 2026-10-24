// 머지·비교 화면의 페이지·보조 용지·편집 블록 항목 글 — 이름, 짧은 내용, 양쪽에서 무엇이 다른가
import type { Block, BlockType, Page } from '../../shared/model'

export const BLOCK_NAME: Record<BlockType, string> = { memo: '메모', link: '링크', todo: '할 일', timer: '타이머', jump: '이동' }

/** 블록 내용 한 줄 (목록·미리보기 상자에 쓴다) */
export function blockSnippet(b: Block, max = 24): string {
  let s = ''
  if (b.type === 'memo') s = b.data.text
  else if (b.type === 'link') s = b.data.label || b.data.url
  else if (b.type === 'todo') s = b.data.items.map((i) => i.text).filter(Boolean).join(', ')
  else if (b.type === 'timer') s = `${Math.floor(b.data.durationSec / 60)}분${b.data.durationSec % 60 ? ` ${b.data.durationSec % 60}초` : ''}`
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** 블록 두 판이 무엇이 다른가 — '내용·위치' 처럼 */
export function blockDiff(a: Block, b: Block): string {
  const out: string[] = []
  if (!!a.deletedAt !== !!b.deletedAt) return '한쪽에서 지움'
  if (a.type !== b.type || !same(a.data, b.data)) {
    if (a.type === 'memo' && b.type === 'memo' && a.data.text === b.data.text && a.data.collapsed === b.data.collapsed) out.push('색')
    else out.push('내용')
  }
  if (a.pageId !== b.pageId || a.x !== b.x || a.y !== b.y) out.push('위치')
  if (a.w !== b.w) out.push('크기')
  if (!!a.minimal !== !!b.minimal || !!a.transparent !== !!b.transparent) out.push('모양')
  if (!!a.fixed !== !!b.fixed) out.push('고정')
  if (a.z !== b.z && !out.length) out.push('쌓임 순서')
  return out.length ? out.join('·') + ' 다름' : '저장 시각만 다름'
}

/** 페이지(보조 용지) 두 판이 무엇이 다른가 */
export function pageDiff(a: Page, b: Page): string {
  const out: string[] = []
  if (!same(a.background, b.background)) out.push('속지')
  if (!same(a.size, b.size)) out.push('크기')
  if (!same(a.pdf, b.pdf)) out.push('PDF')
  const sa = a.sheet
  const sb = b.sheet
  if (sa && sb) {
    if (sa.anchorPageId !== sb.anchorPageId || sa.x !== sb.x || sa.y !== sb.y || sa.snap !== sb.snap) out.push('위치')
    if (sa.title !== sb.title) out.push('제목')
    if (!!sa.transparent !== !!sb.transparent) out.push('투명')
    if (!!sa.fixed !== !!sb.fixed) out.push('고정')
    if (sa.z !== sb.z && !out.length) out.push('쌓임 순서')
  } else if (!!sa !== !!sb) out.push('종류')
  return out.length ? out.join('·') + ' 다름' : '내용 다름'
}
