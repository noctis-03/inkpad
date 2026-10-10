// 작업보드(Work Board) 데이터 모델.
// 보드는 무한히 펼쳐지는 사각 격자 공간이다. 노트·앱·파일의 '바로가기'를 원하는 칸에 놓아 사용자화한다.
// 바로가기 = 어떤 항목(kind+refId)을 어느 칸(gx,gy)에 두었는가. 이 배치가 프리셋으로 Drive에 공유된다.
import type { ID } from './model'

export type ShortcutKind = 'doc' | 'app' | 'file'

/** 월드 격자 한 칸의 크기(px) — 카드 한 장이 한 칸에 앉는다 */
export const BOARD_CELL = 128

/** 바로가기 하나 — 항목과 격자 좌표. gx/gy 는 칸 단위(정수면 칸에 딱 맞고, 소수면 칸 안에서 살짝 어긋난 위치) */
export interface BoardShortcut {
  id: string
  kind: ShortcutKind
  refId: ID
  gx: number
  gy: number
}

/** 그룹 박스 — 항목을 '담지' 않고, 묶음을 시각적으로만 표시하는 사각형. 이름을 붙일 수 있다 */
export interface BoardGroup {
  id: string
  name: string
  /** 좌상단 칸 좌표 */
  gx: number
  gy: number
  /** 칸 단위 크기 */
  gw: number
  gh: number
  /** 색상 키 — BOARD_GROUP_TONES */
  tone: string
}

/** 보드 한 장의 상태 */
export interface Board {
  /** BOARD_WALLPAPERS 의 key */
  wallpaper: string
  /** 격자에 붙여 놓기 */
  snap: boolean
  shortcuts: BoardShortcut[]
  /** 그룹 박스 — 묶음을 시각적으로 표시 (안에 담지는 않는다) */
  groups: BoardGroup[]
}

/** Drive로 주고받는 프리셋 (보드 한 장 + 이름) */
export interface BoardPreset extends Board {
  id: ID
  name: string
  createdAt: number
  updatedAt: number
  /** 클라우드 상태 — 앱·기타 파일과 같은 규칙 (sync/board.ts) */
  fileId?: string
  pending?: 'upsert' | 'delete'
  cloudDetachedAt?: number
}

export const BOARD_PRESET_NAME_MAX = 40
export const BOARD_MAX_SHORTCUTS = 400
export const BOARD_GROUP_NAME_MAX = 24
export const BOARD_MAX_GROUPS = 60
/** 그룹 박스 색 키 — 실제 CSS는 .board-group.tone-<key> */
export const BOARD_GROUP_TONES: string[] = ['blue', 'green', 'violet', 'amber']
export const BOARD_GROUP_MIN_CELLS = 2
export const BOARD_GROUP_MAX_CELLS = 40

export const DEFAULT_BOARD: Board = { wallpaper: 'mist', snap: true, shortcuts: [], groups: [] }

/** 배경화면 목록 — 실제 CSS는 styles.css 의 .board-wall-<key> (라이트/다크 각각) */
export const BOARD_WALLPAPERS: { key: string; name: string }[] = [
  { key: 'mist', name: '안개' },
  { key: 'dawn', name: '새벽' },
  { key: 'forest', name: '숲' },
  { key: 'dusk', name: '황혼' },
  { key: 'ink', name: '먹' },
  { key: 'paper', name: '종이' }
]

export const isWallpaper = (k: unknown): k is string => typeof k === 'string' && BOARD_WALLPAPERS.some((w) => w.key === k)

const KINDS: ShortcutKind[] = ['doc', 'app', 'file']
const LIMIT = 100000
const coord = (v: unknown) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.min(LIMIT, Math.max(-LIMIT, n))
}
const TONES = new Set<string>(BOARD_GROUP_TONES)
const groupSize = (v: unknown) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return BOARD_GROUP_MIN_CELLS
  return Math.min(BOARD_GROUP_MAX_CELLS, Math.max(BOARD_GROUP_MIN_CELLS, n))
}

/**
 * 클라우드·localStorage에서 읽은 값을 안전한 보드로 정리한다.
 * 종류·좌표·개수를 모두 방어한다 — 남의 기기 프리셋이 화면을 깨뜨리지 않게.
 */
export function normalizeBoard(raw: unknown): Board {
  const src = (raw ?? {}) as Partial<Board> & { shortcuts?: unknown; groups?: unknown }
  const list = Array.isArray(src.shortcuts) ? src.shortcuts : []
  const shortcuts: BoardShortcut[] = []
  for (const item of list as BoardShortcut[]) {
    if (!item || !KINDS.includes(item.kind) || typeof item.refId !== 'string' || !item.refId) continue
    shortcuts.push({
      id: typeof item.id === 'string' && item.id ? item.id : `${item.kind}:${item.refId}`,
      kind: item.kind,
      refId: item.refId,
      gx: coord(item.gx),
      gy: coord(item.gy)
    })
    if (shortcuts.length >= BOARD_MAX_SHORTCUTS) break
  }
  const rawGroups = Array.isArray(src.groups) ? src.groups : []
  const groups: BoardGroup[] = []
  for (const item of rawGroups as BoardGroup[]) {
    if (!item || typeof item !== 'object') continue
    const nm = typeof item.name === 'string' ? item.name.trim().slice(0, BOARD_GROUP_NAME_MAX) : ''
    groups.push({
      id: typeof item.id === 'string' && item.id ? item.id : `g:${groups.length}`,
      name: nm || `그룹 ${groups.length + 1}`,
      gx: coord(item.gx),
      gy: coord(item.gy),
      gw: groupSize(item.gw),
      gh: groupSize(item.gh),
      tone: TONES.has(item.tone) ? item.tone : BOARD_GROUP_TONES[0]
    })
    if (groups.length >= BOARD_MAX_GROUPS) break
  }
  return { wallpaper: isWallpaper(src.wallpaper) ? src.wallpaper : DEFAULT_BOARD.wallpaper, snap: src.snap !== false, shortcuts, groups }
}

export const cloneBoard = (b: Board): Board => normalizeBoard(b)

/** 항목의 칸 중심 월드 좌표 (px) */
export const cellCenter = (g: number) => (g + 0.5) * BOARD_CELL

/** 월드 좌표 → 칸 좌표. snap 이면 정수 칸으로 */
export function worldToGrid(wx: number, wy: number, snap: boolean) {
  const gx = wx / BOARD_CELL - 0.5
  const gy = wy / BOARD_CELL - 0.5
  return snap ? { gx: Math.round(gx), gy: Math.round(gy) } : { gx: +gx.toFixed(2), gy: +gy.toFixed(2) }
}

/** 지금 배치를 가운데 원점 기준 정사각 격자로 정렬 — 아이폰 앱 정렬처럼 가지런히 */
export function packGrid(n: number) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)))
  const rows = Math.max(1, Math.ceil(n / cols))
  return Array.from({ length: n }, (_, i) => ({
    gx: (i % cols) - (cols - 1) / 2,
    gy: Math.floor(i / cols) - (rows - 1) / 2
  }))
}
