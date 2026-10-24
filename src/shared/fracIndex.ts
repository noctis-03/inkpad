// 분수 인덱스 — 두 키 사이에 새 키를 끼워 넣는 순서 키 (문서 블록의 pos).
// 키는 0-9a-z 문자열이고 사전순으로 비교한다. 편집은 무작위 글자를 덧붙인 키(jitterKeyBetween)를 써서 두 기기가 같은 자리에
// 따로 끼워 넣어도 키가 겹치기 어렵게 한다. 그래도 같은 키가 나올 수 있어(예전 키, 드문 우연) 정렬은 (pos, id)로 하고,
// 같은 키 사이에 끼울 때는 slotKeys가 앞쪽을 다시 매긴다. 맨 끝 글자는 '0'이 아니게 만든다 — 그래야 어떤 두 키 사이에도 키가 있다.
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'

/** a < 결과 < b (a: '' = 맨 앞 이전, b: null = 맨 뒤 이후). step: 목록 끝에 붙이기 — 가운데 대신 한 칸씩 */
function midpoint(a: string, b: string | null, step = false): string {
  if (b !== null) {
    // 같은 앞부분은 그대로 두고 그 뒤에서 가운데를 찾는다
    let n = 0
    while ((a[n] ?? '0') === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n), step)
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length
  // 맨 뒤·맨 앞에 붙일 때는 가운데가 아니라 한 칸씩 — Enter로 계속 붙여도 키가 천천히 길어진다
  if (step && b === null && a && db - da > 1) return DIGITS[da + 1]
  if (step && !a && b !== null && db > 1) return DIGITS[db - 1]
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]
  // 이웃한 글자 — b가 더 길면 b의 첫 글자로 충분하고, 아니면 한 자리 더 내려간다
  if (b !== null && b.length > 1) return b.slice(0, 1)
  return DIGITS[da] + midpoint(a.slice(1), null, step)
}

/** a와 b 사이의 키. a·b가 null이면 그쪽 끝이 열려 있다 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) throw new Error(`keyBetween: ${a} >= ${b}`)
  return midpoint(a ?? '', b, (a === null) !== (b === null))
}

/**
 * a와 b 사이의 키에 무작위 글자 하나를 덧붙인다 — 두 기기가 같은 자리에 따로 넣어도 키가 겹치기 어렵다.
 * 덧붙이면 b를 넘는 드문 경우(b가 그 키로 시작할 때)는 덧붙이지 않는다
 */
export function jitterKeyBetween(a: string | null, b: string | null, rand: () => number = Math.random): string {
  const k = keyBetween(a, b)
  const x = k + DIGITS[1 + Math.min(DIGITS.length - 2, Math.floor(rand() * (DIGITS.length - 1)))]
  return b === null || x < b ? x : k
}

/**
 * 정렬된 list의 at 자리(list[at-1]과 list[at] 사이)에 n개를 끼울 키 — 차례대로 커진다.
 * 두 기기가 같은 자리에 넣었던 블록은 키가 같을 수 있고, 키가 같은 두 블록 사이에는 키가 없다.
 * 그때는 앞쪽의 같은 키 블록들(list[at-1]까지)을 그 아래 빈 칸으로 다시 매기고(repos: id → 새 키), 새 키는 그 뒤에 둔다.
 */
export function slotKeys<T extends { id: string; pos: string }>(list: readonly T[], at: number, n: number, rand: () => number = Math.random): { keys: string[]; repos: Map<string, string> } {
  const prev = list[at - 1]
  const next = list[at]
  const hi = next?.pos ?? null
  let lo = prev?.pos ?? null
  const repos = new Map<string, string>()
  if (prev && next && prev.pos >= next.pos) {
    let s = at - 1
    while (s > 0 && list[s - 1].pos === prev.pos) s--
    lo = list[s - 1]?.pos ?? null
    for (let k = s; k < at; k++) repos.set(list[k].id, (lo = jitterKeyBetween(lo, hi, rand)))
  }
  const keys: string[] = []
  for (let k = 0; k < n; k++) keys.push((lo = jitterKeyBetween(lo, hi, rand)))
  return { keys, repos }
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
