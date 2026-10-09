// 작업보드 — 윈도우 배경화면처럼 깔리는 판(보드)에 노트·앱·파일의 '바로가기'를 배치한다.
// · 상단 메뉴바를 아래로 끌어내리면 애플 워치 앱 보관소 스타일(벌집 그리드) 런처가 열린다.
// · 아래 '카드 서랍'의 노트 카드를 보드로 끌어다 놓으면 바로가기가 추가된다(포인터 드래그).
// · 배치 결과는 프리셋으로 저장해 Drive(Inkpad/boards)로 공유한다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useUI } from '../../app/store'
import { Icon } from '../Icon'
import { confirmDialog, promptDialog } from '../../app/dialogs'
import {
  BOARD_WALLPAPERS,
  cloneBoard,
  DEFAULT_BOARD,
  hexSpiral,
  hexToPixel,
  normalizeBoard,
  pixelToHex,
  type Board as BoardModel,
  type BoardShortcut,
  type ShortcutKind
} from '../../shared/board'
import { extOf, type DocumentMeta, type HtmlApp, type ID } from '../../shared/model'
import { getThumbnails, listDocuments } from '../../storage/repo'
import { listApps } from '../../sync/apps'
import { listFiles } from '../../sync/files'
import { createPreset, uploadPreset } from '../../sync/board'
import { BoardPresetsSheet } from '../BoardPresetsSheet'
import type { FileRow } from '../../storage/db'

const LS_BOARD = 'inkpad.board.v1'
const HEX_CELL = 96 // 보드 스냅 벌집 크기(px)

function loadBoard(): BoardModel {
  try {
    const raw = localStorage.getItem(LS_BOARD)
    if (raw) return normalizeBoard(JSON.parse(raw))
  } catch {
    /* 저장소 차단 환경 */
  }
  return cloneBoard(DEFAULT_BOARD)
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `s${Date.now()}${Math.random().toString(36).slice(2, 8)}`)

function gradient(title: string) {
  let h = 0
  for (const ch of title) h = (h + ch.charCodeAt(0)) % 360
  return `linear-gradient(135deg, hsl(${h} 68% 62%), hsl(${(h + 42) % 360} 68% 44%))`
}

type Item = { kind: 'doc'; d: DocumentMeta } | { kind: 'app'; a: HtmlApp } | { kind: 'file'; f: FileRow }

export function Board() {
  const navigate = useUI((s) => s.navigate)
  const toast = useUI((s) => s.toast)

  const [board, setBoard] = useState<BoardModel>(loadBoard)
  const [docs, setDocs] = useState<DocumentMeta[]>([])
  const [apps, setApps] = useState<HtmlApp[]>([])
  const [files, setFiles] = useState<FileRow[]>([])
  const [thumbs, setThumbs] = useState<Map<ID, string>>(new Map())
  const [edit, setEdit] = useState(false)
  const [launcher, setLauncher] = useState(false)
  const [drawer, setDrawer] = useState(true)
  const [wallMenu, setWallMenu] = useState(false)
  const [showPresets, setShowPresets] = useState(false)
  const [query, setQuery] = useState('')
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null)
  const [carry, setCarry] = useState<{ kind: ShortcutKind; refId: ID; label: string; x: number; y: number } | null>(null)

  const stageRef = useRef<HTMLDivElement>(null)
  const boardRef = useRef(board)
  const editRef = useRef(edit)
  const thumbUrls = useRef<string[]>([])

  useEffect(() => {
    boardRef.current = board
    try {
      localStorage.setItem(LS_BOARD, JSON.stringify(board))
    } catch {
      /* 저장소 차단 환경 */
    }
  }, [board])
  useEffect(() => {
    editRef.current = edit
    if (edit) setDrawer(true)
  }, [edit])

  const refresh = useCallback(async () => {
    const [d, a, f, th] = await Promise.all([listDocuments(), listApps(), listFiles(), getThumbnails()])
    setDocs(d)
    setApps(a)
    setFiles(f)
    thumbUrls.current.forEach((u) => URL.revokeObjectURL(u))
    const urls: string[] = []
    const m = new Map<ID, string>()
    th.forEach((blob, id) => {
      const u = URL.createObjectURL(blob)
      urls.push(u)
      m.set(id, u)
    })
    thumbUrls.current = urls
    setThumbs(m)
  }, [])

  useEffect(() => {
    void refresh()
    return () => thumbUrls.current.forEach((u) => URL.revokeObjectURL(u))
  }, [refresh])

  // Esc: 편집/런처/서랍 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (launcher) setLauncher(false)
      else if (showPresets) setShowPresets(false)
      else if (wallMenu) setWallMenu(false)
      else if (edit) setEdit(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [launcher, showPresets, wallMenu, edit])

  // ── 항목 조회 ──
  const itemOf = useCallback(
    (sc: BoardShortcut): Item | null => {
      if (sc.kind === 'doc') {
        const d = docs.find((x) => x.id === sc.refId)
        return d ? { kind: 'doc', d } : null
      }
      if (sc.kind === 'app') {
        const a = apps.find((x) => x.id === sc.refId)
        return a ? { kind: 'app', a } : null
      }
      const f = files.find((x) => x.id === sc.refId)
      return f ? { kind: 'file', f } : null
    },
    [docs, apps, files]
  )

  const labelOf = (it: Item) => (it.kind === 'doc' ? it.d.title : it.kind === 'app' ? it.a.title : it.f.name)
  const titleOf = (it: Item) => (it.kind === 'file' ? it.f.title : labelOf(it))

  const open = (sc: BoardShortcut) => {
    if (sc.kind === 'doc') return navigate({ name: 'editor', docId: sc.refId })
    if (sc.kind === 'app') return navigate({ name: 'app', appId: sc.refId })
    navigate({ name: 'file', fileId: sc.refId })
  }

  // ── 좌표 ──
  const snapPoint = (nx: number, ny: number) => {
    const r = stageRef.current?.getBoundingClientRect()
    if (!boardRef.current.snap || !r) return { x: nx, y: ny }
    const h = pixelToHex((nx - 0.5) * r.width, (ny - 0.5) * r.height, HEX_CELL)
    const p = hexToPixel(h.q, h.r, HEX_CELL)
    return {
      x: Math.min(0.985, Math.max(0.015, p.x / r.width + 0.5)),
      y: Math.min(0.97, Math.max(0.03, p.y / r.height + 0.5))
    }
  }

  const addAt = (kind: ShortcutKind, refId: ID, x: number, y: number) => {
    setBoard((b) => ({ ...b, shortcuts: [...b.shortcuts, { id: newId(), kind, refId, x, y }] }))
  }

  const removeShortcut = (id: string) => setBoard((b) => ({ ...b, shortcuts: b.shortcuts.filter((s) => s.id !== id) }))

  /** 벌집 격자에 자동 정렬 — 사용자화의 출발점 */
  const autoArrange = () => {
    const r = stageRef.current?.getBoundingClientRect()
    if (!r) return
    const n = board.shortcuts.length
    const pos = hexSpiral(n, HEX_CELL)
    setBoard((b) => ({
      ...b,
      snap: true,
      shortcuts: b.shortcuts.map((s, i) => {
        const p = pos[Math.min(i, pos.length - 1)]
        return {
          ...s,
          x: Math.min(0.985, Math.max(0.015, p.x / r.width + 0.5)),
          y: Math.min(0.97, Math.max(0.03, p.y / r.height + 0.5))
        }
      })
    }))
    toast('벌집 격자에 정렬했습니다.', 'success')
  }

  // ── 타일 드래그 (편집 모드, 또는 길게 누르기) ──
  const beginTileDrag = (sc: BoardShortcut, e: React.PointerEvent<HTMLButtonElement>) => {
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const sx = e.clientX
    const sy = e.clientY
    let armed = false
    let timer = 0
    const toXY = (cx: number, cy: number) => ({
      x: Math.min(0.985, Math.max(0.015, (cx - rect.left) / rect.width)),
      y: Math.min(0.97, Math.max(0.03, (cy - rect.top) / rect.height))
    })
    const cleanup = () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    const arm = () => {
      if (armed) return
      armed = true
      if (!editRef.current) setEdit(true)
      setDrag({ id: sc.id, ...toXY(sx, sy) })
    }
    if (editRef.current) arm()
    else timer = window.setTimeout(arm, 450)
    const move = (ev: PointerEvent) => {
      if (!armed) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 9) cleanup() // 스크롤/탭 — 길게 누르기 취소
        return
      }
      setDrag({ id: sc.id, ...toXY(ev.clientX, ev.clientY) })
    }
    const up = (ev: PointerEvent) => {
      const wasArmed = armed
      cleanup()
      if (wasArmed) {
        const xy = toXY(ev.clientX, ev.clientY)
        const p = snapPoint(xy.x, xy.y)
        setBoard((b) => ({ ...b, shortcuts: b.shortcuts.map((s) => (s.id === sc.id ? { ...s, x: p.x, y: p.y } : s)) }))
        setDrag(null)
      } else if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 10) {
        open(sc)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  // ── 서랍의 카드 → 보드로 끌어다 놓기 ──
  const beginCarry = (e: React.PointerEvent, kind: ShortcutKind, refId: ID, label: string) => {
    e.preventDefault()
    const stage = stageRef.current
    setCarry({ kind, refId, label, x: e.clientX, y: e.clientY })
    const move = (ev: PointerEvent) => setCarry((c) => (c ? { ...c, x: ev.clientX, y: ev.clientY } : c))
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      const r = stage?.getBoundingClientRect()
      const inside = r && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom
      if (r && inside) {
        const p = snapPoint(
          Math.min(0.985, Math.max(0.015, (ev.clientX - r.left) / r.width)),
          Math.min(0.97, Math.max(0.03, (ev.clientY - r.top) / r.height))
        )
        addAt(kind, refId, p.x, p.y)
        toast(`"${label}"을(를) 보드에 놓았습니다.`, 'success')
      }
      setCarry(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  // ── 상단 메뉴바 끌어내리기 → 워치 그리드 ──
  const beginPullDown = (e: React.PointerEvent) => {
    const sy = e.clientY
    let moved = false
    const move = (ev: PointerEvent) => {
      if (ev.clientY - sy > 56) {
        moved = true
        cleanup()
        setLauncher(true)
      }
    }
    const up = (ev: PointerEvent) => {
      cleanup()
      if (!moved && Math.abs(ev.clientY - sy) < 8) setLauncher((v) => !v) // 그냥 누르면 토글
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  // ── 프리셋 ──
  const savePreset = async () => {
    const name = await promptDialog('프리셋으로 저장', { value: `작업보드 ${new Date().getMonth() + 1}/${new Date().getDate()}`, ok: '저장' })
    if (!name?.trim()) return
    const p = await createPreset(name.trim(), board)
    const up = await uploadPreset(p.id)
    toast(up ? `"${p.name}" 프리셋을 저장하고 Drive에 올렸습니다.` : `"${p.name}" 프리셋을 저장했습니다. 클라우드에는 나중에 올릴 수 있습니다.`, up ? 'success' : 'info')
    setShowPresets(true)
  }

  // ── 표시용 ──
  const shortcuts = board.shortcuts
  const visible = useMemo(() => shortcuts.filter((s) => itemOf(s)), [shortcuts, itemOf])
  const docsInUse = new Set(shortcuts.filter((s) => s.kind === 'doc').map((s) => s.refId))

  const honey = useMemo(() => {
    const cell = 74
    const n = Math.max(1, visible.length + 1) // 마지막 한 칸은 "+"
    const pos = hexSpiral(n, cell)
    let maxR = cell
    for (const p of pos) maxR = Math.max(maxR, Math.hypot(p.x, p.y))
    return { pos, cell, maxR, size: maxR * 2 + cell * 2.2 }
  }, [visible.length])

  const q = query.trim().toLowerCase()
  const trayDocs = docs.filter((d) => !q || d.title.toLowerCase().includes(q))
  const trayApps = apps.filter((a) => !q || a.title.toLowerCase().includes(q))
  const trayFiles = files.filter((f) => !q || f.title.toLowerCase().includes(q))

  /** 서랍 행 — 세 종류를 같은 모양으로 맞춰 렌더한다 */
  const trayRows = useMemo(
    () => [
      { title: '노트 카드', kind: 'doc' as ShortcutKind, items: trayDocs.map((d) => ({ id: d.id as ID, label: d.title })) },
      { title: '앱', kind: 'app' as ShortcutKind, items: trayApps.map((a) => ({ id: a.id as ID, label: a.title })) },
      { title: '기타 파일', kind: 'file' as ShortcutKind, items: trayFiles.map((f) => ({ id: f.id as ID, label: f.name })) }
    ],
    [trayDocs, trayApps, trayFiles]
  )

  const tileVisual = (it: Item) => {
    if (it.kind === 'doc') {
      const url = thumbs.get(it.d.id)
      return (
        <span className="board-tile-face board-face-doc" style={url ? { backgroundImage: `url(${url})` } : undefined}>
          {!url && <Icon name={it.d.mode === 'infinite' ? 'infinite' : 'page'} size={26} />}
        </span>
      )
    }
    if (it.kind === 'app') {
      return (
        <span className="board-tile-face board-face-app" style={{ background: gradient(it.a.title) }}>
          {it.a.title.slice(0, 1)}
        </span>
      )
    }
    return <span className="board-tile-face board-face-file">{extOf(it.f.name).toUpperCase() || 'FILE'}</span>
  }

  const circleVisual = (it: Item) => {
    if (it.kind === 'doc') {
      const url = thumbs.get(it.d.id)
      return (
        <span className="board-hex-face board-face-doc" style={url ? { backgroundImage: `url(${url})` } : undefined}>
          {!url && <Icon name={it.d.mode === 'infinite' ? 'infinite' : 'page'} size={22} />}
        </span>
      )
    }
    if (it.kind === 'app') {
      return (
        <span className="board-hex-face board-face-app" style={{ background: gradient(it.a.title) }}>
          {it.a.title.slice(0, 1)}
        </span>
      )
    }
    return <span className="board-hex-face board-face-file">{extOf(it.f.name).toUpperCase().slice(0, 4) || 'FILE'}</span>
  }

  return (
    <div className={'board board-wall-' + board.wallpaper + (edit ? ' is-edit' : '')}>
      {/* 상단 메뉴바 — 아래로 끌어내리면 워치 그리드 */}
      <header className="board-topbar">
        <div className="board-grabber" onPointerDown={beginPullDown} role="button" aria-label="바로가기 열기 (아래로 끌어내리기)">
          <span className="board-grabber-bar" aria-hidden="true" />
          <span className="board-grabber-hint">
            <Icon name="hex" size={14} /> 바로가기
          </span>
        </div>
        <h1 className="board-brand">작업보드</h1>
        <div className="board-actions">
          <button className={'tb-btn' + (edit ? ' is-on' : '')} onClick={() => setEdit((v) => !v)} title={edit ? '편집 끝내기' : '편집'} aria-label="편집">
            <Icon name={edit ? 'check' : 'edit'} />
          </button>
          <button className="tb-btn" onClick={() => setWallMenu((v) => !v)} title="배경화면" aria-label="배경화면">
            <Icon name="wallpaper" />
          </button>
          <button className="tb-btn" onClick={() => void savePreset()} title="프리셋으로 저장" aria-label="프리셋으로 저장">
            <Icon name="save" />
          </button>
          <button className="tb-btn" onClick={() => setShowPresets(true)} title="프리셋 목록·드라이브 공유" aria-label="프리셋">
            <Icon name="board" />
          </button>
          <button className="tb-btn" onClick={() => navigate({ name: 'library' })} title="노트 목록으로" aria-label="노트 목록">
            <Icon name="back" />
          </button>
        </div>
      </header>

      {/* 배경화면 팝오버 */}
      {wallMenu && (
        <div className="board-pop" role="dialog" aria-label="배경화면">
          <div className="board-pop-title">배경화면</div>
          <div className="board-wall-list">
            {BOARD_WALLPAPERS.map((w) => (
              <button
                key={w.key}
                className={'board-wall-chip board-wall-' + w.key + (board.wallpaper === w.key ? ' is-on' : '')}
                onClick={() => setBoard((b) => ({ ...b, wallpaper: w.key }))}
              >
                <span className="board-wall-dot" aria-hidden="true" />
                {w.name}
              </button>
            ))}
          </div>
          <div className="board-pop-sep" />
          <button className="board-pop-row" onClick={() => setBoard((b) => ({ ...b, snap: !b.snap }))}>
            <Icon name="hex" size={16} /> 벌집 격자에 붙이기
            <b>{board.snap ? '켬' : '끔'}</b>
          </button>
          <button className="board-pop-row" onClick={() => { setWallMenu(false); autoArrange() }} disabled={!shortcuts.length}>
            <Icon name="grid" size={16} /> 벌집 격자에 자동 정렬
          </button>
        </div>
      )}

      {/* 보드 판 — 배경화면 위에 바로가기를 놓는다 */}
      <div className="board-stage" ref={stageRef} onPointerDown={(e) => e.target === e.currentTarget && edit && setEdit(false)}>
        {shortcuts.length === 0 ? (
          <div className="board-empty">
            <Icon name="board" size={52} />
            <h2>작업보드가 비어 있습니다</h2>
            <p>아래 <b>카드 서랍</b>에서 노트 카드를 끌어다 놓으면 바로가기가 생깁니다.</p>
            <button className="primary-btn" onClick={() => { setEdit(true); setDrawer(true) }}>
              <Icon name="plus" size={18} /> 바로가기 추가
            </button>
          </div>
        ) : null}

        {shortcuts.map((sc) => {
          const it = itemOf(sc)
          const pos = drag && drag.id === sc.id ? drag : sc
          const dragging = !!(drag && drag.id === sc.id)
          return (
            <button
              key={sc.id}
              className={'board-tile kind-' + sc.kind + (dragging ? ' is-dragging' : '') + (it ? '' : ' is-missing')}
              style={{ left: `${pos.x * 100}%`, top: `${pos.y * 100}%` }}
              onPointerDown={(e) => beginTileDrag(sc, e)}
              onContextMenu={(e) => {
                e.preventDefault()
                const nm = it ? titleOf(it) : '사라진 항목'
                void confirmDialog(`"${nm}" 바로가기`, { message: '이 바로가기를 보드에서 지웁니다. 실제 파일은 그대로입니다.', ok: '지우기', danger: true }).then(
                  (ok) => ok && removeShortcut(sc.id)
                )
              }}
              onDoubleClick={() => removeShortcut(sc.id)}
              title={it ? titleOf(it) : '사라진 항목'}
            >
              {it ? (
                <>
                  {tileVisual(it)}
                  <span className="board-tile-label">{titleOf(it)}</span>
                </>
              ) : (
                <>
                  <span className="board-tile-face board-face-missing">
                    <Icon name="alert" size={24} />
                  </span>
                  <span className="board-tile-label">사라짐</span>
                </>
              )}
              {edit && (
                <span
                  className="board-tile-remove"
                  role="button"
                  aria-label="바로가기 지우기"
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    removeShortcut(sc.id)
                  }}
                >
                  <Icon name="close" size={13} />
                </span>
              )}
            </button>
          )
        })}
      </div>

      {edit && shortcuts.length > 0 && (
        <p className="board-tip">
          <Icon name="move" size={14} /> 바로가기를 끌어 옮기고, <b>×</b> 로 지웁니다. 배치는 자동으로 저장됩니다.
        </p>
      )}

      {/* 카드 서랍 — 노트 카드를 끌어다 보드에 놓는다 */}
      <section className={'board-drawer' + (drawer ? ' is-open' : '')} aria-label="카드 서랍">
        <button className="board-drawer-head" onClick={() => setDrawer((v) => !v)} aria-expanded={drawer}>
          <Icon name={drawer ? 'chevronDown' : 'chevronRight'} size={16} />
          <b>카드 서랍</b>
          <span className="board-drawer-sub">
            노트 {docs.length} · 앱 {apps.length} · 파일 {files.length}
          </span>
          <span className="board-drawer-hint">카드를 보드로 끌어다 놓으세요</span>
        </button>
        {drawer && (
          <div className="board-drawer-body">
            <div className="board-drawer-search">
              <Icon name="search" size={15} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="카드 검색" aria-label="카드 검색" />
            </div>
            <div className="board-drawer-rows">
              {trayRows.map((row) => (
                <div className="board-drawer-row" key={row.title}>
                  <span className="board-drawer-row-title">{row.title}</span>
                  <div className="board-drawer-strip">
                    {row.items.length === 0 ? (
                      <span className="board-drawer-none">없음</span>
                    ) : (
                      row.items.map((x) => {
                        const placed = row.kind === 'doc' && docsInUse.has(x.id)
                        return (
                          <div
                            key={x.id}
                            className={'board-card kind-' + row.kind + (placed ? ' is-placed' : '')}
                            onPointerDown={(e) => beginCarry(e, row.kind, x.id, x.label)}
                            title={`${x.label} — 보드로 끌어다 놓기`}
                          >
                            {row.kind === 'doc' && thumbs.get(x.id) ? (
                              <span className="board-card-thumb" style={{ backgroundImage: `url(${thumbs.get(x.id)})` }} />
                            ) : (
                              <span className={'board-card-thumb is-icon kind-' + row.kind}>
                                <Icon name={row.kind === 'doc' ? 'page' : row.kind === 'app' ? 'app' : 'file'} size={16} />
                              </span>
                            )}
                            <span className="board-card-name">{x.label}</span>
                          </div>
                        )
                      })
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* 서랍에서 끌고 있는 카드 고스트 */}
      {carry && (
        <div className="board-carry" style={{ left: carry.x, top: carry.y }} aria-hidden="true">
          <Icon name={carry.kind === 'doc' ? 'page' : carry.kind === 'app' ? 'app' : 'file'} size={18} />
          <span>{carry.label}</span>
        </div>
      )}

      {/* 워치 그리드 런처 */}
      {launcher && (
        <div className="board-launcher" role="dialog" aria-label="바로가기">
          <div
            className="board-launcher-pull"
            onPointerDown={(e) => {
              const sy = e.clientY
              const move = (ev: PointerEvent) => {
                if (sy - ev.clientY > 48) {
                  cleanup()
                  setLauncher(false)
                }
              }
              const cleanup = () => {
                window.removeEventListener('pointermove', move)
                window.removeEventListener('pointerup', cleanup)
              }
              window.addEventListener('pointermove', move)
              window.addEventListener('pointerup', cleanup)
            }}
          >
            <span className="board-grabber-bar" aria-hidden="true" />
          </div>
          <div className="board-launcher-head">
            <h2>바로가기</h2>
            <span className="board-launcher-sub">{visible.length}개</span>
            <span className="board-launcher-search">
              <Icon name="search" size={15} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="찾기" aria-label="바로가기 찾기" />
            </span>
            <button className="tb-btn" onClick={() => setLauncher(false)} aria-label="닫기">
              <Icon name="close" />
            </button>
          </div>
          <div className="board-launcher-stage">
            <div className="board-launcher-hex" style={{ width: honey.size, height: honey.size }}>
              {visible.map((sc, i) => {
                const it = itemOf(sc)!
                const nm = titleOf(it)
                if (q && !nm.toLowerCase().includes(q)) return null
                const p = honey.pos[i]
                const d = Math.hypot(p.x, p.y) / honey.maxR
                const scale = 1.12 - Math.min(0.34, d * 0.34)
                return (
                  <button
                    key={sc.id}
                    className={'board-hex kind-' + sc.kind}
                    style={{ left: honey.size / 2 + p.x, top: honey.size / 2 + p.y, transform: `translate(-50%,-50%) scale(${scale})` }}
                    onClick={() => open(sc)}
                    title={nm}
                  >
                    <span className="board-hex-circle">{circleVisual(it)}</span>
                    <span className="board-hex-label">{nm}</span>
                  </button>
                )
              })}
              <button
                className="board-hex board-hex-add"
                style={{ left: honey.size / 2 + honey.pos[visible.length].x, top: honey.size / 2 + honey.pos[visible.length].y, transform: 'translate(-50%,-50%)' }}
                onClick={() => {
                  setLauncher(false)
                  setEdit(true)
                  setDrawer(true)
                }}
                title="바로가기 추가"
              >
                <span className="board-hex-circle">
                  <Icon name="plus" size={26} />
                </span>
                <span className="board-hex-label">추가</span>
              </button>
            </div>
          </div>
          <p className="board-launcher-foot">위로 밀거나 바깥을 누르면 닫힙니다.</p>
        </div>
      )}

      {showPresets && (
        <BoardPresetsSheet
          board={board}
          onClose={() => setShowPresets(false)}
          onApply={(p) => {
            setBoard(normalizeBoard(p))
            toast(`"${p.name}" 프리셋을 불러왔습니다.`, 'success')
          }}
        />
      )}
    </div>
  )
}
