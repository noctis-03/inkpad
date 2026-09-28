export function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
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
