// 작업보드 — 무한히 펼쳐지는 사각 격자 위에 노트·앱·파일의 '바로가기'를 원하는 자리에 놓고 쓴다.
// · 아래 '카드 서랍'의 카드를 보드로 끌어다 놓으면 그 자리에 바로가기가 생긴다.
// · 놓인 바로가기는 다시 끌어 옮길 수 있다 — 윈도우 배경화면·아이폰 앱 정렬처럼 도메인별로 모아 놓는다.
// · 배치는 격자 좌표로 저장되고, 프리셋으로 Drive(Inkpad/boards)에 공유된다.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useUI } from '../../app/store'
import { Icon } from '../Icon'
import { Segmented } from '../Segmented'
import { confirmDialog, promptDialog } from '../../app/dialogs'
import {
  BOARD_CELL,
  BOARD_MAX_SHORTCUTS,
  BOARD_WALLPAPERS,
  cellCenter,
  cloneBoard,
  DEFAULT_BOARD,
  normalizeBoard,
  packGrid,
  worldToGrid,
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

const LS_BOARD = 'inkpad.board.v3'
const MIN_Z = 0.25
const MAX_Z = 2
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

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
type TrayFilter = 'doc' | 'app' | 'file' | 'all'

export function Board() {
  const navigate = useUI((s) => s.navigate)
  const toast = useUI((s) => s.toast)

  const [board, setBoard] = useState<BoardModel>(loadBoard)
  const [docs, setDocs] = useState<DocumentMeta[]>([])
  const [apps, setApps] = useState<HtmlApp[]>([])
  const [files, setFiles] = useState<FileRow[]>([])
  const [thumbs, setThumbs] = useState<Map<ID, string>>(new Map())
  const [view, setView] = useState({ x: 0, y: 0, z: 1 })
  const [edit, setEdit] = useState(false)
  const [drawer, setDrawer] = useState(true)
  const [tray, setTray] = useState<TrayFilter>('doc')
  const [query, setQuery] = useState('')
  const [wallMenu, setWallMenu] = useState(false)
  const [showPresets, setShowPresets] = useState(false)
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null)
  const [carry, setCarry] = useState<{ kind: ShortcutKind; refId: ID; label: string; x: number; y: number } | null>(null)

  const stageRef = useRef<HTMLDivElement>(null)
  const boardRef = useRef(board)
  const viewRef = useRef(view)
  const thumbUrls = useRef<string[]>([])
  const centered = useRef(false)

  useEffect(() => {
    boardRef.current = board
    try {
      localStorage.setItem(LS_BOARD, JSON.stringify(board))
    } catch {
      /* 저장소 차단 환경 */
    }
  }, [board])
  useEffect(() => {
    viewRef.current = view
  }, [view])

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

  /** 무대 크기를 재서 월드 원점을 화면 가운데에 둔다 (첫 1회) */
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el || centered.current) return
    const r = el.getBoundingClientRect()
    if (!r.width) return
    centered.current = true
    setView({ x: Math.round(r.width / 2), y: Math.round(r.height / 2), z: 1 })
  }, [])

  // ── 팬 / 핀치 줌 (무한 캔버스) ──
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gest = useRef<null | {
    mode: 'pan' | 'pinch'
    p0: { x: number; y: number }
    pan0: { x: number; y: number }
    z0: number
    d0: number
    mid0: { x: number; y: number }
  }>(null)

  const armGesture = () => {
    const pts = [...pointers.current.values()]
    const v = viewRef.current
    if (pts.length === 1) gest.current = { mode: 'pan', p0: pts[0], pan0: { x: v.x, y: v.y }, z0: v.z, d0: 0, mid0: pts[0] }
    else if (pts.length >= 2) {
      const [a, b] = pts
      gest.current = {
        mode: 'pinch',
        p0: a,
        pan0: { x: v.x, y: v.y },
        z0: v.z,
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      }
    } else gest.current = null
  }

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const g = gest.current
      if (!g) return
      const pts = [...pointers.current.values()]
      if (g.mode === 'pan' && pts.length === 1) {
        setView({ x: g.pan0.x + (pts[0].x - g.p0.x), y: g.pan0.y + (pts[0].y - g.p0.y), z: g.z0 })
      } else if (g.mode === 'pinch' && pts.length >= 2) {
        const [a, b] = pts
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1
        const z = clamp(g.z0 * (d / g.d0), MIN_Z, MAX_Z)
        const k = z / g.z0
        setView({ z, x: mid.x - (g.mid0.x - g.pan0.x) * k, y: mid.y - (g.mid0.y - g.pan0.y) * k })
      }
    }
    const up = (e: PointerEvent) => {
      pointers.current.delete(e.pointerId)
      if (pointers.current.size) armGesture()
      else gest.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [])

  // 휠: 스크롤 = 이동, ⌘/Ctrl + 휠(트랙패드 핀치) = 커서 기준 줌
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const v = viewRef.current
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect()
        const px = e.clientX - r.left
        const py = e.clientY - r.top
        const z = clamp(v.z * Math.exp(-e.deltaY * 0.0022), MIN_Z, MAX_Z)
        const k = z / v.z
        setView({ z, x: px - (px - v.x) * k, y: py - (py - v.y) * k })
      } else {
        setView({ x: v.x - e.deltaX, y: v.y - e.deltaY, z: v.z })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const stageDown = (e: React.PointerEvent) => {
    if (e.target !== stageRef.current) return // 카드에서 시작한 포인터는 카드가 처리한다
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    armGesture()
  }

  const zoomBy = (factor: number) => {
    const el = stageRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const v = viewRef.current
    const cx = r.width / 2
    const cy = r.height / 2
    const z = clamp(v.z * factor, MIN_Z, MAX_Z)
    const k = z / v.z
    setView({ z, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k })
  }

  const toWorld = useCallback((cx: number, cy: number) => {
    const r = stageRef.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (cx - r.left - v.x) / v.z, y: (cy - r.top - v.y) / v.z }
  }, [])

  // ── 항목 ──
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
  const stamped = (it: Item) => (it.kind === 'doc' ? it.d : it.kind === 'app' ? it.a : it.f)

  const shortcuts = board.shortcuts
  const missing = shortcuts.filter((s) => !itemOf(s)).length

  const open = (sc: BoardShortcut) => {
    if (sc.kind === 'doc') return navigate({ name: 'editor', docId: sc.refId })
    if (sc.kind === 'app') return navigate({ name: 'app', appId: sc.refId })
    navigate({ name: 'file', fileId: sc.refId })
  }

  // ── 배치 조작 ──
  const removeShortcut = (id: string) => setBoard((b) => ({ ...b, shortcuts: b.shortcuts.filter((s) => s.id !== id) }))

  const addAt = (kind: ShortcutKind, refId: ID, wx: number, wy: number) => {
    if (boardRef.current.shortcuts.length >= BOARD_MAX_SHORTCUTS) {
      toast(`바로가기는 ${BOARD_MAX_SHORTCUTS}개까지 놓을 수 있습니다.`, 'error')
      return
    }
    const g = worldToGrid(wx, wy, boardRef.current.snap)
    setBoard((b) => ({ ...b, shortcuts: [...b.shortcuts, { id: newId(), kind, refId, ...g }] }))
  }

  /** 놓인 카드 조작 — 탭이면 열기. 위치 이동은 수정모드일 때만 (6px 이상 끌면 이동) */
  const beginMove = (sc: BoardShortcut, e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    const canMove = edit // 수정모드에서만 위치를 옮길 수 있다
    const sx = e.clientX
    const sy = e.clientY
    let moving = false
    const move = (ev: PointerEvent) => {
      if (!moving && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) moving = true
      if (moving && canMove) setDragPos({ id: sc.id, ...toWorld(ev.clientX, ev.clientY) })
    }
    const up = (ev: PointerEvent) => {
      cleanup()
      if (!moving) {
        open(sc)
        return
      }
      if (!canMove) return // 수정모드가 아니면 위치 고정 — 끌어도 제자리
      const w = toWorld(ev.clientX, ev.clientY)
      const g = worldToGrid(w.x, w.y, boardRef.current.snap)
      setBoard((b) => ({ ...b, shortcuts: b.shortcuts.map((s) => (s.id === sc.id ? { ...s, ...g } : s)) }))
      setDragPos(null)
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cleanup)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cleanup)
  }

  /** 서랍의 카드를 보드로 끌어다 놓기 */
  const beginCarry = (e: React.PointerEvent, kind: ShortcutKind, refId: ID, label: string) => {
    e.preventDefault()
    e.stopPropagation()
    setCarry({ kind, refId, label, x: e.clientX, y: e.clientY })
    const move = (ev: PointerEvent) => setCarry((c) => (c ? { ...c, x: ev.clientX, y: ev.clientY } : c))
    const up = (ev: PointerEvent) => {
      cleanup()
      const r = stageRef.current?.getBoundingClientRect()
      const inside = !!r && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom
      if (inside) {
        const w = toWorld(ev.clientX, ev.clientY)
        addAt(kind, refId, w.x, w.y)
        toast(`"${label}"을(를) 보드에 놓았습니다.`, 'success')
      }
      setCarry(null)
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cleanup)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cleanup)
  }

  /** 지금 배치를 가지런한 사각 격자로 정렬 */
  const arrange = () => {
    const n = board.shortcuts.length
    if (!n) return
    const pos = packGrid(n)
    setBoard((b) => ({ ...b, snap: true, shortcuts: b.shortcuts.map((s, i) => ({ ...s, ...pos[i] })) }))
    requestAnimationFrame(() => fit())
  }

  /** 보드의 모든 바로가기가 화면에 들어오게 맞춤 */
  const fit = () => {
    const el = stageRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const list = boardRef.current.shortcuts
    if (!list.length) {
      setView({ x: Math.round(r.width / 2), y: Math.round(r.height / 2), z: 1 })
      return
    }
    const pad = BOARD_CELL
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const s of list) {
      const cx = cellCenter(s.gx)
      const cy = cellCenter(s.gy)
      minX = Math.min(minX, cx)
      maxX = Math.max(maxX, cx)
      minY = Math.min(minY, cy)
      maxY = Math.max(maxY, cy)
    }
    const w = maxX - minX + pad * 2
    const h = maxY - minY + pad * 2
    const z = clamp(Math.min(r.width / w, r.height / h), MIN_Z, 1.3)
    const cxw = (minX + maxX) / 2
    const cyw = (minY + maxY) / 2
    setView({ z, x: r.width / 2 - cxw * z, y: r.height / 2 - cyw * z })
  }

  // ── 서랍 목록 ──
  const trayItems = useMemo<{ key: string; kind: ShortcutKind; id: ID; label: string; at: number }[]>(() => {
    const q = query.trim().toLowerCase()
    const out: { key: string; kind: ShortcutKind; id: ID; label: string; at: number }[] = []
    if (tray === 'doc' || tray === 'all') for (const d of docs) out.push({ key: `doc:${d.id}`, kind: 'doc', id: d.id, label: d.title, at: d.updatedAt })
    if (tray === 'app' || tray === 'all') for (const a of apps) out.push({ key: `app:${a.id}`, kind: 'app', id: a.id, label: a.title, at: a.updatedAt })
    if (tray === 'file' || tray === 'all') for (const f of files) out.push({ key: `file:${f.id}`, kind: 'file', id: f.id, label: f.name, at: f.updatedAt })
    const list = q ? out.filter((x) => x.label.toLowerCase().includes(q)) : out
    return list.sort((a, b) => b.at - a.at)
  }, [docs, apps, files, tray, query])

  const placedKeys = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of shortcuts) {
      const k = `${s.kind}:${s.refId}`
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m
  }, [shortcuts])

  // ── 격자 배경 (무한 격자) ──
  const gridStyle = useMemo(() => {
    const c = BOARD_CELL * view.z
    const major = c * 8
    const images: string[] = []
    const sizes: string[] = []
    const positions: string[] = []
    const push = (color: string, size: number) => {
      images.push(`linear-gradient(to right, ${color} 1px, transparent 1px)`, `linear-gradient(to bottom, ${color} 1px, transparent 1px)`)
      sizes.push(`${size}px ${size}px`, `${size}px ${size}px`)
      positions.push(`${view.x}px ${view.y}px`, `${view.x}px ${view.y}px`)
    }
    if (c > 12) push('var(--grid-line)', c)
    if (major > 12) push('var(--grid-major)', major)
    return {
      backgroundImage: images.join(', '),
      backgroundSize: sizes.join(', '),
      backgroundPosition: positions.join(', ')
    }
  }, [view.x, view.y, view.z])

  // 같은 칸에 겹친 바로가기는 살짝 어긋나게 쌓는다 (아이폰 아이콘 겹침 느낌)
  const stackIndex = useMemo(() => {
    const seen = new Map<string, number>()
    const out = new Map<string, number>()
    for (const s of shortcuts) {
      const k = `${Math.round(s.gx)},${Math.round(s.gy)}`
      const n = seen.get(k) ?? 0
      seen.set(k, n + 1)
      if (n) out.set(s.id, n)
    }
    return out
  }, [shortcuts])

  const savePreset = async () => {
    const name = await promptDialog('프리셋으로 저장', {
      value: `작업보드 ${new Date().getMonth() + 1}/${new Date().getDate()}`,
      ok: '저장'
    })
    if (!name?.trim()) return
    const p = await createPreset(name.trim(), board)
    const up = await uploadPreset(p.id)
    toast(
      up ? `"${p.name}" 프리셋을 저장하고 Drive에 올렸습니다.` : `"${p.name}" 프리셋을 저장했습니다. 클라우드에는 나중에 올릴 수 있습니다.`,
      up ? 'success' : 'info'
    )
    setShowPresets(true)
  }

  const applyPreset = (p: BoardModel & { name: string }) => {
    setBoard(normalizeBoard(p))
    toast(`"${p.name}" 프리셋을 불러왔습니다.`, 'success')
    requestAnimationFrame(() => fit())
  }

  const face = (it: Item, size: number) => {
    if (it.kind === 'doc') {
      const url = thumbs.get(it.d.id)
      return (
        <span className="board-item-face" style={url ? { backgroundImage: `url(${url})` } : undefined}>
          {!url && <Icon name={it.d.mode === 'infinite' ? 'infinite' : 'page'} size={size} />}
        </span>
      )
    }
    if (it.kind === 'app') {
      return (
        <span className="board-item-face board-face-app" style={{ background: gradient(it.a.title) }}>
          {it.a.title.slice(0, 1)}
        </span>
      )
    }
    return <span className="board-item-face board-face-file">{extOf(it.f.name).toUpperCase().slice(0, 5) || 'FILE'}</span>
  }

  return (
    <div className={'board board-wall-' + board.wallpaper + (edit ? ' is-editing' : '')} data-zoom={view.z < 0.55 ? 'far' : undefined}>
      <header className="board-topbar">
        <h1 className="board-brand">작업보드</h1>
        <span className="board-count">
          바로가기 {shortcuts.length}개{missing ? ` · 사라짐 ${missing}` : ''}
        </span>
        <div className="board-actions">
          <button className={'tb-btn' + (board.snap ? ' is-on' : '')} onClick={() => setBoard((b) => ({ ...b, snap: !b.snap }))} aria-label="격자에 붙이기" title="격자에 붙이기">
            <Icon name="grid" />
          </button>
          <button className="tb-btn" onClick={arrange} disabled={!shortcuts.length} aria-label="가지런히 정렬" title="가지런히 정렬">
            <Icon name="blocks" />
          </button>
          <button className="tb-btn" onClick={fit} disabled={!shortcuts.length} aria-label="화면에 맞춤" title="화면에 맞춤">
            <Icon name="fit" />
          </button>
          <button className="tb-btn" onClick={() => setWallMenu((v) => !v)} aria-label="배경화면" title="배경화면">
            <Icon name="wallpaper" />
          </button>
          <button
            className={'tb-btn' + (edit ? ' is-on' : '')}
            onClick={() => setEdit((v) => !v)}
            aria-label="편집"
            title={edit ? '편집 끝내기' : '편집 (배치·서랍)'}
          >
            <Icon name={edit ? 'check' : 'edit'} />
          </button>
          <button className="tb-btn" onClick={() => void savePreset()} aria-label="프리셋으로 저장" title="프리셋으로 저장">
            <Icon name="save" />
          </button>
          <button className="tb-btn" onClick={() => setShowPresets(true)} aria-label="프리셋 목록" title="프리셋 · 드라이브 공유">
            <Icon name="board" />
          </button>
          <button className="tb-btn" onClick={() => navigate({ name: 'library' })} aria-label="노트 목록" title="노트 목록">
            <Icon name="back" />
          </button>
        </div>
      </header>

      {/* 무한 사각 격자 무대 — 빈 곳을 끌면 이동, 핀치/⌘휠로 확대 */}
      <div className="board-stage" ref={stageRef} onPointerDown={stageDown} style={gridStyle}>
        {shortcuts.length === 0 ? (
          <div className="board-empty">
            <Icon name="board" size={52} />
            <h2>작업보드가 비어 있습니다</h2>
            <p>
              오른쪽 위 <b>편집</b>을 켜면 아래 <b>카드 서랍</b>이 열립니다. 카드를 보드로 끌어다 놓으면 그 자리에 바로가기가 생기고, 놓인 카드도 편집 중에만 옮길 수 있습니다. 빈 곳을 끌면 보드가 움직이고, 벌려서(핀치) 확대할 수 있습니다.
            </p>
            <button
              className="primary-btn"
              onClick={() => {
                setEdit(true)
                setDrawer(true)
              }}
            >
              <Icon name="plus" size={18} /> 편집 시작
            </button>
          </div>
        ) : null}

        <div className="board-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
          {shortcuts.map((sc) => {
            const it = itemOf(sc)
            const dragging = dragPos?.id === sc.id
            const wx = dragging ? dragPos!.x : cellCenter(sc.gx)
            const wy = dragging ? dragPos!.y : cellCenter(sc.gy)
            const off = dragging ? 0 : (stackIndex.get(sc.id) ?? 0) * 7
            return (
              <button
                key={sc.id}
                className={'board-item kind-' + sc.kind + (dragging ? ' is-dragging' : '') + (it ? '' : ' is-missing')}
                style={{ left: wx + off, top: wy + off }}
                onPointerDown={(e) => beginMove(sc, e)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  const nm = it ? titleOf(it) : '사라진 항목'
                  void confirmDialog(`"${nm}" 바로가기`, {
                    message: '이 바로가기를 보드에서 지웁니다. 실제 노트·파일은 그대로입니다.',
                    ok: '지우기',
                    danger: true
                  }).then((ok) => ok && removeShortcut(sc.id))
                }}
                title={it ? `${titleOf(it)} — 끌어서 옮기기` : '사라진 항목'}
              >
                {it ? (
                  <>
                    {face(it, 30)}
                    <span className="board-item-label">{titleOf(it)}</span>
                  </>
                ) : (
                  <>
                    <span className="board-item-face board-face-missing">
                      <Icon name="alert" size={26} />
                    </span>
                    <span className="board-item-label">사라짐</span>
                  </>
                )}
                {edit && (
                  <span
                    className="board-item-remove"
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
      </div>

      {/* 줌 컨트롤 (무한 캔버스) */}
      <div className={'board-hud' + (edit && drawer ? ' with-drawer' : '')}>
        <button className="tb-btn" onClick={() => zoomBy(1 / 1.25)} aria-label="축소">
          <Icon name="minus" size={18} />
        </button>
        <b className="board-hud-zoom">{Math.round(view.z * 100)}%</b>
        <button className="tb-btn" onClick={() => zoomBy(1.25)} aria-label="확대">
          <Icon name="plus" size={18} />
        </button>
        <button className="tb-btn" onClick={fit} disabled={!shortcuts.length} aria-label="화면에 맞춤">
          <Icon name="fit" size={18} />
        </button>
      </div>

      {/* 카드 서랍 — 수정모드일 때만 뜬다. 카드를 보드로 끌어다 놓는다 */}
      {edit && (
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
              <div className="board-drawer-tools">
                <Segmented
                  className="board-tray-seg"
                  value={tray}
                  options={[
                    ['doc', '노트'],
                    ['app', '앱'],
                    ['file', '파일'],
                    ['all', '전체']
                  ]}
                  onChange={(v) => setTray(v)}
                  label="서랍 항목"
                />
                <span className="board-drawer-search">
                  <Icon name="search" size={15} />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="카드 검색" aria-label="카드 검색" />
                </span>
              </div>
              <div className="board-drawer-strip">
                {trayItems.length === 0 ? (
                  <span className="board-drawer-none">카드가 없습니다</span>
                ) : (
                  trayItems.map((x) => {
                    const n = placedKeys.get(x.key) ?? 0
                    return (
                      <div
                        key={x.key}
                        className={'board-card kind-' + x.kind + (n ? ' is-placed' : '')}
                        onPointerDown={(e) => beginCarry(e, x.kind, x.id, x.label)}
                        title={`${x.label} — 보드로 끌어다 놓기${n ? ` (보드에 ${n}개)` : ''}`}
                      >
                        {x.kind === 'doc' && thumbs.get(x.id) ? (
                          <span className="board-card-thumb" style={{ backgroundImage: `url(${thumbs.get(x.id)})` }} />
                        ) : (
                          <span className={'board-card-thumb is-icon kind-' + x.kind}>
                            <Icon name={x.kind === 'doc' ? 'page' : x.kind === 'app' ? 'app' : 'file'} size={16} />
                          </span>
                        )}
                        <span className="board-card-name">{x.label}</span>
                        {n ? <span className="board-card-badge">{n}</span> : null}
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {/* 서랍에서 끌고 있는 카드 고스트 */}
      {carry && (
        <div className="board-carry" style={{ left: carry.x, top: carry.y }} aria-hidden="true">
          <Icon name={carry.kind === 'doc' ? 'page' : carry.kind === 'app' ? 'app' : 'file'} size={18} />
          <span>{carry.label}</span>
        </div>
      )}

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
            <Icon name="grid" size={16} /> 격자에 붙이기
            <b>{board.snap ? '켬' : '끔'}</b>
          </button>
          <button className="board-pop-row" onClick={arrange} disabled={!shortcuts.length}>
            <Icon name="blocks" size={16} /> 가지런히 정렬
          </button>
          <button
            className="board-pop-row"
            onClick={async () => {
              const ok = await confirmDialog('보드 비우기', { message: '이 보드의 바로가기를 모두 없앱니다. 노트·앱·파일은 그대로입니다.', ok: '비우기', danger: true })
              if (ok) setBoard((b) => ({ ...b, shortcuts: [] }))
              setWallMenu(false)
            }}
            disabled={!shortcuts.length}
          >
            <Icon name="trash" size={16} /> 바로가기 모두 없애기
          </button>
        </div>
      )}

      {showPresets && <BoardPresetsSheet board={board} onApply={applyPreset} onClose={() => setShowPresets(false)} />}
    </div>
  )
}
