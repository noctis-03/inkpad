// 보조 용지 레이어 — 용지 종이와 그 위 획은 엔진이 캔버스에 그린다.
// 여기서는 용지마다 제목 줄(옮기기·이름·⋯ 메뉴)과 크기 조절 손잡이만 DOM으로 얹는다.
// 위치는 화면 좌표로 맞추고, 제목 줄은 용지처럼 배율을 따라 커지고 작아진다(블록과 같게 — --sw·--z로 CSS가 scale한다).
// 크기 조절 손잡이만 화면 크기 그대로 둔다(축소해도 잡을 수 있게). 카메라가 움직이면 React를 거치지 않고 style만 고친다.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { TAP_SLOP_PX } from '../../engine/constants'
import type { Engine } from '../../engine/engine'
import { BACKGROUND_LABELS, makeBackground, type BackgroundType, type ID, type Page } from '../../shared/model'
import { Icon } from '../Icon'
import { FtPopover } from './FloatingToolbar'

export function SheetLayer({ engine, readOnly }: { engine: Engine; readOnly: boolean }) {
  useSyncExternalStore(engine.subscribeSheets, engine.sheetsVersion)
  const sheets = engine.sheets
  const layerRef = useRef<HTMLDivElement>(null)
  const frames = useRef(new Map<ID, HTMLElement>())

  const place = useCallback(() => {
    const { x, y, zoom } = engine.cam
    for (const sh of engine.sheets) {
      const el = frames.current.get(sh.id)
      const r = engine.layout.rects.get(sh.id)
      if (!el) continue
      if (!r) {
        el.style.display = 'none'
        continue
      }
      el.style.display = ''
      el.style.transform = `translate(${(r.x - x) * zoom}px, ${(r.y - y) * zoom}px)`
      el.style.width = `${r.w * zoom}px`
      el.style.height = `${r.h * zoom}px`
      el.style.setProperty('--sw', `${r.w}px`) // 제목 줄 폭 = 용지 폭(pt), 배율은 --z
      el.style.setProperty('--z', String(zoom))
    }
  }, [engine])

  useEffect(() => engine.onCamera(place), [engine, place])
  useLayoutEffect(place)

  // 제목 줄 위 휠도 화면 이동·확대로 (캔버스와 같게)
  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    const onWheel = (e: WheelEvent) => engine.overlayWheel(e)
    layer.addEventListener('wheel', onWheel, { passive: false })
    return () => layer.removeEventListener('wheel', onWheel)
  }, [engine])

  const register = useCallback(
    (id: ID) => (el: HTMLElement | null) => {
      if (el) frames.current.set(id, el)
      else frames.current.delete(id)
    },
    []
  )

  return (
    <div className="sheet-layer" ref={layerRef}>
      {sheets.map((sh) => (
        <SheetFrame key={sh.id} engine={engine} sheet={sh} readOnly={readOnly} frameRef={register(sh.id)} />
      ))}
    </div>
  )
}

function SheetFrame({ engine, sheet, readOnly, frameRef }: { engine: Engine; sheet: Page; readOnly: boolean; frameRef: (el: HTMLElement | null) => void }) {
  const info = sheet.sheet!
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [editing, setEditing] = useState(false)
  const locked = readOnly || !!info.fixed

  // ── 제목 줄 끌기: 옮기기 (가까운 페이지 가장자리에 붙는다). 끄는 동안은 히스토리 없이, 놓을 때 1건 ──
  const drag = useRef<null | { id: number; sx: number; sy: number; gx: number; gy: number; before: Page; moved: boolean; onTitle: boolean }>(null)
  const onHeadDown = (e: ReactPointerEvent) => {
    if (readOnly || editing) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const t = e.target as HTMLElement
    if (t.closest('.sheet-menu-btn')) return
    const r = engine.layout.rects.get(sheet.id)
    if (!r) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const w = engine.worldOfClient(e.clientX, e.clientY)
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, gx: w.x - r.x, gy: w.y - r.y, before: sheet, moved: false, onTitle: !!t.closest('.sheet-title') }
  }
  const onHeadMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId || info.fixed) return
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < TAP_SLOP_PX) return
      d.moved = true
    }
    const w = engine.worldOfClient(e.clientX, e.clientY)
    engine.moveSheet(sheet.id, w.x - d.gx, w.y - d.gy, { history: false })
  }
  const onHeadUp = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (d.moved) engine.commitSheetEdit(d.before)
    else if (d.onTitle) setEditing(true) // 제목을 톡 누르면 이름 바꾸기
  }
  // 시스템 제스처 등으로 취소되면 끌기 전 자리로 되돌린다 (기록하지 않는다)
  const onHeadCancel = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (d.moved) engine.updateSheet(sheet.id, { sheet: d.before.sheet, size: d.before.size! }, { history: false })
  }

  // ── 바깥쪽 아래 모서리 끌기: 폭·높이. 왼쪽에 붙은 용지는 손잡이가 왼쪽 아래(페이지 반대쪽)다 ──
  const fromLeft = info.snap === 'left'
  const resize = useRef<null | { id: number; sx: number; sy: number; before: Page }>(null)
  const onResizeDown = (e: ReactPointerEvent) => {
    if (locked || !sheet.size) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    resize.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, before: sheet }
  }
  const onResizeMove = (e: ReactPointerEvent) => {
    const d = resize.current
    if (!d || d.id !== e.pointerId) return
    const z = engine.cam.zoom
    const dx = (e.clientX - d.sx) / z
    const dy = (e.clientY - d.sy) / z
    const s0 = d.before.size!
    // 페이지·다른 용지 크기에 가까우면 맞춘다 (엔진이 판단)
    engine.resizeSheet(sheet.id, s0.w + (fromLeft ? -dx : dx), s0.h + dy, { history: false })
  }
  const onResizeUp = (e: ReactPointerEvent) => {
    const d = resize.current
    if (!d || d.id !== e.pointerId) return
    resize.current = null
    if (e.type === 'pointercancel') engine.updateSheet(sheet.id, { size: d.before.size! }, { history: false })
    else engine.commitSheetEdit(d.before)
  }

  const commitTitle = (v: string) => {
    setEditing(false)
    const title = v.trim()
    if (title !== info.title) engine.updateSheet(sheet.id, { sheet: { title } })
  }

  return (
    <div className="sheet-frame" ref={frameRef} data-sheet-id={sheet.id} data-snap={info.snap ?? undefined} data-fixed={info.fixed ? '' : undefined}>
      <div className="sheet-head" onPointerDown={onHeadDown} onPointerMove={onHeadMove} onPointerUp={onHeadUp} onPointerCancel={onHeadCancel}>
        {!locked && <Icon name="grip" size={12} />}
        {editing ? (
          <input
            className="sheet-title-input"
            autoFocus
            defaultValue={info.title}
            placeholder="보조 용지"
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return // 한글 조합 중 Enter는 조합 확정
              if (e.key === 'Enter') commitTitle(e.currentTarget.value)
              else if (e.key === 'Escape') setEditing(false)
            }}
            onBlur={(e) => commitTitle(e.currentTarget.value)}
          />
        ) : (
          <span className={'sheet-title' + (info.title ? '' : ' is-empty')}>{info.title || '보조 용지'}</span>
        )}
        {info.fixed && <Icon name="pin" size={12} />}
        <button className="sheet-menu-btn" aria-label="보조 용지 메뉴" onClick={(e) => setMenu(e.currentTarget)}>
          <Icon name="more" size={14} />
        </button>
      </div>
      {!locked && (
        <div
          className={'sheet-resize' + (fromLeft ? ' is-left' : '')}
          role="separator"
          aria-label="보조 용지 크기 조절"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
        />
      )}
      {menu && (
        <FtPopover anchor={menu} side="below" kind="blocks" onClose={() => setMenu(null)}>
          <SheetMenu engine={engine} sheet={sheet} readOnly={readOnly} onRename={() => setEditing(true)} onClose={() => setMenu(null)} />
        </FtPopover>
      )}
    </div>
  )
}

/** 용지 속지 고르기: 페이지 속지 + 투명(테두리만) */
const SHEET_PAPERS: (BackgroundType | 'none')[] = ['blank', 'lined', 'grid', 'dot', 'cornell', 'none']

function SheetMenu({ engine, sheet, readOnly, onRename, onClose }: { engine: Engine; sheet: Page; readOnly: boolean; onRename: () => void; onClose: () => void }) {
  const info = sheet.sheet!
  const done = (fn: () => void) => () => {
    fn()
    onClose()
  }
  const paper = info.transparent ? 'none' : sheet.background.type
  // 메뉴는 열어 둔다 — 바뀐 속지를 바로 보며 다시 고를 수 있게
  const setPaper = (t: BackgroundType | 'none') => {
    if (t === paper) return
    if (t === 'none') engine.updateSheet(sheet.id, { sheet: { transparent: true } })
    else engine.updateSheet(sheet.id, { background: sheet.background.type === t ? sheet.background : makeBackground(t), sheet: { transparent: false } })
  }
  return (
    <div className="ft-menu">
      <div className="ft-pop-label sheet-paper-label">속지</div>
      <div className="sheet-paper-row" role="group" aria-label="보조 용지 속지">
        {SHEET_PAPERS.map((t) => {
          const label = t === 'none' ? '투명' : BACKGROUND_LABELS[t]
          return (
            <button key={t} className={'sheet-paper' + (paper === t ? ' is-active' : '')} disabled={readOnly} aria-label={`속지 ${label}`} aria-pressed={paper === t} onClick={() => setPaper(t)}>
              <span className={`paper-preview paper-${t}`} />
              <small>{label}</small>
            </button>
          )
        })}
      </div>
      <div className="ft-menu-sep" />
      <button className="menu-item" disabled={readOnly} onClick={done(onRename)}>
        <Icon name="edit" />
        이름 바꾸기
      </button>
      <button className="menu-item" disabled={readOnly || info.fixed || info.snap === 'left'} onClick={done(() => engine.updateSheet(sheet.id, { sheet: { snap: 'left' } }))}>
        <Icon name="back" />
        페이지 왼쪽에 붙이기
      </button>
      <button className="menu-item" disabled={readOnly || info.fixed || info.snap === 'right'} onClick={done(() => engine.updateSheet(sheet.id, { sheet: { snap: 'right' } }))}>
        <Icon name="chevronRight" />
        페이지 오른쪽에 붙이기
      </button>
      <button className="menu-item" disabled={readOnly} onClick={done(() => engine.bringSheetToFront(sheet.id))}>
        <Icon name="arrowUp" />
        맨 앞으로
      </button>
      <button className="menu-item" disabled={readOnly} onClick={done(() => engine.duplicateSheet(sheet.id))}>
        <Icon name="copy" />
        복제
      </button>
      <button className="menu-item" disabled={readOnly} onClick={done(() => engine.updateSheet(sheet.id, { sheet: { fixed: !info.fixed } }))}>
        <Icon name={info.fixed ? 'unlock' : 'pin'} />
        {info.fixed ? '고정 해제' : '움직이지 않게 고정'}
      </button>
      <div className="ft-menu-sep" />
      <button className="menu-item blk-menu-danger" disabled={readOnly} onClick={done(() => engine.deleteSheet(sheet.id))}>
        <Icon name="trash" />
        삭제
      </button>
    </div>
  )
}
