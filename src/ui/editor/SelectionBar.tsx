import { useLayoutEffect, useRef } from 'react'
import type { Engine } from '../../engine/engine'
import { PEN_COLORS, PEN_COLOR_NAMES, ro, useUI } from '../../app/store'
import { Icon } from '../Icon'

/**
 * 올가미 선택 도구 모음: 이동은 선택 영역을 펜으로 끌기.
 * 위치는 .editor-area 크기와 툴바 실제 폭을 재서 정한다 — 페이지 사이드바가 열려도
 * 화면 밖으로 나가지 않고, 위쪽 공간이 부족하면 선택 영역 아래에 놓인다 (C-2).
 */
export function SelectionBar({ engine }: { engine: Engine }) {
  const sel = useUI((s) => s.selection)
  const barRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const area = bar.parentElement
    if (!area) return
    const bw = bar.offsetWidth
    const bh = bar.offsetHeight
    const aw = area.clientWidth
    const ah = area.clientHeight
    let top = sel ? sel.rect.y - bh - 8 : 8
    if (sel && top < 8) top = sel.rect.y + sel.rect.h + 8 // 위쪽이 부족하면 아래에 놓는다
    top = Math.max(8, Math.min(top, Math.max(8, ah - bh - 8)))
    const left = sel ? Math.max(8, Math.min(sel.rect.x, Math.max(8, aw - bw - 8))) : 8
    bar.style.top = `${top}px`
    bar.style.left = `${left}px`
  })

  if (!sel || sel.moving) return sel?.moving ? <SelectionBox rect={sel.rect} /> : null
  return (
    <>
      <SelectionBox rect={sel.rect} />
      <div ref={barRef} className="selection-bar" role="toolbar" aria-label="선택 영역">
        <span className="sel-count">{sel.count}개</span>
        <button className="tb-btn" onClick={() => engine.duplicateSelection()} aria-label="복제">
          <Icon name="copy" size={20} />
        </button>
        {PEN_COLORS.slice(0, 5).map((c, i) => (
          <button
            key={c}
            className="color-swatch small"
            style={{ ['--swatch' as string]: c }}
            onClick={() => engine.recolorSelection(c)}
            aria-label={`${ro(PEN_COLOR_NAMES[i])} 바꾸기`}
          />
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
