import { create } from 'zustand'
import {
  DEFAULT_SETTINGS,
  type EngineStats,
  type Preset,
  type SelectionInfo,
  type Settings,
  type Tool,
  type ToolStyle,
  type ViewInfo
} from '../engine/types'
import type { SaveState } from '../engine/engine'
import type { ID } from '../shared/model'

// UI 상태만 관리한다. 문서 데이터는 Engine과 IndexedDB가 관리한다 (설계 3장).
const LS_SETTINGS = 'inkpad.settings.v2'
const LS_STYLE = 'inkpad.style.v2'
const LS_PRESETS = 'inkpad.presets.v1'
const LS_LIBRARY = 'inkpad.library.v1'

export const PEN_COLORS = ['#111827ff', '#2563ebff', '#dc2626ff', '#059669ff', '#7c3aedff', '#ea580cff', '#6b7280ff', '#db2777ff']
export const HL_COLORS = ['#facc1566', '#4ade8066', '#60a5fa66', '#f472b666', '#fb923c66']
export const PEN_WIDTHS = [1, 1.5, 2.5, 4, 6, 10]
export const HL_WIDTHS = [10, 16, 24]
export const ERASER_SIZES = [12, 24, 48]

const DEFAULT_STYLE: ToolStyle = {
  pen: { color: PEN_COLORS[0], width: PEN_WIDTHS[2] },
  highlighter: { color: HL_COLORS[0], width: HL_WIDTHS[1] },
  eraserSize: ERASER_SIZES[1]
}

// FR-TL-01: 프리셋 5개
const DEFAULT_PRESETS: Preset[] = [
  { tool: 'pen', color: '#111827ff', width: 2.5 },
  { tool: 'pen', color: '#2563ebff', width: 2.5 },
  { tool: 'pen', color: '#dc2626ff', width: 2.5 },
  { tool: 'pen', color: '#111827ff', width: 6 },
  { tool: 'highlighter', color: '#facc1566', width: 16 }
]

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

export type Route = { name: 'library' } | { name: 'editor'; docId: ID }

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
  presets: Preset[]
  activePreset: number | null
  library: LibraryPrefs
  stats: EngineStats | null
  view: ViewInfo
  selection: SelectionInfo | null
  saveState: SaveState
  panel: 'none' | 'settings' | 'sync' | 'page' | 'export' | 'debug' | 'history'
  sidebar: boolean
  toasts: Toast[]
  busy: { text: string; progress?: number } | null

  navigate: (r: Route) => void
  setTool: (t: Tool) => void
  toggleQuick: () => void
  setSettings: (p: Partial<Settings>) => void
  resetSettings: () => void
  setStyle: (s: ToolStyle) => void
  applyPreset: (i: number) => void
  savePreset: (i: number) => void
  setLibrary: (p: Partial<LibraryPrefs>) => void
  setPanel: (p: UIState['panel']) => void
  setSidebar: (v: boolean) => void
  toast: (text: string, kind?: Toast['kind'], action?: Toast['action']) => void
  dismissToast: (id: number) => void
  setBusy: (b: UIState['busy']) => void
}

let toastSeq = 0

function initialRoute(): Route {
  const m = /^#\/doc\/([0-9A-Z]{26})$/.exec(location.hash)
  return m ? { name: 'editor', docId: m[1] } : { name: 'library' }
}

export const useUI = create<UIState>((set, get) => ({
  route: initialRoute(),
  tool: 'pen',
  prevTool: 'eraser',
  settings: load(LS_SETTINGS, DEFAULT_SETTINGS),
  style: load(LS_STYLE, DEFAULT_STYLE),
  presets: load(LS_PRESETS, DEFAULT_PRESETS),
  activePreset: null,
  library: load<LibraryPrefs>(LS_LIBRARY, { view: 'grid', sort: 'updated' }),
  stats: null,
  view: { canUndo: false, canRedo: false, zoom: 1, currentPage: 0, pageCount: 1 },
  selection: null,
  saveState: 'saved',
  panel: 'none',
  sidebar: window.innerWidth >= 900,
  toasts: [],
  busy: null,

  navigate: (route) => {
    const hash = route.name === 'editor' ? `#/doc/${route.docId}` : '#/'
    if (location.hash !== hash) history.pushState(null, '', hash)
    set({ route, panel: 'none', selection: null })
  },
  setTool: (t) => {
    const cur = get().tool
    if (t !== cur) set({ tool: t, prevTool: cur })
    set({ activePreset: null })
  },
  toggleQuick: () => {
    const { tool, prevTool } = get()
    const next: Tool = tool === 'eraser' ? (prevTool === 'eraser' ? 'pen' : prevTool) : 'eraser'
    set({ tool: next, prevTool: tool, activePreset: null })
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
    set({ style, activePreset: null })
  },
  applyPreset: (i) => {
    const p = get().presets[i]
    if (!p) return
    const style = { ...get().style, [p.tool]: { color: p.color, width: p.width } }
    save(LS_STYLE, style)
    const cur = get().tool
    set({ style, tool: p.tool, prevTool: cur === p.tool ? get().prevTool : cur, activePreset: i })
  },
  savePreset: (i) => {
    const { tool, style } = get()
    if (tool !== 'pen' && tool !== 'highlighter') return
    const presets = [...get().presets]
    presets[i] = { tool, color: style[tool].color, width: style[tool].width }
    save(LS_PRESETS, presets)
    set({ presets, activePreset: i })
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
  setBusy: (busy) => set({ busy })
}))

window.addEventListener('popstate', () => {
  useUI.setState({ route: initialRoute(), panel: 'none' })
})
