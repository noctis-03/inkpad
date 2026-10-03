import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import type { Engine } from '../../engine/engine'
import type { Tool } from '../../engine/types'
import { ERASER_SIZES, HL_COLORS, HL_WIDTHS, PEN_COLORS, PEN_WIDTHS, useUI, type ToolbarPos } from '../../app/store'
import { Icon } from '../Icon'
import {
  NARROW_BP,
  POS_ALL,
  POS_NARROW,
  anchorXY,
  applyTrial,
  availFor,
  fitLayout,
  marginFor,
  nearestPos,
  normalizePos,
  orientOf,
  readInsets,
  zoneRect,
  type Layout
} from './floatingLayout'

const TOOLS: { id: Tool; label: string; icon: string }[] = [
  { id: 'pen', label: '펜', icon: 'pen' },
  { id: 'highlighter', label: '형광펜', icon: 'highlighter' },
  { id: 'eraser', label: '지우개', icon: 'eraser' },
  { id: 'lasso', label: '올가미', icon: 'lasso' }
]
const TOOL_NAME: Record<Tool, string> = { pen: '펜', highlighter: '형광펜', eraser: '지우개', lasso: '올가미' }
const opaque = (c: string) => c.slice(0, 7)
const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b)

/** 굵기 → 화면 표시 두께(px) */
function thick(tool: Tool, w: number) {
  if (tool === 'eraser') return clamp(w / 2, 6, 22)
  if (tool === 'highlighter') return clamp(w * 0.55, 5, 14)
  return clamp(w * 1.4, 1.5, 12)
}

/** 굵기 표시(가로 선 / 지우개 원) */
function widthMarkOf(tool: Tool, color: string, w: number) {
  return tool === 'eraser' ? (
    <span className="ft-edot" style={{ ['--s' as string]: `${thick(tool, w)}px` }} />
  ) : (
    <span className="ft-wline" style={{ ['--t' as string]: `${thick(tool, w)}px`, ['--c' as string]: opaque(color) }} />
  )
}

type PopKind = 'style' | 'more'
type Side = 'below' | 'above' | 'left' | 'right'
const sideOf = (p: ToolbarPos): Side =>
  p.startsWith('top') ? 'below' : p.startsWith('bottom') ? 'above' : p === 'left' ? 'right' : 'left'

export function FloatingToolbar({ engine }: { engine: Engine | null }) {
  const tool = useUI((s) => s.tool)
  const setTool = useUI((s) => s.setTool)
  const style = useUI((s) => s.style)
  const setStyle = useUI((s) => s.setStyle)
  const view = useUI((s) => s.view)
  const pos = useUI((s) => s.toolbarPos)
  const setPos = useUI((s) => s.setToolbarPos)
  const collapsed = useUI((s) => s.toolbarCollapsed)
  const setCollapsed = useUI((s) => s.setToolbarCollapsed)

  const barRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const layoutRef = useRef<Layout | null>(null)
  const [layout, setLayout] = useState<Layout | null>(null)
  const [snap, setSnap] = useState<{ allowed: ToolbarPos[]; W: number; H: number } | null>(null)
  const [near, setNear] = useState<ToolbarPos | null>(null)
  const [pop, setPop] = useState<{ kind: PopKind; anchor: HTMLElement } | null>(null)

  // ── 현재 스타일 파생값 (기존 EditorToolbar 로직과 동일) ──
  const isHl = tool === 'highlighter'
  const isEr = tool === 'eraser'
  const colors = isHl ? HL_COLORS : PEN_COLORS
  const widths = isHl ? HL_WIDTHS : isEr ? ERASER_SIZES : PEN_WIDTHS
  const curColor = isHl ? style.highlighter.color : isEr ? '#9ca3afff' : style.pen.color
  const curWidth = isHl ? style.highlighter.width : isEr ? style.eraserSize : style.pen.width
  const inlineColors = isHl ? HL_COLORS : PEN_COLORS.slice(0, 5)

  const pickColor = (c: string) => {
    if (isHl) setStyle({ ...style, highlighter: { ...style.highlighter, color: c } })
    else {
      setStyle({ ...style, pen: { ...style.pen, color: c } })
      if (tool !== 'pen') setTool('pen')
    }
  }
  const pickWidth = (w: number) => {
    if (isHl) setStyle({ ...style, highlighter: { ...style.highlighter, width: w } })
    else if (isEr) setStyle({ ...style, eraserSize: w })
    else setStyle({ ...style, pen: { ...style.pen, width: w } })
  }

  // ── 레이아웃 계산 + 스냅 배치 ──
  const relayout = useCallback(
    (animate = true) => {
      const el = barRef.current
      const area = el?.parentElement
      const probe = probeRef.current
      if (!el || !area || !probe) return
      const W = area.clientWidth
      const H = area.clientHeight
      if (!W || !H) return
      const ins = readInsets(probe, area)
      const m = marginFor(W)
      let p = normalizePos(pos, W)
      let L = fitLayout(el, orientOf(p), availFor(orientOf(p), W, H, ins, m))
      if (!L.fits && L.orient === 'v') {
        p = 'top'
        L = fitLayout(el, 'h', availFor('h', W, H, ins, m))
      }
      const [x, y] = anchorXY(p, L.w, L.h, W, H, ins, m)
      const first = !('ready' in el.dataset)
      if (!animate || first) el.style.transition = 'none'
      el.dataset.pos = p
      el.style.left = `${x}px`
      el.style.top = `${y}px`
      el.dataset.ready = ''
      if (!animate || first) requestAnimationFrame(() => requestAnimationFrame(() => (el.style.transition = '')))
      const next: Layout = { ...L, pos: p }
      layoutRef.current = next
      setLayout((prev) =>
        prev && prev.pos === next.pos && prev.orient === next.orient && prev.density === next.density && prev.hide.join() === next.hide.join()
          ? prev
          : next
      )
      document.documentElement.dataset.ftPos = p // toasts/page-indicator 회피용
    },
    [pos]
  )

  // 도구/접힘/위치가 바뀌면 크기가 달라지므로 페인트 전에 다시 계산
  useLayoutEffect(() => relayout(), [relayout, tool, collapsed])

  // .editor-area 크기 변화 (회전, 사이드바 토글, 키보드 등)
  useEffect(() => {
    const area = barRef.current?.parentElement
    if (!area) return
    const ro = new ResizeObserver(() => {
      setPop(null)
      relayout(false)
    })
    ro.observe(area)
    return () => ro.disconnect()
  }, [relayout])

  useEffect(
    () => () => {
      delete document.documentElement.dataset.ftPos
    },
    []
  )

  // 도구가 바뀌면 팝오버 닫기
  useEffect(() => setPop(null), [tool])

  // ── 드래그 ──
  const drag = useRef<null | {
    id: number
    sx: number
    sy: number
    ox: number
    oy: number
    moved: boolean
    W: number
    H: number
    areaL: number
    areaT: number
    near: ToolbarPos
    allowed: ToolbarPos[]
    sizes: { h: [number, number]; v: [number, number] }
    ins: ReturnType<typeof readInsets>
    m: number
  }>(null)
  const lastTap = useRef(0)

  const goTop = () => (pos === 'top' ? relayout() : setPos('top'))

  const onGripDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const el = barRef.current
    const area = el?.parentElement
    const cur = layoutRef.current
    if (!el || !area || !cur || !probeRef.current) return
    e.preventDefault()
    setPop(null)
    e.currentTarget.setPointerCapture(e.pointerId)
    const W = area.clientWidth
    const H = area.clientHeight
    const ins = readInsets(probeRef.current, area)
    const m = marginFor(W)
    const Lh = fitLayout(el, 'h', availFor('h', W, H, ins, m))
    const Lv = fitLayout(el, 'v', availFor('v', W, H, ins, m))
    applyTrial(el, cur.orient, cur.density, cur.hide) // 측정 후 현재 레이아웃 복원
    const r = el.getBoundingClientRect()
    const a = area.getBoundingClientRect()
    drag.current = {
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      ox: e.clientX - r.left,
      oy: e.clientY - r.top,
      moved: false,
      W,
      H,
      areaL: a.left,
      areaT: a.top,
      near: cur.pos,
      allowed: (W < NARROW_BP ? POS_NARROW : POS_ALL).filter((p) => orientOf(p) === 'h' || Lv.fits),
      sizes: { h: [Lh.w, Lh.h], v: [Lv.w, Lv.h] },
      ins,
      m
    }
  }

  const onGripMove = (e: ReactPointerEvent) => {
    const d = drag.current
    const el = barRef.current
    if (!d || !el || e.pointerId !== d.id) return
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 5) return
      d.moved = true
      el.dataset.dragging = ''
      setSnap({ allowed: d.allowed, W: d.W, H: d.H })
    }
    el.style.left = `${clamp(e.clientX - d.areaL - d.ox, 0, Math.max(0, d.W - el.offsetWidth))}px`
    el.style.top = `${clamp(e.clientY - d.areaT - d.oy, 0, Math.max(0, d.H - el.offsetHeight))}px`
    const n = nearestPos(e.clientX - d.areaL, e.clientY - d.areaT, d.W, d.H, d.allowed)
    if (n !== d.near) {
      d.near = n
      setNear(n)
    }
    const g = ghostRef.current
    if (g) {
      const [w, h] = d.sizes[orientOf(n)]
      const [x, y] = anchorXY(n, w, h, d.W, d.H, d.ins, d.m)
      Object.assign(g.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` })
    }
  }

  const onGripUp = (e: ReactPointerEvent) => {
    const d = drag.current
    const el = barRef.current
    if (!d || e.pointerId !== d.id) return
    drag.current = null
    if (!d.moved) {
      const now = Date.now()
      if (now - lastTap.current < 320) goTop()
      lastTap.current = now
      return
    }
    if (el) delete el.dataset.dragging
    setSnap(null)
    setNear(null)
    // 같은 위치에 놓으면 pos가 안 바뀌어 effect가 안 돌므로 직접 relayout
    if (d.near === pos) relayout()
    else setPos(d.near)
  }

  // ── 클릭 동작 ──
  const togglePop = (kind: PopKind, anchor: HTMLElement) =>
    setPop((p) => (p && p.kind === kind ? null : { kind, anchor }))

  const onToolClick = (t: Tool, btn: HTMLElement) => {
    if (t === tool) {
      if (collapsed) {
        setCollapsed(false)
        return
      }
      if (t !== 'lasso') togglePop('style', btn)
      return
    }
    setTool(t)
  }

  const hide = layout?.hide ?? []
  const side = sideOf(layout?.pos ?? 'top')
  const toolColor = (t: Tool) =>
    t === 'pen' ? opaque(style.pen.color) : t === 'highlighter' ? opaque(style.highlighter.color) : 'transparent'
  const widthMark = (w: number) => widthMarkOf(tool, curColor, w)

  return (
    <>
      <div ref={probeRef} className="ft-probe" aria-hidden="true" />

      {snap && (
        <div className="ft-snap-layer" aria-hidden="true">
          {snap.allowed.map((p) => {
            const r = zoneRect(p, snap.W, snap.H)
            return <div key={p} className={'ft-zone' + (p === near ? ' is-near' : '')} style={r} />
          })}
          <div ref={ghostRef} className="ft-ghost" />
        </div>
      )}

      <div
        ref={barRef}
        className="ft-bar"
        role="toolbar"
        aria-label="그리기 도구"
        data-tool={tool}
        data-collapsed={collapsed ? '' : undefined}
      >
        <button
          className="ft-grip"
          aria-label="도구 메뉴 이동 (두 번 탭: 상단 중앙)"
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
        >
          <Icon name="grip" />
        </button>

        <div className="ft-group ft-tools">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={'ft-btn ft-tool' + (tool === t.id ? ' is-active' : '')}
              style={{ ['--tc' as string]: toolColor(t.id) }}
              aria-label={t.label}
              aria-pressed={tool === t.id}
              onClick={(e) => onToolClick(t.id, e.currentTarget)}
            >
              <Icon name={t.icon} />
            </button>
          ))}
        </div>

        <span className="ft-sep ft-hide ft-style" />
        <div className="ft-group ft-hide ft-style" aria-label="색상과 굵기">
          <div className="ft-swatches">
            {!isEr &&
              inlineColors.map((c) => (
                <button
                  key={c}
                  className={'ft-sw' + (c === curColor ? ' is-active' : '')}
                  style={{ ['--c' as string]: c }}
                  aria-label={`색상 ${opaque(c)}`}
                  onClick={() => pickColor(c)}
                />
              ))}
          </div>
          <div className="ft-widths">
            {widths.map((w) => (
              <button
                key={w}
                className={'ft-wbtn' + (w === curWidth ? ' is-active' : '')}
                aria-label={`굵기 ${w}`}
                aria-pressed={w === curWidth}
                onClick={() => pickWidth(w)}
              >
                {widthMark(w)}
              </button>
            ))}
          </div>
          <button
            className={'ft-btn ft-chip' + (pop?.kind === 'style' ? ' is-open' : '')}
            style={{
              ['--c' as string]: opaque(curColor),
              ['--d' as string]: `${clamp(thick(tool, curWidth) * (isEr ? 0.6 : 1), 4, 14)}px`
            }}
            aria-label="색상·굵기"
            aria-expanded={pop?.kind === 'style'}
            onClick={(e) => togglePop('style', e.currentTarget)}
          >
            <span className="ft-ring">
              <span className="ft-dot" />
            </span>
          </button>
        </div>

        <span className="ft-sep ft-hide ft-hist-sep" />
        <div className="ft-group ft-hide ft-hist">
          <button className="ft-btn ft-k-undo" disabled={!view.canUndo} onClick={() => engine?.undo()} aria-label="실행 취소">
            <Icon name="undo" />
          </button>
          <button className="ft-btn ft-k-redo" disabled={!view.canRedo} onClick={() => engine?.redo()} aria-label="다시 실행">
            <Icon name="redo" />
          </button>
          <button className="ft-btn ft-k-fit" onClick={() => engine?.fitAll()} aria-label="전체 보기">
            <Icon name="fit" />
          </button>
        </div>

        <button
          className="ft-btn ft-k-collapse"
          onClick={() => {
            setPop(null)
            setCollapsed(!collapsed)
          }}
          aria-label={collapsed ? '도구 메뉴 펼치기' : '도구 메뉴 접기'}
        >
          <Icon name={collapsed ? 'maximize' : 'minimize'} />
        </button>
        <button
          className={'ft-btn ft-hide ft-more' + (pop?.kind === 'more' ? ' is-open' : '')}
          aria-label="더보기"
          onClick={(e) => togglePop('more', e.currentTarget)}
        >
          <Icon name="more" />
        </button>
      </div>

      {pop && (
        <FtPopover anchor={pop.anchor} side={side} kind={pop.kind} onClose={() => setPop(null)}>
          {pop.kind === 'style' ? (
            <StylePanel
              tool={tool}
              colors={colors}
              widths={widths}
              curColor={curColor}
              curWidth={curWidth}
              pickColor={pickColor}
              pickWidth={pickWidth}
              isHl={isHl}
              isEr={isEr}
            />
          ) : (
            <div className="ft-menu">
              {hide.includes('undo') && (
                <button className="menu-item" disabled={!view.canUndo} onClick={() => engine?.undo()}>
                  <Icon name="undo" />
                  실행 취소
                </button>
              )}
              {hide.includes('redo') && (
                <button className="menu-item" disabled={!view.canRedo} onClick={() => engine?.redo()}>
                  <Icon name="redo" />
                  다시 실행
                </button>
              )}
              {hide.includes('fit') && (
                <button
                  className="menu-item"
                  onClick={() => {
                    engine?.fitAll()
                    setPop(null)
                  }}
                >
                  <Icon name="fit" />
                  전체 보기
                </button>
              )}
              {hide.includes('collapse') && (
                <button
                  className="menu-item"
                  onClick={() => {
                    setPop(null)
                    setCollapsed(!collapsed)
                  }}
                >
                  <Icon name={collapsed ? 'maximize' : 'minimize'} />
                  {collapsed ? '메뉴 펼치기' : '메뉴 접기'}
                </button>
              )}
              <div className="ft-menu-sep" />
              <button
                className="menu-item"
                onClick={() => {
                  setPop(null)
                  goTop()
                }}
              >
                <Icon name="dockTop" />
                상단 중앙으로 이동
              </button>
            </div>
          )}
        </FtPopover>
      )}
    </>
  )
}

function FtPopover(props: { anchor: HTMLElement; side: Side; kind: PopKind; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const a = props.anchor.getBoundingClientRect()
    const pw = el.offsetWidth
    const ph = el.offsetHeight
    const g = 10
    const m = 8
    let x: number
    let y: number
    if (props.side === 'below' || props.side === 'above') {
      x = a.left + a.width / 2 - pw / 2
      y = props.side === 'below' ? a.bottom + g : a.top - g - ph
    } else {
      y = a.top + a.height / 2 - ph / 2
      x = props.side === 'right' ? a.right + g : a.left - g - pw
    }
    x = Math.min(Math.max(x, m), window.innerWidth - pw - m)
    y = Math.min(Math.max(y, m), window.innerHeight - ph - m)
    el.style.left = `${x}px`
    el.style.top = `${y}px`
    el.style.transformOrigin = `${a.left + a.width / 2 - x}px ${a.top + a.height / 2 - y}px`
    requestAnimationFrame(() => (el.dataset.show = ''))
  }) // 내용(색·굵기)이 바뀌어 크기가 변해도 다시 맞춘다
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])
  return createPortal(
    <>
      <div
        className="ft-backdrop"
        onPointerDown={(e) => {
          e.preventDefault()
          props.onClose()
        }}
      />
      <div ref={ref} className={'ft-pop' + (props.kind === 'more' ? ' is-menu' : '')} role="dialog">
        {props.children}
      </div>
    </>,
    document.body
  )
}

function StylePanel(props: {
  tool: Tool
  colors: string[]
  widths: number[]
  curColor: string
  curWidth: number
  pickColor: (c: string) => void
  pickWidth: (w: number) => void
  isHl: boolean
  isEr: boolean
}) {
  const { tool, colors, widths, curColor, curWidth, pickColor, pickWidth, isHl, isEr } = props
  return (
    <>
      <div className="ft-pop-title">
        {TOOL_NAME[tool]}
        <span>
          {curWidth}
          {isEr ? 'px' : 'pt'}
        </span>
      </div>
      <div className="ft-preview">
        {isEr ? (
          <span className="ft-edot" style={{ ['--s' as string]: `${clamp(curWidth * 0.75, 10, 40)}px` }} />
        ) : (
          <svg viewBox="0 0 220 40">
            <path
              d="M12 26 C 46 4, 80 36, 112 20 S 176 6, 208 22"
              fill="none"
              stroke={curColor}
              strokeWidth={thick(tool, curWidth) * 1.25}
              strokeLinecap="round"
            />
          </svg>
        )}
      </div>
      {!isEr && (
        <>
          <div className="ft-pop-label">색상</div>
          <div className="ft-sw-grid">
            {colors.map((c) => (
              <button
                key={c}
                className={'ft-sw' + (c === curColor ? ' is-active' : '')}
                style={{ ['--c' as string]: c }}
                aria-label={`색상 ${opaque(c)}`}
                onClick={() => pickColor(c)}
              />
            ))}
            <label className="ft-sw is-custom" aria-label="직접 선택">
              <input type="color" value={opaque(curColor)} onChange={(e) => pickColor(e.target.value + (isHl ? '66' : 'ff'))} />
            </label>
          </div>
        </>
      )}
      <div className="ft-pop-label">{isEr ? '크기' : '굵기'}</div>
      <div className="seg full ft-wseg">
        {widths.map((w) => (
          <button key={w} className={w === curWidth ? 'is-active' : ''} onClick={() => pickWidth(w)} aria-label={`${w}`}>
            {widthMarkOf(tool, curColor, w)}
          </button>
        ))}
      </div>
    </>
  )
}
