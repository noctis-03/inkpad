// 편집 블록 전용 헬퍼와 블록 저장소.
// 블록은 Element 청크와 절대 섞이지 않는다(PDF 내보내기 제외 규칙) — 이 모듈과 blocks 테이블만이 블록을 안다.
import { BLOCK_DEFAULT_W, BLOCK_MAX_OUTSIDE, BLOCK_SCHEMA_VERSION, type Block, type BlockType, type ID } from '../shared/model'
import { ulid } from '../shared/ulid'
import type { Layout } from './layout'

/** 블록이 소속된 페이지의 원점(월드 좌표). infinite 모드는 월드 원점이 곧 기준점. */
export function blockOrigin(layout: Layout, pageId: ID): { ox: number; oy: number } {
  if (!layout.paged) return { ox: 0, oy: 0 }
  const r = layout.rects.get(pageId)
  return r ? { ox: r.x, oy: r.y } : { ox: 0, oy: 0 }
}

export const blockWorldPos = (layout: Layout, b: Block) => {
  const { ox, oy } = blockOrigin(layout, b.pageId)
  return { x: b.x + ox, y: b.y + oy }
}

/**
 * 월드 좌표의 블록 왼쪽 위 → 소속 페이지 + 상대 좌표.
 * 블록 중심점을 기준으로 layout.pageNear()로 소속 페이지를 다시 정하고,
 * paged 모드에서는 페이지 사각형에서 BLOCK_MAX_OUTSIDE(pt)를 넘지 않게 clamp한다 (infinite는 clamp 없음).
 */
export function anchorBlock(layout: Layout, wx: number, wy: number, w: number, h: number): { pageId: ID; x: number; y: number } | null {
  if (!layout.paged) {
    const page = layout.pages[0]
    if (!page) return null
    return { pageId: page.id, x: wx, y: wy }
  }
  const page = layout.pageNear(wx + w / 2, wy + h / 2)
  if (!page) return null
  const r = layout.rects.get(page.id)
  if (!r) return null
  const minX = r.x - BLOCK_MAX_OUTSIDE
  const minY = r.y - BLOCK_MAX_OUTSIDE
  const maxX = r.x + r.w + BLOCK_MAX_OUTSIDE - w
  const maxY = r.y + r.h + BLOCK_MAX_OUTSIDE - h
  const x = Math.min(Math.max(wx, Math.min(minX, maxX)), Math.max(minX, maxX))
  const y = Math.min(Math.max(wy, Math.min(minY, maxY)), Math.max(minY, maxY))
  // Block.x/y는 소속 페이지 원점 기준 상대 좌표다 — clamp한 월드 좌표에서 페이지 원점을 빼서 돌려준다.
  return { pageId: page.id, x: x - r.x, y: y - r.y }
}

// ───────── 링크 URL 보안 (6.4) ─────────

/** 실행·저장을 허용하는 스킴. 그 외(javascript:, data: 등)는 저장 자체를 거부한다 */
const SAFE_URL_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:']

/**
 * 링크 URL 정규화. 스킴이 없으면 https://를 붙이고, 안전한 스킴만 통과시킨다.
 * 통과하면 정규화된 URL, 비어 있으면 ''(빈 값 허용), 위험한 스킴이면 null을 반환한다.
 * 직접 입력·.inkpad 가져오기·동기화로 들어온 블록 모두 이 함수를 거쳐야 한다.
 */
export function normalizeBlockUrl(raw: string): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const u = new URL(withScheme)
    if (!SAFE_URL_SCHEMES.includes(u.protocol)) return null
    return u.href
  } catch {
    return null
  }
}

/** 실행(탭) 직전에 한 번 더 검증한다 — window.open에 절대 위험 스킴을 넘기지 않는다 */
export function isSafeBlockUrl(url: string): boolean {
  const normalized = normalizeBlockUrl(url)
  return !!normalized && normalized === url.trim()
}

// ───────── 블록 레지스트리 (팔레트·헤더 라벨 공용) ─────────

export const BLOCK_META: Record<BlockType, { label: string; desc: string; icon: string; color: string }> = {
  memo: { label: '메모', desc: '짧은 글을 적어 둡니다', icon: 'memo', color: '#fef3c7' },
  link: { label: '링크', desc: '웹사이트로 바로 갑니다', icon: 'link', color: '#dbeafe' },
  todo: { label: '할 일', desc: '체크 목록을 만듭니다', icon: 'todo', color: '#d1fae5' },
  timer: { label: '타이머', desc: '시간을 재고 알려 줍니다', icon: 'timer', color: '#fce7f3' },
  jump: { label: '페이지 이동', desc: '다른 페이지로 건너뜁니다', icon: 'jump', color: '#ede9fe' }
}

export const MEMO_BG: Record<import('../shared/model').MemoColor, string> = {
  yellow: '#fef3c7',
  pink: '#fce7f3',
  blue: '#dbeafe',
  green: '#d1fae5'
}

/** 배치 모드에서 새 블록 하나를 만든다. 높이는 내용에 따라 정해지므로 저장하지 않는다 */
export function createBlock(type: BlockType, documentId: ID, pageId: ID, x: number, y: number, z: number): Block {
  const now = Date.now()
  const base = {
    id: ulid(),
    documentId,
    pageId,
    schemaVersion: BLOCK_SCHEMA_VERSION,
    x,
    y,
    w: BLOCK_DEFAULT_W[type],
    z,
    createdAt: now,
    updatedAt: now
  }
  switch (type) {
    case 'memo':
      return { ...base, type: 'memo', data: { text: '', color: 'yellow', collapsed: false } }
    case 'link':
      return { ...base, type: 'link', data: { url: '', label: '' } }
    case 'todo':
      return { ...base, type: 'todo', data: { items: [] } }
    case 'timer':
      return { ...base, type: 'timer', data: { durationSec: 300 } }
    case 'jump':
      return { ...base, type: 'jump', data: { targetPageId: null } }
  }
}

/** 복제 시 todo 항목 id를 새로 발급한다(원본과 항목 id가 겹치지 않도록) */
export function refreshBlockIds(b: Block): Block {
  if (b.type !== 'todo') return b
  return { ...b, data: { ...b.data, items: b.data.items.map((it) => ({ ...it, id: ulid() })) } }
}

/**
 * 엔진이 소유한 블록 저장소. Undo/Redo(Command.blocks)와 저장(dirty 집계)은 엔진이 담당하고
 * 여기서는 현재 값과 구독(React useSyncExternalStore)만 관리한다.
 */
export class BlockStore {
  private map = new Map<ID, Block>()
  private listeners = new Set<() => void>()
  private heights = new Map<ID, number>()
  private snapshotCache: Block[] = []

  load(list: Block[]): void {
    this.map.clear()
    this.heights.clear()
    for (const b of list) this.map.set(b.id, b)
    this.emit()
  }

  get(id: ID): Block | undefined {
    return this.map.get(id)
  }

  /** z 오름차순. useSyncExternalStore의 getSnapshot으로 쓰므로 바뀌지 않는 한 같은 배열을 돌려준다 */
  list(): Block[] {
    return this.snapshotCache
  }

  ofPage(pageId: ID): Block[] {
    return this.list().filter((b) => b.pageId === pageId)
  }

  /** 전체 블록의 월드 좌표 합집합 bounds. 높이는 UI가 보고한 측정값을 쓴다 */
  bounds(layout: Layout): { minX: number; minY: number; maxX: number; maxY: number } | null {
    let out: { minX: number; minY: number; maxX: number; maxY: number } | null = null
    for (const b of this.map.values()) {
      if (b.deletedAt) continue
      const { ox, oy } = blockOrigin(layout, b.pageId)
      const h = this.heights.get(b.id) ?? 72
      const minX = b.x + ox
      const minY = b.y + oy
      if (!out) out = { minX, minY, maxX: minX + b.w, maxY: minY + h }
      else {
        out.minX = Math.min(out.minX, minX)
        out.minY = Math.min(out.minY, minY)
        out.maxX = Math.max(out.maxX, minX + b.w)
        out.maxY = Math.max(out.maxY, minY + h)
      }
    }
    return out
  }

  /** 저장하지 않는 런타임 값 — 화면에 그린 블록의 실제 높이 */
  setMeasuredHeight(id: ID, h: number): void {
    if (h > 0 && this.heights.get(id) !== h) this.heights.set(id, h)
  }

  measuredHeight(id: ID): number {
    return this.heights.get(id) ?? 0
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** 내부 전용: Command 적용 시에만 호출 */
  _put(b: Block): void {
    this.map.set(b.id, b)
    this.emit()
  }

  /** 내부 전용: Command 적용 시에만 호출 */
  _remove(id: ID): void {
    this.map.delete(id)
    this.heights.delete(id)
    this.emit()
  }

  /** 내부 전용: 페이지 배치 재계산처럼 값이 아니라 좌표 기준이 바뀌었을 때 UI만 다시 그린다 */
  _notify(): void {
    this.emit()
  }

  private emit() {
    this.snapshotCache = [...this.map.values()].sort((a, b) => a.z - b.z)
    for (const fn of [...this.listeners]) fn()
  }
}
