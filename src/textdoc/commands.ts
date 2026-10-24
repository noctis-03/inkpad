// 문서 블록 명령 — 슬래시(/) 메뉴 항목, 마크다운 단축키, 여러 줄 붙여넣기 나누기
import { escapeHtml } from '../shared/richText'
import type { TextBlockType } from '../shared/model'

export interface SlashItem {
  type: TextBlockType
  label: string
  desc: string
  /** 아이콘 자리 글자 */
  glyph: string
  /** 검색어 (한글·영문) */
  keys: string[]
}

export const SLASH_ITEMS: SlashItem[] = [
  { type: 'p', label: '텍스트', desc: '일반 문단', glyph: 'T', keys: ['텍스트', '문단', 'text', 'p', 'paragraph'] },
  { type: 'h1', label: '제목 1', desc: '큰 제목', glyph: 'H1', keys: ['제목1', '제목 1', 'h1', 'heading1', '큰제목'] },
  { type: 'h2', label: '제목 2', desc: '중간 제목', glyph: 'H2', keys: ['제목2', '제목 2', 'h2', 'heading2'] },
  { type: 'h3', label: '제목 3', desc: '작은 제목', glyph: 'H3', keys: ['제목3', '제목 3', 'h3', 'heading3'] },
  { type: 'bullet', label: '글머리 목록', desc: '• 항목', glyph: '•', keys: ['글머리', '목록', 'bullet', 'list', 'ul'] },
  { type: 'number', label: '번호 목록', desc: '1. 항목', glyph: '1.', keys: ['번호', '목록', 'number', 'numbered', 'ol'] },
  { type: 'todo', label: '할 일', desc: '체크 상자', glyph: '☐', keys: ['할일', '할 일', '체크', 'todo', 'check'] },
  { type: 'toggle', label: '토글', desc: '접고 펼치는 목록', glyph: '▸', keys: ['토글', '접기', 'toggle'] },
  { type: 'quote', label: '인용', desc: '인용문', glyph: '❝', keys: ['인용', 'quote', 'blockquote'] },
  { type: 'code', label: '코드', desc: '코드 블록', glyph: '</>', keys: ['코드', 'code'] },
  { type: 'divider', label: '구분선', desc: '가로줄', glyph: '—', keys: ['구분선', '가로줄', 'divider', 'hr', 'line'] }
]

/** 슬래시 뒤 검색어로 거른다 (공백 무시, 앞부분 일치 우선) */
export function filterSlash(query: string): SlashItem[] {
  const q = query.replace(/\s+/g, '').toLowerCase()
  if (!q) return SLASH_ITEMS
  const starts: SlashItem[] = []
  const has: SlashItem[] = []
  for (const it of SLASH_ITEMS) {
    const keys = [it.label, ...it.keys].map((k) => k.replace(/\s+/g, '').toLowerCase())
    if (keys.some((k) => k.startsWith(q))) starts.push(it)
    else if (keys.some((k) => k.includes(q))) has.push(it)
  }
  return [...starts, ...has]
}

/**
 * 문단 맨 앞에서 쓰는 마크다운 단축키 — 캐럿 앞 글자(prefix, 방금 친 글자까지)가 이 모양이면 블록을 바꾼다.
 * 공백으로 끝나는 것은 공백을 친 순간, ``` 와 --- 는 세 번째 글자를 친 순간.
 */
export function markdownShortcut(prefix: string): { type: TextBlockType; checked?: boolean } | null {
  switch (prefix) {
    case '# ':
      return { type: 'h1' }
    case '## ':
      return { type: 'h2' }
    case '### ':
      return { type: 'h3' }
    case '- ':
    case '* ':
    case '• ':
      return { type: 'bullet' }
    case '1. ':
    case '1) ':
      return { type: 'number' }
    case '[] ':
    case '[ ] ':
      return { type: 'todo', checked: false }
    case '[x] ':
      return { type: 'todo', checked: true }
    case '> ':
      return { type: 'quote' }
    case '>> ':
      return { type: 'toggle' }
    case '```':
      return { type: 'code' }
    case '---':
      return { type: 'divider' }
  }
  return null
}

/** 붙여넣은 글을 줄마다 블록으로 — 줄 앞의 마크다운 표시(#, -, 1., [ ], >)를 블록 종류로 바꾼다 */
export function linesToBlocks(text: string): { type: TextBlockType; html: string; checked?: boolean }[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  // 끝의 빈 줄은 버린다
  while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop()
  return lines.map((ln) => {
    const m = /^(#{1,3} |[-*•] |\d+[.)] |\[[ xX]?\] |> )/.exec(ln)
    if (!m) return { type: 'p' as const, html: escapeHtml(ln) }
    const mark = m[1]
    const rest = escapeHtml(ln.slice(mark.length))
    if (mark.startsWith('#')) return { type: (['h1', 'h2', 'h3'] as const)[mark.trim().length - 1], html: rest }
    if (/^\d/.test(mark)) return { type: 'number' as const, html: rest }
    if (mark.startsWith('[')) return { type: 'todo' as const, html: rest, checked: /x/i.test(mark) }
    if (mark.startsWith('>')) return { type: 'quote' as const, html: rest }
    return { type: 'bullet' as const, html: rest }
  })
}
