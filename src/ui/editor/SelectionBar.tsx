import { useLayoutEffect, useRef } from 'react'
import type { Engine } from '../../engine/engine'
import { PEN_COLORS, PEN_COLOR_NAMES, ro, useUI } from '../../app/store'
import { Icon } from '../Icon'

/**
 * 올가미 선택 도구 모음: 이동은 선택 영역을 펜으로 끌기.
 * 위치는 .editor-area 크기와 툴바 실제 폭을 재서 정한다 — 페이지 사이드바가 열려도
 * 화면 밖으로 나가지 않고, 위쪽 공간이 부족하면 선택 영역 아래에 놓인다.
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

  if (!sel || sel.moving) return sel?.moving ? <SelectionShape poly={sel.poly} /> : null
  const send = (
    <button className="tb-btn" onClick={() => useUI.setState({ sendImage: 'selection' })} aria-label="이미지로 보내기" title="이미지로 보내기 — 복사·공유해 AI 앱에 붙여넣기">
      <Icon name="share" size={20} />
    </button>
  )
  // 획 없이 영역만 고른 경우(인쇄된 PDF 문제만 감쌌을 때 등) — 보내기만 할 수 있다
  if (!sel.count)
    return (
      <>
        <SelectionShape poly={sel.poly} />
        <div ref={barRef} className="selection-bar" role="toolbar" aria-label="고른 영역">
          <span className="sel-count">영역</span>
          {send}
          <button className="tb-btn" onClick={() => engine.clearSelection()} aria-label="선택 해제">
            <Icon name="close" size={20} />
          </button>
        </div>
      </>
    )
  return (
    <>
      <SelectionShape poly={sel.poly} />
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
        {send}
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

/** 고른 영역 — 올가미 모양 그대로 움직이는 점선 (이미지로 보내면 이 모양대로 잘린다) */
function SelectionShape({ poly }: { poly: number[] }) {
  let points = ''
  for (let i = 0; i < poly.length; i += 2) points += `${poly[i]},${poly[i + 1]} `
  return (
    <svg className="selection-shape" aria-hidden="true">
      <polygon points={points} />
    </svg>
  )
}
