import type { Engine } from '../../engine/engine'
import { PEN_COLORS, useUI } from '../../app/store'
import { Icon } from '../Icon'

/** 올가미 선택 도구 모음: 이동은 선택 영역을 펜으로 끌기 */
export function SelectionBar({ engine }: { engine: Engine }) {
  const sel = useUI((s) => s.selection)
  if (!sel || sel.moving) return sel?.moving ? <SelectionBox rect={sel.rect} /> : null
  const top = Math.max(8, sel.rect.y - 56)
  const left = Math.max(8, Math.min(sel.rect.x, window.innerWidth - 360))
  return (
    <>
      <SelectionBox rect={sel.rect} />
      <div className="selection-bar" style={{ top, left }} role="toolbar" aria-label="선택 영역">
        <span className="sel-count">
          {sel.count}개
          {sel.blocks > 0 && sel.count > sel.blocks ? ` (블록 ${sel.blocks})` : ''}
        </span>
        <button className="tb-btn" onClick={() => engine.duplicateSelection()} aria-label="복제">
          <Icon name="copy" size={20} />
        </button>
        {PEN_COLORS.slice(0, 5).map((c) => (
          <button key={c} className="color-swatch small" style={{ ['--swatch' as string]: c }} onClick={() => engine.recolorSelection(c)} aria-label={`색 ${c}로 바꾸기`} />
        ))}
        <button className="tb-btn danger" onClick={() => engine.deleteSelection()} aria-label="삭제">
          <Icon name="trash" size={20} />
        </button>
        <button className="tb-btn" onClick={() => engine.clearSelection()} aria-label="선택 해제">
          <Icon name="close" size={20} />
        </button>
      </div>
    </>
  )
}

function SelectionBox({ rect }: { rect: { x: number; y: number; w: number; h: number } }) {
  return <div className="selection-box" style={{ left: rect.x - 4, top: rect.y - 4, width: rect.w + 8, height: rect.h + 8 }} />
}
