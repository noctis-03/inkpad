/* useFlip 회귀 테스트 — 섹션을 옮겼다 돌아올 때 카드 등장 애니메이션이 나오는지.
 *
 * 버그 재현: 목록 → 빈 목록(컨테이너 언마운트) → 같은 목록 으로 돌아오면,
 * 이전 위치 기억(prev)이 갱신되지 않아 카드가 '제자리 이동'(dx=0)으로 판정되고
 * 애니메이션이 전혀 나오지 않았다.
 */
import React, { useRef, act } from 'react'
import { createRoot } from 'react-dom/client'
import { useFlip } from '../../src/ui/motion/useFlip'

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

/** 목록이 비면 컨테이너 자체가 렌더되지 않는다 — Library 의 실제 구조와 같다 */
function List({ keys, section }: { keys: string[]; section: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useFlip(ref, [section, keys.join('|')], section)
  if (!keys.length) return <div data-test="empty">비어 있음</div>
  return (
    <div ref={ref} data-test="grid">
      {keys.map((k) => (
        <article key={k} data-flip-key={k} className="doc-card">
          {k}
        </article>
      ))}
    </div>
  )
}

const root = createRoot(document.getElementById('root'))
const anims = () => (globalThis as any).__anim as any[]
const appearAnims = (keys: string[]) =>
  anims().filter((a) => keys.includes(a.key) && JSON.stringify(a.keyframes).includes('"opacity":0'))

// 카드 위치 고정 (이동 없음) — 등장 여부만 본다
for (const k of ['x', 'y']) rects[k] = { left: 0, top: 0, width: 100, height: 100 }

/* 1) 첫 진입: 전체 (노트 2개) */
anims().length = 0
await act(async () => {
  root.render(<List keys={['x', 'y']} section="all" />)
})
check('첫 진입에는 애니메이션 없음(등장 연출이 담당)', anims().length === 0, `anim ${anims().length}회`)

/* 2) 기타 파일 (파일 0개 → 컨테이너 언마운트) */
anims().length = 0
await act(async () => {
  root.render(<List keys={[]} section="files" />)
})
check('빈 섹션에서는 애니메이션 없음', anims().length === 0, `anim ${anims().length}회`)

/* 3) 다시 전체 — 카드가 '등장' 애니메이션으로 들어와야 한다 (여기가 버그 지점) */
anims().length = 0
await act(async () => {
  root.render(<List keys={['x', 'y']} section="all" />)
})
check('빈 섹션을 거쳐 돌아오면 카드가 등장 애니메이션', appearAnims(['x', 'y']).length === 2, `등장 ${appearAnims(['x', 'y']).length}건 / 전체 ${anims().length}건`)

/* 4) 컨테이너가 살아 있는 섹션 전환 (기타 파일에 파일 2개 → 전체) */
rects.a = { left: 0, top: 0, width: 100, height: 100 }
rects.b = { left: 0, top: 0, width: 100, height: 100 }
anims().length = 0
await act(async () => {
  root.render(<List keys={['a', 'b']} section="files" />)
})
anims().length = 0
await act(async () => {
  root.render(<List keys={['x', 'y']} section="all" />)
})
check('섹션 전환(컨테이너 유지)에서도 노트 카드가 등장 애니메이션', appearAnims(['x', 'y']).length === 2, `등장 ${appearAnims(['x', 'y']).length}건 / 전체 ${anims().length}건`)

/* 5) 같은 섹션에서 재정렬 — 등장이 아니라 '이동' 애니메이션이어야 한다.
      키 '순서'가 바뀌어야 FLIP 이 다시 돈다(순서가 그대로면 재계산할 이유가 없다). */
anims().length = 0
rects.x = { left: -40, top: 0, width: 100, height: 100 }
await act(async () => {
  root.render(<List keys={['y', 'x']} section="all" />)
})
const moveX = anims().find((a) => a.key === 'x' && !JSON.stringify(a.keyframes).includes('"opacity":0'))
check('같은 섹션 재정렬은 이동 애니메이션', !!moveX, JSON.stringify(anims().map((a: any) => a.key)))
check('이동량(dx) 계산', !!moveX && /translate\(40px, 0px\)/.test(moveX.keyframes[0].transform), moveX && moveX.keyframes[0].transform)

/* 6) 모션 끄기 — 아무 애니메이션도 없어야 한다 */
doc.documentElement.dataset.motion = 'off'
anims().length = 0
await act(async () => {
  root.render(<List keys={['x', 'y']} section="notes" />)
})
check('모션 끄기면 애니메이션 없음', anims().length === 0, `anim ${anims().length}회`)
doc.documentElement.dataset.motion = 'normal'

console.log(`\nFLIP 회귀 테스트: ${pass}개 통과, ${failures.length}개 실패`)
if (failures.length) {
  console.log('\n실패 항목:')
  failures.forEach((f) => console.log('  ✗ ' + f))
  process.exitCode = 1
} else {
  console.log('모든 항목 통과 ✓')
}
