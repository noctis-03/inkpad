// 사용자가 고른 카테고리 색 — 화면·DB와 떨어진 순수 함수 (storage/categoryColors·sync/categoryColors가 쓰고
// tools/verify/category-color-test.ts가 검사한다).
// 색은 노트가 아니라 '색 이름'(util.colorLabel — [태그]가 있으면 태그) 단위로 둔다. 노트에는 카테고리 이름만 있으므로
// 색을 바꿔도 노트는 다시 올리지 않는다 — Drive에는 작은 JSON 하나(Inkpad/category-colors.json)만 오간다.
// 두 기기가 따로 고쳤으면 색 이름마다 나중에 고친 쪽을 남긴다(할 일 합치기와 같은 규칙). 자동으로 되돌리기는
// color: null로 남겨(지운 표식) 다른 기기의 옛 값이 되살아나지 않게 한다.

/** 색 이름 하나의 값 — color가 null이면 '자동 배정으로 되돌림' */
export interface CatColorEntry {
  color: string | null
  /** 고친 시각 (ms) */
  ts: number
}
export type CatColorMap = Record<string, CatColorEntry>

/** Drive 파일 이름 (Inkpad/ 바로 아래) */
export const CATEGORY_COLOR_FILE = 'category-colors.json'

export interface CatColorFileV1 {
  kind: 'inkpad-category-colors'
  v: 1
  entries: CatColorMap
}

const HEX = /^#[0-9a-f]{6}$/

/** 두 값 중 남길 것 — 나중에 고친 쪽, 같은 시각이면 값으로 정해 어느 기기에서 합쳐도 같다 */
function pick(a: CatColorEntry, b: CatColorEntry): CatColorEntry {
  if (a.ts !== b.ts) return a.ts > b.ts ? a : b
  return (a.color ?? '') >= (b.color ?? '') ? a : b
}

export function mergeCatColors(a: CatColorMap, b: CatColorMap): CatColorMap {
  const out: CatColorMap = {}
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k]
    const y = b[k]
    out[k] = x && y ? pick(x, y) : (x ?? y)
  }
  return out
}

/** 키 순서와 상관없이 내용이 같은가 */
export function sameCatColors(a: CatColorMap, b: CatColorMap): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => b[k] && b[k].color === a[k].color && b[k].ts === a[k].ts)
}

/** 색 하나를 고친 결과 (원본은 그대로) */
export function withCatColor(m: CatColorMap, key: string, color: string | null, ts: number): CatColorMap {
  return { ...m, [key]: { color: color && HEX.test(color.toLowerCase()) ? color.toLowerCase() : null, ts } }
}

/** 화면에 쓸 색 — 자동으로 되돌린 것(null)은 뺀다 */
export function overridesOf(m: CatColorMap): Map<string, string> {
  const out = new Map<string, string>()
  for (const [k, e] of Object.entries(m)) if (e.color) out.set(k, e.color)
  return out
}

export const toCatColorFile = (entries: CatColorMap): CatColorFileV1 => ({ kind: 'inkpad-category-colors', v: 1, entries })

/** 받은 파일을 읽는다 — 형식이 다르면 null, 이상한 칸은 버린다 */
export function fromCatColorFile(raw: unknown): CatColorMap | null {
  const f = raw as Partial<CatColorFileV1> | null
  if (!f || f.kind !== 'inkpad-category-colors' || typeof f.entries !== 'object' || !f.entries) return null
  const out: CatColorMap = {}
  for (const [k, e] of Object.entries(f.entries)) {
    if (!k || !e || typeof e.ts !== 'number' || !Number.isFinite(e.ts)) continue
    const color = typeof e.color === 'string' && HEX.test(e.color.toLowerCase()) ? e.color.toLowerCase() : null
    out[k] = { color, ts: e.ts }
  }
  return out
}
