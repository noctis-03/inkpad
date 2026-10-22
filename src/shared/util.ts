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

const UNCATEGORIZED = '#64748b' // 미분류 — 중립 회색

/** 색을 정하는 이름 — [태그]로 시작하면 태그만("[과제] 디지털 시스템"·"[과제] 회로 실습"은 모두 "과제") */
function colorLabel(name: string | null | undefined): string {
  const trimmed = name?.trim()
  return trimmed ? (splitCategory(trimmed).group ?? trimmed) : ''
}

/** 이름 → 팔레트 칸. 같은 이름은 언제나 같은 칸 — 배정에서 '원래 색'으로 먼저 지킨다 */
function hashIndex(label: string): number {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) % 100000007
  return h % CATEGORY_COLORS.length
}

// ── 색 거리: OKLab(사람 눈이 느끼는 차이에 가까운 색 공간) ──
type Lab = [number, number, number]
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
function hexToLab(hex: string): Lab {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => toLinear(c / 255))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
/** OKLCH → #rrggbb. sRGB 밖이면 null */
function lchToHex(L: number, C: number, H: number): string | null {
  const a = C * Math.cos((H * Math.PI) / 180)
  const b = C * Math.sin((H * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
  if (rgb.some((c) => c < -1e-4 || c > 1 + 1e-4)) return null
  return '#' + rgb.map((c) => Math.round(toGamma(Math.min(1, Math.max(0, c))) * 255).toString(16).padStart(2, '0')).join('')
}
const dist = (p: Lab, q: Lab) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])

/** 새 색 후보 — 팔레트와 비슷한 밝기(밝은·어두운 바탕 모두에서 보이게)와 또렷한 채도. 회색 쪽으로 흐려지지 않게 채도 하한 */
let candidates: { hex: string; lab: Lab }[] | null = null
function colorCandidates() {
  if (candidates) return candidates
  candidates = []
  for (const L of [0.5, 0.58, 0.66])
    for (let H = 0; H < 360; H += 5)
      for (let C = 0.17; C >= 0.1; C -= 0.01) {
        const hex = lchToHex(L, C, H)
        if (hex) {
          candidates.push({ hex, lab: hexToLab(hex) })
          break
        }
      }
  return candidates
}

/**
 * 카테고리 이름 전체 → 색. 해시로 하나씩 고르면 다른 카테고리와 같은 색이 나오므로, 목록 전체를 보고 배정한다.
 *  1) 가나다순으로, 원래 색(해시 칸)이 비어 있으면 그 색 — 겹치지 않던 카테고리는 색이 그대로다
 *  2) 원래 색을 뺏긴 것은 팔레트의 다음 빈 색
 *  3) 팔레트 12색을 다 쓰면 이미 쓴 색(미분류 회색 포함)과 가장 먼 색을 새로 만든다 — 같은 색은 나오지 않는다
 * 같은 목록이면 어느 기기·어느 순서로 넘겨도 같은 결과. 카테고리가 늘면 겹쳐 밀려났던 것만 색이 바뀔 수 있다.
 */
export function assignCategoryColors(names: Iterable<string | null | undefined>): Map<string, string> {
  const labels = [...new Set([...names].map(colorLabel).filter(Boolean))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const out = new Map<string, string>()
  const taken = new Set<number>()
  const rest: string[] = []
  for (const label of labels) {
    const i = hashIndex(label)
    if (taken.has(i)) rest.push(label)
    else {
      taken.add(i)
      out.set(label, CATEGORY_COLORS[i])
    }
  }
  const used: Lab[] = [hexToLab(UNCATEGORIZED), ...[...out.values()].map(hexToLab)]
  for (const label of rest) {
    const start = hashIndex(label)
    let pick: string | null = null
    for (let k = 1; k <= CATEGORY_COLORS.length && !pick; k++) {
      const i = (start + k) % CATEGORY_COLORS.length
      if (!taken.has(i)) {
        taken.add(i)
        pick = CATEGORY_COLORS[i]
      }
    }
    if (!pick) {
      let best = -1
      for (const c of colorCandidates()) {
        let near = Infinity
        for (const u of used) near = Math.min(near, dist(c.lab, u))
        if (near > best) {
          best = near
          pick = c.hex
        }
      }
    }
    out.set(label, pick!)
    used.push(hexToLab(pick!))
  }
  return out
}

/**
 * 카테고리 이름 → 색. assigned(assignCategoryColors의 결과)를 주면 그 배정을 따른다 — 목록 전체를 아는 화면이 넘긴다.
 * 배정에 없으면 이름 해시로 팔레트에서 고른다(같은 이름은 언제나 같은 색). 이름이 없으면(미분류) 중립 회색.
 */
export function categoryColor(name: string | null | undefined, assigned?: Map<string, string>): string {
  const label = colorLabel(name)
  if (!label) return UNCATEGORIZED
  return assigned?.get(label) ?? CATEGORY_COLORS[hashIndex(label)]
}

/**
 * 카테고리 이름 앞의 [태그] — "[과제] 디지털 시스템" → { group: '과제', label: '디지털 시스템' }.
 * 사이드바는 뒤쪽 이름(label)을 묶음 머리글로, 그 아래에 [태그]들을 둔다. 카테고리 자체(이름·노트에 붙은 값)는 그대로다.
 * 태그 뒤에 이름이 없으면("[과제]") 묶지 않는다
 */
export function splitCategory(name: string): { group: string | null; label: string } {
  const m = /^\s*\[([^\]]*)\]\s*(.*)$/.exec(name)
  const group = m?.[1].trim().replace(/\s+/g, ' ')
  const rest = m?.[2].trim().replace(/\s+/g, ' ')
  if (!m || !group || !rest) return { group: null, label: name }
  return { group, label: rest }
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
