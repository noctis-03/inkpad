// 편집 블록 레이어 — 캔버스 위의 DOM 오버레이.
// 블록은 절대 캔버스(scene)에 그리지 않고, 엔진 카메라에 맞춰 transform으로 따라간다.
// 블록 DOM은 #canvas-root의 자식이 아니므로 포인터 이벤트가 엔진으로 새지 않는다.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { GESTURE_SETTLE_MS, TAP_SLOP_PX } from '../../engine/constants'
import type { Engine } from '../../engine/engine'
import { BLOCK_META, MEMO_BG, anchorBlock, blockOrigin, blockWorldPos, createBlock, isSafeBlockUrl, normalizeBlockUrl } from '../../engine/blocks'
import { BLOCK_DEFAULT_W, type Block, type BlockType, type ID, type JumpBlock, type LinkBlock, type MemoBlock, type TimerBlock, type TodoBlock } from '../../shared/model'
import { ulid } from '../../shared/ulid'
import { useUI } from '../../app/store'
import { Icon } from '../Icon'
import { FtPopover } from './FloatingToolbar'

const HEAD_H = 28 // .blk-head 높이 (styles.css의 Blocks 섹션과 동일)
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.max(0, s % 60)).padStart(2, '0')}`

/** 타이머 실행 상태 — UI 메모리 전용(저장·동기화·히스토리 대상이 아니다) */
interface TimerRun {
  endAt: number | null
  remainSec: number
}

export function BlockLayer({ engine, readOnly }: { engine: Engine; readOnly: boolean }) {
  const blocks = useSyncExternalStore(engine.blocks.subscribe, () => engine.blocks.list())
  const blocksVisible = useUI((s) => s.blocksVisible)
  const placingBlock = useUI((s) => s.placingBlock)
  const selectedBlockId = useUI((s) => s.selectedBlockId)
  const panel = useUI((s) => s.panel)
  const tool = useUI((s) => s.tool)
  const worldRef = useRef<HTMLDivElement>(null)
  const els = useRef(new Map<ID, HTMLElement>())
  const roRef = useRef<ResizeObserver | null>(null)
  const [attach, setAttach] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [fresh, setFresh] = useState<ID | null>(null)
  const timers = useRef(new Map<ID, TimerRun>())

  // ── 카메라 동기화: React state로 매 프레임 전달하지 않고 DOM transform을 직접 갱신한다 ──
  const cullRef = useRef<() => void>(() => {})
  useEffect(() => {
    const world = worldRef.current
    if (!world) return
    const cull = () => {
      const W = engine.root.clientWidth
      const H = engine.root.clientHeight
      const { x, y, zoom } = engine.cam
      const margin = Math.max(W, H) / zoom // 뷰포트 주변 1화면 여유
      const minX = x - margin
      const minY = y - margin
      const maxX = x + W / zoom + margin
      const maxY = y + H / zoom + margin
      for (const b of engine.blocks.list()) {
        const el = els.current.get(b.id)
        if (!el) continue
        const { ox, oy } = blockOrigin(engine.layout, b.pageId)
        const wx = b.x + ox
        const wy = b.y + oy
        const h = engine.blocks.measuredHeight(b.id) || 72
        el.style.display = wx + b.w >= minX && wx <= maxX && wy + h >= minY && wy <= maxY ? '' : 'none'
      }
    }
    cullRef.current = cull
    let settle = 0
    const off = engine.onCamera(() => {
      const { x, y, zoom } = engine.cam
      world.style.transform = `translate(${-x * zoom}px, ${-y * zoom}px) scale(${zoom})`
      cull()
      // Safari에서 scale된 텍스트가 흐려지지 않도록 will-change는 제스처 중에만 켠다
      world.classList.add('is-moving')
      clearTimeout(settle)
      settle = window.setTimeout(() => world.classList.remove('is-moving'), GESTURE_SETTLE_MS)
    })
    world.style.transform = `translate(${-engine.cam.x * engine.cam.zoom}px, ${-engine.cam.y * engine.cam.zoom}px) scale(${engine.cam.zoom})`
    cull()
    return () => {
      off()
      clearTimeout(settle)
      cullRef.current = () => {}
    }
  }, [engine, blocksVisible])

  // ── 블록 높이 측정 (저장하지 않는 런타임 값) ──
  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      for (const en of entries) {
        const el = en.target as HTMLElement
        if (el.dataset.blkId) engine.blocks.setMeasuredHeight(el.dataset.blkId, el.offsetHeight)
      }
    })
    roRef.current = ro
    return () => {
      ro.disconnect()
      roRef.current = null
    }
  }, [engine])

  const attachEl = useCallback(
    (id: ID) => (el: HTMLElement | null) => {
      const prev = els.current.get(id)
      if (prev && prev !== el) roRef.current?.unobserve(prev)
      if (el) {
        els.current.set(id, el)
        roRef.current?.observe(el)
      } else els.current.delete(id)
    },
    []
  )

  // ── 블록 목록·표시 상태가 바뀌면 culling 다시 적용 ──
  useLayoutEffect(() => {
    cullRef.current()
  }, [blocks, blocksVisible])

  // ── 캔버스를 탭하면 블록 선택 해제 (엔진 올가미 선택과는 독립적) ──
  useEffect(() => {
    const fn = () => {
      if (useUI.getState().selectedBlockId) useUI.setState({ selectedBlockId: null })
    }
    const r = engine.root
    r.addEventListener('pointerdown', fn, true)
    return () => r.removeEventListener('pointerdown', fn, true)
  }, [engine])

  // ── 배치 모드: 다른 도구로 전환하면 취소 ──
  const prevTool = useRef(tool)
  useEffect(() => {
    if (prevTool.current === tool) return
    prevTool.current = tool
    if (useUI.getState().placingBlock) useUI.setState({ placingBlock: null })
  }, [tool])

  // ── 배치 모드: 안내 토스트 ──
  useEffect(() => {
    if (!placingBlock) return
    const meta = BLOCK_META[placingBlock]
    useUI.getState().toast(`페이지나 여백을 탭해서 ${meta.label} 블록을 놓으세요`, 'info', {
      label: '취소',
      run: () => useUI.setState({ placingBlock: null })
    })
  }, [placingBlock])

  // ── 타이머: 실행 중인 타이머가 있을 때만 켜지는 250ms 티커 ──
  const [, forceTick] = useState(0)
  const tickRef = useRef(0)
  const ensureTick = useCallback(() => {
    if (tickRef.current) return
    tickRef.current = window.setInterval(() => {
      const now = Date.now()
      const ringing: ID[] = []
      for (const [id, t] of timers.current) {
        // 삭제된 블록의 실행 상태는 정리한다 — 유령 토스트·되살아난 실행 방지
        if (!engine.blocks.get(id)) {
          timers.current.delete(id)
          continue
        }
        if (t.endAt != null && t.endAt <= now) {
          t.endAt = null
          t.remainSec = 0
          ringing.push(id)
        }
      }
      if (ringing.length) {
        useUI.getState().toast('타이머가 끝났습니다', 'info')
        for (const id of ringing) {
          const el = els.current.get(id)
          if (!el) continue
          el.setAttribute('data-ringing', '')
          setTimeout(() => el.removeAttribute('data-ringing'), 2200)
        }
      }
      if (![...timers.current.values()].some((t) => t.endAt != null)) {
        clearInterval(tickRef.current)
        tickRef.current = 0
      }
      forceTick((n) => n + 1)
    }, 250)
  }, [engine])
  useEffect(
    () => () => {
      if (tickRef.current) clearInterval(tickRef.current)
    },
    []
  )
  const timerRun = useCallback(
    (id: ID, durationSec: number): TimerRun => {
      let t = timers.current.get(id)
      if (!t) {
        t = { endAt: null, remainSec: durationSec }
        timers.current.set(id, t)
      }
      return t
    },
    []
  )

  // ── 배치 모드: 탭 한 번으로 블록 생성. 페이지 밖·페이지 사이도 그 자리에 생성된다 ──
  const onCatcherTap = (e: ReactPointerEvent) => {
    const type = useUI.getState().placingBlock
    if (!type) return
    e.preventDefault()
    e.stopPropagation()
    const w = engine.worldOfClient(e.clientX, e.clientY)
    const list = engine.blocks.list()
    const z = list.length ? list[list.length - 1].z + 1 : 1
    // 블록 헤더 중앙이 탭 지점에 오도록 한다
    const a = anchorBlock(engine.layout, w.x - BLOCK_DEFAULT_W[type] / 2, w.y - HEAD_H / 2, BLOCK_DEFAULT_W[type], HEAD_H)
    if (!a) return
    const b = createBlock(type, engine.doc.id, a.pageId, a.x, a.y, z)
    engine.addBlock(b)
    useUI.setState({ placingBlock: null, selectedBlockId: b.id })
    engine.clearSelection()
    setFresh(b.id)
  }

  const select = useCallback(
    (id: ID) => {
      engine.clearSelection()
      useUI.setState({ selectedBlockId: id })
    },
    [engine]
  )
  const onFreshConsumed = useCallback(() => setFresh(null), [])

  return (
    <div className="block-layer" data-export-open={panel === 'export' ? '' : undefined} hidden={!blocksVisible}>
      <div className="block-world" ref={worldRef}>
        {blocks.map((b) => (
          <BlockCard
            key={b.id}
            engine={engine}
            block={b}
            readOnly={readOnly}
            fresh={fresh === b.id}
            selected={selectedBlockId === b.id}
            attachEl={attachEl}
            onSelect={select}
            onDragStart={() => setAttach(null)}
            onDragMove={(wx, wy, h) => {
              const a = anchorBlock(engine.layout, wx, wy, b.w, h)
              if (!a || !engine.layout.paged) return setAttach(null)
              const r = engine.layout.rects.get(a.pageId)
              setAttach(r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null)
            }}
            onDragEnd={() => setAttach(null)}
            timerRun={timerRun}
            ensureTick={ensureTick}
            onFreshConsumed={onFreshConsumed}
          />
        ))}
        {attach && <div className="blk-attach" style={{ left: attach.x, top: attach.y, width: attach.w, height: attach.h }} />}
      </div>
      {placingBlock && <div className="block-catcher" onPointerDown={onCatcherTap} />}
    </div>
  )
}

// ───────────────────────── 블록 카드 ─────────────────────────

interface CardProps {
  engine: Engine
  block: Block
  readOnly: boolean
  fresh: boolean
  selected: boolean
  attachEl: (id: ID) => (el: HTMLElement | null) => void
  onSelect: (id: ID) => void
  onDragStart: () => void
  onDragMove: (wx: number, wy: number, h: number) => void
  onDragEnd: () => void
  timerRun: (id: ID, durationSec: number) => TimerRun
  ensureTick: () => void
  onFreshConsumed: () => void
}

function BlockCard(p: CardProps) {
  const { engine, block, readOnly } = p
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [editTick, setEditTick] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const { x, y } = blockWorldPos(engine.layout, block)
  const h = engine.blocks.measuredHeight(block.id) || 72
  const r = engine.layout.paged ? engine.layout.rects.get(block.pageId) : undefined
  const outside = !!r && (x + block.w <= r.x || x >= r.x + r.w || y + h <= r.y || y >= r.y + r.h)
  const meta = BLOCK_META[block.type]

  // fresh는 최초 마운트에서 한 번만 소비한다 — Undo/Redo로 다시 마운트될 때 편집 폼이 다시 열리지 않게
  useEffect(() => {
    if (p.fresh) p.onFreshConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const label =
    block.type === 'memo'
      ? block.data.text.split('\n', 1)[0].trim() || meta.label
      : block.type === 'link'
        ? block.data.label.trim() || safeDomain(block.data.url) || meta.label
        : block.type === 'todo'
          ? `${meta.label} ${block.data.items.filter((i) => i.done).length}/${block.data.items.length}`
          : meta.label

  // 실행 피드백: box-shadow 링 펄스 (0 → 12px, 0.45s)
  const fire = () => {
    const el = rootRef.current
    if (!el) return
    el.classList.remove('fire')
    void el.offsetWidth
    el.classList.add('fire')
    setTimeout(() => el.classList.remove('fire'), 500)
  }

  // ── 헤더 드래그: 소속 페이지 재지정(anchorBlock) + attach 표시. 본문 드래그는 블록을 움직이지 않는다 ──
  const drag = useRef<null | { id: number; sx: number; sy: number; wx: number; wy: number; moved: boolean; el: HTMLElement }>(null)
  const onHeadDown = (e: ReactPointerEvent) => {
    if (readOnly) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const el = rootRef.current
    if (!el) return
    e.preventDefault()
    e.stopPropagation()
    p.onSelect(block.id)
    e.currentTarget.setPointerCapture(e.pointerId)
    const w0 = blockWorldPos(engine.layout, block)
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, wx: w0.x, wy: w0.y, moved: false, el }
    p.onDragStart()
  }
  const onHeadMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < TAP_SLOP_PX) return
      d.moved = true
      d.el.classList.add('is-drag')
      d.el.style.zIndex = '9999'
    }
    const dx = (e.clientX - d.sx) / engine.cam.zoom
    const dy = (e.clientY - d.sy) / engine.cam.zoom
    d.el.style.left = `${d.wx + dx}px`
    d.el.style.top = `${d.wy + dy}px`
    p.onDragMove(d.wx + dx, d.wy + dy, d.el.offsetHeight)
  }
  /** onHeadUp/onHeadCancel 공통 정리 — DOM 위치를 원래 값으로 되돌리고 드래그 상태를 비운다 */
  const endHeadDrag = (d: NonNullable<typeof drag.current>) => {
    drag.current = null
    d.el.classList.remove('is-drag')
    d.el.style.zIndex = ''
    // 직접 고친 left/top을 원래 값으로 되돌린다 — exec 후 React가 새 위치를 다시 쓴다
    d.el.style.left = `${d.wx}px`
    d.el.style.top = `${d.wy}px`
    p.onDragEnd()
  }
  const onHeadUp = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    endHeadDrag(d)
    if (!d.moved) return
    engine.moveBlockToWorld(block.id, d.wx + (e.clientX - d.sx) / engine.cam.zoom, d.wy + (e.clientY - d.sy) / engine.cam.zoom, d.el.offsetHeight)
  }
  // 포인터가 취소된 드래그(시스템 제스처·팜 리젝션)는 커밋하지 않는다 — 원래 자리로 되돌린다
  const onHeadCancel = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    endHeadDrag(d)
  }

  const maxZ = () => {
    const list = engine.blocks.list()
    return list.length ? list[list.length - 1].z + 1 : 1
  }
  const requestEdit = () => setEditTick((n) => n + 1)

  const style: CSSProperties = { left: x, top: y, width: block.w }
  if (block.type === 'memo') (style as Record<string, string | number>)['--memo'] = MEMO_BG[block.data.color]

  return (
    <div
      ref={(el) => {
        rootRef.current = el
        p.attachEl(block.id)(el)
      }}
      className="blk"
      data-type={block.type}
      data-selected={p.selected ? '' : undefined}
      data-outside={outside ? '' : undefined}
      data-blk-id={block.id}
      style={style}
      onPointerDownCapture={() => p.onSelect(block.id)}
    >
      <div className="blk-head" onPointerDown={onHeadDown} onPointerMove={onHeadMove} onPointerUp={onHeadUp} onPointerCancel={onHeadCancel}>
        <Icon name="grip" size={12} />
        <Icon name={meta.icon} size={13} />
        <span className="blk-label">{label}</span>
        <span className="blk-nopdf" title="PDF 내보내기에는 포함되지 않음">
          <Icon name="noPdf" size={13} />
        </span>
        <button className="blk-mini" aria-label="블록 메뉴" onClick={(e) => setMenu(e.currentTarget)}>
          <Icon name="more" size={14} />
        </button>
      </div>

      {block.type === 'memo' && <MemoBody {...p} block={block} />}
      {block.type === 'link' && <LinkBody {...p} block={block} fire={fire} editTick={editTick} />}
      {block.type === 'todo' && <TodoBody {...p} block={block} />}
      {block.type === 'timer' && <TimerBody {...p} block={block} fire={fire} editTick={editTick} />}
      {block.type === 'jump' && <JumpBody {...p} block={block} fire={fire} editTick={editTick} />}

      {menu && (
        <FtPopover anchor={menu} side="below" kind="blocks" onClose={() => setMenu(null)}>
          <BlockMenu {...p} maxZ={maxZ} requestEdit={requestEdit} onClose={() => setMenu(null)} />
        </FtPopover>
      )}
    </div>
  )
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

// ───────────────────────── 타입별 본문 ─────────────────────────

function MemoBody(p: Omit<CardProps, 'block'> & { block: MemoBlock }) {
  const { engine, block } = p
  const ref = useRef<HTMLTextAreaElement>(null)
  const startText = useRef(block.data.text)
  useEffect(() => {
    if (ref.current) ref.current.style.height = `${ref.current.scrollHeight}px`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }
  // Undo/Redo·동기화로 block.data.text가 바뀌어도 uncontrolled textarea의 DOM 값은 그대로다.
  // 포커스 중이 아니면 DOM 값을 맞춰, 다음 입력이 취소된 내용을 되살리지 않게 한다.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (document.activeElement !== el && el.value !== block.data.text) {
      el.value = block.data.text
      grow(el)
    }
  }, [block.data.text])
  return (
    <div className="blk-body">
      {!block.data.collapsed && (
        <textarea
          ref={ref}
          rows={1}
          readOnly={p.readOnly}
          defaultValue={block.data.text}
          placeholder="메모 입력"
          onFocus={() => (startText.current = block.data.text)}
          onChange={(e) => {
            grow(e.currentTarget)
            // 연속 입력 — 저장만 예약하고 히스토리에는 넣지 않는다. blur에서 시작·종료 스냅샷으로 한 번 exec한다.
            engine.updateBlock(block.id, { data: { ...block.data, text: e.target.value } }, { history: false })
          }}
          onBlur={(e) => {
            grow(e.currentTarget)
            engine.commitBlockEdit({ ...block, data: { ...block.data, text: startText.current } })
          }}
        />
      )}
    </div>
  )
}

function LinkBody({ engine, block, fresh, readOnly, fire, editTick }: Omit<CardProps, 'block'> & { block: LinkBlock; fire: () => void; editTick: number }) {
  const [editing, setEditing] = useState(fresh && !readOnly)
  const [url, setUrl] = useState(block.data.url)
  const [label, setLabel] = useState(block.data.label)
  const toast = useUI((s) => s.toast)
  useEffect(() => {
    if (editTick && !readOnly) setEditing(true)
  }, [editTick, readOnly])
  // 편집 모드에 들어올 때마다 현재 블록 값으로 폼을 맞춘다 — Undo/동기화 후 낡은 값으로 덮어쓰지 않게
  useEffect(() => {
    if (!editing) return
    setUrl(block.data.url)
    setLabel(block.data.label)
  }, [editing, block.data.url, block.data.label])
  const domain = safeDomain(block.data.url)
  const initial = (block.data.label || domain || block.data.url).trim()
  const open = () => {
    if (editing) return
    if (!block.data.url) {
      if (readOnly) return // 읽기 전용에서는 편집 폼을 열지 않는다
      return setEditing(true)
    }
    if (!isSafeBlockUrl(block.data.url)) return toast('허용되지 않는 링크입니다.', 'error')
    fire()
    window.open(block.data.url, '_blank', 'noopener,noreferrer')
  }
  if (editing)
    return (
      <div className="blk-body blk-link-form">
        <input className="modal-input" placeholder="URL" value={url} onChange={(e) => setUrl(e.target.value)} />
        <input className="modal-input" placeholder="표시 이름" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button
          className="primary-btn"
          onClick={() => {
            const n = normalizeBlockUrl(url)
            if (n === null) return toast('http·https·mailto·tel 링크만 허용합니다.', 'error')
            engine.updateBlock(block.id, { data: { url: n, label: label.trim() } })
            setEditing(false)
          }}
        >
          완료
        </button>
      </div>
    )
  return (
    <div className="blk-body">
      <button className="blk-action" onClick={open}>
        <span className="blk-fav">{(initial || '?').slice(0, 1).toUpperCase()}</span>
        <span className="blk-link-text">
          <b>{initial || '링크'}</b>
          <small>{domain || 'URL 없음 — 탭하면 편집'}</small>
        </span>
        <Icon name="external" size={15} />
      </button>
    </div>
  )
}

function TodoBody({ engine, block, fresh, readOnly }: Omit<CardProps, 'block'> & { block: TodoBlock }) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (fresh) inputRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const longPress = useRef<null | { id: number; timer: number; sx: number; sy: number }>(null)
  const items = block.data.items
  const patch = (next: typeof items) => engine.updateBlock(block.id, { data: { ...block.data, items: next } })
  const cancelLong = () => {
    if (longPress.current) clearTimeout(longPress.current.timer)
    longPress.current = null
  }
  return (
    <div className="blk-body">
      {items.map((it) => (
        <div
          key={it.id}
          className="blk-todo-row"
          onPointerDown={(e) => {
            if (readOnly) return
            // 항목을 길게 누르면 삭제한다
            longPress.current = { id: e.pointerId, timer: window.setTimeout(() => patch(items.filter((x) => x.id !== it.id)), 600), sx: e.clientX, sy: e.clientY }
          }}
          onPointerMove={(e) => {
            const lp = longPress.current
            if (lp && lp.id === e.pointerId && Math.hypot(e.clientX - lp.sx, e.clientY - lp.sy) > TAP_SLOP_PX) cancelLong()
          }}
          onPointerUp={cancelLong}
          onPointerCancel={cancelLong}
        >
          <button
            className={'blk-todo-check' + (it.done ? ' is-done' : '')}
            disabled={readOnly}
            aria-label={it.done ? '완료 취소' : '완료'}
            onClick={() => patch(items.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)))}
          >
            <Icon name="check" size={13} />
          </button>
          <span className={it.done ? 'is-done' : ''}>{it.text}</span>
        </div>
      ))}
      <input
        ref={inputRef}
        className="blk-todo-add"
        placeholder="+ 항목 추가"
        disabled={readOnly}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // 한글 IME 조합 중 Enter(keyCode 229 / isComposing)는 조합 확정용이므로 항목 추가로 처리하지 않는다
          if (e.nativeEvent.isComposing || e.keyCode === 229) return
          if (e.key !== 'Enter' || !draft.trim()) return
          e.preventDefault()
          patch([...items, { id: ulid(), text: draft.trim(), done: false }])
          setDraft('')
        }}
      />
    </div>
  )
}

function TimerBody({ engine, block, readOnly, fire, timerRun, editTick, ensureTick }: Omit<CardProps, 'block'> & { block: TimerBlock; fire: () => void; editTick: number }) {
  const [editing, setEditing] = useState(false)
  const [direct, setDirect] = useState('')
  const [, force] = useState(0)
  useEffect(() => {
    if (editTick) setEditing(true)
  }, [editTick])
  const run = timerRun(block.id, block.data.durationSec)
  const running = run.endAt != null
  const remain = running ? Math.max(0, Math.round((run.endAt! - Date.now()) / 1000)) : run.remainSec
  const total = Math.max(1, block.data.durationSec)
  const toggle = () => {
    if (running) {
      run.remainSec = Math.max(0, Math.round((run.endAt! - Date.now()) / 1000))
      run.endAt = null
    } else {
      if (run.remainSec <= 0) run.remainSec = block.data.durationSec
      run.endAt = Date.now() + run.remainSec * 1000
      fire()
      ensureTick()
    }
    force((n) => n + 1)
  }
  /** 직접 입력한 초를 적용한다. 잘못된 값이면 편집 모드를 닫지 않는다. */
  const applyDirect = () => {
    const n = Math.round(Number(direct))
    if (!Number.isFinite(n) || n <= 0) return
    run.endAt = null
    run.remainSec = n
    engine.updateBlock(block.id, { data: { durationSec: n } })
    setEditing(false)
  }
  if (editing)
    return (
      <div className="blk-body">
        <div className="seg full">
          {[1, 5, 10, 25].map((m) => (
            <button
              key={m}
              className={block.data.durationSec === m * 60 ? 'is-active' : ''}
              onClick={() => {
                run.endAt = null
                run.remainSec = m * 60
                engine.updateBlock(block.id, { data: { durationSec: m * 60 } })
              }}
            >
              {m}분
            </button>
          ))}
        </div>
        <div className="blk-timer-direct">
          <input
            className="modal-input"
            inputMode="numeric"
            placeholder="초 단위 (예: 90)"
            value={direct}
            onChange={(e) => setDirect(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyDirect()
            }}
          />
          <button className="primary-btn" onClick={applyDirect}>
            완료
          </button>
        </div>
      </div>
    )
  return (
    <div className="blk-body">
      <button className="blk-action" disabled={readOnly} onClick={toggle}>
        <Icon name={running ? 'pause' : 'play'} size={16} />
        <span className="blk-timer-digits">{mmss(remain)}</span>
        <span className="blk-timer-bar">
          <span style={{ width: `${Math.round((remain / total) * 100)}%` }} />
        </span>
      </button>
    </div>
  )
}

function JumpBody({ engine, block, fresh, fire, editTick }: Omit<CardProps, 'block'> & { block: JumpBlock; fire: () => void; editTick: number }) {
  const [editing, setEditing] = useState(fresh)
  const selRef = useRef<HTMLSelectElement>(null)
  useEffect(() => {
    if (editTick) setEditing(true)
  }, [editTick])
  useEffect(() => {
    if (!fresh) return
    try {
      selRef.current?.showPicker?.()
    } catch {
      selRef.current?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const pages = engine.pages
  const idx = pages.findIndex((pg) => pg.id === block.data.targetPageId)
  if (editing)
    return (
      <div className="blk-body">
        <select
          ref={selRef}
          value={block.data.targetPageId ?? ''}
          onChange={(e) => {
            engine.updateBlock(block.id, { data: { ...block.data, targetPageId: e.target.value || null } })
            setEditing(false)
          }}
        >
          <option value="">대상 페이지 선택</option>
          {pages.map((pg, i) => (
            <option key={pg.id} value={pg.id}>
              {i + 1}페이지
            </option>
          ))}
        </select>
      </div>
    )
  return (
    <div className="blk-body">
      <button
        className="blk-action"
        disabled={idx < 0}
        onClick={() => {
          if (idx < 0) return
          fire()
          engine.scrollToPage(idx)
        }}
      >
        <Icon name="jump" size={15} />
        {idx < 0 ? '삭제된 페이지' : `${idx + 1}페이지로 이동`}
      </button>
    </div>
  )
}

// ───────────────────────── ⋯ 메뉴 ─────────────────────────

/** 공통 항목(복제·맨 앞으로·삭제) + 타입별 항목 */
function BlockMenu(p: CardProps & { maxZ: () => number; requestEdit: () => void; onClose: () => void }) {
  const { engine, block, readOnly } = p
  const done = (fn: () => void) => () => {
    fn()
    p.onClose()
  }
  return (
    <div className="ft-menu">
      <button className="menu-item" disabled={readOnly} onClick={done(() => engine.duplicateBlock(block.id))}>
        <Icon name="copy" />
        복제
      </button>
      <button className="menu-item" disabled={readOnly} onClick={done(() => engine.bringBlockToFront(block.id))}>
        <Icon name="arrowUp" />
        맨 앞으로
      </button>
      {block.type === 'memo' && <MemoMenuItems {...p} block={block} done={done} />}
      {block.type === 'link' && (
        <>
          <button className="menu-item" disabled={readOnly} onClick={done(p.requestEdit)}>
            <Icon name="edit" />
            링크 편집
          </button>
          <button
            className="menu-item"
            disabled={!block.data.url}
            onClick={done(() => {
              void navigator.clipboard?.writeText(block.data.url).then(() => useUI.getState().toast('링크를 복사했습니다', 'info'))
            })}
          >
            <Icon name="copy" />
            URL 복사
          </button>
        </>
      )}
      {block.type === 'todo' && (
        <button
          className="menu-item"
          disabled={readOnly}
          onClick={done(() => engine.updateBlock(block.id, { data: { ...block.data, items: block.data.items.filter((i) => !i.done) } }))}
        >
          <Icon name="check" />
          완료 항목 지우기
        </button>
      )}
      {block.type === 'timer' && (
        <>
          <button className="menu-item" disabled={readOnly} onClick={done(p.requestEdit)}>
            <Icon name="timer" />
            시간 설정
          </button>
          <button
            className="menu-item"
            disabled={readOnly}
            onClick={done(() => {
              const run = p.timerRun(block.id, block.data.durationSec)
              run.endAt = null
              run.remainSec = block.data.durationSec
            })}
          >
            <Icon name="restore" />
            초기화
          </button>
        </>
      )}
      {block.type === 'jump' && (
        <button className="menu-item" disabled={readOnly} onClick={done(p.requestEdit)}>
          <Icon name="jump" />
          대상 변경
        </button>
      )}
      <div className="ft-menu-sep" />
      <button
        className="menu-item blk-menu-danger"
        disabled={readOnly}
        onClick={done(() => {
          engine.deleteBlock(block.id)
          useUI.setState({ selectedBlockId: null })
        })}
      >
        <Icon name="trash" />
        삭제
      </button>
    </div>
  )
}

function MemoMenuItems({ engine, block, readOnly, done }: Omit<CardProps, 'block'> & { block: MemoBlock; done: (fn: () => void) => () => void }) {
  const colors = ['yellow', 'pink', 'blue', 'green'] as const
  return (
    <>
      <div className="ft-menu-sep" />
      <div className="blk-menu-row" role="group" aria-label="메모 색">
        {colors.map((c) => (
          <button
            key={c}
            className={'ft-sw' + (block.data.color === c ? ' is-active' : '')}
            style={{ ['--c' as string]: MEMO_BG[c] }}
            disabled={readOnly}
            aria-label={`메모 색 ${c}`}
            onClick={done(() => engine.updateBlock(block.id, { data: { ...block.data, color: c } }))}
          />
        ))}
      </div>
      <button
        className="menu-item"
        disabled={readOnly}
        onClick={done(() => engine.updateBlock(block.id, { data: { ...block.data, collapsed: !block.data.collapsed } }))}
      >
        <Icon name={block.data.collapsed ? 'chevronDown' : 'close'} />
        {block.data.collapsed ? '펼치기' : '접기'}
      </button>
    </>
  )
}
