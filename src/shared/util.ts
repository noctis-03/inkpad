export function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

/** 카드 책등 색 팔레트 — 상태 색(파랑·호박·초록)과 어울리는 순서로 둔다 */
const CATEGORY_COLORS = ['#2563eb', '#b45309', '#15803d', '#7c3aed', '#0e7490', '#be123c', '#4d7c0f', '#a16207']

/**
 * 카테고리 이름 → 책등 색. 사용자가 임의로 짓는 이름이므로 고정 표가 아니라
 * 이름을 해시해 팔레트에서 고른다 — 같은 이름은 언제나 같은 색이 나온다.
 * 이름이 없으면(미분류) 중립 회색.
 */
export function categoryColor(name: string | null | undefined): string {
  const label = name?.trim()
  if (!label) return '#64748b'
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) % 100000007
  return CATEGORY_COLORS[h % CATEGORY_COLORS.length]
}

/**
 * 카테고리 태그용 색 조합 — 글자색 + 옅은 배경 + 테두리.
 * 색만으로 구분하지 않도록 이름 텍스트와 항상 함께 쓴다.
 */
export function categoryTint(name: string | null | undefined) {
  const hex = categoryColor(name)
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return {
    color: hex,
    background: `rgba(${r}, ${g}, ${b}, .12)`,
    borderColor: `rgba(${r}, ${g}, ${b}, .3)`
  }
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatDate(ts: number) {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const pad = (v: number) => String(v).padStart(2, '0')
  if (sameDay) return `오늘 ${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일`
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** "1-3, 5, 8-" → 0부터 시작하는 인덱스 (범위 밖은 버림) */
export function parsePageRange(input: string, total: number): number[] | null {
  const out = new Set<number>()
  const parts = input.split(',').map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return null
  for (const p of parts) {
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(p)
    if (m) {
      const a = m[1] ? parseInt(m[1], 10) : 1
      const b = m[2] ? parseInt(m[2], 10) : total
      if (a > b) return null
      for (let i = a; i <= b; i++) if (i >= 1 && i <= total) out.add(i - 1)
    } else if (/^\d+$/.test(p)) {
      const i = parseInt(p, 10)
      if (i >= 1 && i <= total) out.add(i - 1)
    } else return null
  }
  return [...out].sort((a, b) => a - b)
}

export function safeFileName(name: string) {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'untitled'
}

export function isStandalone() {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches
  )
}
