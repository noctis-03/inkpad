export function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

/** 카드 책등 색 팔레트 — 상태 색(파랑·호박·초록)과 어울리는 순서로 둔다 */
/** 카테고리 팔레트 12색 — 점 색만으로 서로 구분되고 밝은·어두운 바탕 모두에서 보이는 것으로 골랐다.
    늘리면 비슷한 색(파랑·남색, 초록·청록)이 생겨 오히려 구분이 어려워진다 */
const CATEGORY_COLORS = [
  '#2563eb', // 파랑
  '#db2777', // 분홍
  '#059669', // 초록
  '#d97706', // 주황
  '#7c3aed', // 보라
  '#0891b2', // 청록
  '#dc2626', // 빨강
  '#4d7c0f', // 올리브
  '#c026d3', // 자홍
  '#ca8a04', // 겨자
  '#a0522d', // 갈색
  '#4f46e5' // 남보라
]

/**
 * 카테고리 이름 → 책등 색. 사용자가 임의로 짓는 이름이므로 고정 표가 아니라
 * 이름을 해시해 팔레트에서 고른다 — 같은 이름은 언제나 같은 색이 나온다.
 * 앞의 [묶음]은 빼고 나머지 이름만 본다("[과제] 디지털 시스템"은 "디지털 시스템"과 같은 색).
 * 이름이 없으면(미분류) 중립 회색.
 */
export function categoryColor(name: string | null | undefined): string {
  const label = name?.trim() && splitCategory(name.trim()).label.trim()
  if (!label) return '#64748b'
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) % 100000007
  return CATEGORY_COLORS[h % CATEGORY_COLORS.length]
}

/**
 * 카테고리 이름 앞의 [묶음] — "[과제] 디지털 시스템" → { group: '과제', label: '디지털 시스템' }.
 * 사이드바가 같은 묶음의 카테고리를 구분선 아래 모은다. 카테고리 자체(이름·색·노트에 붙은 값)는 그대로다
 */
export function splitCategory(name: string): { group: string | null; label: string } {
  const m = /^\s*\[([^\]]*)\]\s*(.*)$/.exec(name)
  const group = m?.[1].trim().replace(/\s+/g, ' ')
  if (!m || !group) return { group: null, label: name }
  return { group, label: m[2].trim() || name }
}

/**
 * 카테고리 태그용 색 — 글자색 + 테두리색 + 바탕(파스텔).
 * 바탕은 카테고리 색을 흰색 쪽으로 옅게 섞은 불투명 파스텔이다 — 필기 미리보기 위에
 * 얹히므로 반투명이면 글씨가 비쳐 읽히지 않는다(그래서 알파가 아니라 흰색과 섞는다).
 */
export function categoryTag(name: string | null | undefined) {
  const hex = categoryColor(name)
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  // 흰색 92% + 카테고리 색 8% → 아주 연한 파스텔 (불투명)
  const pastel = (c: number) => Math.round(255 - (255 - c) * 0.08)
  return {
    color: hex,
    borderColor: `rgba(${r}, ${g}, ${b}, .45)`,
    background: `rgb(${pastel(r)}, ${pastel(g)}, ${pastel(b)})`
  }
}

/** 바이트 → "1.2 MB" (mbDigits: MB의 소수 자릿수 — 사용량 계량처럼 세밀하게 볼 때 2) */
export function formatBytes(n: number, mbDigits = 1) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(mbDigits)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 바이트 → "512B" · "12KB" · "1.2MB" — 좁은 자리(진행 표시·버전 크기)용 짧은 표기 */
export function formatBytesShort(n: number) {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
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
      // 범위 밖 단일 번호(0 등)를 조용히 버리면 빈 결과가 "선택 없음"으로 처리된다 — 오류로 알린다
      if (i < 1 || i > total) return null
      out.add(i - 1)
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
