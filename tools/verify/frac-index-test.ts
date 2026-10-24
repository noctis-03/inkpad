// 분수 인덱스 — 문서 블록의 순서 키(src/shared/fracIndex.ts). 어디에 끼워 넣어도 순서가 지켜지는가
import { byPos, jitterKeyBetween, keyBetween, keysBetween, slotKeys } from '../../src/shared/fracIndex.ts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else fail++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${!cond && detail ? ' — ' + detail : ''}`)
}

const valid = (k: string) => /^[0-9a-z]+$/.test(k) && !k.endsWith('0')

// 1) 기본
const a = keyBetween(null, null)
check('빈 목록의 첫 키', valid(a), a)
const b = keyBetween(a, null)
const c = keyBetween(null, a)
check('뒤에 붙이기·앞에 붙이기', c < a && a < b, `${c} ${a} ${b}`)
check('a·b 사이', (() => { const m = keyBetween(a, b); return a < m && m < b && valid(m) })())

// 2) 같은 자리에 계속 끼워 넣기 (앞쪽·뒤쪽·가운데) — 순서가 깨지지 않고 키가 너무 길어지지 않는다
for (const where of ['front', 'back', 'middle'] as const) {
  const list = [keyBetween(null, null)]
  let ok = true
  for (let i = 0; i < 400; i++) {
    const at = where === 'front' ? 0 : where === 'back' ? list.length : Math.floor(list.length / 2)
    const k = keyBetween(at > 0 ? list[at - 1] : null, at < list.length ? list[at] : null)
    if (!valid(k)) ok = false
    list.splice(at, 0, k)
  }
  const sorted = [...list].sort()
  const maxLen = Math.max(...list.map((k) => k.length))
  check(`${where}에 400번 끼워 넣기 → 순서 유지`, ok && sorted.every((k, i) => k === list[i]), list.slice(0, 5).join(','))
  check(`${where}: 키 길이 ${maxLen} (100자 미만)`, maxLen < 100)
}

// 3) 무작위 끼워 넣기 1000번
{
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const list: string[] = []
  let ok = true
  for (let i = 0; i < 1000; i++) {
    const at = Math.floor(rnd() * (list.length + 1))
    const k = keyBetween(at > 0 ? list[at - 1] : null, at < list.length ? list[at] : null)
    if (!valid(k) || (at > 0 && !(list[at - 1] < k)) || (at < list.length && !(k < list[at]))) ok = false
    list.splice(at, 0, k)
  }
  check('무작위 1000번 → 모두 이웃 사이', ok)
}

// 4) 여러 개 한꺼번에
{
  const ks = keysBetween('1', '2', 5)
  check('사이에 5개 → 차례대로', ks.every((k, i) => '1' < k && k < '2' && (i === 0 || ks[i - 1] < k)), ks.join(','))
}

// 5) 잘못된 순서는 거부, 같은 pos는 id로
let threw = false
try {
  keyBetween('b', 'a')
} catch {
  threw = true
}
check('a >= b면 오류', threw)
const rows = [{ pos: 'i', id: '2' }, { pos: 'i', id: '1' }, { pos: 'a', id: '9' }].sort(byPos)
check('같은 pos는 id 순', rows.map((r) => r.id).join('') === '912')

// 6) 무작위 글자를 덧붙인 키 — 두 기기가 같은 자리에 넣어도 키가 다르다
{
  let seed = 11
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  let ok = true
  for (let i = 0; i < 2000; i++) {
    const lo = i % 3 ? keyBetween(null, null) + (i % 7 ? '' : 'x') : null
    const hi = i % 5 ? keyBetween(lo, null) : null
    const k = jitterKeyBetween(lo, hi, rnd)
    if (!valid(k) || (lo !== null && !(lo < k)) || (hi !== null && !(k < hi))) ok = false
  }
  check('덧붙인 키도 이웃 사이 (2000번)', ok)
  check('rand가 1에 가까워도 올바른 키', valid(jitterKeyBetween('i', 'r', () => 0.9999999)) && valid(jitterKeyBetween(null, null, () => 0)))
  const tail = keyBetween('h', 'i5')
  check('덧붙이면 b를 넘는 경우는 덧붙이지 않음', jitterKeyBetween('h', 'i5', () => 0.99) === tail && tail < 'i5', tail)
  let diff = 0
  for (let i = 0; i < 200; i++) if (jitterKeyBetween('i', 'r', rnd) !== jitterKeyBetween('i', 'r', rnd)) diff++
  check(`같은 자리에 따로 넣은 두 키가 다름 (${diff}/200)`, diff >= 180)
  for (const where of ['front', 'back', 'middle'] as const) {
    const list = [keyBetween(null, null)]
    let ord = true
    for (let i = 0; i < 400; i++) {
      const at = where === 'front' ? 0 : where === 'back' ? list.length : Math.floor(list.length / 2)
      const k = jitterKeyBetween(at > 0 ? list[at - 1] : null, at < list.length ? list[at] : null, rnd)
      if (!valid(k)) ord = false
      list.splice(at, 0, k)
    }
    const maxLen = Math.max(...list.map((k) => k.length))
    check(`덧붙인 키로 ${where}에 400번 → 순서 유지, 키 길이 ${maxLen} (100자 미만)`, ord && [...list].sort().every((k, i) => k === list[i]) && maxLen < 100)
  }
}

// 7) 같은 키 블록 사이에 끼우기 — 두 기기가 같은 자리에 넣은 뒤 (예전 키에는 덧붙인 글자가 없다)
{
  type R = { id: string; pos: string }
  const order = (list: R[]) => [...list].sort(byPos).map((r) => r.id).join(' ')
  const put = (list: R[], at: number, ids: string[]) => {
    const { keys, repos } = slotKeys(list, at, ids.length)
    const out = list.map((r) => (repos.has(r.id) ? { ...r, pos: repos.get(r.id)! } : r))
    return { out: [...out, ...ids.map((id, k) => ({ id, pos: keys[k] }))], repos }
  }
  const base: R[] = [{ id: 'a', pos: 'i' }, { id: 'A', pos: 'n' }, { id: 'B', pos: 'n' }, { id: 'c', pos: 'r' }]
  check('출발: 두 기기가 넣은 줄 A·B의 키가 같다 (id 순)', order(base) === 'a A B c', order(base))
  const { out, repos } = put(base, 2, ['N'])
  check('A·B 사이에 새 줄 → A 다음, B 앞', order(out) === 'a A N B c', order(out))
  check('…앞쪽(A)만 다시 매김, 오류 없음', [...repos.keys()].join() === 'A', [...repos.keys()].join())
  const many = put(base, 2, ['N1', 'N2', 'N3'])
  check('사이에 여러 줄 → 차례대로', order(many.out) === 'a A N1 N2 N3 B c', order(many.out))
  const three: R[] = [{ id: 'a', pos: 'i' }, { id: 'X', pos: 'n' }, { id: 'Y', pos: 'n' }, { id: 'Z', pos: 'n' }]
  const t3 = put(three, 2, ['N'])
  check('셋이 같은 키, X·Y 사이 → X N Y Z', order(t3.out) === 'a X N Y Z', order(t3.out))
  const t3b = put(three, 3, ['N'])
  check('…Y·Z 사이 → X Y N Z (X·Y 다시 매김)', order(t3b.out) === 'a X Y N Z' && [...t3b.repos.keys()].join() === 'X,Y', order(t3b.out))
  const front: R[] = [{ id: 'X', pos: 'n' }, { id: 'Y', pos: 'n' }]
  const tf = put(front, 1, ['N'])
  check('맨 앞의 같은 키 둘 사이 → X N Y', order(tf.out) === 'X N Y', order(tf.out))
  const plain = put(base, 1, ['N'])
  check('같은 키가 아닌 자리는 다시 매기지 않음', plain.repos.size === 0 && order(plain.out) === 'a N A B c', order(plain.out))
  check('맨 뒤·빈 목록', order(put(base, 4, ['N']).out) === 'a A B c N' && order(put([], 0, ['N']).out) === 'N')
}

console.log(`\n분수 인덱스: ${pass}개 통과, ${fail}개 실패`)
if (fail) process.exitCode = 1
else console.log('모든 분수 인덱스 검사 통과 ✓')
