// 최근 열람한 노트 — 노트를 열 때마다 이 기기에만 기록한다 (동기화하지 않는다)
const KEY = 'inkpad.recentDocs.v1'
const MAX = 30

export interface RecentDoc {
  id: string
  at: number
}

export function loadRecentDocs(): RecentDoc[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(v)) return []
    return v.filter(
      (e): e is RecentDoc => !!e && typeof e === 'object' && typeof (e as RecentDoc).id === 'string' && typeof (e as RecentDoc).at === 'number'
    )
  } catch {
    return []
  }
}

/** 노트를 열 때 기록한다 — 최신이 앞쪽. 중복은 제거하고 최대 MAX개만 남긴다 */
export function trackRecentDoc(id: string) {
  try {
    const list = loadRecentDocs().filter((e) => e.id !== id)
    list.unshift({ id, at: Date.now() })
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)))
  } catch {
    /* 저장 공간 부족 등 */
  }
}
