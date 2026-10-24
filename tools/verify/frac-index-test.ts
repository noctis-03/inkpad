// 분수 인덱스 — 문서 블록의 순서 키(src/shared/fracIndex.ts). 어디에 끼워 넣어도 순서가 지켜지는가
import { byPos, keyBetween, keysBetween } from '../../src/shared/fracIndex.ts'

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

console.log(`\n분수 인덱스: ${pass}개 통과, ${fail}개 실패`)
if (fail) process.exitCode = 1
else console.log('모든 분수 인덱스 검사 통과 ✓')
