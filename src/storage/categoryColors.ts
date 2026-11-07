// 사용자가 고른 카테고리 색 — 이 기기 DB(settings 표의 'categoryColors' 한 줄)와 화면 반영.
// 색을 고치면 pending 표식이 붙고 CATCOLORS_EVENT가 난다 — sync/categoryColors가 그 파일 하나만 바로 올린다.
// 읽은 값은 shared/util의 색 배정(setCategoryColorOverrides)에 넣는다 — 라이브러리·일정·동기화 화면이 같은 색을 쓴다.
import { useSyncExternalStore } from 'react'
import { mergeCatColors, overridesOf, sameCatColors, withCatColor, type CatColorMap } from '../shared/categoryColors'
import { colorLabel, setCategoryColorOverrides } from '../shared/util'
import { db } from './db'

const KEY = 'categoryColors'
/** 이 기기에서 색을 고쳤다 — sync/categoryColors가 듣고 올린다 */
export const CATCOLORS_EVENT = 'inkpad-catcolors-edited'

export interface CatColorRow {
  entries: CatColorMap
  /** 이 기기에서 고친 뒤 아직 올리지 않았다 */
  pending?: boolean
}

export async function readCategoryColors(): Promise<CatColorRow> {
  const row = await db.settings.get(KEY)
  const v = row?.value as CatColorRow | undefined
  return { entries: v?.entries ?? {}, ...(v?.pending ? { pending: true } : {}) }
}

// ───────── 화면 반영 ─────────

let version = 0
const listeners = new Set<() => void>()

function apply(entries: CatColorMap) {
  setCategoryColorOverrides(overridesOf(entries))
  version++
  for (const l of listeners) l()
}

/** 앱 시작 때 한 번 — DB의 색을 화면 배정에 넣는다 */
export async function initCategoryColors() {
  apply((await readCategoryColors()).entries)
}

/** 색이 바뀔 때마다 늘어나는 번호 — 색 배정을 useMemo로 잡아 두는 화면이 의존성에 넣는다 */
export function useCategoryColorVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => version
  )
}

// ───────── 고치기 ─────────

/** 카테고리(의 색 이름)에 색을 고른다. null이면 자동 배정으로 되돌린다. 같은 [태그]의 카테고리는 모두 바뀐다 */
export async function setCategoryColor(category: string, color: string | null): Promise<void> {
  const key = colorLabel(category)
  if (!key) return
  const entries = await db.transaction('rw', db.settings, async () => {
    const cur = await readCategoryColors()
    const next = withCatColor(cur.entries, key, color, Math.max(Date.now(), (cur.entries[key]?.ts ?? 0) + 1))
    await db.settings.put({ key: KEY, value: { entries: next, pending: true } satisfies CatColorRow })
    return next
  })
  apply(entries)
  // 올리기는 사용자가 고친 이때만 — 앱을 열거나 받아 합칠 때는 네트워크를 쓰지 않는다 (sync.ts 규칙 12)
  window.dispatchEvent(new Event(CATCOLORS_EVENT))
}

/**
 * 받은 색을 합쳐 저장한다 (sync/categoryColors) — 트랜잭션 안에서 지금 값과 합치므로 그 사이에 고친 것도 남는다.
 * sent를 주면 '방금 올린 내용'이다 — 지금 값이 그대로면 pending을 뗀다.
 */
export async function storeMergedCategoryColors(remote: CatColorMap | null, sent?: CatColorMap): Promise<CatColorRow> {
  const { row, changed } = await db.transaction('rw', db.settings, async () => {
    const cur = await readCategoryColors()
    const entries = remote ? mergeCatColors(cur.entries, remote) : cur.entries
    const pending = sent ? !sameCatColors(entries, sent) : !!cur.pending || (!!remote && !sameCatColors(entries, remote))
    const row: CatColorRow = { entries, ...(pending ? { pending: true } : {}) }
    await db.settings.put({ key: KEY, value: row })
    return { row, changed: !sameCatColors(cur.entries, entries) }
  })
  if (changed) apply(row.entries)
  return row
}
