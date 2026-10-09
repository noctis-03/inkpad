/* 목록 등장/이동 애니메이션 회귀 테스트.
 *
 * 배경: 등장 연출을 FLIP 내부 기억(prev/first)에 맡기면 컨테이너가 사라졌다 나타나거나
 * 카드가 60개를 넘을 때 조용히 생략돼 "모핑이 안 나온다"가 됐다.
 * 이제 섹션 전환의 '등장'은 data-enter(CSS)가 담당하고, FLIP 은 위치 '이동'만 맡는다.
 */
import React, { useRef, act } from 'react'
import { createRoot } from 'react-dom/client'
import { useFlip } from '../../src/ui/motion/useFlip'
import { useSectionEnter } from '../../src/ui/motion/useSectionEnter'

const doc = document as any
const win = window as any
let pass = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) pass++
  else failures.push(name + (detail ? ' — ' + detail : ''))
}

const rects: Record<string, { left: number; top: number; width: number; height: number }> = {}
win.Element.prototype.getBoundingClientRect = function () {
  const k = this.dataset?.flipKey
  const r = (k && rects[k]) || { left: 0, top: 0, width: 100, height: 100 }
  return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON() {} }
}
doc.documentElement.dataset.motion = 'normal'

/** Library 실제 구조를 그대로 흉내낸다: 섹션이 비면 컨테이너가 사라진다. */
function List({ keys, section }: { keys: string[]; section: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const enter = useSectionEnter(true, section)
  useFlip(ref, [section, keys.join('|')], section)
  if (!keys.length) return <div data-test="empty">비어 있음</div>
  return (
    <div ref={ref} data-test="grid" data-enter={enter ? '' : undefined}>
      {keys.map((k) => (
        <article key={k} data-flip-key={k} className="doc-card">
          {k}
        </article>
      ))}
    </div>
  )
}

function EnterProbe({ section, hold }: { section: string; hold: number }) {
  const enter = useSectionEnter(true, section, hold)
  return <div data-test="probe" data-enter={enter ? 'y' : 'n'} />
}

const root = createRoot(document.getElementById('root'))
const anims = () => (globalThis as any).__anim as any[]
const hasAnim = (k: string) => anims().some((a) => a.key === k)
const gridHasEnter = () => document.querySelector('[data-test="grid"]')?.hasAttribute('data-enter') ?? false

/* 1) 첫 진입 — FLIP 은 위치만 기억하고 애니메이션을 만들지 않는다 */
for (const k of ['x', 'y']) rects[k] = { left: 0, top: 0, width: 100, height: 100 }
anims().length = 0
await act(async () => { root.render(<List keys={['x', 'y']} section="all" />) })
check('첫 진입: WAAPI 등장 애니메이션 없음(CSS 담당)', anims().length === 0, `anim ${anims().length}회`)
check('첫 진입: data-enter 로 등장 연출 켜짐', gridHasEnter())

/* 2) 빈 섹션(컨테이너 언마운트) */
anims().length = 0
await act(async () => { root.render(<List keys={[]} section="files" />) })
check('빈 섹션: 애니메이션 없음', anims().length === 0, `anim ${anims().length}회`)

/* 3) 빈 섹션을 거쳐 전체로 복귀 — 등장은 data-enter 가 책임진다 */
anims().length = 0
await act(async () => { root.render(<List keys={['x', 'y']} section="all" />) })
check('빈 섹션 경유 복귀: data-enter 재무장', gridHasEnter(), `data-enter=${gridHasEnter()}`)
check('빈 섹션 경유 복귀: FLIP 은 등장을 만들지 않음(중복 방지)', !hasAnim('x'), JSON.stringify(anims().map((a: any) => a.key)))

/* 4) 컨테이너가 유지되는 섹션 전환 */
rects.a = { left: 0, top: 0, width: 100, height: 100 }
anims().length = 0
await act(async () => { root.render(<List keys={['a']} section="files" />) })
anims().length = 0
await act(async () => { root.render(<List keys={['x', 'y']} section="all" />) })
check('섹션 전환(컨테이너 유지): data-enter 재무장', gridHasEnter())
check('섹션 전환: FLIP 등장 중복 없음', !hasAnim('x'))

/* 5) 같은 섹션에서 재정렬 — FLIP 이 '이동'을 담당한다 */
anims().length = 0
rects.x = { left: -40, top: 0, width: 100, height: 100 }
await act(async () => { root.render(<List keys={['y', 'x']} section="all" />) })
const moveX = anims().find((a: any) => a.key === 'x')
check('같은 섹션 재정렬: 이동 애니메이션', !!moveX, JSON.stringify(anims().map((a: any) => a.key)))
check('같은 섹션 재정렬: 이동량(dx) 계산', !!moveX && /translate\(40px, 0px\)/.test(moveX.keyframes[0].transform), moveX && moveX.keyframes[0].transform)

/* 6) 모션 끄기 — WAAPI 도 data-enter 애니메이션도 없어야 한다 */
doc.documentElement.dataset.motion = 'off'
anims().length = 0
await act(async () => { root.render(<List keys={['x', 'y']} section="notes" />) })
check('모션 끄기: WAAPI 애니메이션 없음', anims().length === 0, `anim ${anims().length}회`)
doc.documentElement.dataset.motion = 'normal'

/* 7) useSectionEnter — 전환에만 재무장하고 holdMs 뒤 내려간다 */
const probe = () => document.querySelector('[data-test="probe"]')
await act(async () => { root.render(<EnterProbe section="a" hold={60} />) })
check('useSectionEnter: 첫 로드에 켜짐', probe()?.getAttribute('data-enter') === 'y')
await act(async () => { await new Promise((r) => setTimeout(r, 100)) })
check('useSectionEnter: holdMs 뒤 내려감', probe()?.getAttribute('data-enter') === 'n', probe()?.getAttribute('data-enter') ?? 'null')
await act(async () => { root.render(<EnterProbe section="a" hold={60} />) })
check('useSectionEnter: 같은 섹션 재렌더로는 다시 켜지지 않음', probe()?.getAttribute('data-enter') === 'n')
await act(async () => { root.render(<EnterProbe section="b" hold={60} />) })
check('useSectionEnter: 섹션이 바뀌면 다시 켜짐', probe()?.getAttribute('data-enter') === 'y')

console.log(`\n등장/이동 회귀 테스트: ${pass}개 통과, ${failures.length}개 실패`)
if (failures.length) {
  console.log('\n실패 항목:')
  failures.forEach((f) => console.log('  ✗ ' + f))
  process.exitCode = 1
} else {
  console.log('모든 항목 통과 ✓')
}
