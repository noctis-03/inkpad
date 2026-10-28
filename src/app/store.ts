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

// UI 상태만 관리한다. 문서 데이터는 Engine과 IndexedDB가 관리한다.
const LS_SETTINGS = 'inkpad.settings.v2'
const LS_STYLE = 'inkpad.style.v2'
const LS_LIBRARY = 'inkpad.library.v1'
const LS_TOOLBAR = 'inkpad.toolbar.v1'
const LS_BLOCKS = 'inkpad.blocks.v1'
const LS_TABS = 'inkpad.tabs.v1'

export type ToolbarPos = 'top' | 'top-left' | 'top-right' | 'bottom' | 'bottom-left' | 'bottom-right' | 'left' | 'right'
const TOOLBAR_POS: ToolbarPos[] = ['top', 'top-left', 'top-right', 'bottom', 'bottom-left', 'bottom-right', 'left', 'right']
const tb = load<{ pos: ToolbarPos; collapsed: boolean }>(LS_TOOLBAR, { pos: 'top', collapsed: false })
if (!TOOLBAR_POS.includes(tb.pos)) tb.pos = 'top'
const blocksLs = load<{ visible: boolean }>(LS_BLOCKS, { visible: true })

// 색과 이름은 한 줄에 함께 둔다 — 따로 두면 팔레트를 바꿀 때 이름만 남아 어긋난다
// (VoiceOver가 빨강 버튼을 "초록"으로 읽던 문제). 색을 바꾸면 이름도 같은 줄에서 바꾼다.
const PEN_PALETTE: [hex: string, name: string][] = [
  ['#1c1b19ff', '먹'],
  ['#1f3a7aff', '남색'],
  ['#2b5bd7ff', '파랑'],
  ['#c4302bff', '빨강'],
  ['#1f7a4dff', '초록'],
  ['#6a3fbfff', '보라'],
  ['#d0632bff', '주황'],
  ['#77736cff', '회색']
]
const HL_PALETTE: [hex: string, name: string][] = [
  ['#ffd84a66', '노랑'],
  ['#7ee08a66', '연두'],
  ['#7cc0ff66', '하늘'],
  ['#ff9cc866', '분홍'],
  ['#ffb36b66', '살구']
]
export const PEN_COLORS = PEN_PALETTE.map(([hex]) => hex)
export const HL_COLORS = HL_PALETTE.map(([hex]) => hex)
export const PEN_COLOR_NAMES = PEN_PALETTE.map(([, name]) => name)
export const HL_COLOR_NAMES = HL_PALETTE.map(([, name]) => name)

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
 * 예전 팔레트 색이 저장된 사용자를 위한 최근접 색 보정.
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

export type Route =
  | { name: 'library' }
  | { name: 'board' }
  | { name: 'editor'; docId: ID }
  | { name: 'app'; appId: ID }
  | { name: 'file'; fileId: ID }

/** 탭으로 열리는 화면 — 라이브러리·작업보드는 맨 앞 '홈' 탭이다 */
export type TabRoute = Extract<Route, { name: 'editor' | 'app' | 'file' }>
/** 옆 칸에 띄울 수 있는 화면 — 편집 화면은 상태(도구·선택·보기)를 앱 전체에 하나만 두므로 왼쪽(가운데)에만 */
export type SplitRoute = Extract<Route, { name: 'app' | 'file' }>

export const isTabRoute = (r: Route): r is TabRoute => r.name === 'editor' || r.name === 'app' || r.name === 'file'
/** 'doc:ID' · 'app:ID' · 'file:ID' — 탭·칸을 가리키는 열쇠 */
export const routeKey = (r: TabRoute) => (r.name === 'editor' ? `doc:${r.docId}` : r.name === 'app' ? `app:${r.appId}` : `file:${r.fileId}`)
const sameTab = (a: Route | null, b: Route | null) => !!a && !!b && isTabRoute(a) && isTabRoute(b) && routeKey(a) === routeKey(b)

interface TabsState {
  tabs: TabRoute[]
  split: SplitRoute | null
  /** 가운데 칸이 차지하는 비율 */
  splitRatio: number
  /** 옆 칸이 놓인 쪽 */
  splitSide: 'left' | 'right'
}
const SPLIT_MIN = 0.3
const SPLIT_MAX = 0.75
export const clampSplit = (r: number) => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, r))

/** 이 기기에만 저장 (동기화하지 않음). 망가진 값은 버린다 */
function loadTabs(): TabsState {
  const t = load<{ tabs?: unknown; split?: unknown; splitRatio?: unknown; splitSide?: unknown }>(LS_TABS, {})
  const ok = (r: unknown): r is TabRoute => {
    const x = r as TabRoute | null
    return !!x && ((x.name === 'editor' && typeof x.docId === 'string') || (x.name === 'app' && typeof x.appId === 'string') || (x.name === 'file' && typeof x.fileId === 'string'))
  }
  const tabs = Array.isArray(t.tabs) ? t.tabs.filter(ok) : []
  const split = ok(t.split) && t.split.name !== 'editor' && tabs.some((x) => sameTab(x, t.split as Route)) ? (t.split as SplitRoute) : null
  return { tabs, split, splitRatio: clampSplit(typeof t.splitRatio === 'number' ? t.splitRatio : 0.6), splitSide: t.splitSide === 'left' ? 'left' : 'right' }
}

/** 이미지로 보낼 곳 — { page: 0부터 } 또는 'selection'(올가미) */
export type SendImageTarget = { page: number } | 'selection'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error' | 'success'
  action?: { label: string; run: () => void }
  /** 자동으로 사라지지 않는다 (미리보기 생성 같은 진행 표시) — dismissToast로 직접 닫는다 */
  sticky?: boolean
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
  toolbarPos: ToolbarPos
  toolbarCollapsed: boolean
  blocksVisible: boolean
  placingBlock: BlockType | null
  selectedBlockId: ID | null
  /** 편집 화면을 닫을 때 — 라이브러리가 돌아온 이 카드에 settle 한다 */
  returnDocId: ID | null
  /** 뷰어보드 열기 — 편집 화면을 보기 전용으로 연다 (편집 화면이 1회 읽고 지운다) */
  viewOnly: boolean
  /** 낙서 모드로 열기 — 쓸 수 있지만 아무것도 저장하지 않는다 (편집 화면이 1회 읽고 지운다) */
  scratch: boolean
  /** 노트·앱·파일을 열기 전 화면 — 뒤로가기면 이 화면으로 돌아간다 (작업보드에서 열었으면 작업보드로) */
  returnRoute: Route | null
  /** 열린 탭 (노트·앱·파일). 지금 보는 탭은 route다 */
  tabs: TabRoute[]
  /** 옆 칸 (듀얼) — 탭 하나를 옆에 띄운다 */
  split: SplitRoute | null
  splitRatio: number
  splitSide: 'left' | 'right'
  /** 이미지로 보내기 창 (편집 화면이 그린다) — 페이지 하나, 또는 올가미로 고른 영역 */
  sendImage: SendImageTarget | null
  /** 마지막으로 본 홈 화면 (라이브러리 / 작업보드) — 홈 탭을 누르면 여기로 */
  home: Extract<Route, { name: 'library' | 'board' }>

  navigate: (r: Route) => void
  setTool: (t: Tool) => void
  toggleQuick: () => void
  setSettings: (p: Partial<Settings>) => void
  resetSettings: () => void
  setStyle: (s: ToolStyle) => void
  setLibrary: (p: Partial<LibraryPrefs>) => void
  setPanel: (p: UIState['panel']) => void
  setSidebar: (v: boolean) => void
  toast: (text: string, kind?: Toast['kind'], action?: Toast['action'], opts?: { sticky?: boolean }) => number
  dismissToast: (id: number) => void
  setToolbarPos: (p: ToolbarPos) => void
  setToolbarCollapsed: (v: boolean) => void
  setBlocksVisible: (v: boolean) => void
  setPlacingBlock: (t: BlockType | null) => void
  setSelectedBlockId: (id: ID | null) => void
  closeTab: (r: TabRoute) => void
  /** 화면 머리의 뒤로 — 지금 탭을 닫고 홈(라이브러리·작업보드)으로 */
  backHome: () => void
  closeOtherTabs: (r: TabRoute) => void
  /** 탭 순서 바꾸기 — r을 to 자리로 (탭 바에서 끌기·단축키) */
  moveTab: (r: TabRoute, to: number) => void
  /** 앱·파일을 옆 칸으로 — 가운데에는 그 전에 보던 화면이 온다 */
  openSplit: (r: SplitRoute) => void
  closeSplit: () => void
  setSplitRatio: (r: number) => void
  /** 좌우 바꾸기 — 옆 칸을 왼쪽↔오른쪽으로 (각 칸의 폭은 그대로) */
  swapSplit: () => void
}

let toastSeq = 0

function initialRoute(): Route {
  if (/^#\/board\/?$/.test(location.hash)) return { name: 'board' }
  const m = /^#\/doc\/([0-9A-Z]{26})$/.exec(location.hash)
  if (m) return { name: 'editor', docId: m[1] }
  const a = /^#\/app\/([0-9A-Z]{26})$/.exec(location.hash)
  if (a) return { name: 'app', appId: a[1] }
  const f = /^#\/file\/([0-9A-Z]{26})$/.exec(location.hash)
  if (f) return { name: 'file', fileId: f[1] }
  return { name: 'library' }
}

const firstRoute = initialRoute()
const firstTabs = loadTabs()
if (isTabRoute(firstRoute) && !firstTabs.tabs.some((t) => sameTab(t, firstRoute))) firstTabs.tabs.push(firstRoute)
if (sameTab(firstTabs.split, firstRoute)) firstTabs.split = null

/** 새 탭은 지금 보는 탭 바로 뒤에 (크롬처럼), 이미 있으면 그대로 */
function withTab(tabs: TabRoute[], r: Route, cur: Route): TabRoute[] {
  if (!isTabRoute(r) || tabs.some((t) => sameTab(t, r))) return tabs
  const at = tabs.findIndex((t) => sameTab(t, cur))
  return at < 0 ? [...tabs, r] : [...tabs.slice(0, at + 1), r, ...tabs.slice(at + 1)]
}

export const useUI = create<UIState>((set, get) => ({
  route: firstRoute,
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
  toolbarPos: tb.pos,
  toolbarCollapsed: tb.collapsed,
  blocksVisible: blocksLs.visible,
  placingBlock: null,
  selectedBlockId: null,
  returnDocId: null,
  viewOnly: false,
  scratch: false,
  returnRoute: null,
  tabs: firstTabs.tabs,
  split: firstTabs.split,
  splitRatio: firstTabs.splitRatio,
  splitSide: firstTabs.splitSide,
  sendImage: null,
  home: firstRoute.name === 'board' ? { name: 'board' } : { name: 'library' },

  navigate: (route) => {
    const hash =
      route.name === 'editor'
        ? `#/doc/${route.docId}`
        : route.name === 'app'
          ? `#/app/${route.appId}`
          : route.name === 'file'
            ? `#/file/${route.fileId}`
            : route.name === 'board'
              ? '#/board'
              : '#/'
    if (location.hash !== hash) history.pushState(null, '', hash)
    const prev = get().route
    const opens = route.name === 'editor' || route.name === 'app' || route.name === 'file'
    const { tabs, split } = get()
    set({
      route,
      panel: 'none',
      selection: null,
      sendImage: null,
      // 노트·앱·파일을 열 때는 열기 전 화면을 기억해 뒤로가기 때 돌아간다 (작업보드 → 노트 → 뒤로 = 작업보드)
      returnRoute: opens ? prev : null,
      tabs: withTab(tabs, route, prev),
      // 옆 칸에 있던 것을 가운데로 열면 칸을 닫는다 (같은 화면을 두 번 띄우지 않는다)
      split: sameTab(split, route) ? null : split,
      ...(route.name === 'library' || route.name === 'board' ? { home: route } : {})
    })
  },
  closeTab: (r) => {
    const { tabs, route, split, home } = get()
    const at = tabs.findIndex((t) => sameTab(t, r))
    if (at < 0) return
    const rest = tabs.filter((_, i) => i !== at)
    set({ tabs: rest, split: sameTab(split, r) ? null : split })
    // 보던 탭을 닫으면 오른쪽 이웃(없으면 왼쪽), 탭이 없으면 홈으로 — 옆 칸에 떠 있는 탭은 건너뛴다
    if (sameTab(route, r)) {
      const sp = get().split
      const pick = [...rest.slice(at), ...rest.slice(0, at).reverse()].find((t) => !sameTab(t, sp))
      get().navigate(pick ?? home)
    }
  },
  backHome: () => {
    const { route, tabs, split, home } = get()
    // 다른 탭으로 옮겨 가지 않는다(closeTab과 다르다) — 뒤로는 늘 홈. 옆 칸은 그대로 둔다
    if (isTabRoute(route)) set({ tabs: tabs.filter((t) => !sameTab(t, route)), split: sameTab(split, route) ? null : split })
    get().navigate(home)
  },
  moveTab: (r, to) => {
    const tabs = get().tabs
    const from = tabs.findIndex((t) => sameTab(t, r))
    const at = Math.max(0, Math.min(tabs.length - 1, to))
    if (from < 0 || at === from) return
    const next = tabs.filter((_, i) => i !== from)
    next.splice(at, 0, tabs[from])
    set({ tabs: next })
  },
  closeOtherTabs: (r) => {
    const { route, split } = get()
    set({ tabs: get().tabs.filter((t) => sameTab(t, r)), split: sameTab(split, r) ? split : null })
    if (isTabRoute(route) && !sameTab(route, r)) get().navigate(r)
  },
  openSplit: (r) => {
    const { route, returnRoute, tabs, home } = get()
    let tabsNext = withTab(tabs, r, route)
    if (sameTab(route, r)) {
      // 가운데에 있던 것을 옆으로 보낸다 — 가운데에는 그 전에 보던 화면(없으면 다른 탭, 그것도 없으면 홈)
      const back = returnRoute && !sameTab(returnRoute, r) ? returnRoute : tabsNext.find((t) => !sameTab(t, r)) ?? home
      if (isTabRoute(back)) tabsNext = withTab(tabsNext, back, route)
      set({ tabs: tabsNext, split: r })
      get().navigate(back)
      // 뒤로가기가 방금 옆으로 보낸 것을 다시 가운데로 끌어오지 않게
      set({ returnRoute: home })
    } else set({ tabs: tabsNext, split: r })
  },
  closeSplit: () => set({ split: null }),
  setSplitRatio: (r) => set({ splitRatio: clampSplit(r) }),
  swapSplit: () => set({ splitSide: get().splitSide === 'left' ? 'right' : 'left' }),
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
  toast: (text, kind = 'info', action, opts) => {
    const id = ++toastSeq
    set({ toasts: [...get().toasts, { id, text, kind, action, sticky: opts?.sticky }].slice(-3) })
    // sticky(진행 표시 등)는 직접 닫을 때까지 남는다
    if (!opts?.sticky) setTimeout(() => get().dismissToast(id), action ? 7000 : kind === 'error' ? 6000 : 3000)
    return id
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
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
  const { tabs, split } = useUI.getState()
  useUI.setState({
    route: next,
    tabs: withTab(tabs, next, prev),
    split: sameTab(split, next) ? null : split,
    ...(next.name === 'library' || next.name === 'board' ? { home: next } : {}),
    panel: 'none',
    // 뒤로가기로 편집 화면에서 나올 때도 닫기 전환을 위해 카드 id를 남긴다
    ...(prev.name === 'editor' && next.name === 'library' ? { returnDocId: prev.docId } : {})
  })
})

// 탭·옆 칸은 이 기기에만 기억한다 — 앱을 다시 켜면 그대로
useUI.subscribe((st, prev) => {
  if (st.tabs !== prev.tabs || st.split !== prev.split || st.splitRatio !== prev.splitRatio || st.splitSide !== prev.splitSide)
    save(LS_TABS, { tabs: st.tabs, split: st.split, splitRatio: st.splitRatio, splitSide: st.splitSide })
})
