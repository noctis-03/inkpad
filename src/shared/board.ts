// 작업보드(Work Board) 데이터 모델.
// 보드 = 윈도우 배경화면처럼 깔리는 판 + 그 위에 사용자가 배치한 '바로가기'(실제 파일이 아니라 위치 정보).
// 바로가기 배열(위치 포함)이 곧 사용자화 결과이고, 이것을 프리셋으로 저장해 Drive로 공유한다.
import type { ID } from './model'

export type ShortcutKind = 'doc' | 'app' | 'file'

/** 바로가기 하나 — 어떤 항목을(kind+refId) 보드 어디에(x,y) 두었는지 */
export interface BoardShortcut {
  /** 바로가기 자체의 id (같은 항목을 여러 번 놓을 수 있다) */
  id: string
  kind: ShortcutKind
  /** 문서 · 앱 · 기타 파일의 id */
  refId: ID
  /** 보드 기준 정규화 좌표 (0..1) — 타일 중심 */
  x: number
  y: number
}

/** 보드 한 장의 상태 (배경 + 배치) */
export interface Board {
  /** BOARD_WALLPAPERS 의 key */
  wallpaper: string
  /** 벌집(허니컴) 격자에 스냅할지 */
  snap: boolean
  shortcuts: BoardShortcut[]
}

/** Drive로 주고받는 프리셋 (보드 한 장 + 이름) */
export interface BoardPreset {
  id: ID
  name: string
  wallpaper: string
  snap: boolean
  shortcuts: BoardShortcut[]
  createdAt: number
  updatedAt: number
  /** 클라우드 상태 — 앱·기타 파일과 같은 규칙 (sync/board.ts) */
  fileId?: string
  pending?: 'upsert' | 'delete'
  cloudDetachedAt?: number
}

export const BOARD_PRESET_NAME_MAX = 40
export const BOARD_MAX_SHORTCUTS = 120

export const DEFAULT_BOARD: Board = { wallpaper: 'mist', snap: false, shortcuts: [] }

/** 배경화면 목록 — 실제 CSS는 styles.css 의 .board-wall-<key> (라이트/다크 각각) */
export const BOARD_WALLPAPERS: { key: string; name: string }[] = [
  { key: 'mist', name: '안개' },
  { key: 'dawn', name: '새벽' },
  { key: 'forest', name: '숲' },
  { key: 'dusk', name: '황혼' },
  { key: 'ink', name: '먹' },
  { key: 'paper', name: '종이' }
]

export const isWallpaper = (k: string) => BOARD_WALLPAPERS.some((w) => w.key === k)

export const shortcutKey = (kind: ShortcutKind, refId: ID) => `${kind}:${refId}`

const KINDS: ShortcutKind[] = ['doc', 'app', 'file']
const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5)

/**
 * 클라우드에서 받은 값(또는 오래된 로컬 값)을 안전한 보드로 정리한다.
 * 좌표 범위·kind·길이를 모두 방어한다 — 남의 기기 프리셋이 화면을 깨뜨리지 않게.
 */
export function normalizeBoard(raw: unknown): Board {
  const src = (raw ?? {}) as Partial<Board> & { shortcuts?: unknown }
  const wallpaper = typeof src.wallpaper === 'string' && isWallpaper(src.wallpaper) ? src.wallpaper : DEFAULT_BOARD.wallpaper
  const snap = src.snap === true
  const list = Array.isArray(src.shortcuts) ? src.shortcuts : []
  const shortcuts: BoardShortcut[] = []
  for (const item of list as BoardShortcut[]) {
    if (!item || !KINDS.includes(item.kind) || typeof item.refId !== 'string' || !item.refId) continue
    shortcuts.push({
      id: typeof item.id === 'string' && item.id ? item.id : shortcutKey(item.kind, item.refId),
      kind: item.kind,
      refId: item.refId,
      x: clamp01(Number(item.x)),
      y: clamp01(Number(item.y))
    })
    if (shortcuts.length >= BOARD_MAX_SHORTCUTS) break
  }
  return { wallpaper, snap, shortcuts }
}

export const cloneBoard = (b: Board): Board => normalizeBoard(JSON.parse(JSON.stringify(b)))

// ───────── 벌집(허니컴) 배치 ─────────
// 애플 워치 앱 그리드와 보드 스냅이 같은 계산을 쓴다 (pointy-top axial).

export interface HexPos {
  q: number
  r: number
  x: number
  y: number
}

export const hexToPixel = (q: number, r: number, cell: number) => ({
  x: cell * Math.sqrt(3) * (q + r / 2),
  y: cell * 1.5 * r
})

function hexRound(q: number, r: number) {
  const x = q
  const z = r
  const y = -x - z
  let rx = Math.round(x)
  let ry = Math.round(y)
  let rz = Math.round(z)
  const dx = Math.abs(rx - x)
  const dy = Math.abs(ry - y)
  const dz = Math.abs(rz - z)
  if (dx > dy && dx > dz) rx = -ry - rz
  else if (dy > dz) ry = -rx - rz
  else rz = -rx - ry
  return { q: rx, r: rz }
}

/** 픽셀 → 가장 가까운 벌집 칸 (보드 스냅용) */
export function pixelToHex(x: number, y: number, cell: number) {
  return hexRound(((Math.sqrt(3) / 3) * x - y / 3) / cell, ((2 / 3) * y) / cell)
}

/** 중심에서 바깥으로 도는 벌집 좌표 count개 (애플 워치 그리드·스냅 격자 공용) */
export function hexSpiral(count: number, cell: number): HexPos[] {
  const out: HexPos[] = []
  if (count <= 0) return out
  const push = (q: number, r: number) => out.push({ q, r, ...hexToPixel(q, r, cell) })
  push(0, 0)
  const dirs: [number, number][] = [
    [1, 0],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [0, -1],
    [1, -1]
  ]
  for (let ring = 1; out.length < count; ring++) {
    let q = -ring
    let r = ring
    for (let d = 0; d < 6 && out.length < count; d++) {
      for (let i = 0; i < ring && out.length < count; i++) {
        push(q, r)
        q += dirs[d][0]
        r += dirs[d][1]
      }
    }
  }
  return out
}
