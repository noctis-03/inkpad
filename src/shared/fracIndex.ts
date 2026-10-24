// 분수 인덱스 — 두 키 사이에 새 키를 끼워 넣는 순서 키 (문서 블록의 pos).
// 키는 0-9a-z 문자열이고 사전순으로 비교한다. 두 기기가 같은 자리에 따로 끼워 넣으면 같은 키가 나올 수 있어
// 정렬은 (pos, id)로 한다. 맨 끝 글자는 '0'이 아니게 만든다 — 그래야 어떤 두 키 사이에도 키가 있다.
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'

/** a < 결과 < b (a: '' = 맨 앞 이전, b: null = 맨 뒤 이후) */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // 같은 앞부분은 그대로 두고 그 뒤에서 가운데를 찾는다
    let n = 0
    while ((a[n] ?? '0') === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]
  // 이웃한 글자 — b가 더 길면 b의 첫 글자로 충분하고, 아니면 한 자리 더 내려간다
  if (b !== null && b.length > 1) return b.slice(0, 1)
  return DIGITS[da] + midpoint(a.slice(1), null)
}

/** a와 b 사이의 키. a·b가 null이면 그쪽 끝이 열려 있다 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) throw new Error(`keyBetween: ${a} >= ${b}`)
  return midpoint(a ?? '', b)
}

/** a와 b 사이에 n개 — 차례대로 커진다 */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  const out: string[] = []
  let prev = a
  for (let i = 0; i < n; i++) {
    // 남은 칸을 고르게 나누지는 않는다 — 블록 수가 적어 길이가 조금 느는 것은 괜찮다
    const k = keyBetween(prev, b)
    out.push(k)
    prev = k
  }
  return out
}

/** 문서 블록 정렬 — pos, 같으면 id */
export const byPos = <T extends { pos: string; id: string }>(a: T, b: T) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
