// 카테고리 색 배정 — 해시로 하나씩 고르면 겹치므로 목록 전체를 보고 배정한다(src/shared/util.ts assignCategoryColors)
import { assignCategoryColors, categoryColor } from '../../src/shared/util.ts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else fail++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${!cond && detail ? ' — ' + detail : ''}`)
}

/** 해시 칸이 같은(그냥 두면 같은 색이 되는) 이름 둘을 찾는다 */
function collidingPair(): [string, string] {
  const seen = new Map<string, string>()
  for (let i = 0; ; i++) {
    const name = `카테고리${i}`
    const c = categoryColor(name)
    if (seen.has(c)) return [seen.get(c)!, name]
    seen.set(c, name)
  }
}

// OKLab 거리 — 테스트에서도 같은 기준으로 잰다
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
function lab(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => lin(c / 255))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
const dist = (p: string, q: string) => {
  const [a, b] = [lab(p), lab(q)]
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}
const minGap = (colors: string[]) => {
  let g = Infinity
  for (let i = 0; i < colors.length; i++) for (let j = i + 1; j < colors.length; j++) g = Math.min(g, dist(colors[i], colors[j]))
  return g
}

console.log('[카테고리 색]')
const [x, y] = collidingPair()
check('준비: 해시만 쓰면 같은 색이 되는 두 이름이 있다', categoryColor(x) === categoryColor(y), `${x} ${y}`)
const two = assignCategoryColors([x, y])
check('배정: 해시가 겹쳐도 두 색이 다르다', categoryColor(x, two) !== categoryColor(y, two))

const twelve = Array.from({ length: 12 }, (_, i) => `과목${i}`)
const m12 = assignCategoryColors(twelve)
const c12 = twelve.map((n) => categoryColor(n, m12))
check('12개까지: 모두 다른 색, 모두 원래 팔레트 색', new Set(c12).size === 12 && c12.every((c) => [...Array(500)].some((_, i) => categoryColor(`p${i}`) === c)), c12.join(' '))

const solo = ['물리', '화학', '영어']
const alone = solo.filter((n, i) => solo.every((o, j) => i === j || categoryColor(o) !== categoryColor(n)))
const mSolo = assignCategoryColors(solo)
check('겹치지 않던 카테고리는 원래 색 그대로', alone.every((n) => categoryColor(n, mSolo) === categoryColor(n)), alone.join(','))

const forty = Array.from({ length: 40 }, (_, i) => `주제 ${i}`)
const m40 = assignCategoryColors(forty)
const c40 = forty.map((n) => categoryColor(n, m40))
check('12개를 넘어도(40개) 같은 색이 없다', new Set(c40).size === 40)
check('새로 만든 색도 서로 떨어져 있다(OKLab 0.04 이상)', minGap(c40) >= 0.04, minGap(c40).toFixed(3))
check('새로 만든 색은 미분류 회색과도 떨어져 있다', c40.every((c) => dist(c, categoryColor(null)) >= 0.04))
check('새로 만든 색은 #rrggbb', c40.every((c) => /^#[0-9a-f]{6}$/.test(c)), c40.find((c) => !/^#[0-9a-f]{6}$/.test(c)) ?? '')

const shuffled = [...forty].reverse()
const again = assignCategoryColors([...shuffled, ...shuffled, null, '  ', undefined])
check('넘기는 순서·중복·빈 이름과 상관없이 같은 결과', forty.every((n) => categoryColor(n, again) === categoryColor(n, m40)))

const tagged = assignCategoryColors(['[과제] 디지털 시스템', '[과제] 회로 실습', '물리'])
check('같은 [태그]는 같은 색(의도된 묶음)', categoryColor('[과제] 디지털 시스템', tagged) === categoryColor('[과제] 회로 실습', tagged))
check('미분류는 회색', categoryColor(null, tagged) === '#64748b' && categoryColor('  ', tagged) === '#64748b')

console.log(`\n카테고리 색: ${pass}개 통과, ${fail}개 실패`)
if (fail) process.exitCode = 1
else console.log('모든 카테고리 색 검사 통과 ✓')
