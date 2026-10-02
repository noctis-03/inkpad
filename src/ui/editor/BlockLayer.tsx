import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BLOCK_FONT_SIZES, PEN_COLORS, useUI } from '../../app/store'
import type { Engine } from '../../engine/engine'
import type { BlockRec } from '../../engine/scene'
import { MIN_TEXT_W, isSafeUrl, type Element, type ID, type LinkElement, type TextBox } from '../../shared/model'
import { Icon } from '../Icon'
import { BlockSheet, type SheetTab } from './BlockSheet'

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
  pointerId: number
  id: ID
  mode: 'move' | 'resize'
  /** 리사이즈 기준 변: l = 왼쪽 핸들(왼쪽 변 고정), r = 오른쪽 핸들 */
  edge: 'l' | 'r' | null
  sx: number
  sy: number
  baseX: number
  baseY: number
  baseW: number
  moved: boolean
  el: HTMLElement
}

/** 새 블록을 놓을 월드 좌표 (대안 C의 생성 어포던스만 흡수) */
interface GhostState {
  wx: number
  wy: number
}

/**
 * 블록 편집 모드의 DOM 레이어.
 *
 * 왜 DOM인가: 캔버스는 한글 IME 조합(composing) 중간 상태를 그릴 수 없다.
 * 블록은 DOM으로 렌더하고, 카메라 변환만 엔진에서 받아 CSS transform으로 따라간다.
 * 데이터(모델·저장·Undo·선택)는 전부 엔진이 소유한다 — 여기는 표시와 조작만 담당한다.
 *
 * 배치 (대안 A + B·C 흡수):
 *  - 모서리 핸들 4개(시각 24px, 히트 44px) + 앵커 pill 3버튼 [편집 · Aa · ⋯]
 *  - Aa = 빠른 스타일 popover(크기·색·정렬), ⋯ = 하단 시트(모든 속성 · 블록 목록)
 *  - 빈 곳 탭 = 새 블록 고스트(종류 칩으로 확정). 엔진의 onEmptyTap으로 좌표를 받는다 —
 *    엔진이 root에 포인터 캡처를 걸기 때문에 DOM에서 포인터를 가로채는 방식은 쓸 수 없다.
 */
export function BlockLayer({ engine, host }: { engine: Engine; host: HTMLElement }) {
  const editMode = useUI((s) => s.editMode)
  const style = useUI((s) => s.style)
  const setStyle = useUI((s) => s.setStyle)
  const settings = useUI((s) => s.settings)
  const toast = useUI((s) => s.toast)
  const snapOn = settings.blockSnap
  const snapStep = settings.blockSnapStep

  const [, force] = useReducer((n: number) => n + 1, 0)
  const layerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const [zoom, setZoom] = useState(engine.cam.zoom)
  const [editing, setEditing] = useState<ID | null>(null)
  const [quickId, setQuickId] = useState<ID | null>(null)
  const [sheetTab, setSheetTab] = useState<SheetTab | null>(null)
  const [ghost, setGhost] = useState<GhostState | null>(null)

  const interactive = editMode === 'block' && !engine.readOnly
  const step = snapOn ? Math.max(1, snapStep || 16) : 0

  // 리스너는 한 번만 등록하고, 최신 값은 ref로 읽는다 (팬/줌 중 리스너가 갈아끼워져도 드래그가 끊기지 않게)
  const live = useRef({ editing, zoom, step, interactive })
  live.current = { editing, zoom, step, interactive }

  useEffect(() => engine.onBlocksChange(force), [engine])

  // 빈 곳 탭 → 엔진이 위치만 알려준다. 새 블록은 종류를 고른 뒤에 만든다 (고스트)
  useEffect(
    () =>
      engine.onEmptyTap((wx, wy) => {
        engine.clearSelection()
        setEditing(null)
        setQuickId(null)
        setSheetTab(null)
        setGhost({ wx, wy })
      }),
    [engine]
  )

  // 새 블록: 텍스트는 곧바로 편집을, 링크는 시트를 연다 (주소·이름을 한자리에서)
  useEffect(
    () =>
      engine.onBlockCreated((id) => {
        const rec = engine.blocks().find((b) => b.el.id === id)
        setGhost(null)
        if (rec && rec.el.type === 'link') setSheetTab('style')
        else setEditing(id)
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
      setQuickId(null)
      setSheetTab(null)
      setGhost(null)
    }
  }, [editMode])

  // Esc: 고스트·빠른 스타일·시트를 닫는다 (선택 해제는 Editor가 담당)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setGhost(null)
      setQuickId(null)
      setSheetTab(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const selectedIds = engine.selectedBlockIds()
  const selOne = selectedIds.size === 1 ? [...selectedIds][0] : null

  // 스타일 시트는 '한 개 선택'에 묶인다 — 선택이 풀리면 닫는다 (목록 탭은 유지)
  useEffect(() => {
    if (sheetTab === 'style' && !selOne) setSheetTab(null)
  }, [sheetTab, selOne])
  useEffect(() => {
    if (quickId && quickId !== selOne) setQuickId(null)
  }, [quickId, selOne])

  // 블록 위에서 시작한 포인터는 엔진(필기)으로 새지 않게 캡처 단계에서 끊는다.
  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return

    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement
      // 고스트의 버튼은 React가 처리한다 (클릭은 별도 이벤트라 여기선 통과만 막는다)
      if (target.closest('.block-ghost')) {
        e.stopPropagation()
        return
      }
      const blockEl = target.closest<HTMLElement>('.block')
      const inUi = !!target.closest('.block-pill, .block-quick, .block-url')
      const handle = target.closest<HTMLElement>('.block-handle')

      if (!blockEl) {
        // 빈 곳 → 엔진이 팬/탭을 처리하고, 탭이면 onEmptyTap으로 위치를 알려준다
        setEditing(null)
        setQuickId(null)
        return
      }

      if (!live.current.interactive) return
      const id = blockEl.dataset.id!
      const inText = target.classList.contains('block-ta')
      const isEditingThis = live.current.editing === id
      // 손가락은 팬/줌 제스처로 넘긴다 (편집 중이거나 UI·핸들·본문일 때만 예외)
      if (e.pointerType === 'touch' && !isEditingThis && !inUi && !handle && !inText) return
      e.stopPropagation()
      if (inUi) return
      if (inText) {
        engine.selectBlock(id)
        return
      }
      engine.selectBlock(id)
      if (isEditingThis && !handle) return
      const rec = engine.blocks().find((b) => b.el.id === id)
      if (!rec) return
      const p = rec.el as PositionedEl
      dragRef.current = {
        pointerId: e.pointerId,
        id,
        mode: handle ? 'resize' : 'move',
        edge: handle ? ((handle.dataset.edge as 'l' | 'r') ?? 'r') : null,
        sx: e.clientX,
        sy: e.clientY,
        baseX: rec.ox + p.x,
        baseY: rec.oy + p.y,
        baseW: p.w,
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
      if (!d || d.pointerId !== e.pointerId) return
      e.stopPropagation()
      const z = live.current.zoom
      const dx = (e.clientX - d.sx) / z
      const dy = (e.clientY - d.sy) / z
      if (!d.moved && Math.hypot(dx, dy) * z > 4) d.moved = true
      if (!d.moved) return
      if (d.mode === 'resize') {
        if (d.edge === 'l') {
          d.el.style.left = snapOf(d.baseX + dx) + 'px'
          d.el.style.width = Math.max(MIN_TEXT_W, snapOf(d.baseW - dx)) + 'px'
        } else {
          d.el.style.width = Math.max(MIN_TEXT_W, snapOf(d.baseW + dx)) + 'px'
        }
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

    /**
     * 블록 DOM의 위치·폭 인라인 스타일을 모델 값으로 맞춘다.
     *
     * left/top/width는 React가 렌더링하는 값이라 수동으로 `style.left = ''`처럼 지우면 안 된다:
     * react-dom은 이전 렌더와 값이 같은 스타일 속성을 DOM에 다시 쓰지 않으므로
     * (setValueForStyles의 `prevStyles[key] !== styles[key]` 검사) 지운 채로 남아
     * 블록 폭이 내용 폭으로 줄어드는 현상이 생긴다. 드래그가 끝나면 지우지 말고
     * 커밋된 모델 값으로 맞춰 React 렌더와 DOM을 항상 일치시킨다.
     */
    const syncBlockStyle = (el: HTMLElement) => {
      const rec = engine.blocks().find((b) => b.el.id === el.dataset.id)
      if (!rec || (rec.el.type !== 'text' && rec.el.type !== 'link')) return
      const p = rec.el as PositionedEl
      el.style.left = rec.ox + p.x + 'px'
      el.style.top = rec.oy + p.y + 'px'
      el.style.width = p.w + 'px'
    }

    const onUp = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d || d.pointerId !== e.pointerId) return
      e.stopPropagation()
      dragRef.current = null
      const z = live.current.zoom
      if (!d.moved) return
      const dx = (e.clientX - d.sx) / z
      const dy = (e.clientY - d.sy) / z
      if (d.mode === 'resize') {
        const rec = engine.blocks().find((b) => b.el.id === d.id)
        if (!rec || (rec.el.type !== 'text' && rec.el.type !== 'link')) return
        const p = rec.el as PositionedEl
        const w = Math.max(MIN_TEXT_W, snapOf(d.baseW + (d.edge === 'l' ? -dx : dx)))
        if (d.edge === 'l') {
          engine.updateBlock(d.id, { x: snapOf(rec.ox + p.x + dx) - rec.ox, w })
        } else {
          engine.updateBlock(d.id, { w })
        }
      } else {
        engine.moveBlock(d.id, d.baseX + dx, d.baseY + dy)
      }
      syncBlockStyle(d.el)
      force()
    }

    const onCancel = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d || d.pointerId !== e.pointerId) return
      dragRef.current = null
      e.stopPropagation()
      syncBlockStyle(d.el)
    }

    layer.addEventListener('pointerdown', onDown, true)
    layer.addEventListener('pointermove', onMove, true)
    layer.addEventListener('pointerup', onUp, true)
    layer.addEventListener('pointercancel', onCancel, true)
    return () => {
      layer.removeEventListener('pointerdown', onDown, true)
      layer.removeEventListener('pointermove', onMove, true)
      layer.removeEventListener('pointerup', onUp, true)
      layer.removeEventListener('pointercancel', onCancel, true)
    }
  }, [engine])

  const blocks: BlockRec[] = engine.blocks()
  const sheetBlock = selOne ? (blocks.find((b) => b.el.id === selOne) ?? null) : null

  const stepFont = (id: ID, dir: number, curSize: number) => {
    // 기본 스타일값이 아니라 이 블록의 현재 글자 크기 기준으로 단계를 움직인다
    const cur = curSize
    let i = BLOCK_FONT_SIZES.indexOf(cur)
    if (i < 0) i = BLOCK_FONT_SIZES.findIndex((s) => s >= cur)
    if (i < 0) i = BLOCK_FONT_SIZES.length - 1
    const next = BLOCK_FONT_SIZES[Math.max(0, Math.min(BLOCK_FONT_SIZES.length - 1, i + dir))]
    setStyle({ ...style, block: { ...style.block, fontSize: next } })
    engine.updateBlock(id, { fontSize: next })
  }

  const pickBlockColor = (id: ID, c: string) => {
    setStyle({ ...style, block: { ...style.block, color: c } })
    engine.updateBlock(id, { color: c })
  }

  const openLink = (url: string) => {
    if (!isSafeUrl(url)) {
      toast('링크 주소는 http(s):// 또는 mailto: 로 시작해야 합니다.', 'error')
      return
    }
    window.open(url.trim(), '_blank', 'noopener,noreferrer')
  }

  /** 고스트 확정: 종류를 정하고 그 자리에 블록을 만든다 */
  const createAt = (kind: 'text' | 'link') => {
    if (!ghost) return
    engine.setBlockKind(kind)
    useUI.getState().setBlockKind(kind)
    const id = engine.createBlock(ghost.wx, ghost.wy)
    if (!id) {
      toast('여기에는 블록을 놓을 수 없습니다.', 'error')
      return
    }
    setGhost(null)
  }

  const editText = (id: ID) => {
    setSheetTab(null)
    setQuickId(null)
    setEditing(id)
  }

  return createPortal(
    <>
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
              {isSel && !isEdit && interactive && (
                <>
                  <span className="block-handle nw" data-edge="l" aria-hidden />
                  <span className="block-handle ne" data-edge="r" aria-hidden />
                  <span className="block-handle sw" data-edge="l" aria-hidden />
                  <span className="block-handle se" data-edge="r" aria-hidden />
                  <div className="block-pill" style={{ transform: `scale(${1 / zoom})` }}>
                    <button className="pb-btn" onClick={() => editText(el.id)} aria-label={isLink ? '링크 이름 편집' : '내용 편집'}>
                      <Icon name="edit" size={18} />
                    </button>
                    <button
                      className="pb-btn pb-aa"
                      onClick={() => setQuickId(quickId === el.id ? null : el.id)}
                      aria-pressed={quickId === el.id}
                      aria-label="빠른 스타일"
                    >
                      Aa
                    </button>
                    <button
                      className="pb-btn"
                      onClick={() => {
                        setQuickId(null)
                        setSheetTab('style')
                      }}
                      aria-label="모든 속성 · 블록 목록"
                      title="모든 속성 · 블록 목록"
                    >
                      <Icon name="more" size={18} />
                    </button>
                  </div>
                  {isLink && (
                    <div className="block-url" style={{ transform: `scale(${1 / zoom})` }}>
                      <Icon name="link" size={13} />
                      <span className="bu-text" title={(el as LinkElement).url}>
                        {(el as LinkElement).url || '주소 없음'}
                      </span>
                      <button
                        className="pb-btn sm"
                        disabled={!isSafeUrl((el as LinkElement).url)}
                        onClick={() => openLink((el as LinkElement).url)}
                        aria-label="링크 열기"
                      >
                        <Icon name="external" size={16} />
                      </button>
                    </div>
                  )}
                  {quickId === el.id && (
                    <div className="block-quick" style={{ transform: `scale(${1 / zoom})` }}>
                      <div className="bq-row">
                        <button className="pb-btn sm" onClick={() => stepFont(el.id, -1, p.fontSize)} aria-label="글자 작게">
                          A−
                        </button>
                        <span className="bq-val">{p.fontSize}</span>
                        <button className="pb-btn sm" onClick={() => stepFont(el.id, 1, p.fontSize)} aria-label="글자 크게">
                          A+
                        </button>
                      </div>
                      <div className="bq-sw">
                        {PEN_COLORS.map((c) => (
                          <button
                            key={c}
                            className={'bq-dot' + (p.color.slice(0, 7) === c.slice(0, 7) ? ' is-on' : '')}
                            style={{ ['--swatch' as string]: c }}
                            onClick={() => pickBlockColor(el.id, c)}
                            aria-label={`색 ${c}`}
                          />
                        ))}
                      </div>
                      <div className="bq-row">
                        {(['left', 'center', 'right'] as const).map((a) => (
                          <button
                            key={a}
                            className={'pb-btn sm' + ((p.align ?? 'left') === a ? ' is-on' : '')}
                            onClick={() => engine.updateBlock(el.id, { align: a })}
                            aria-label={a === 'left' ? '왼쪽 정렬' : a === 'center' ? '가운데 정렬' : '오른쪽 정렬'}
                          >
                            {a === 'left' ? '왼' : a === 'center' ? '중' : '오'}
                          </button>
                        ))}
                        <div className="bq-spacer" />
                        <button className="pb-btn sm" onClick={() => { setQuickId(null); setSheetTab('style') }} aria-label="모든 속성">
                          전체
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}

        {ghost && interactive && (
          <div className="block-ghost" style={{ left: ghost.wx, top: ghost.wy }}>
            <div className="bg-label">＋ 새 블록</div>
            <div className="bg-kinds">
              <button className="bg-kind" onClick={() => createAt('text')}>
                <Icon name="type" size={15} />
                텍스트
              </button>
              <button className="bg-kind" onClick={() => createAt('link')}>
                <Icon name="link" size={15} />
                링크
              </button>
              <button className="bg-x" onClick={() => setGhost(null)} aria-label="취소">
                <Icon name="close" size={15} />
              </button>
            </div>
          </div>
        )}
      </div>

      {sheetTab && (
        <BlockSheet
          engine={engine}
          block={sheetBlock}
          tab={sheetTab}
          onTab={setSheetTab}
          onClose={() => setSheetTab(null)}
          onEditText={editText}
        />
      )}
    </>,
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
