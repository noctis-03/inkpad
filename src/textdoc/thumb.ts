// 문서 카드 미리보기 — 제목과 앞쪽 블록 몇 줄을 A4 비율 종이에 그린다 (노트 미리보기와 같은 폭·형식)
import { plainText } from '../shared/richText'
import type { TextBlock } from '../shared/model'

const W = 320
const H = Math.round((W * 297) / 210)
const PAD = 22

/** 그릴 글이 하나도 없으면 null — 카드는 아이콘으로 보인다 */
export async function renderTextThumb(title: string, blocks: readonly TextBlock[]): Promise<Blob | null> {
  const lines = blocks.filter((b) => b.type === 'divider' || plainText(b.html).trim())
  if (!title.trim() && !lines.length) return null
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, W, H)
  const font = "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Pretendard', system-ui, sans-serif"
  let y = PAD
  const maxW = W - PAD * 2
  /** 한 줄에 안 들어가면 말줄임 */
  const fit = (s: string, w: number) => {
    if (g.measureText(s).width <= w) return s
    let t = s
    while (t && g.measureText(t + '…').width > w) t = t.slice(0, -1)
    return t + '…'
  }
  if (title.trim()) {
    g.fillStyle = '#23211d'
    g.font = `700 22px ${font}`
    y += 22
    g.fillText(fit(title.trim(), maxW), PAD, y)
    y += 16
  }
  let n = 0
  for (const b of lines) {
    if (y > H - PAD) break
    const indent = b.indent * 14
    if (b.type === 'divider') {
      g.fillStyle = '#e3dfd5'
      g.fillRect(PAD, y + 6, maxW, 1)
      y += 14
      continue
    }
    const size = b.type === 'h1' ? 18 : b.type === 'h2' ? 16 : b.type === 'h3' ? 14 : 12
    const weight = b.type.startsWith('h') ? 700 : 400
    g.font = `${weight} ${size}px ${font}`
    g.fillStyle = b.type === 'todo' && b.checked ? '#9a958b' : '#3a3733'
    const mark = b.type === 'bullet' ? '• ' : b.type === 'number' ? `${++n}. ` : b.type === 'todo' ? (b.checked ? '☑ ' : '☐ ') : b.type === 'toggle' ? '▸ ' : ''
    if (b.type !== 'number') n = 0
    y += size + 6
    const text = plainText(b.html).split('\n')[0]
    g.fillText(fit(mark + text, maxW - indent), PAD + indent, y)
    if (b.type === 'quote') {
      g.fillStyle = '#c9c3b8'
      g.fillRect(PAD + indent - 8, y - size, 2, size + 3)
    }
  }
  return await new Promise((res) => c.toBlob((bl) => res(bl), 'image/jpeg', 0.8))
}
