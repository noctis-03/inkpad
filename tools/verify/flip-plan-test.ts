/**
 * FLIP 등장/이동 판정 회귀 테스트 (의존성 없음)
 *
 * 실행:  node --experimental-strip-types --no-warnings tools/verify/flip-plan-test.ts
 *
 * 배경: "모핑이 한 방향으로만 적용되는" 결함.
 *  - 기타 파일(빈 섹션)을 거쳐 '전체'로 돌아오면 등장 연출이 없었다.
 *  - 카드가 60개를 넘는 섹션으로 돌아갈 때도 통째로 생략돼 등장이 사라졌다.
 * 두 경로가 다시 깨지지 않도록 여기서 잠근다.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  planFlip,
  FLIP_ANIM_BUDGET,
  MOVE_EPSILON,
  STAGGER_MS,
  STAGGER_MAX_STEPS,
  type FlipCard,
  type FlipRect
} from '../../src/ui/motion/flipPlan.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const USE_FLIP_SRC = readFileSync(join(ROOT, 'src/ui/motion/useFlip.ts'), 'utf8')
const CSS = readFileSync(join(ROOT, 'src/styles.css'), 'utf8')

let pass = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) pass++
  else failures.push(`${name}${detail ? ' — ' + detail : ''}`)
}

const mem = (entries: Array<[string, FlipRect]>) => new Map<string, FlipRect>(entries)
const cards = (keys: string[], y = 0, x = 0): FlipCard[] =>
  keys.map((key, i) => ({ key, left: x, top: y + i * 100 }))

/* ── T1 · 빈 섹션을 거쳐 돌아온 경우 (보고된 증상) ───────────────────── */
// 섹션이 비면 useFlip 이 기억을 버리므로 prev 가 빈 Map 이 된다.
// 그 상태에서 목록이 다시 그려지면 모든 카드가 '등장'이어야 한다.
{
  const acts = planFlip(new Map(), cards(['a', 'b', 'c']))
  check('T1 빈 기억 → 전부 등장', acts.length === 3 && acts.every((a) => a.kind === 'enter'))
  check('T1 등장 지연 계단', acts.map((a) => (a.kind === 'enter' ? a.delay : -1)).join(',') === '0,30,60')
}

/* ── T2 · 섹션 전환: 공유 카드는 이동, 새 카드는 등장 ──────────────── */
{
  // 이전 섹션(기타 파일) 기억: file 카드만
  const prev = mem([
    ['file:1', { left: 0, top: 0 }],
    ['file:2', { left: 0, top: 100 }]
  ])
  // '전체'로 복귀: 문서 카드는 새로 나타나고(등장), 파일 카드는 아래로 밀린다(이동)
  const now: FlipCard[] = [
    { key: 'doc:1', left: 0, top: 0 },
    { key: 'doc:2', left: 0, top: 100 },
    { key: 'file:1', left: 0, top: 200 },
    { key: 'file:2', left: 0, top: 300 }
  ]
  const acts = planFlip(prev, now)
  const enters = acts.filter((a) => a.kind === 'enter').map((a) => a.key)
  const moves = acts.filter((a) => a.kind === 'move') as Array<{ key: string; dx: number; dy: number }>
  check('T2 새 카드만 등장', enters.join(',') === 'doc:1,doc:2')
  check('T2 공유 카드는 이동', moves.map((m) => m.key).join(',') === 'file:1,file:2')
  check('T2 이동량 계산(dy = 이전 - 현재)', moves.every((m) => m.dy === -200 && m.dx === 0))
}

/* ── T3 · 같은 목록·같은 위치 → 아무 연출도 없음 ─────────────────── */
{
  const now = cards(['a', 'b'])
  const acts = planFlip(mem(now.map((c) => [c.key, { left: c.left, top: c.top }])), now)
  check('T3 제자리면 액션 없음', acts.length === 0)
}

/* ── T4 · 카드가 많아도(>60) 등장은 살아남는다 ───────────────────── */
{
  const many = cards(Array.from({ length: 120 }, (_, i) => `k${i}`))
  const acts = planFlip(new Map(), many)
  check(`T4 카드 120개에도 등장 발생`, acts.length > 0 && acts.every((a) => a.kind === 'enter'))
  check(`T4 애니메이션 예산 준수(${acts.length} ≤ ${FLIP_ANIM_BUDGET})`, acts.length <= FLIP_ANIM_BUDGET)
}

/* ── T5 · 등장 지연 계단 상한 ───────────────────────────────────── */
{
  const many = cards(Array.from({ length: 40 }, (_, i) => `k${i}`))
  const acts = planFlip(new Map(), many)
  const maxDelay = Math.max(...acts.map((a) => (a.kind === 'enter' ? a.delay : -1)))
  check('T5 지연 상한', maxDelay === STAGGER_MAX_STEPS * STAGGER_MS, `maxDelay=${maxDelay}`)
}

/* ── T6 · 서브픽셀 이동은 무시 ───────────────────────────────────── */
{
  const prev = mem([['a', { left: 0, top: 0 }]])
  const acts = planFlip(prev, [{ key: 'a', left: MOVE_EPSILON / 2, top: MOVE_EPSILON / 2 }])
  check('T6 서브픽셀 무시', acts.length === 0)
  const acts2 = planFlip(prev, [{ key: 'a', left: MOVE_EPSILON * 2, top: 0 }])
  check('T6 임계 초과는 이동', acts2.length === 1 && acts2[0].kind === 'move')
}

/* ── T7 · 예산 0 이면 아무것도 걸지 않는다 ─────────────────────── */
{
  check('T7 예산 0', planFlip(new Map(), cards(['a', 'b']), 0).length === 0)
  check('T7 음수 예산 안전', planFlip(new Map(), cards(['a']), -5).length === 0)
}

/* ── T8 · 소스 가드: 훅이 실패 경로를 다시 열지 않았는지 ─────────── */
{
  // 컨테이너가 없을 때 기억을 버리는 코드가 남아 있어야 한다
  check(
    'T8 빈 목록에서 기억 초기화',
    /if\s*\(\s*!el\s*\)\s*\{[\s\S]{0,120}prev\.current\s*=\s*new Map\(\)/.test(USE_FLIP_SRC)
  )
  // 예전의 '카드 60개 초과 → 통째로 생략' 가드가 되살아나지 않았는지
  check('T8 카드 수 기반 통째 생략 가드 없음', !/cards\.length\s*>\s*60/.test(USE_FLIP_SRC))
  // 카드 등장 CSS 연출이 살아 있는지
  check('T8 카드 등장 CSS(card-in) 존재', /\.doc-grid\[data-enter\][\s\S]{0,120}card-in/.test(CSS))
}

/* ── 리포트 ─────────────────────────────────────────────────────── */
console.log(`\nFLIP 판정 시뮬레이션: ${pass}개 통과, ${failures.length}개 실패`)
if (failures.length) {
  console.log('\n실패 항목:')
  failures.forEach((f) => console.log('  ✗ ' + f))
  process.exitCode = 1
} else {
  console.log('모든 시뮬레이션 통과 ✓')
}
