import { create } from 'zustand'
import {
  DEFAULT_SETTINGS,
  type EngineStats,
  type SelectionInfo,
  type Settings,
  type Tool,
  type ToolStyle,
  type ViewInfo
} from '../engine/types'
import type { SaveState } from '../engine/engine'
import type { BlockType, ID } from '../shared/model'

// UI 상태만 관리한다. 문서 데이터는 Engine과 IndexedDB가 관리한다 (설계 3장).
const LS_SETTINGS = 'inkpad.settings.v2'
const LS_STYLE = 'inkpad.style.v2'
const LS_LIBRARY = 'inkpad.library.v1'
const LS_TOOLBAR = 'inkpad.toolbar.v1'
const LS_BLOCKS = 'inkpad.blocks.v1'

export type ToolbarPos = 'top' | 'top-left' | 'top-right' | 'bottom' | 'bottom-left' | 'bottom-right' | 'left' | 'right'
const TOOLBAR_POS: ToolbarPos[] = ['top', 'top-left', 'top-right', 'bottom', 'bottom-left', 'bottom-right', 'left', 'right']
const tb = load<{ pos: ToolbarPos; collapsed: boolean }>(LS_TOOLBAR, { pos: 'top', collapsed: false })
if (!TOOLBAR_POS.includes(tb.pos)) tb.pos = 'top'
const blocksLs = load<{ visible: boolean }>(LS_BLOCKS, { visible: true })

export const PEN_COLORS = ['#1c1b19ff', '#1f3a7aff', '#2b5bd7ff', '#c4302bff', '#1f7a4dff', '#6a3fbfff', '#d0632bff', '#77736cff']
export const HL_COLORS = ['#ffd84a66', '#7ee08a66', '#7cc0ff66', '#ff9cc866', '#ffb36b66']
export const PEN_COLOR_NAMES = ['먹', '파랑', '빨강', '초록', '보라', '주황', '회색', '분홍']
export const HL_COLOR_NAMES = ['노랑', '연두', '하늘', '분홍', '살구']

/** 마지막 글자의 받침에 따라 '로/으로' 조사를 붙인다 ("파랑으로") */
export const ro = (name: string) => {
  const code = name.charCodeAt(name.length - 1)
  const hasFinal = code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 > 0
  return `${name}${hasFinal ? '으로' : '로'}`
}

export const PEN_WIDTHS = [1, 1.5, 2.5, 4, 6, 10]
export const HL_WIDTHS = [10, 16, 24]
export const ERASER_SIZES = [12, 24, 48]

const DEFAULT_STYLE: ToolStyle = {
  pen: { color: PEN_COLORS[0], width: PEN_WIDTHS[2] },
  highlighter: { color: HL_COLORS[0], width: HL_WIDTHS[1] },
  eraserSize: ERASER_SIZES[1]
}

/**
 * 예전 팔레트 색이 저장된 사용자를 위한 최근접 색 보정 (D-1).
 * localStorage(inkpad.style.v2)의 선택색이 새 팔레트에 없으면 선택 표시가 사라지므로
 * 가장 가까운 새 색으로 옮긴다. 이미 그린 획의 색은 그대로다.
 */
function nearestOf(hex: string, palette: string[]): string {
  const ch = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16)
  const r = ch(hex, 1)
  const g = ch(hex, 3)
  const b = ch(hex, 5)
  let best = palette[0]
  let bd = Infinity
  for (const c of palette) {
    const d = (r - ch(c, 1)) ** 2 + (g - ch(c, 3)) ** 2 + (b - ch(c, 5)) ** 2
    if (d < bd) {
      bd = d
      best = c
    }
  }
  return best
}

const loadedStyle = load<ToolStyle>(LS_STYLE, DEFAULT_STYLE)
const initialStyle: ToolStyle = {
  ...loadedStyle,
  pen: { ...loadedStyle.pen, color: PEN_COLORS.includes(loadedStyle.pen.color) ? loadedStyle.pen.color : nearestOf(loadedStyle.pen.color, PEN_COLORS) },
  highlighter: {
    ...loadedStyle.highlighter,
    color: HL_COLORS.includes(loadedStyle.highlighter.color) ? loadedStyle.highlighter.color : nearestOf(loadedStyle.highlighter.color, HL_COLORS)
  }
}

function load<T>(key: string, def: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const v = JSON.parse(raw)
      return Array.isArray(def) ? (v as T) : ({ ...def, ...v } as T)
    }
  } catch {
    /* ignore */
  }
  return def
}

const save = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* 저장 공간 부족 등 */
  }
}

export interface LibraryPrefs {
  view: 'grid' | 'list'
  sort: 'updated' | 'created' | 'title'
}

export type Route = { name: 'library' } | { name: 'editor'; docId: ID } | { name: 'app'; appId: ID } | { name: 'file'; fileId: ID }

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error' | 'success'
  action?: { label: string; run: () => void }
}

interface UIState {
  route: Route
  tool: Tool
  prevTool: Tool
  settings: Settings
  style: ToolStyle
  library: LibraryPrefs
  stats: EngineStats | null
  view: ViewInfo
  selection: SelectionInfo | null
  saveState: SaveState
  panel: 'none' | 'settings' | 'sync' | 'page' | 'export' | 'debug' | 'history'
  sidebar: boolean
  toasts: Toast[]
  busy: { text: string; progress?: number } | null
  toolbarPos: ToolbarPos
  toolbarCollapsed: boolean
  blocksVisible: boolean
  placingBlock: BlockType | null
  selectedBlockId: ID | null
  /** 노트 열기 애니메이션용 — 누른 카드의 화면 위치 (편집 화면 마운트 시 1회 읽고 지운다) */
  docCardRect: DOMRect | null
  /** 편집 화면을 닫을 때 — 라이브러리 복귀 전환이 이 카드로 축소한다 (모션 5.6) */
  returnDocId: ID | null

  navigate: (r: Route) => void
  setTool: (t: Tool) => void
  toggleQuick: () => void
  setSettings: (p: Partial<Settings>) => void
  resetSettings: () => void
  setStyle: (s: ToolStyle) => void
  setLibrary: (p: Partial<LibraryPrefs>) => void
  setPanel: (p: UIState['panel']) => void
  setSidebar: (v: boolean) => void
  toast: (text: string, kind?: Toast['kind'], action?: Toast['action']) => void
  dismissToast: (id: number) => void
  setBusy: (b: UIState['busy']) => void
  setToolbarPos: (p: ToolbarPos) => void
  setToolbarCollapsed: (v: boolean) => void
  setBlocksVisible: (v: boolean) => void
  setPlacingBlock: (t: BlockType | null) => void
  setSelectedBlockId: (id: ID | null) => void
}

let toastSeq = 0

function initialRoute(): Route {
  const m = /^#\/doc\/([0-9A-Z]{26})$/.exec(location.hash)
  if (m) return { name: 'editor', docId: m[1] }
  const a = /^#\/app\/([0-9A-Z]{26})$/.exec(location.hash)
  if (a) return { name: 'app', appId: a[1] }
  const f = /^#\/file\/([0-9A-Z]{26})$/.exec(location.hash)
  if (f) return { name: 'file', fileId: f[1] }
  return { name: 'library' }
}

export const useUI = create<UIState>((set, get) => ({
  route: initialRoute(),
  tool: 'pen',
  prevTool: 'eraser',
  settings: load(LS_SETTINGS, DEFAULT_SETTINGS),
  style: initialStyle,
  library: load<LibraryPrefs>(LS_LIBRARY, { view: 'grid', sort: 'updated' }),
  stats: null,
  view: { canUndo: false, canRedo: false, zoom: 1, currentPage: 0, pageCount: 1 },
  selection: null,
  saveState: 'saved',
  panel: 'none',
  sidebar: window.innerWidth >= 900,
  toasts: [],
  busy: null,
  toolbarPos: tb.pos,
  toolbarCollapsed: tb.collapsed,
  blocksVisible: blocksLs.visible,
  placingBlock: null,
  selectedBlockId: null,
  docCardRect: null,
  returnDocId: null,

  navigate: (route) => {
    const hash = route.name === 'editor' ? `#/doc/${route.docId}` : route.name === 'app' ? `#/app/${route.appId}` : route.name === 'file' ? `#/file/${route.fileId}` : '#/'
    if (location.hash !== hash) history.pushState(null, '', hash)
    set({ route, panel: 'none', selection: null })
  },
  setTool: (t) => {
    const cur = get().tool
    if (t !== cur) set({ tool: t, prevTool: cur })
  },
  toggleQuick: () => {
    const { tool, prevTool } = get()
    const next: Tool = tool === 'eraser' ? (prevTool === 'eraser' ? 'pen' : prevTool) : 'eraser'
    set({ tool: next, prevTool: tool })
  },
  setSettings: (p) => {
    const settings = { ...get().settings, ...p }
    save(LS_SETTINGS, settings)
    set({ settings })
  },
  resetSettings: () => {
    const keep = { pressureCapability: get().settings.pressureCapability }
    const settings = { ...DEFAULT_SETTINGS, ...keep }
    save(LS_SETTINGS, settings)
    set({ settings })
  },
  setStyle: (style) => {
    save(LS_STYLE, style)
    set({ style })
  },
  setLibrary: (p) => {
    const library = { ...get().library, ...p }
    save(LS_LIBRARY, library)
    set({ library })
  },
  setPanel: (panel) => set({ panel: get().panel === panel ? 'none' : panel }),
  setSidebar: (sidebar) => set({ sidebar }),
  toast: (text, kind = 'info', action) => {
    const id = ++toastSeq
    set({ toasts: [...get().toasts, { id, text, kind, action }].slice(-3) })
    setTimeout(() => get().dismissToast(id), action ? 7000 : kind === 'error' ? 6000 : 3000)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setBusy: (busy) => set({ busy }),
  setToolbarPos: (toolbarPos) => {
    save(LS_TOOLBAR, { pos: toolbarPos, collapsed: get().toolbarCollapsed })
    set({ toolbarPos })
  },
  setToolbarCollapsed: (toolbarCollapsed) => {
    save(LS_TOOLBAR, { pos: get().toolbarPos, collapsed: toolbarCollapsed })
    set({ toolbarCollapsed })
  },
  setBlocksVisible: (visible) => {
    save(LS_BLOCKS, { visible })
    set(visible ? { blocksVisible: visible } : { blocksVisible: visible, placingBlock: null, selectedBlockId: null })
  },
  setPlacingBlock: (placingBlock) => set({ placingBlock }),
  setSelectedBlockId: (selectedBlockId) => set({ selectedBlockId })
}))

window.addEventListener('popstate', () => {
  const prev = useUI.getState().route
  const next = initialRoute()
  useUI.setState({
    route: next,
    panel: 'none',
    // 뒤로가기로 편집 화면에서 나올 때도 닫기 전환을 위해 카드 id를 남긴다 (모션 5.6)
    ...(prev.name === 'editor' && next.name === 'library' ? { returnDocId: prev.docId } : {})
  })
})
