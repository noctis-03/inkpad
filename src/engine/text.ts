import type { TextBox } from '../shared/model'

/**
 * 텍스트 박스 레이아웃 (줄바꿈 + 높이 계산).
 *
 * 화면(DOM textarea)과 캔버스 렌더가 같은 폰트·같은 규칙으로 줄을 나눠야
 * 커밋 순간에 줄이 튀지 않는다. 그래서 폰트 문자열과 줄바꿈 알고리즘을
 * 한 곳에서만 정의하고 양쪽이 이걸 함께 쓴다.
 */

/** DOM(textarea의 CSS font-family)과 캔버스(ctx.font)가 공유하는 폰트 스택 */
export const TEXT_FONT =
  "-apple-system, BlinkMacSystemFont, system-ui, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif"

/** 줄 간격 (글자 크기 배수) */
export const TEXT_LINE_HEIGHT = 1.45

/** 기본 텍스트 박스 폭 (월드 단위 = pt) */
export const DEFAULT_TEXT_WIDTH = 260

export function fontString(fontSize: number) {
  return `${fontSize}px ${TEXT_FONT}`
}

let measureCtx: CanvasRenderingContext2D | null = null
function measure(): CanvasRenderingContext2D {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')!
  return measureCtx
}

/** CJK는 단어 구분 없이 글자 단위로 끊는다 */
function isCJK(ch: string) {
  const c = ch.codePointAt(0)!
  return (
    (c >= 0x1100 && c <= 0x11ff) || // 한글 자모
    (c >= 0x2e80 && c <= 0x9fff) || // CJK 부수·한자
    (c >= 0xa960 && c <= 0xa97f) ||
    (c >= 0xac00 && c <= 0xd7a3) || // 한글 음절
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) // 전각
  )
}

/**
 * 한 문단을 maxW에 맞춰 줄바꿈한다.
 * 공백이 있으면 공백에서 끊고(라틴 단어 보호), 없으면 글자 단위로 끊는다(CJK·긴 단어).
 */
function wrapParagraph(ctx: CanvasRenderingContext2D, para: string, maxW: number): string[] {
  const lines: string[] = []
  let line = ''
  let lastSpace = -1 // line 안에서 '다음 줄 시작' 인덱스
  for (const ch of para) {
    line += ch
    if (ch === ' ') lastSpace = line.length
    if (ctx.measureText(line).width <= maxW) continue
    if (lastSpace > 0 && lastSpace < line.length) {
      lines.push(line.slice(0, lastSpace - 1))
      line = line.slice(lastSpace)
    } else {
      const last = line[line.length - 1]
      lines.push(line.slice(0, -1))
      line = last
    }
    const sp = line.lastIndexOf(' ')
    lastSpace = sp >= 0 ? sp + 1 : -1
  }
  lines.push(line)
  return lines
}

export interface TextLayout {
  lines: string[]
  lineHeight: number
  height: number
  font: string
}

type CacheEntry = TextLayout & { key: string }
const cache = new WeakMap<TextBox, CacheEntry>()

/**
 * 박스의 줄/높이를 계산한다. 결과는 요소 객체에 WeakMap으로 캐시하므로
 * 매 프레임 다시 측정하지 않는다 (텍스트가 바뀌면 key가 달라져 자동 무효화).
 */
export function layoutTextBox(box: TextBox): TextLayout {
  const w = Math.max(24, box.w)
  const key = `${box.fontSize}|${w}|${box.text}`
  const hit = cache.get(box)
  if (hit && hit.key === key) return hit
  const ctx = measure()
  ctx.font = fontString(box.fontSize)
  const lineHeight = box.fontSize * TEXT_LINE_HEIGHT
  const lines: string[] = []
  for (const para of box.text.split('\n')) {
    if (para === '') lines.push('')
    else lines.push(...wrapParagraph(ctx, para, w))
  }
  const value: CacheEntry = {
    key,
    lines,
    lineHeight,
    height: Math.max(lineHeight, lines.length * lineHeight),
    font: ctx.font
  }
  cache.set(box, value)
  return value
}

/** 월드 좌표 기준 텍스트 박스의 경계 (히트 테스트·컬링용) */
export function textBoxBounds(box: TextBox) {
  return { w: Math.max(24, box.w), h: layoutTextBox(box).height }
}
