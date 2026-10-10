// 작업보드 — 무한히 펼쳐지는 사각 격자 위에 노트·앱·파일의 '바로가기'를 원하는 자리에 놓고 쓴다.
// · 보기 모드: 카드를 모두 같은 크기로 보여 주고 탭해서 연다.
// · 편집 모드: 격자·서랍·그룹 도구가 열리고 카드를 옮기거나 지운다. 되돌리기/다시가 함께 돈다.
// · 배치는 격자 좌표로 저장되고, 프리셋으로 Drive(Inkpad/boards)에 공유된다.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useUI } from '../../app/store'
import { Icon } from '../Icon'
import { Segmented } from '../Segmented'
import { confirmDialog, promptDialog } from '../../app/dialogs'
import {
  BOARD_CELL,
  BOARD_GROUP_MAX_CELLS,
  BOARD_GROUP_MIN_CELLS,
  BOARD_GROUP_NAME_MAX,
  BOARD_GROUP_TONES,
  BOARD_MAX_GROUPS,
  BOARD_MAX_SHORTCUTS,
  BOARD_WALLPAPERS,
  cellCenter,
  cloneBoard,
  DEFAULT_BOARD,
  normalizeBoard,
  packGrid,
  worldToGrid,
  type Board as BoardModel,
  type BoardGroup,
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
const LS_HIDE_MISSING = 'inkpad.board.hideMissing'
const MIN_Z = 0.25
const MAX_Z = 2
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

/** 그룹 박스 안쪽 맨 위 '이름 칸' 높이(px) — 박스 하나 안에 들어간다 */
const GROUP_HEAD_H = 30
/** 이 배율 이하로 축소되면 그룹 안 항목은 숨고 그룹은 이름 타일로 접힌다 */
const GROUP_COLLAPSE_Z = 0.5
/** 줌 버튼 한 번에 움직이는 배율 폭 (10%p) */
const ZOOM_STEP = 0.1
/** 되돌리기 스택 최대 단계 */
const UNDO_MAX = 50
/** 카드 서랍이 오른쪽 패널로 바뀌는 무대 폭 */
const WIDE_W = 900

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

/** 파일 확장자 → 색 계열 토큰 (P2) */
const FILE_TONES: { tone: string; exts: string[] }[] = [
  { tone: '--danger', exts: ['pdf'] },
  { tone: '--success', exts: ['xlsx', 'xls', 'csv', 'numbers'] },
  { tone: '--warn', exts: ['pptx', 'ppt', 'key'] },
  { tone: '--app', exts: ['png', 'jpg', 'jpeg', 'heic', 'webp', 'gif'] }
]
function fileTone(name: string): string {
  const e = extOf(name)
  for (const t of FILE_TONES) if (t.exts.includes(e)) return t.tone
  return '--file'
}
/** 그룹 톤 키 → 색 토큰 */
const TONE_VAR: Record<string, string> = { blue: '--accent', green: '--success', violet: '--app', amber: '--warn' }

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
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const [edit, setEdit] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [tray, setTray] = useState<TrayFilter>('doc')
  const [query, setQuery] = useState('')
  const [wallMenu, setWallMenu] = useState(false)
  const [moreMenu, setMoreMenu] = useState(false)
  const [groupMenu, setGroupMenu] = useState<string | null>(null)
  const [showPresets, setShowPresets] = useState(false)
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null)
  const [dropCell, setDropCell] = useState<{ gx: number; gy: number; busy: boolean } | null>(null)
  const [droppedId, setDroppedId] = useState<string | null>(null)
  const [groupLive, setGroupLive] = useState<BoardGroup | null>(null)
  const [worldAnim, setWorldAnim] = useState(false)
  const [carry, setCarry] = useState<{ kind: ShortcutKind; refId: ID; label: string; x: number; y: number } | null>(null)
  const [reconnectFor, setReconnectFor] = useState<BoardShortcut | null>(null)
  const [presetName, setPresetName] = useState('내 보드')
  const [hideMissing, setHideMissing] = useState(() => {
    try {
      return localStorage.getItem(LS_HIDE_MISSING) === '1'
    } catch {
      return false
    }
  })

  const stageRef = useRef<HTMLDivElement>(null)
  const boardRef = useRef(board)
  const viewRef = useRef(view)
  const stageSizeRef = useRef(stage)
  const thumbUrls = useRef<string[]>([])
  const centered = useRef(false)
  const animTimer = useRef<number | undefined>(undefined)
  const dropTimer = useRef<number | undefined>(undefined)
  const mapRef = useRef<HTMLCanvasElement>(null)
  const mapRaf = useRef<number | undefined>(undefined)
  const savedRef = useRef<string>('')
  const history = useRef<BoardModel[]>([])
  const future = useRef<BoardModel[]>([])
  const editRef = useRef(edit)
  const multiTap = useRef<{ n: number; t0: number; moved: boolean }>({ n: 0, t0: 0, moved: false })

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
  useEffect(() => {
    stageSizeRef.current = stage
  }, [stage])
  useEffect(() => {
    editRef.current = edit
  }, [edit])
  useEffect(() => {
    try {
      localStorage.setItem(LS_HIDE_MISSING, hideMissing ? '1' : '0')
    } catch {
      /* 저장소 차단 환경 */
    }
  }, [hideMissing])

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

  /** 무대 크기 추적 — 초점 반경과 서랍 패널 전환에 쓴다 */
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setStage((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── 되돌리기 / 다시 (P9) ──
  const pushHistory = useCallback(() => {
    history.current = [...history.current.slice(-(UNDO_MAX - 1)), cloneBoard(boardRef.current)]
    future.current = []
  }, [])

  const commit = useCallback(
    (updater: (b: BoardModel) => BoardModel) => {
      pushHistory()
      setBoard((b) => updater(b))
    },
    [pushHistory]
  )

  const undo = useCallback(() => {
    const prev = history.current.pop()
    if (!prev) return
    future.current = [...future.current, cloneBoard(boardRef.current)]
    setBoard(prev)
  }, [])

  const redo = useCallback(() => {
    const next = future.current.pop()
    if (!next) return
    history.current = [...history.current, cloneBoard(boardRef.current)]
    setBoard(next)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!editRef.current) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

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
        if (Math.hypot(pts[0].x - g.p0.x, pts[0].y - g.p0.y) > 8) multiTap.current.moved = true
        setView({ x: g.pan0.x + (pts[0].x - g.p0.x), y: g.pan0.y + (pts[0].y - g.p0.y), z: g.z0 })
      } else if (g.mode === 'pinch' && pts.length >= 2) {
        multiTap.current.moved = true
        const [a, b] = pts
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1
        const z = clamp(g.z0 * (d / g.d0), MIN_Z, MAX_Z)
        const k = z / g.z0
        setView({ z, x: mid.x - (g.mid0.x - g.pan0.x) * k, y: mid.y - (g.mid0.y - g.pan0.y) * k })
      }
    }
    const down = () => {
      if (pointers.current.size === 0) multiTap.current = { n: 0, t0: performance.now(), moved: false }
      multiTap.current.n = Math.max(multiTap.current.n, pointers.current.size + 1)
    }
    const up = (e: PointerEvent) => {
      pointers.current.delete(e.pointerId)
      if (pointers.current.size) armGesture()
      else {
        gest.current = null
        // 두 손가락 탭 = 되돌리기, 세 손가락 탭 = 다시 (편집 모드, 짧고 거의 안 움직였을 때만)
        const mt = multiTap.current
        if (editRef.current && !mt.moved && performance.now() - mt.t0 < 250) {
          if (mt.n === 2) undo()
          else if (mt.n >= 3) redo()
        }
      }
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [undo, redo])

  // 휠: 스크롤 = 이동, ⌘/Ctrl + 휠(트랙패드 핀치) = 커서 기준 줌
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setWorldAnim(false) // 휠은 연속 입력이라 즉시 반영한다
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
    if (e.target !== stageRef.current) return // 카드·그룹에서 시작한 포인터는 그쪽이 처리한다
    setWorldAnim(false) // 팬은 즉시 반응해야 한다
    setWallMenu(false)
    setMoreMenu(false)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    armGesture()
  }

  /** 월드 변환을 부드럽게 이어 주는 동안만 transition 을 켠다 (팬·핀치는 즉시) */
  const withWorldAnim = (fn: () => void) => {
    setWorldAnim(true)
    requestAnimationFrame(() => {
      fn()
      if (animTimer.current) clearTimeout(animTimer.current)
      animTimer.current = window.setTimeout(() => setWorldAnim(false), 320)
    })
  }

  const centerWorld = () => {
    const el = stageRef.current
    if (!el) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    const v = viewRef.current
    return { x: (r.width / 2 - v.x) / v.z, y: (r.height / 2 - v.y) / v.z }
  }

  /** 화면 중심을 고정한 채 배율만 바꾼다 */
  const zoomTo = (next: number, animate = true) => {
    const run = () => {
      const el = stageRef.current
      if (!el) return
      const v = viewRef.current
      const z = clamp(next, MIN_Z, MAX_Z)
      const k = z / v.z
      const r = el.getBoundingClientRect()
      const cx = r.width / 2
      const cy = r.height / 2
      setView({ z, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k })
    }
    if (animate) withWorldAnim(run)
    else run()
  }

  const zoomStep = (delta: number) => zoomTo(viewRef.current.z + delta)

  const zoomReset = () => {
    if (Math.abs(viewRef.current.z - 1) < 0.001) return
    zoomTo(1)
  }

  const toWorld = useCallback((cx: number, cy: number) => {
    const r = stageRef.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (cx - r.left - v.x) / v.z, y: (cy - r.top - v.y) / v.z }
  }, [])

  const insideStage = (cx: number, cy: number) => {
    const r = stageRef.current?.getBoundingClientRect()
    return !!r && cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom
  }

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
  const updatedOf = (it: Item) => (it.kind === 'doc' ? it.d.updatedAt : it.kind === 'app' ? it.a.updatedAt : it.f.updatedAt)

  const shortcuts = board.shortcuts
  const missing = shortcuts.filter((s) => !itemOf(s)).length

  const open = (sc: BoardShortcut) => {
    if (sc.kind === 'doc') return navigate({ name: 'editor', docId: sc.refId })
    if (sc.kind === 'app') return navigate({ name: 'app', appId: sc.refId })
    navigate({ name: 'file', fileId: sc.refId })
  }

  // ── 배치 조작 ──
  /** 바로가기 삭제 — 확인 없이 지우고 토스트로 되돌리기를 제공한다 (P9) */
  const removeShortcut = (sc: BoardShortcut, label?: string) => {
    commit((b) => ({ ...b, shortcuts: b.shortcuts.filter((s) => s.id !== sc.id) }))
    const nm = label ?? (itemOf(sc) ? (itemOf(sc)!.kind === 'file' ? (itemOf(sc) as { f: FileRow }).f.name : labelOf(itemOf(sc)!)) : '연결 끊긴 항목')
    toast(`‘${nm}’ 바로가기를 지웠습니다`, 'info', { label: '되돌리기', run: undo })
  }

  const addAt = (kind: ShortcutKind, refId: ID, wx: number, wy: number) => {
    if (boardRef.current.shortcuts.length >= BOARD_MAX_SHORTCUTS) {
      toast(`바로가기는 ${BOARD_MAX_SHORTCUTS}개까지 놓을 수 있습니다.`, 'error')
      return
    }
    const g = worldToGrid(wx, wy, boardRef.current.snap)
    commit((b) => ({ ...b, shortcuts: [...b.shortcuts, { id: newId(), kind, refId, ...g }] }))
  }

  /** 화면 중심에서 가장 가까운 빈 칸 (서랍의 ＋ 버튼) */
  const nearestEmptyCell = () => {
    const occ = new Set(boardRef.current.shortcuts.map((s) => `${Math.round(s.gx)},${Math.round(s.gy)}`))
    const c = centerWorld()
    const g0 = worldToGrid(c.x, c.y, true)
    for (let r = 0; r < 60; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
          const gx = g0.gx + dx
          const gy = g0.gy + dy
          if (!occ.has(`${gx},${gy}`)) return { gx, gy }
        }
      }
    }
    return g0
  }

  const placeFromPanel = (kind: ShortcutKind, refId: ID, label: string) => {
    if (boardRef.current.shortcuts.length >= BOARD_MAX_SHORTCUTS) {
      toast(`바로가기는 ${BOARD_MAX_SHORTCUTS}개까지 놓을 수 있습니다.`, 'error')
      return
    }
    const g = nearestEmptyCell()
    commit((b) => ({ ...b, shortcuts: [...b.shortcuts, { id: newId(), kind, refId, ...g }] }))
    toast(`"${label}"을(를) 보드에 놓았습니다.`, 'success')
  }

  /** 연결이 끊긴 바로가기에 새 항목을 이어 준다 — 자리는 그대로 (P8) */
  const relink = (sc: BoardShortcut, kind: ShortcutKind, refId: ID, label: string) => {
    commit((b) => ({ ...b, shortcuts: b.shortcuts.map((s) => (s.id === sc.id ? { ...s, kind, refId } : s)) }))
    toast(`"${label}"(으)로 다시 연결했습니다.`, 'success')
    setReconnectFor(null)
  }

  const dropPreviewAt = (cx: number, cy: number) => {
    if (!boardRef.current.snap || !insideStage(cx, cy)) {
      setDropCell(null)
      return
    }
    const w = toWorld(cx, cy)
    const g = worldToGrid(w.x, w.y, true)
    const busy = boardRef.current.shortcuts.some((s) => Math.round(s.gx) === g.gx && Math.round(s.gy) === g.gy)
    setDropCell({ ...g, busy })
  }

  /** 놓인 카드 조작 — 탭이면 열기. 편집 모드에서만 카드를 옮기고, 그 밖에는 화면 팬으로 이어진다 */
  const beginMove = (sc: BoardShortcut, e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    setWorldAnim(false)
    setGroupMenu(null)
    const canMove = edit
    const sx = e.clientX
    const sy = e.clientY
    let moving = false
    if (!canMove) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      armGesture()
    }
    const move = (ev: PointerEvent) => {
      if (!moving && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) moving = true
      if (!moving) return
      if (canMove) {
        setDragPos({ id: sc.id, ...toWorld(ev.clientX, ev.clientY) })
        dropPreviewAt(ev.clientX, ev.clientY)
      }
    }
    const up = (ev: PointerEvent) => {
      cleanup()
      if (!moving) {
        open(sc)
        return
      }
      if (!canMove) return
      const w = toWorld(ev.clientX, ev.clientY)
      const g = worldToGrid(w.x, w.y, boardRef.current.snap)
      commit((b) => ({ ...b, shortcuts: b.shortcuts.map((s) => (s.id === sc.id ? { ...s, ...g } : s)) }))
      setDragPos(null)
      setDropCell(null)
      setDroppedId(sc.id)
      if (dropTimer.current) clearTimeout(dropTimer.current)
      dropTimer.current = window.setTimeout(() => setDroppedId(null), 320)
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

  /** 서랍/패널의 행을 보드로 끌어다 놓기 */
  const beginCarry = (e: React.PointerEvent, kind: ShortcutKind, refId: ID, label: string) => {
    e.preventDefault()
    e.stopPropagation()
    setCarry({ kind, refId, label, x: e.clientX, y: e.clientY })
    const move = (ev: PointerEvent) => {
      setCarry((c) => (c ? { ...c, x: ev.clientX, y: ev.clientY } : c))
      dropPreviewAt(ev.clientX, ev.clientY)
    }
    const up = (ev: PointerEvent) => {
      cleanup()
      if (insideStage(ev.clientX, ev.clientY)) {
        const w = toWorld(ev.clientX, ev.clientY)
        addAt(kind, refId, w.x, w.y)
        toast(`"${label}"을(를) 보드에 놓았습니다.`, 'success')
      }
      setDropCell(null)
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
    commit((b) => ({ ...b, snap: true, shortcuts: b.shortcuts.map((s, i) => ({ ...s, ...pos[i] })) }))
    requestAnimationFrame(() => fit())
  }

  /** 보드의 모든 바로가기가 화면에 들어오게 맞춤 */
  const fit = () => {
    withWorldAnim(() => {
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
        minX = Math.min(minX, cellCenter(s.gx))
        maxX = Math.max(maxX, cellCenter(s.gx))
        minY = Math.min(minY, cellCenter(s.gy))
        maxY = Math.max(maxY, cellCenter(s.gy))
      }
      const w = maxX - minX + pad * 2
      const h = maxY - minY + pad * 2
      const z = clamp(Math.min(r.width / w, r.height / h), MIN_Z, 1.3)
      const cxw = (minX + maxX) / 2
      const cyw = (minY + maxY) / 2
      setView({ z, x: r.width / 2 - cxw * z, y: r.height / 2 - cyw * z })
    })
  }

  // ── 그룹 박스 (P6) ──
  const addGroup = async () => {
    const n = boardRef.current.groups.length
    if (n >= BOARD_MAX_GROUPS) {
      toast(`그룹은 ${BOARD_MAX_GROUPS}개까지 만들 수 있습니다.`, 'error')
      return
    }
    const c = centerWorld()
    const gw = 3
    const gh = 2
    const gx = Math.round(c.x / BOARD_CELL - gw / 2)
    const gy = Math.round(c.y / BOARD_CELL - gh / 2)
    const name = await promptDialog('새 그룹', {
      message: '보드 위에 그룹 박스를 놓습니다. 항목을 담지는 않고, 묶음을 시각적으로만 표시합니다.',
      value: `그룹 ${n + 1}`,
      ok: '만들기'
    })
    if (name === null) return
    const clean = name.trim().slice(0, BOARD_GROUP_NAME_MAX)
    commit((b) => ({
      ...b,
      groups: [...b.groups, { id: newId(), name: clean || `그룹 ${n + 1}`, gx, gy, gw, gh, tone: BOARD_GROUP_TONES[n % BOARD_GROUP_TONES.length] }]
    }))
    toast(clean ? `"${clean}" 그룹을 만들었습니다.` : '그룹을 만들었습니다.', 'success')
  }

  const renameGroup = async (g: BoardGroup) => {
    const name = await promptDialog('그룹 이름', { value: g.name, ok: '바꾸기' })
    if (name === null) return
    const clean = name.trim().slice(0, BOARD_GROUP_NAME_MAX)
    commit((b) => ({ ...b, groups: b.groups.map((x) => (x.id === g.id ? { ...x, name: clean || x.name } : x)) }))
    setGroupMenu(null)
  }

  const toneGroup = (g: BoardGroup, tone: string) => {
    commit((b) => ({ ...b, groups: b.groups.map((x) => (x.id === g.id ? { ...x, tone } : x)) }))
    setGroupMenu(null)
  }

  const removeGroup = (g: BoardGroup) => {
    commit((b) => ({ ...b, groups: b.groups.filter((x) => x.id !== g.id) }))
    setGroupMenu(null)
    toast(`"${g.name}" 그룹을 지웠습니다`, 'info', { label: '되돌리기', run: undo })
  }

  /** 편집 모드 — 그룹 헤더 띠를 잡아 옮긴다 (빈 곳은 보드 팬으로 넘긴다) */
  const beginGroupMove = (g: BoardGroup, e: React.PointerEvent<HTMLDivElement>) => {
    if (!edit) return
    e.stopPropagation()
    setWorldAnim(false)
    const sx = e.clientX
    const sy = e.clientY
    const z = viewRef.current.z
    const snap = boardRef.current.snap
    let moving = false
    let next: BoardGroup = { ...g }
    const move = (ev: PointerEvent) => {
      if (!moving && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) moving = true
      if (!moving) return
      const dx = (ev.clientX - sx) / z / BOARD_CELL
      const dy = (ev.clientY - sy) / z / BOARD_CELL
      next = {
        ...next,
        gx: snap ? Math.round(g.gx + dx) : +(g.gx + dx).toFixed(2),
        gy: snap ? Math.round(g.gy + dy) : +(g.gy + dy).toFixed(2)
      }
      setGroupLive({ ...next })
    }
    const up = () => {
      cleanup()
      if (moving) commit((b) => ({ ...b, groups: b.groups.map((x) => (x.id === g.id ? { ...x, gx: next.gx, gy: next.gy } : x)) }))
      setGroupLive(null)
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

  /** 편집 모드 — 오른쪽 아래 손잡이로 크기를 조절한다 */
  const beginGroupResize = (g: BoardGroup, e: React.PointerEvent<HTMLSpanElement>) => {
    e.stopPropagation()
    e.preventDefault()
    setWorldAnim(false)
    const sx = e.clientX
    const sy = e.clientY
    const z = viewRef.current.z
    const snap = boardRef.current.snap
    let next: BoardGroup = { ...g }
    const move = (ev: PointerEvent) => {
      const dw = (ev.clientX - sx) / z / BOARD_CELL
      const dh = (ev.clientY - sy) / z / BOARD_CELL
      const gw = clamp(snap ? Math.round(g.gw + dw) : +(g.gw + dw).toFixed(2), BOARD_GROUP_MIN_CELLS, BOARD_GROUP_MAX_CELLS)
      const gh = clamp(snap ? Math.round(g.gh + dh) : +(g.gh + dh).toFixed(2), BOARD_GROUP_MIN_CELLS, BOARD_GROUP_MAX_CELLS)
      next = { ...next, gw, gh }
      setGroupLive({ ...next })
    }
    const up = () => {
      cleanup()
      commit((b) => ({ ...b, groups: b.groups.map((x) => (x.id === g.id ? { ...x, gw: next.gw, gh: next.gh } : x)) }))
      setGroupLive(null)
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

  // ── 서랍/패널 목록 ──
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

  const collapsed = view.z <= GROUP_COLLAPSE_Z
  const groupedIds = useMemo(() => {
    const m = new Map<string, string>()
    for (const sc of shortcuts) {
      const cx = sc.gx + 0.5
      const cy = sc.gy + 0.5
      const g = board.groups.find((gr) => cx >= gr.gx && cx <= gr.gx + gr.gw && cy >= gr.gy && cy <= gr.gy + gr.gh)
      if (g) m.set(sc.id, g.id)
    }
    return m
  }, [shortcuts, board.groups])
  const groupCounts = useMemo(() => {
    const m = new Map<string, number>()
    groupedIds.forEach((gid) => m.set(gid, (m.get(gid) ?? 0) + 1))
    return m
  }, [groupedIds])

  // ── 격자 배경 (편집 모드에서만 보인다) ──
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

  const wide = stage.w >= WIDE_W

  // ── 미니맵 (P7) ──
  const mapColor = useCallback((name: string, fallback: string) => {
    const el = stageRef.current
    const v = el ? getComputedStyle(el).getPropertyValue(name).trim() : ''
    return v || fallback
  }, [])

  const drawMap = useCallback(() => {
    const cv = mapRef.current
    if (!cv) return
    const list = boardRef.current.shortcuts
    if (!list.length) return
    const W = cv.width
    const H = cv.height
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    cv.width = 136 * dpr
    cv.height = 88 * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, 136, 88)

    // 월드 바운딩 박스 + 현재 뷰포트
    const v = viewRef.current
    const st = stageSizeRef.current
    const vx0 = -v.x / v.z
    const vy0 = -v.y / v.z
    const vx1 = (st.w - v.x) / v.z
    const vy1 = (st.h - v.y) / v.z
    let x0 = Math.min(vx0, ...list.map((s) => cellCenter(s.gx)))
    let y0 = Math.min(vy0, ...list.map((s) => cellCenter(s.gy)))
    let x1 = Math.max(vx1, ...list.map((s) => cellCenter(s.gx)))
    let y1 = Math.max(vy1, ...list.map((s) => cellCenter(s.gy)))
    for (const g of boardRef.current.groups) {
      x0 = Math.min(x0, g.gx * BOARD_CELL)
      y0 = Math.min(y0, g.gy * BOARD_CELL)
      x1 = Math.max(x1, (g.gx + g.gw) * BOARD_CELL)
      y1 = Math.max(y1, (g.gy + g.gh) * BOARD_CELL)
    }
    const padX = (x1 - x0) * 0.08 + 20
    const padY = (y1 - y0) * 0.08 + 20
    x0 -= padX
    x1 += padX
    y0 -= padY
    y1 += padY
    const sc = Math.min(136 / (x1 - x0), 88 / (y1 - y0))
    const ox = (136 - (x1 - x0) * sc) / 2
    const oy = (88 - (y1 - y0) * sc) / 2
    const px = (wx: number) => ox + (wx - x0) * sc
    const py = (wy: number) => oy + (wy - y0) * sc

    // 그룹 면
    for (const g of boardRef.current.groups) {
      ctx.fillStyle = mapColor(TONE_VAR[g.tone] ?? '--accent', '#3355c8')
      ctx.globalAlpha = 0.15
      ctx.fillRect(px(g.gx * BOARD_CELL), py(g.gy * BOARD_CELL), g.gw * BOARD_CELL * sc, g.gh * BOARD_CELL * sc)
      ctx.globalAlpha = 1
    }
    // 뷰포트
    ctx.fillStyle = mapColor('--accent-soft-2', '#f1f4fd')
    ctx.globalAlpha = 0.5
    ctx.fillRect(px(vx0), py(vy0), (vx1 - vx0) * sc, (vy1 - vy0) * sc)
    ctx.globalAlpha = 1
    ctx.strokeStyle = mapColor('--accent', '#3355c8')
    ctx.lineWidth = 2
    ctx.strokeRect(px(vx0), py(vy0), (vx1 - vx0) * sc, (vy1 - vy0) * sc)
    // 바로가기 점
    for (const s of list) {
      const it = itemOf(s)
      const kind = it ? it.kind : 'missing'
      ctx.fillStyle =
        kind === 'app' ? mapColor('--app', '#5b4fc4') : kind === 'file' ? mapColor('--file', '#2f7a72') : mapColor('--muted-2', '#a49e92')
      ctx.beginPath()
      ctx.arc(px(cellCenter(s.gx)), py(cellCenter(s.gy)), 2, 0, Math.PI * 2)
      ctx.fill()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemOf, mapColor])

  useEffect(() => {
    if (mapRaf.current) cancelAnimationFrame(mapRaf.current)
    mapRaf.current = requestAnimationFrame(() => drawMap())
    return () => {
      if (mapRaf.current) cancelAnimationFrame(mapRaf.current)
    }
  }, [drawMap, board, view, stage, docs, apps, files])

  const mapPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = mapRef.current
    if (!cv) return null
    const r = cv.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }
  }
  const mapToWorld = (p: { x: number; y: number; w: number; h: number }) => {
    const list = boardRef.current.shortcuts
    if (!list.length) return null
    const v = viewRef.current
    const st = stageSizeRef.current
    const vx0 = -v.x / v.z
    const vy0 = -v.y / v.z
    const vx1 = (st.w - v.x) / v.z
    const vy1 = (st.h - v.y) / v.z
    let x0 = Math.min(vx0, ...list.map((s) => cellCenter(s.gx)))
    let y0 = Math.min(vy0, ...list.map((s) => cellCenter(s.gy)))
    let x1 = Math.max(vx1, ...list.map((s) => cellCenter(s.gx)))
    let y1 = Math.max(vy1, ...list.map((s) => cellCenter(s.gy)))
    for (const g of boardRef.current.groups) {
      x0 = Math.min(x0, g.gx * BOARD_CELL)
      y0 = Math.min(y0, g.gy * BOARD_CELL)
      x1 = Math.max(x1, (g.gx + g.gw) * BOARD_CELL)
      y1 = Math.max(y1, (g.gy + g.gh) * BOARD_CELL)
    }
    const padX = (x1 - x0) * 0.08 + 20
    const padY = (y1 - y0) * 0.08 + 20
    x0 -= padX
    x1 += padX
    y0 -= padY
    y1 += padY
    const sc = Math.min(136 / (x1 - x0), 88 / (y1 - y0))
    const ox = (136 - (x1 - x0) * sc) / 2
    const oy = (88 - (y1 - y0) * sc) / 2
    return { wx: (p.x - ox) / sc + x0, wy: (p.y - oy) / sc + y0 }
  }

  const mapJump = (e: React.PointerEvent<HTMLCanvasElement>, animate: boolean) => {
    const p = mapPointer(e)
    if (!p) return
    const w = mapToWorld(p)
    if (!w) return
    const el = stageRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const v = viewRef.current
    const apply = () => setView({ z: v.z, x: r.width / 2 - w.wx * v.z, y: r.height / 2 - w.wy * v.z })
    if (animate) withWorldAnim(apply)
    else apply()
  }

  // ── 프리셋 ──
  const savePreset = async () => {
    const name = await promptDialog('프리셋으로 저장', {
      value: presetName === '내 보드' ? `작업보드 ${new Date().getMonth() + 1}/${new Date().getDate()}` : presetName,
      ok: '저장'
    })
    if (!name?.trim()) return
    const p = await createPreset(name.trim(), board)
    const up = await uploadPreset(p.id)
    savedRef.current = JSON.stringify(board)
    setPresetName(p.name)
    toast(
      up ? `"${p.name}" 프리셋을 저장하고 Drive에 올렸습니다.` : `"${p.name}" 프리셋을 저장했습니다. 클라우드에는 나중에 올릴 수 있습니다.`,
      up ? 'success' : 'info'
    )
    setShowPresets(true)
  }

  const applyPreset = (p: BoardModel & { name: string }) => {
    pushHistory()
    const nb = normalizeBoard(p)
    setBoard(nb)
    savedRef.current = JSON.stringify(nb)
    setPresetName(p.name)
    toast(`"${p.name}" 프리셋을 불러왔습니다.`, 'success')
    requestAnimationFrame(() => fit())
  }

  const dirty = JSON.stringify(board) !== savedRef.current

  const removeAllMissing = async () => {
    if (!missing) return
    const ok = await confirmDialog('연결 끊긴 바로가기 지우기', {
      message: `연결이 끊긴 바로가기 ${missing}개를 보드에서 지웁니다. 실제 노트·파일은 그대로입니다.`,
      ok: '지우기',
      danger: true
    })
    if (!ok) return
    commit((b) => ({ ...b, shortcuts: b.shortcuts.filter((s) => itemOf(s)) }))
    toast(`연결 끊긴 바로가기 ${missing}개를 지웠습니다`, 'info', { label: '되돌리기', run: undo })
    setMoreMenu(false)
  }

  // ── 카드 얼굴 (P2) ──
  const kindIcon = (it: Item) => (it.kind === 'doc' ? (it.d.mode === 'infinite' ? 'infinite' : 'page') : it.kind === 'app' ? 'app' : 'file')

  const face = (it: Item) => {
    if (it.kind === 'doc') {
      const url = thumbs.get(it.d.id)
      if (url) return <span className="board-face has-photo"><img src={url} alt="" draggable={false} /></span>
      const infinite = it.d.mode === 'infinite'
      return (
        <span className={'board-face is-empty' + (infinite ? ' is-infinite' : '')}>
          <Icon name={infinite ? 'infinite' : 'page'} size={26} />
        </span>
      )
    }
    if (it.kind === 'app') {
      return (
        <span className="board-face is-app" style={{ background: gradient(it.a.title) }}>
          {it.a.title.slice(0, 1)}
        </span>
      )
    }
    const tone = fileTone(it.f.name)
    return (
      <span
        className="board-face is-file"
        style={{ background: `linear-gradient(160deg, color-mix(in srgb, var(${tone}) 85%, white), var(${tone}))` }}
      >
        <span className="board-file-ext">{extOf(it.f.name).toUpperCase().slice(0, 5) || 'FILE'}</span>
        <span className="board-file-fold" aria-hidden="true" />
      </span>
    )
  }

  const trayRow = (x: { key: string; kind: ShortcutKind; id: ID; label: string; at: number; at2?: number }) => {
    const n = placedKeys.get(x.key) ?? 0
    const url = x.kind === 'doc' ? thumbs.get(x.id) : undefined
    return (
      <div className={'tray-row kind-' + x.kind} key={x.key}>
        <span
          className="tray-row-grip"
          onPointerDown={(e) => beginCarry(e, x.kind, x.id, x.label)}
          title={`${x.label} — 보드로 끌어다 놓기`}
        >
          {url ? (
            <span className="tray-thumb" style={{ backgroundImage: `url(${url})` }} />
          ) : (
            <span className={'tray-thumb is-icon kind-' + x.kind}>
              <Icon name={x.kind === 'doc' ? 'page' : x.kind === 'app' ? 'app' : 'file'} size={18} />
            </span>
          )}
        </span>
        <span className="tray-row-main">
          <b className="tray-row-name">{x.label}</b>
          <span className="tray-row-time">{new Date(x.at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}</span>
        </span>
        {n ? (
          <span className="tray-row-placed">놓음 {n}</span>
        ) : (
          <button className="tray-row-add" onClick={() => placeFromPanel(x.kind, x.id, x.label)} aria-label={`${x.label} 보드에 놓기`}>
            <Icon name="plus" size={16} />
          </button>
        )}
      </div>
    )
  }

  // ── 서랍/패널 본문 ──
  const trayBody = (
    <>
      <div className="tray-tools">
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
        <span className="search-box board-tray-search">
          <Icon name="search" size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="제목으로 찾기" aria-label="카드 검색" />
        </span>
      </div>
      <div className="tray-list">
        {trayItems.length === 0 ? <span className="tray-none">카드가 없습니다</span> : trayItems.map(trayRow)}
      </div>
      <p className="hint">끌어서 원하는 칸에 놓거나 ＋를 누르세요</p>
    </>
  )

  return (
    <div className={'board board-wall-' + board.wallpaper + (edit ? ' is-editing' : '')} data-zoom={view.z < 0.55 ? 'far' : undefined}>
      {/* ── 상단 바 (P1: 3열 그리드) ── */}
      <header className="board-topbar">
        <div className="board-topbar-left">
          <button className="board-back" onClick={() => navigate({ name: 'library' })} aria-label="노트 목록으로">
            <Icon name="back" size={18} /> 노트
          </button>
          <h1 className="board-title">작업보드</h1>
          <button className="board-preset-chip" onClick={() => setShowPresets(true)} aria-label="프리셋 열기">
            <span className={'dot' + (dirty ? ' is-dirty' : '')} aria-hidden="true" />
            <span className="name">{presetName}</span>
            <Icon name="chevronDown" size={13} />
          </button>
        </div>
        <div className="board-topbar-center">
          <Segmented
            value={edit ? 'edit' : 'view'}
            options={[
              ['view', '보기'],
              ['edit', '편집']
            ]}
            onChange={(v) => {
              const on = v === 'edit'
              setEdit(on)
              if (on) setPanelOpen(true) // 편집을 켜면 카드 서랍(노트)을 바로 연다
            }}
            label="보기/편집 모드"
          />
        </div>
        <div className="board-topbar-right">
          <button className="tb-btn" onClick={() => setWallMenu((v) => !v)} aria-label="배경화면" title="배경화면">
            <Icon name="wallpaper" />
          </button>
          <button className={'tb-btn' + (moreMenu ? ' is-on' : '')} onClick={() => setMoreMenu((v) => !v)} aria-label="더보기" title="더보기">
            <Icon name="more" />
          </button>
        </div>
      </header>

      {/* ── 편집 툴바 (P3) ── */}
      {edit && (
        <div className={'board-edit-toolbar' + (wide && panelOpen ? ' with-panel' : '')} role="toolbar" aria-label="편집 도구">
          <button className="bet-btn" onClick={undo} disabled={!history.current.length} aria-label="되돌리기">
            <Icon name="undo" size={17} />
          </button>
          <button className="bet-btn" onClick={redo} disabled={!future.current.length} aria-label="다시">
            <Icon name="redo" size={17} />
          </button>
          <span className="bet-sep" />
          <button className={'bet-btn' + (board.snap ? ' is-on' : '')} onClick={() => commit((b) => ({ ...b, snap: !b.snap }))} aria-label="격자에 붙이기">
            <Icon name="grid" size={17} />
            <span>격자</span>
          </button>
          <button className="bet-btn" onClick={arrange} disabled={!shortcuts.length} aria-label="가지런히 정렬">
            <Icon name="blocks" size={17} />
            <span>정렬</span>
          </button>
          <button className="bet-btn" onClick={() => void addGroup()} aria-label="그룹 추가">
            <Icon name="folderPlus" size={17} />
            <span>그룹</span>
          </button>
          <button
            className={'bet-btn' + (panelOpen ? ' is-on' : '')}
            onClick={() => setPanelOpen((v) => !v)}
            aria-label="카드 서랍 — 노트·앱·파일"
          >
            <Icon name="page" size={17} />
            <span>서랍</span>
          </button>
          <span className="bet-sep" />
          <button className="primary-btn bet-done" onClick={() => setEdit(false)}>
            완료
          </button>
        </div>
      )}

      {/* 무한 사각 격자 무대 */}
      <div className="board-stage" ref={stageRef} onPointerDown={stageDown}>
        {/* 격자는 보기·편집 모두에서 보인다 */}
        <div className="board-grid" style={gridStyle} aria-hidden="true" />

        {shortcuts.length === 0 ? (
          <div className="board-empty">
            <Icon name="board" size={52} />
            <h2>작업보드가 비어 있습니다</h2>
            <p>
              위쪽 <b>편집</b>을 켜면 카드 서랍이 열립니다. 카드를 보드로 끌어다 놓으면 그 자리에 바로가기가 생기고, 놓인 카드도 편집
              중에만 옮길 수 있습니다. 빈 곳을 끌면 보드가 움직이고, 벌려서(핀치) 확대할 수 있습니다.
            </p>
            <button
              className="primary-btn"
              onClick={() => {
                setEdit(true)
                setPanelOpen(true)
              }}
            >
              <Icon name="plus" size={18} /> 편집 시작
            </button>
          </div>
        ) : null}

        <div
          className="board-world"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
            transition: worldAnim ? 'transform 260ms var(--ft-ease)' : 'none'
          }}
        >
          {/* 그룹 박스 */}
          {board.groups.map((g) => {
            const live = groupLive?.id === g.id ? groupLive : g
            const n = groupCounts.get(g.id) ?? 0
            const bigName = view.z < 1 ? (1 / view.z).toFixed(2) : '1'
            // 박스 상단이 무대 맨 위에 닿으면 위쪽 탭이 잘리므로 이름을 박스 안쪽 알약으로 띄운다
            const boxTop = live.gy * BOARD_CELL - (collapsed ? 0 : GROUP_HEAD_H)
            const labelInside = !collapsed && view.y + boxTop * view.z < 30 * view.z + 6
            return (
              <div
                key={g.id}
                className={
                  'board-group tone-' +
                  g.tone +
                  (collapsed ? ' is-collapsed' : '') +
                  (groupLive?.id === g.id ? ' is-dragging' : '') +
                  (groupMenu === g.id ? ' is-menu-open' : '') +
                  (labelInside ? ' is-label-inside' : '')
                }
                style={{
                  left: live.gx * BOARD_CELL,
                  /* 이름 칸까지 포함한 '박스 하나' — 위로 GROUP_HEAD_H 만큼 늘려 잡는다 */
                  top: live.gy * BOARD_CELL - (collapsed ? 0 : GROUP_HEAD_H),
                  width: live.gw * BOARD_CELL,
                  height: live.gh * BOARD_CELL + (collapsed ? 0 : GROUP_HEAD_H),
                  ['--tone' as string]: `var(${TONE_VAR[g.tone] ?? '--accent'})`
                }}
              >
                {collapsed ? (
                  <>
                    <span className="board-group-big-name">{g.name}</span>
                    {n ? <span className="board-group-big-count">항목 {n}개</span> : null}
                  </>
                ) : (
                  <div className="board-group-head" onPointerDown={(e) => beginGroupMove(g, e)}>
                    <b className="board-group-name" style={{ fontSize: `calc(var(--fs-sm) * ${bigName})` }}>
                      {g.name}
                    </b>
                    {n ? <span className="board-group-count">{n}</span> : null}
                    <button
                      className="board-group-more"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => setGroupMenu((v) => (v === g.id ? null : g.id))}
                      aria-label="그룹 메뉴"
                    >
                      <Icon name="more" size={14} />
                    </button>
                  </div>
                )}
                {groupMenu === g.id && (
                  <div className="board-group-menu" onPointerDown={(e) => e.stopPropagation()}>
                    <button onClick={() => void renameGroup(g)}>
                      <Icon name="edit" size={14} /> 이름 바꾸기
                    </button>
                    <div className="board-group-swatches">
                      {BOARD_GROUP_TONES.map((t) => (
                        <button
                          key={t}
                          className={'swatch' + (g.tone === t ? ' is-on' : '')}
                          style={{ background: `var(${TONE_VAR[t] ?? '--accent'})` }}
                          onClick={() => toneGroup(g, t)}
                          aria-label={`색 ${t}`}
                        />
                      ))}
                    </div>
                    <button className="danger" onClick={() => removeGroup(g)}>
                      <Icon name="trash" size={14} /> 그룹 지우기
                    </button>
                  </div>
                )}
                <span className="board-group-resize" onPointerDown={(e) => beginGroupResize(g, e)} aria-hidden="true" />
              </div>
            )
          })}

          {/* 놓일 칸 미리보기 (P4) */}
          {dropCell && (
            <span
              className={'board-drop' + (dropCell.busy ? ' is-busy' : '')}
              style={{
                left: dropCell.gx * BOARD_CELL,
                top: dropCell.gy * BOARD_CELL,
                width: BOARD_CELL,
                height: BOARD_CELL
              }}
              aria-hidden="true"
            />
          )}

          {/* 바로가기 카드 */}
          {shortcuts.map((sc) => {
            const it = itemOf(sc)
            if (collapsed && groupedIds.has(sc.id)) return null
            if (!it && hideMissing) return null
            const dragging = dragPos?.id === sc.id
            const wx = dragging ? dragPos!.x : cellCenter(sc.gx)
            const wy = dragging ? dragPos!.y : cellCenter(sc.gy)
            const off = dragging ? 0 : (stackIndex.get(sc.id) ?? 0) * 7
            const ix = wx + off
            const iy = wy + off
            // 모든 카드는 같은 크기 — 중심에서 멀어질수록 작아지던 초점 축소는 쓰지 않는다
            const tf = dragging ? `translate(-50%, -50%) scale(1.06) rotate(-3deg)` : 'translate(-50%, -50%)'
            return (
              <button
                key={sc.id}
                className={
                  'board-item kind-' + sc.kind + (dragging ? ' is-dragging' : '') + (it ? '' : ' is-missing') + (droppedId === sc.id ? ' is-drop' : '')
                }
                style={{ left: ix, top: iy, transform: tf }}
                onPointerDown={(e) => beginMove(sc, e)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  if (!it) return
                  void confirmDialog(`"${titleOf(it)}" 바로가기`, {
                    message: '이 바로가기를 보드에서 지웁니다. 실제 노트·파일은 그대로입니다.',
                    ok: '지우기',
                    danger: true
                  }).then((ok) => ok && removeShortcut(sc, titleOf(it)))
                }}
                title={it ? `${titleOf(it)} — 끌어서 옮기기` : '연결 끊김'}
              >
                {it ? (
                  <>
                    {face(it)}
                    <span className="board-kind">
                      <Icon name={kindIcon(it)} size={12} />
                    </span>
                    <span className="board-item-label">{titleOf(it)}</span>
                  </>
                ) : (
                  <>
                    <span className="board-face is-missing">
                      <span className="board-missing-text">연결 끊김</span>
                    </span>
                    <span className="board-relink">
                      <button
                        className="board-relink-btn"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => {
                          setReconnectFor(sc)
                          setEdit(true)
                          setPanelOpen(true)
                        }}
                      >
                        다시 연결
                      </button>
                    </span>
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
                      removeShortcut(sc, it ? titleOf(it) : undefined)
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

      {/* ── 미니맵 + 줌 HUD (P7) ── */}
      {shortcuts.length > 0 && (
        <div className="board-dock" style={{ bottom: wide && panelOpen ? 16 : undefined }}>
          <canvas
            ref={mapRef}
            className="board-minimap"
            width={136}
            height={88}
            onPointerDown={(e) => mapJump(e, false)}
            aria-label="미니맵"
          />
          <div className="board-hud">
            <button className="tb-btn" onClick={() => zoomStep(-ZOOM_STEP)} disabled={view.z <= MIN_Z} aria-label="축소 (10%)">
              <Icon name="minus" size={18} />
            </button>
            <button className="board-hud-zoom" onClick={zoomReset} aria-label="배율 100%로" title="눌러서 100%로">
              {Math.round(view.z * 100)}%
            </button>
            <button className="tb-btn" onClick={() => zoomStep(ZOOM_STEP)} disabled={view.z >= MAX_Z} aria-label="확대 (10%)">
              <Icon name="plus" size={18} />
            </button>
            <button className="tb-btn" onClick={fit} disabled={!shortcuts.length} aria-label="화면에 맞춤">
              <Icon name="fit" size={18} />
            </button>
          </div>
        </div>
      )}

      {/* ── 카드 서랍 (좁은 화면 = 아래 서랍 / 넓은 화면 = 오른쪽 패널) (P5) ── */}
      {edit && !wide && (
        <section className={'board-drawer' + (panelOpen ? ' is-open' : '')} aria-label="카드 서랍">
          <button className="board-drawer-head" onClick={() => setPanelOpen((v) => !v)} aria-expanded={panelOpen}>
            <Icon name={panelOpen ? 'chevronDown' : 'chevronRight'} size={16} />
            <b>{reconnectFor ? '다시 연결 — 대신 연결할 항목' : '카드 서랍'}</b>
            <span className="board-drawer-sub">
              노트 {docs.length} · 앱 {apps.length} · 파일 {files.length}
            </span>
            <span className="board-drawer-hint">카드를 보드로 끌어다 놓으세요</span>
          </button>
          {panelOpen && <div className="board-drawer-body">{trayBody}</div>}
        </section>
      )}

      {edit && wide && panelOpen && (
        <aside className={'tray-panel' + (reconnectFor ? ' is-relink' : '')} aria-label="카드 서랍">
          <div className="tray-panel-head">
            <b>{reconnectFor ? '다시 연결 — 대신 연결할 항목' : '카드 서랍'}</b>
            <button className="icon-mini" onClick={() => setPanelOpen(false)} aria-label="서랍 닫기">
              <Icon name="close" size={16} />
            </button>
          </div>
          {trayBody}
        </aside>
      )}

      {/* 서랍에서 끌고 있는 카드 고스트 */}
      {carry && (
        <div className="board-carry" style={{ left: carry.x, top: carry.y }} aria-hidden="true">
          <Icon name={carry.kind === 'doc' ? 'page' : carry.kind === 'app' ? 'app' : 'file'} size={18} />
          <span>{carry.label}</span>
        </div>
      )}

      {/* 배경화면 팝오버 */}
      {wallMenu && (
        <div className="board-pop" role="dialog" aria-label="배경화면">
          <div className="board-pop-title">배경화면</div>
          <div className="board-wall-list">
            {BOARD_WALLPAPERS.map((w) => (
              <button
                key={w.key}
                className={'board-wall-chip board-wall-' + w.key + (board.wallpaper === w.key ? ' is-on' : '')}
                onClick={() => commit((b) => ({ ...b, wallpaper: w.key }))}
              >
                <span className="board-wall-dot" aria-hidden="true" />
                {w.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ⋯ 메뉴 */}
      {moreMenu && (
        <div className="board-pop board-more" role="dialog" aria-label="더보기">
          <button className="board-pop-row" onClick={() => void savePreset()}>
            <Icon name="save" size={16} /> 현재 배치 저장
          </button>
          <button className="board-pop-row" onClick={() => setShowPresets(true)}>
            <Icon name="board" size={16} /> 프리셋 목록
          </button>
          <div className="board-pop-sep" />
          <button className="board-pop-row" onClick={() => setHideMissing((v) => !v)}>
            <Icon name={hideMissing ? 'eyeOff' : 'eye'} size={16} /> 연결 끊긴 바로가기 숨기기
            <b>{hideMissing ? '켬' : '끔'}</b>
          </button>
          <button className="board-pop-row" onClick={() => void removeAllMissing()} disabled={!missing}>
            <Icon name="trash" size={16} /> 연결 끊긴 바로가기 모두 지우기 ({missing})
          </button>
          <div className="board-pop-sep" />
          <button
            className="board-pop-row"
            onClick={async () => {
              setMoreMenu(false)
              const ok = await confirmDialog('보드 비우기', { message: '이 보드의 바로가기를 모두 없앱니다. 노트·앱·파일은 그대로입니다.', ok: '비우기', danger: true })
              if (ok) commit((b) => ({ ...b, shortcuts: [] }))
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
