// 작업보드 화면의 상수와 작은 도우미 — Board.tsx 본체(상태·이벤트·그리기)에서 떼어 냈다.
import { cloneBoard, DEFAULT_BOARD, normalizeBoard, type Board as BoardModel, type ShortcutKind } from '../../shared/board'
import { extOf } from '../../shared/model'

export const LS_BOARD = 'inkpad.board.v3'
export const LS_HIDE_MISSING = 'inkpad.board.hideMissing'
export const MIN_Z = 0.25
export const MAX_Z = 2
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

/** 그룹 박스 안쪽 맨 위 '이름 칸' 높이(px) — 박스 하나 안에 들어간다 */
export const GROUP_HEAD_H = 30
/** 이 배율 이하로 축소되면 그룹 안 항목은 숨고 그룹은 이름 타일로 접힌다 */
export const GROUP_COLLAPSE_Z = 0.5
/** 줌 버튼 한 번에 움직이는 배율 폭 (10%p) */
export const ZOOM_STEP = 0.1
/** 되돌리기 스택 최대 단계 */
export const UNDO_MAX = 50
/** 카드 서랍이 오른쪽 패널로 바뀌는 무대 폭 */
export const WIDE_W = 900
/** 서랍 카테고리 필터의 예약 키 — 실제 카테고리 이름과 겹치지 않게 */
export const CAT_ALL = '__all__'
export const CAT_NONE = '__none__'
/** 종류별 표시 이름 */
export const KIND_LABEL: Record<ShortcutKind, string> = { doc: '노트', app: '앱', file: '파일' }

export function loadBoard(): BoardModel {
  try {
    const raw = localStorage.getItem(LS_BOARD)
    if (raw) return normalizeBoard(JSON.parse(raw))
  } catch {
    /* 저장소 차단 환경 */
  }
  return cloneBoard(DEFAULT_BOARD)
}

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `s${Date.now()}${Math.random().toString(36).slice(2, 8)}`)

export function gradient(title: string) {
  let h = 0
  for (const ch of title) h = (h + ch.charCodeAt(0)) % 360
  return `linear-gradient(135deg, hsl(${h} 68% 62%), hsl(${(h + 42) % 360} 68% 44%))`
}

/** 파일 확장자 → 색 계열 토큰 */
const FILE_TONES: { tone: string; exts: string[] }[] = [
  { tone: '--danger', exts: ['pdf'] },
  { tone: '--success', exts: ['xlsx', 'xls', 'csv', 'numbers'] },
  { tone: '--warn', exts: ['pptx', 'ppt', 'key'] },
  { tone: '--app', exts: ['png', 'jpg', 'jpeg', 'heic', 'webp', 'gif'] }
]
export function fileTone(name: string): string {
  const e = extOf(name)
  for (const t of FILE_TONES) if (t.exts.includes(e)) return t.tone
  return '--file'
}
/** 그룹 톤 키 → 색 토큰 */
export const TONE_VAR: Record<string, string> = { blue: '--accent', green: '--success', violet: '--app', amber: '--warn' }
/** 카테고리 표식 색 — 이름이 같으면 늘 같은 색이 나오게 (서랍 카테고리 머리의 작은 네모) */
const CAT_TONES = ['--accent', '--success', '--app', '--warn']
export function catTone(name: string) {
  let h = 0
  for (const ch of name) h = (h + ch.charCodeAt(0) * 7) % 997
  return CAT_TONES[h % CAT_TONES.length]
}
