// 작업보드(Work Board) — 노트·앱·파일을 배경화면 위에 '그리드 시각화'로 보여 주는 보드.
// 바로가기(자유 배치) 개념은 없다. 보드는 설정 한 벌만 갖고, 그 설정을 프리셋으로 저장해 Drive로 공유한다.
import type { ID } from './model'

export type BoardVisual = 'grid' | 'hex'
export type BoardSize = 'sm' | 'md' | 'lg'
export type BoardSort = 'updated' | 'created' | 'title'
export type BoardFilter = 'all' | 'docs' | 'apps' | 'files'

/** 보드 설정 — 배경화면 + 시각화 방식 (Drive 프리셋에 담기는 전부) */
export interface Board {
  /** BOARD_WALLPAPERS 의 key */
  wallpaper: string
  /** 시각화 형태: 격자 / 벌집 */
  visual: BoardVisual
  /** 카드(타일) 크기 */
  size: BoardSize
  /** 정렬 */
  sort: BoardSort
  /** 표시할 항목 */
  filter: BoardFilter
}

/** 보드 설정 요약값 — 타입만 뽑은 것 (프리셋·클라우드 메타에 쓴다) */
export type BoardCfg = Pick<Board, 'wallpaper' | 'visual' | 'size' | 'sort' | 'filter'>

/** Drive로 주고받는 프리셋 (보드 설정 한 벌 + 이름) */
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

export const DEFAULT_BOARD: Board = { wallpaper: 'mist', visual: 'grid', size: 'md', sort: 'updated', filter: 'all' }

/** 배경화면 목록 — 실제 CSS는 styles.css 의 .board-wall-<key> (라이트/다크 각각) */
export const BOARD_WALLPAPERS: { key: string; name: string }[] = [
  { key: 'mist', name: '안개' },
  { key: 'dawn', name: '새벽' },
  { key: 'forest', name: '숲' },
  { key: 'dusk', name: '황혼' },
  { key: 'ink', name: '먹' },
  { key: 'paper', name: '종이' }
]

export const BOARD_VISUALS: { key: BoardVisual; name: string }[] = [
  { key: 'grid', name: '격자' },
  { key: 'hex', name: '벌집' }
]
export const BOARD_SIZES: { key: BoardSize; name: string }[] = [
  { key: 'sm', name: '작게' },
  { key: 'md', name: '보통' },
  { key: 'lg', name: '크게' }
]
export const BOARD_SORTS: { key: BoardSort; name: string }[] = [
  { key: 'updated', name: '수정일' },
  { key: 'created', name: '만든 날' },
  { key: 'title', name: '제목' }
]
export const BOARD_FILTERS: { key: BoardFilter; name: string }[] = [
  { key: 'all', name: '전체' },
  { key: 'docs', name: '노트' },
  { key: 'apps', name: '앱' },
  { key: 'files', name: '파일' }
]

const nameOf = <T extends string>(list: { key: T; name: string }[], key: unknown, fallback: T): T =>
  list.some((x) => x.key === key) ? (key as T) : fallback
const labelOf = <T extends string>(list: { key: T; name: string }[], key: unknown, fallback: string) =>
  list.find((x) => x.key === key)?.name ?? fallback

/**
 * 클라우드·localStorage에서 읽은 값을 안전한 보드 설정으로 정리한다.
 * 모르는 값은 기본값으로 떨어뜨린다 — 남의 기기 프리셋이 화면을 깨뜨리지 않게.
 */
export function normalizeBoard(raw: unknown): Board {
  const src = (raw ?? {}) as Partial<BoardCfg>
  return {
    wallpaper: typeof src.wallpaper === 'string' && BOARD_WALLPAPERS.some((w) => w.key === src.wallpaper) ? src.wallpaper : DEFAULT_BOARD.wallpaper,
    visual: nameOf(BOARD_VISUALS, src.visual, DEFAULT_BOARD.visual),
    size: nameOf(BOARD_SIZES, src.size, DEFAULT_BOARD.size),
    sort: nameOf(BOARD_SORTS, src.sort, DEFAULT_BOARD.sort),
    filter: nameOf(BOARD_FILTERS, src.filter, DEFAULT_BOARD.filter)
  }
}

export const cloneBoard = (b: Board): Board => normalizeBoard(b)

/** 설정 → 짧은 문자열 (`mist|grid|md|updated|all`) — Drive appProperties 124바이트 제한 안에 넉넉히 들어간다 */
export const cfgOf = (c: BoardCfg) => [c.wallpaper, c.visual, c.size, c.sort, c.filter].join('|')

/** 위 문자열을 다시 보드 설정으로 (모르는 값은 기본값) */
export function parseCfg(cfg?: string): Board {
  if (!cfg) return cloneBoard(DEFAULT_BOARD)
  const [wallpaper, visual, size, sort, filter] = cfg.split('|')
  return normalizeBoard({ wallpaper, visual, size, sort, filter } as BoardCfg)
}

/** 사람이 읽는 설정 요약 — 프리셋 카드 부제 */
export const cfgSummary = (c: BoardCfg) => {
  const b = normalizeBoard(c)
  return [
    labelOf(BOARD_VISUALS, b.visual, '격자'),
    labelOf(BOARD_SIZES, b.size, '보통'),
    labelOf(BOARD_SORTS, b.sort, '수정일'),
    labelOf(BOARD_FILTERS, b.filter, '전체'),
    labelOf(BOARD_WALLPAPERS, b.wallpaper, '안개')
  ].join(' · ')
}

// ───────── 벌집(허니컴) 좌표 ─────────
// 벌집 시각화의 배치 계산. 가운데가 가장 크고 바깥으로 갈수록 작아진다(애플 워치 앱 보관소 느낌).

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

/** 중심에서 바깥으로 도는 벌집 좌표 count개 */
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
