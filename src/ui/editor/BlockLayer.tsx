import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BLOCK_FONT_SIZES, PEN_COLORS, useUI } from '../../app/store'
import type { Engine } from '../../engine/engine'
import type { BlockRec } from '../../engine/scene'
import { MIN_TEXT_W, isSafeUrl, type Element, type LinkElement, type TextBox } from '../../shared/model'
import { Icon } from '../Icon'

/** 좌표를 가진 블록 요소 (텍스트·링크) */
type PositionedEl = Element & {
  x: number
  y: number
  w: number
  fontSize: number
  color: string
  fontFamily?: string
  align?: 'left' | 'center' | 'right'
}

interface DragState {
  id: number
  mode: 'move' | 'resize'
  sx: number
  sy: number
  baseX: number
  baseY: number
  baseW: number
  moved: boolean
  el: HTMLElement
}

/**
 * 블록 편집 모드의 DOM 레이어.
 *
 * 왜 DOM인가: 캔버스는 한글 IME 조합(composing) 중간 상태를 그릴 수 없다.
 * 블록은 DOM으로 렌더하고, 카메라 변환만 엔진에서 받아 CSS transform으로 따라간다.
 * 데이터(모델·저장·Undo·선택)는 전부 엔진이 소유한다 — 여기는 표시와 조작만 담당한다.
 */
export function BlockLayer({ engine, host }: { engine: Engine; host: HTMLElement }) {
  const editMode = useUI((s) => s.editMode)
  const style = useUI((s) => s.style)
  const setStyle = useUI((s) => s.setStyle)
  const snapOn = useUI((s) => s.settings.blockSnap)
  const snapStep = useUI((s) => s.settings.blockSnapStep)

  const [, force] = useReducer((n: number) => n + 1, 0)
  const layerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const [zoom, setZoom] = useState(engine.cam.zoom)
  const [editing, setEditing] = useState<string | null>(null)
  const [urlEdit, setUrlEdit] = useState<string | null>(null)
  const [urlDraft, setUrlDraft] = useState('')

  const interactive = editMode === 'block' && !engine.readOnly
  const step = snapOn ? Math.max(1, snapStep || 16) : 0

  // 리스너는 한 번만 등록하고, 최신 값은 ref로 읽는다 (팬/줌 중 리스너가 갈아끼워져도 드래그가 끊기지 않게)
  const live = useRef({ editing, urlEdit, zoom, step, interactive })
  live.current = { editing, urlEdit, zoom, step, interactive }

  useEffect(() => engine.onBlocksChange(force), [engine])

  // 새 블록은 곧바로 편집을 연다. 링크 블록은 주소 입력도 함께 연다
  useEffect(
    () =>
      engine.onBlockCreated((id) => {
        const rec = engine.blocks().find((b) => b.el.id === id)
        setEditing(id)
        if (rec && rec.el.type === 'link') {
          setUrlDraft(rec.el.url)
          setUrlEdit(id)
        }
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
      setEditing(null)
      setUrlEdit(null)
    }
  }, [editMode])

  // 블록 위에서 시작한 포인터는 엔진(필기·블록 생성)으로 새지 않게 캡처 단계에서 끊는다.
  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return

    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement
      const blockEl = target.closest<HTMLElement>('.block')
      if (!blockEl) {
        // 빈 곳 → 엔진이 처리 (탭 = 새 블록, 끌기 = 화면 이동). 열려 있던 편집기는 닫는다
        setEditing(null)
        setUrlEdit(null)
        return
      }
      if (!live.current.interactive) return
      const id = blockEl.dataset.id!
      const inToolbar = !!target.closest('.block-toolbar, .link-pop')
      const inText = target.classList.contains('block-ta')
      const isEditingThis = live.current.editing === id
      // 손가락은 팬/줌 제스처로 넘긴다 (편집 중이거나 도구막대일 때만 예외)
      if (e.pointerType === 'touch' && !isEditingThis && !inToolbar) return
      e.stopPropagation()
      if (inToolbar) return
      if (!inText) engine.selectBlock(id)
      if (inText) return
      if (isEditingThis && !target.classList.contains('block-resize')) return
      const rec = engine.blocks().find((b) => b.el.id === id)
      if (!rec) return
      const el = rec.el as PositionedEl
      dragRef.current = {
        id: e.pointerId,
        mode: target.classList.contains('block-resize') ? 'resize' : 'move',
        sx: e.clientX,
        sy: e.clientY,
        baseX: rec.ox + el.x,
        baseY: rec.oy + el.y,
        baseW: el.w,
        moved: false,
        el: blockEl
      }
      try {
        blockEl.setPointerCapture(e.pointerId)
      } catch {
        /* noop */
      }
    }

    const snapOf = (v: number) => {
      const s = live.current.step
      return s ? Math.round(v / s) * s : Math.round(v * 100) / 100
    }

    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d || d.id !== e.pointerId) return
      e.stopPropagation()
      const z = live.current.zoom
      const dx = (e.clientX - d.sx) / z
      const dy = (e.clientY - d.sy) / z
      if (!d.moved && Math.hypot(dx, dy) * z > 4) d.moved = true
      if (!d.moved) return
      if (d.mode === 'resize') {
        d.el.style.width = Math.max(MIN_TEXT_W, snapOf(d.baseW + dx)) + 'px'
        // 폭이 바뀌면 줄바꿈이 바뀐다 — 높이를 즉시 다시 잰다 (커밋되는 h도 이 기준으로)
        const ta = d.el.querySelector<HTMLTextAreaElement>('.block-ta')
        if (ta) {
          ta.style.height = 'auto'
          ta.style.height = ta.scrollHeight + 'px'
        }
      } else {
        d.el.style.left = snapOf(d.baseX + dx) + 'px'
        d.el.style.top = snapOf(d.baseY + dy) + 'px'
      }
    }

    const onUp = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d || d.id !== e.pointerId) return
      e.stopPropagation()
      dragRef.current = null
      const z = live.current.zoom
      d.el.style.left = ''
      d.el.style.top = ''
      d.el.style.width = ''
      if (!d.moved) return
      const dx = (e.clientX - d.sx) / z
      const dy = (e.clientY - d.sy) / z
      if (d.mode === 'resize') engine.updateBlock(d.el.dataset.id!, { w: Math.max(MIN_TEXT_W, snapOf(d.baseW + dx)) })
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
  }, [engine])

  const selectedIds = engine.selectedBlockIds()
  const blocks: BlockRec[] = engine.blocks()

  const stepFont = (dir: number, curSize: number) => {
    // 기본 스타일값이 아니라 이 블록의 현재 글자 크기 기준으로 단계를 움직인다
    const cur = curSize
    let i = BLOCK_FONT_SIZES.indexOf(cur)
    if (i < 0) i = BLOCK_FONT_SIZES.findIndex((s) => s >= cur)
    if (i < 0) i = BLOCK_FONT_SIZES.length - 1
    const next = BLOCK_FONT_SIZES[Math.max(0, Math.min(BLOCK_FONT_SIZES.length - 1, i + dir))]
    setStyle({ ...style, block: { ...style.block, fontSize: next } })
    return next
  }

  const openLink = (url: string) => {
    if (!isSafeUrl(url)) {
      useUI.getState().toast('링크 주소는 http(s):// 또는 mailto: 로 시작해야 합니다.', 'error')
      return
    }
    window.open(url.trim(), '_blank', 'noopener,noreferrer')
  }

  const applyUrl = () => {
    if (!urlEdit) return
    engine.updateBlock(urlEdit, { url: urlDraft.trim() })
    setUrlEdit(null)
  }

  return createPortal(
    <div className="block-layer" ref={layerRef} data-mode={editMode}>
      {blocks.map((b) => {
        const el = b.el
        if (el.type !== 'text' && el.type !== 'link') return null
        const p = el as PositionedEl
        const isLink = el.type === 'link'
        const isSel = selectedIds.has(el.id)
        const isEdit = editing === el.id
        const value = isLink ? (el as LinkElement).label : (el as TextBox).text
        const commit = (v: string, h: number) => {
          setEditing(null)
          if (isLink) {
            if (!v.trim() && !(el as LinkElement).url) engine.deleteBlock(el.id)
            else engine.updateBlock(el.id, { label: v, h })
          } else if (!v.trim()) engine.deleteBlock(el.id)
          else engine.updateBlock(el.id, { text: v, h })
        }
        return (
          <div
            key={el.id}
            className={'block' + (isSel ? ' is-selected' : '') + (isEdit ? ' is-editing' : '') + (isLink ? ' block-link' : '')}
            data-id={el.id}
            data-editing={isEdit ? '1' : ''}
            style={{ left: b.ox + p.x, top: b.oy + p.y, width: p.w }}
          >
            {isLink && (
              <span className="link-badge" aria-hidden>
                <Icon name="link" size={12} />
              </span>
            )}
            <BlockText
              value={value}
              editing={isEdit}
              w={p.w}
              fontSize={p.fontSize}
              color={p.color}
              fontFamily={p.fontFamily}
              align={p.align}
              placeholder={isLink ? '링크 이름' : '내용을 입력하세요'}
              onCommit={commit}
              onCancel={() => setEditing(null)}
            />
            {isSel && !isEdit && interactive && urlEdit === el.id && (
              <div className="link-pop" style={{ transform: `scale(${1 / zoom})` }}>
                <input
                  className="link-input"
                  value={urlDraft}
                  autoFocus
                  placeholder="https://…"
                  spellCheck={false}
                  onChange={(e) => setUrlDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyUrl()
                    else if (e.key === 'Escape') setUrlEdit(null)
                  }}
                />
                <button className="tb-btn" onClick={applyUrl} aria-label="링크 주소 적용">
                  <Icon name="check" size={18} />
                </button>
                <button className="tb-btn" onClick={() => setUrlEdit(null)} aria-label="취소">
                  <Icon name="close" size={18} />
                </button>
              </div>
            )}
            {isSel && !isEdit && interactive && urlEdit !== el.id && (
              <div className="block-toolbar" style={{ transform: `scale(${1 / zoom})` }}>
                {isLink ? (
                  <>
                    <button
                      className="tb-btn"
                      disabled={!isSafeUrl((el as LinkElement).url)}
                      onClick={() => openLink((el as LinkElement).url)}
                      aria-label="링크 열기"
                    >
                      <Icon name="external" size={18} />
                    </button>
                    <button
                      className="tb-btn"
                      onClick={() => {
                        setUrlDraft((el as LinkElement).url)
                        setUrlEdit(el.id)
                      }}
                      aria-label="링크 주소 편집"
                    >
                      <Icon name="link" size={18} />
                    </button>
                    <button className="tb-btn" onClick={() => setEditing(el.id)} aria-label="링크 이름 편집">
                      <Icon name="edit" size={18} />
                    </button>
                  </>
                ) : (
                  <button className="tb-btn" onClick={() => setEditing(el.id)} aria-label="내용 편집">
                    <Icon name="edit" size={18} />
                  </button>
                )}
                <button className="tb-btn" onClick={() => engine.updateBlock(el.id, { fontSize: stepFont(-1, p.fontSize) })} aria-label="글자 작게">
                  A-
                </button>
                <button className="tb-btn" onClick={() => engine.updateBlock(el.id, { fontSize: stepFont(1, p.fontSize) })} aria-label="글자 크게">
                  A+
                </button>
                {!isLink &&
                  PEN_COLORS.slice(0, 5).map((c) => (
                    <button
                      key={c}
                      className={'color-swatch small' + (p.color.slice(0, 7) === c.slice(0, 7) ? ' is-active' : '')}
                      style={{ ['--swatch' as string]: c }}
                      onClick={() => {
                        setStyle({ ...style, block: { ...style.block, color: c } })
                        engine.updateBlock(el.id, { color: c })
                      }}
                      aria-label={`글자 색 ${c}`}
                    />
                  ))}
                <button className="tb-btn danger" onClick={() => engine.deleteBlock(el.id)} aria-label="블록 삭제">
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
  value,
  editing,
  w,
  fontSize,
  color,
  fontFamily,
  align,
  placeholder,
  onCommit,
  onCancel
}: {
  value: string
  editing: boolean
  w: number
  fontSize: number
  color: string
  fontFamily?: string
  align?: 'left' | 'center' | 'right'
  placeholder: string
  onCommit: (v: string, h: number) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState(value)
  /** Esc로 닫은 것인지 — 취소면 미확정 내용을 버리고 저장값으로 되돌린다 */
  const canceledRef = useRef(false)

  useEffect(() => setDraft(value), [value])

  // 편집이 닫히는 순간을 여기서 정리한다.
  //  - blur는 편집 상태가 이미 false가 된 뒤에 와서 커밋을 놓칠 수 있다 (모드 전환 등 강제 종료)
  //  - Esc로 취한 경우에는 커밋하지 않고 표시값을 저장값으로 되돌린다
  useEffect(() => {
    if (editing) {
      canceledRef.current = false
      return
    }
    if (canceledRef.current) {
      setDraft(value)
      return
    }
    if (draft !== value) onCommit(draft, ref.current?.scrollHeight ?? 0)
    // draft·value는 editing이 바뀐 렌더의 최신값을 그대로 쓴다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

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
  }, [draft, editing, w, fontSize, fontFamily])

  return (
    <textarea
      ref={ref}
      className="block-ta"
      value={draft}
      readOnly={!editing}
      tabIndex={-1}
      spellCheck={false}
      placeholder={editing ? placeholder : ''}
      style={{ fontSize, color, fontFamily: fontFamily ?? 'inherit', textAlign: align ?? 'left' }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (editing || draft !== value) onCommit(draft, ref.current?.scrollHeight ?? 0)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          canceledRef.current = true
          setDraft(value)
          onCancel()
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          onCommit(draft, ref.current?.scrollHeight ?? 0)
        }
      }}
    />
  )
}
