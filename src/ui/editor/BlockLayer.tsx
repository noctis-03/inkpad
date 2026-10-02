import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BLOCK_FONT_SIZES, PEN_COLORS, useUI } from '../../app/store'
import type { Engine } from '../../engine/engine'
import type { BlockRec } from '../../engine/scene'
import { MIN_TEXT_W, type TextBox } from '../../shared/model'
import { Icon } from '../Icon'

/**
 * 블록 편집 모드의 DOM 레이어.
 *
 * 왜 DOM인가: 캔버스는 한글 IME 조합(composing) 중간 상태를 그릴 수 없다.
 * 블록은 DOM으로 렌더하고, 카메라 변환만 엔진에서 받아 CSS transform으로 따라간다.
 * 데이터(모델·저장·Undo)는 전부 엔진이 소유한다 — 여기는 표시와 조작만 담당한다.
 */
export function BlockLayer({ engine, host }: { engine: Engine; host: HTMLElement }) {
  const editMode = useUI((s) => s.editMode)
  const style = useUI((s) => s.style)
  const setStyle = useUI((s) => s.setStyle)
  const snapOn = useUI((s) => s.settings.blockSnap)
  const snapStep = useUI((s) => s.settings.blockSnapStep)

  const [, force] = useReducer((n: number) => n + 1, 0)
  const layerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(engine.cam.zoom)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  const interactive = editMode === 'block' && !engine.readOnly
  const step = snapOn ? Math.max(1, snapStep || 16) : 0
  const snapv = (v: number) => (step ? Math.round(v / step) * step : Math.round(v * 100) / 100)

  useEffect(() => engine.onBlocksChange(force), [engine])

  // 새 블록은 곧바로 편집을 연다
  useEffect(
    () =>
      engine.onBlockCreated((id) => {
        setSelected(id)
        setEditing(id)
      }),
    [engine]
  )

  // 카메라는 매 프레임 바뀐다 — React를 다시 그리지 않고 DOM에 직접 반영한다
  useEffect(
    () =>
      engine.onCameraChange((c) => {
        const el = layerRef.current
        if (el) el.style.transform = `translate(${-c.x * c.zoom}px, ${-c.y * c.zoom}px) scale(${c.zoom})`
        setZoom((z) => (Math.abs(z - c.zoom) > 1e-4 ? c.zoom : z))
      }),
    [engine]
  )

  useEffect(() => {
    if (editMode !== 'block') {
      setSelected(null)
      setEditing(null)
    }
  }, [editMode])

  // 블록 위에서 시작한 포인터는 엔진(필기·블록 생성)으로 새지 않게 여기서 끊는다.
  // 캡처 단계에서 stopPropagation 하면 엔진의 루트 리스너보다 먼저 실행된다.
  useEffect(() => {
    const layer = layerRef.current
    if (!layer || !interactive) return
    let drag: {
      id: number
      mode: 'move' | 'resize'
      sx: number
      sy: number
      baseX: number
      baseY: number
      baseW: number
      moved: boolean
      el: HTMLElement
    } | null = null

    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement
      const blockEl = target.closest<HTMLElement>('.block')
      if (!blockEl) return // 빈 곳 → 엔진이 처리 (탭 = 새 블록, 끌기 = 화면 이동)
      const id = blockEl.dataset.id!
      const editingThis = blockEl.dataset.editing === '1'
      // 손가락은 팬/줌 제스처로 넘긴다 (편집 중일 때만 예외)
      if (e.pointerType === 'touch' && !editingThis) return
      e.stopPropagation()
      setSelected(id)
      if (target.closest('.block-toolbar')) return
      if (editingThis && !target.classList.contains('block-resize')) return
      const rec = engine.blocks().find((b) => b.el.id === id)
      if (!rec) return
      drag = {
        id: e.pointerId,
        mode: target.classList.contains('block-resize') ? 'resize' : 'move',
        sx: e.clientX,
        sy: e.clientY,
        baseX: rec.ox + (rec.el as TextBox).x,
        baseY: rec.oy + (rec.el as TextBox).y,
        baseW: (rec.el as TextBox).w,
        moved: false,
        el: blockEl
      }
      try {
        blockEl.setPointerCapture(e.pointerId)
      } catch {
        /* noop */
      }
    }

    const onMove = (e: PointerEvent) => {
      if (!drag || drag.id !== e.pointerId) return
      e.stopPropagation()
      const dx = (e.clientX - drag.sx) / zoom
      const dy = (e.clientY - drag.sy) / zoom
      if (!drag.moved && Math.hypot(dx, dy) * zoom > 4) drag.moved = true
      if (!drag.moved) return
      if (drag.mode === 'resize') drag.el.style.width = Math.max(MIN_TEXT_W, snapv(drag.baseW + dx)) + 'px'
      else {
        drag.el.style.left = snapv(drag.baseX + dx) + 'px'
        drag.el.style.top = snapv(drag.baseY + dy) + 'px'
      }
    }

    const onUp = (e: PointerEvent) => {
      if (!drag || drag.id !== e.pointerId) return
      e.stopPropagation()
      const d = drag
      drag = null
      d.el.style.left = ''
      d.el.style.top = ''
      d.el.style.width = ''
      if (!d.moved) return
      const dx = (e.clientX - d.sx) / zoom
      const dy = (e.clientY - d.sy) / zoom
      if (d.mode === 'resize') engine.updateTextBlock(d.el.dataset.id!, { w: Math.max(MIN_TEXT_W, snapv(d.baseW + dx)) })
      else engine.moveBlock(d.el.dataset.id!, d.baseX + dx, d.baseY + dy)
    }

    layer.addEventListener('pointerdown', onDown, true)
    layer.addEventListener('pointermove', onMove, true)
    layer.addEventListener('pointerup', onUp, true)
    layer.addEventListener('pointercancel', onUp, true)
    return () => {
      layer.removeEventListener('pointerdown', onDown, true)
      layer.removeEventListener('pointermove', onMove, true)
      layer.removeEventListener('pointerup', onUp, true)
      layer.removeEventListener('pointercancel', onUp, true)
    }
  }, [engine, interactive, step, zoom])

  const blocks = engine.blocks().filter((b): b is BlockRec & { el: TextBox } => b.el.type === 'text')

  const stepFont = (dir: number) => {
    const cur = style.block.fontSize
    let i = BLOCK_FONT_SIZES.indexOf(cur)
    if (i < 0) {
      i = BLOCK_FONT_SIZES.findIndex((s) => s >= cur)
      if (i < 0) i = BLOCK_FONT_SIZES.length - 1
    }
    const next = BLOCK_FONT_SIZES[Math.max(0, Math.min(BLOCK_FONT_SIZES.length - 1, i + dir))]
    setStyle({ ...style, block: { ...style.block, fontSize: next } })
    return next
  }

  return createPortal(
    <div className="block-layer" ref={layerRef} data-mode={editMode}>
      {blocks.map((b) => {
        const el = b.el
        const isSel = selected === el.id
        const isEdit = editing === el.id
        const commit = (text: string, h: number) => {
          setEditing(null)
          if (!text.trim()) {
            engine.deleteBlock(el.id)
            setSelected(null)
            return
          }
          engine.updateTextBlock(el.id, { text, h })
        }
        return (
          <div
            key={el.id}
            className={'block' + (isSel ? ' is-selected' : '') + (isEdit ? ' is-editing' : '')}
            data-id={el.id}
            data-editing={isEdit ? '1' : ''}
            style={{ left: b.ox + el.x, top: b.oy + el.y, width: el.w }}
          >
            <BlockText el={el} editing={isEdit} onCommit={commit} onCancel={() => setEditing(null)} />
            {isSel && !isEdit && interactive && (
              <div className="block-toolbar" style={{ transform: `scale(${1 / zoom})` }}>
                <button className="tb-btn" onClick={() => setEditing(el.id)} aria-label="내용 편집">
                  <Icon name="edit" size={18} />
                </button>
                <button className="tb-btn" onClick={() => engine.updateTextBlock(el.id, { fontSize: stepFont(-1) })} aria-label="글자 작게">
                  A-
                </button>
                <button className="tb-btn" onClick={() => engine.updateTextBlock(el.id, { fontSize: stepFont(1) })} aria-label="글자 크게">
                  A+
                </button>
                {PEN_COLORS.slice(0, 5).map((c) => (
                  <button
                    key={c}
                    className={'color-swatch small' + (el.color.slice(0, 7) === c.slice(0, 7) ? ' is-active' : '')}
                    style={{ ['--swatch' as string]: c }}
                    onClick={() => {
                      setStyle({ ...style, block: { ...style.block, color: c } })
                      engine.updateTextBlock(el.id, { color: c })
                    }}
                    aria-label={`글자 색 ${c}`}
                  />
                ))}
                <button
                  className="tb-btn danger"
                  onClick={() => {
                    engine.deleteBlock(el.id)
                    setSelected(null)
                  }}
                  aria-label="블록 삭제"
                >
                  <Icon name="trash" size={18} />
                </button>
              </div>
            )}
            {isSel && !isEdit && interactive && <span className="block-resize" aria-hidden />}
          </div>
        )
      })}
    </div>,
    host
  )
}

function BlockText({
  el,
  editing,
  onCommit,
  onCancel
}: {
  el: TextBox
  editing: boolean
  onCommit: (text: string, h: number) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState(el.text)

  useEffect(() => setDraft(el.text), [el.text, el.id])

  // 높이 자동 측정 + 편집 시작 시 포커스 (CSS transform은 레이아웃에 영향이 없어 scrollHeight는 월드 단위다)
  useLayoutEffect(() => {
    const ta = ref.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = ta.scrollHeight + 'px'
    if (editing && document.activeElement !== ta) {
      ta.focus()
      const n = ta.value.length
      ta.setSelectionRange(n, n)
    }
  }, [draft, editing, el.w, el.fontSize, el.fontFamily])

  return (
    <textarea
      ref={ref}
      className="block-ta"
      value={draft}
      readOnly={!editing}
      tabIndex={-1}
      spellCheck={false}
      placeholder={editing ? '내용을 입력하세요' : ''}
      style={{
        fontSize: el.fontSize,
        color: el.color,
        fontFamily: el.fontFamily ?? 'inherit',
        textAlign: el.align ?? 'left'
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (editing) onCommit(draft, ref.current?.scrollHeight ?? 0)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          onCommit(draft, ref.current?.scrollHeight ?? 0)
        }
      }}
    />
  )
}
