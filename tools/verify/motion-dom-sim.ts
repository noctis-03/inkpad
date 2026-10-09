/**
 * 모션 그래픽 검증 시뮬레이션 (DOM 셰임 기반, 의존성 없음)
 *
 * 실행:  node --experimental-strip-types tools/verify/motion-dom-sim.ts
 *
 * 실제 src/ui/motion/*.ts 모듈을 그대로 불러와, 브라우저 없이 최소 DOM 셰임 위에서
 * 포인터 눌림 / settle / 모션 단계 토큰 동작을 시뮬레이션하고,
 * styles.css 와의 정합성(눌림 대상·인디케이터·모션 끄기 규칙)까지 검사한다.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { installPress } from '../../src/ui/motion/press.ts'
import { settle } from '../../src/ui/motion/settle.ts'
import { motionLevel, dur, durRich, SPRING, EASE } from '../../src/ui/motion/motion.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CSS = readFileSync(join(ROOT, 'src/styles.css'), 'utf8')
const PRESS_SRC = readFileSync(join(ROOT, 'src/ui/motion/press.ts'), 'utf8')

/* ───────────────────────── 미니 DOM 셰임 ───────────────────────── */

type Listener = { fn: (ev: any) => void; capture: boolean }

class ClassList {
  private set = new Set<string>()
  constructor(initial = '') {
    initial.split(/\s+/).filter(Boolean).forEach((c) => this.set.add(c))
  }
  add(...c: string[]) {
    c.forEach((x) => this.set.add(x))
  }
  remove(...c: string[]) {
    c.forEach((x) => this.set.delete(x))
  }
  contains(c: string) {
    return this.set.has(c)
  }
  toString() {
    return [...this.set].join(' ')
  }
}

class El {
  tagName: string
  id = ''
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  children: El[] = []
  parent: El | null = null
  classList: ClassList
  private listeners: Record<string, Listener[]> = {}
  offsetWidth = 0
  constructor(tag: string, className = '') {
    this.tagName = tag.toUpperCase()
    this.classList = new ClassList(className)
  }
  get className() {
    return this.classList.toString()
  }
  set className(v: string) {
    this.classList = new ClassList(v)
  }
  append(...kids: El[]) {
    for (const k of kids) {
      k.parent = this
      this.children.push(k)
    }
    return this
  }
  get firstChild() {
    return this.children[0] ?? null
  }
  matches(sel: string): boolean {
    for (const part of sel.split(',')) {
      const p = part.trim()
      if (!p) continue
      if (p.startsWith('#') && this.id === p.slice(1)) return true
      if (p.startsWith('.') && this.classList.contains(p.slice(1))) return true
      if (p === '[data-press]' && 'press' in this.dataset) return true
      if (p.startsWith('[') && p.endsWith(']')) {
        const m = /^\[([\w-]+)\]$/.exec(p)
        if (m) {
          const key = m[1].replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())
          if (key in this.dataset) return true
        }
      }
    }
    return false
  }
  closest(sel: string): El | null {
    let n: El | null = this
    while (n) {
      if (n.matches(sel)) return n
      n = n.parent
    }
    return null
  }
  addEventListener(type: string, fn: (ev: any) => void, opts?: { capture?: boolean; once?: boolean }) {
    ;(this.listeners[type] ??= []).push({ fn, capture: !!opts?.capture })
  }
  removeEventListener(type: string, fn: (ev: any) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l.fn !== fn)
  }
  dispatchEvent(ev: any): boolean {
    ev.target ??= this
    // capture: 최상위(document)에서 대상까지
    const path: El[] = []
    let n: El | null = this
    while (n) {
      path.unshift(n)
      n = n.parent
    }
    for (const node of path) {
      for (const l of node.listeners[ev.type] ?? []) l.fn(ev)
    }
    return true
  }
}

const documentEl = new El('html')
const bodyEl = new El('body')
const documentShim = new El('document')
documentShim.append(documentEl)
documentEl.append(bodyEl)
;(documentEl as any).dataset = documentEl.dataset
const docListeners: Record<string, Listener[]> = {}
;(documentShim as any).documentElement = documentEl
;(documentShim as any).addEventListener = (type: string, fn: (ev: any) => void, opts?: any) => {
  ;(docListeners[type] ??= []).push({ fn, capture: !!opts?.capture })
}
// 이벤트는 대상에서 documentShim 까지 전파된다고 가정한다 (press.ts 는 document 에 캡처 등록)
const origDispatch = El.prototype.dispatchEvent
El.prototype.dispatchEvent = function (ev: any) {
  ev.target ??= this
  // capture path: document → ... → target
  for (const l of docListeners[ev.type] ?? []) if (l.capture) l.fn(ev)
  return origDispatch.call(this, ev)
}

const windowListeners: Record<string, Listener[]> = {}
const windowShim = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  addEventListener: (type: string, fn: (ev: any) => void, opts?: any) => {
    ;(windowListeners[type] ??= []).push({ fn, capture: !!opts?.capture })
  },
  removeEventListener: (type: string, fn: (ev: any) => void) => {
    windowListeners[type] = (windowListeners[type] ?? []).filter((l) => l.fn !== fn)
  }
}

let rafQueue: Array<() => void> = []
;(globalThis as any).document = documentShim
;(globalThis as any).window = windowShim
;(globalThis as any).requestAnimationFrame = (cb: () => void) => {
  rafQueue.push(cb)
  return rafQueue.length
}
;(globalThis as any).cancelAnimationFrame = () => {}

const flushRaf = async () => {
  const q = rafQueue
  rafQueue = []
  q.forEach((cb) => cb())
  await new Promise((r) => setTimeout(r, 0))
}

/* ───────────────────────── 미니 테스트 러너 ───────────────────────── */

let pass = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++
  } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`)
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function pointer(type: string, pointerType = 'mouse'): any {
  const ev: any = { type, pointerType, clientX: 0, clientY: 0 }
  return ev
}

function makeButton(cls = 'tb-btn') {
  const b = new El('button', cls)
  bodyEl.append(b)
  return b
}

/* ───────────────────────── T1 · 모션 토큰 ───────────────────────── */

check('토큰: SPRING/EASE 상수 노출', SPRING.includes('cubic-bezier') && EASE.includes('cubic-bezier'))
for (const lvl of ['off', 'normal', 'rich'] as const) {
  documentEl.dataset.motion = lvl
  check(`토큰: motionLevel(${lvl})`, motionLevel() === lvl)
  check(`토큰: dur(300) @${lvl}`, dur(300) === (lvl === 'off' ? 0 : 300))
  check(`토큰: durRich(300) @${lvl}`, durRich(300) === (lvl === 'rich' ? 300 : 0))
}
documentEl.dataset.motion = 'garbage'
check('토큰: 알 수 없는 값은 normal 로 폴백', motionLevel() === 'normal')
documentEl.dataset.motion = 'normal'

/* ───────────────────────── T2 · 전역 눌림 피드백 ───────────────────────── */

installPress()

// 2-1) 마우스: 즉시 눌림
{
  const btn = makeButton()
  btn.dispatchEvent(pointer('pointerdown'))
  check('눌림: 마우스 pointerdown 즉시 is-pressed', btn.classList.contains('is-pressed'))
  btn.dispatchEvent(pointer('pointerup'))
  await sleep(150)
  check('눌림: pointerup 후 is-pressed 해제', !btn.classList.contains('is-pressed'))
}

// 2-2) 최소 유지 110ms — 아주 짧은 탭도 눌림이 보인다
{
  const btn = makeButton()
  btn.dispatchEvent(pointer('pointerdown'))
  await sleep(10)
  btn.dispatchEvent(pointer('pointerup'))
  check('눌림: 짧은 탭 직후에도 눌림 유지', btn.classList.contains('is-pressed'))
  await sleep(140)
  check('눌림: 짧은 탭도 110ms 뒤 해제', !btn.classList.contains('is-pressed'))
}

// 2-3) 터치: 40ms 지연 후 눌림 (스크롤과 구분)
{
  const btn = makeButton()
  btn.dispatchEvent(pointer('pointerdown', 'touch'))
  check('눌림: 터치는 즉시 눌리지 않음(40ms 지연)', !btn.classList.contains('is-pressed'))
  await sleep(60)
  check('눌림: 터치는 40ms 뒤 눌림', btn.classList.contains('is-pressed'))
  btn.dispatchEvent(pointer('pointerup', 'touch'))
  await sleep(140)
  check('눌림: 터치 해제', !btn.classList.contains('is-pressed'))
}

// 2-4) 터치 스크롤: 40ms 안에 스크롤이 시작되면 눌림을 취소해야 한다
{
  const btn = makeButton()
  btn.dispatchEvent(pointer('pointerdown', 'touch'))
  await sleep(5)
  for (const l of windowListeners['scroll'] ?? []) l.fn({ type: 'scroll' })
  await sleep(60)
  check('눌림: 터치 중 스크롤 시작 시 눌림 취소', !btn.classList.contains('is-pressed'))
}

// 2-5) 제외 영역(필기 캔버스)은 눌리지 않는다
{
  const canvasRoot = new El('div')
  canvasRoot.id = 'canvas-root'
  bodyEl.append(canvasRoot)
  const btn = new El('button', 'tb-btn')
  canvasRoot.append(btn)
  btn.dispatchEvent(pointer('pointerdown'))
  check('눌림: #canvas-root 하위는 제외', !btn.classList.contains('is-pressed'))
}

// 2-6) 모션 끄기면 눌림 없음
{
  documentEl.dataset.motion = 'off'
  const btn = makeButton()
  btn.dispatchEvent(pointer('pointerdown'))
  check('눌림: 모션 끄기면 is-pressed 없음', !btn.classList.contains('is-pressed'))
  documentEl.dataset.motion = 'normal'
}

// 2-7) data-press 속성 대상도 눌린다
{
  const b = new El('button')
  b.dataset.press = ''
  bodyEl.append(b)
  b.dispatchEvent(pointer('pointerdown'))
  check('눌림: [data-press] 대상 인식', b.classList.contains('is-pressed'))
  b.dispatchEvent(pointer('pointerup'))
  await sleep(140)
}

// 2-8) 여러 손가락: 다른 요소를 눌러도 이전 요소의 눌림이 남지 않는다
{
  const a = makeButton()
  const b = makeButton()
  a.dispatchEvent(pointer('pointerdown'))
  b.dispatchEvent(pointer('pointerdown'))
  check('눌림: 멀티터치 시 이전 요소 눌림 해제', !a.classList.contains('is-pressed') && b.classList.contains('is-pressed'))
  b.dispatchEvent(pointer('pointerup'))
  await sleep(140)
  check('눌림: 멀티터치 해제', !b.classList.contains('is-pressed'))
}

/* ───────────────────────── T3 · 카드 settle ───────────────────────── */

{
  const card = new El('article', 'doc-card')
  card.append(new El('div', 'doc-thumb'))
  bodyEl.append(card)
  settle(card)
  check('settle: 호출 직후에는 아직 클래스 없음(다음 프레임)', !card.classList.contains('is-settling'))
  await flushRaf()
  check('settle: 다음 프레임에 is-settling 추가', card.classList.contains('is-settling'))
  card.dispatchEvent({ type: 'animationend', animationName: 'settle-lift' })
  check('settle: 먼저 끝나는 settle-lift 로는 정리하지 않음(광택 띠 보존)', card.classList.contains('is-settling'))
  card.dispatchEvent({ type: 'animationend', animationName: 'sheen' })
  check('settle: 마지막 sheen 종료 시 정리', !card.classList.contains('is-settling'))
}
{
  // 애니메이션이 아예 없는 카드(썸네일 없음)도 안전 타임아웃으로 정리된다
  const card = new El('article', 'doc-card')
  bodyEl.append(card)
  settle(card)
  await flushRaf()
  check('settle: 썸네일 없는 카드도 클래스 추가', card.classList.contains('is-settling'))
  await sleep(1200)
  check('settle: 안전 타임아웃 후 클래스 정리', !card.classList.contains('is-settling'))
}
{
  const card = new El('article', 'doc-card')
  bodyEl.append(card)
  documentEl.dataset.motion = 'off'
  settle(card)
  await flushRaf()
  check('settle: 모션 끄기면 클래스 없음', !card.classList.contains('is-settling'))
  documentEl.dataset.motion = 'normal'
  settle(null)
  check('settle: null 안전', true)
}

/* ───────────────────────── T4 · CSS 정합성 ───────────────────────── */

// 4-1) 모션 끄기 전역 규칙
check('CSS: [data-motion=off] 전역 규칙 존재', /\[data-motion=['"]off['"]\]\s*\*/.test(CSS))
check('CSS: prefers-reduced-motion 대응 존재', /@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(CSS))
check('CSS: .motion-ind 스타일 존재', /\.motion-ind\s*\{/.test(CSS))
check('CSS: [data-indicator-key] 상대 위치 규칙', /\[data-indicator-key\]\s*\{/.test(CSS))

// 4-2) press.ts 의 눌림 대상이 CSS 에 모두 눌림 스타일을 갖는지
const targetsBlock = /const TARGETS = \[([\s\S]*?)\]\.join/.exec(PRESS_SRC)?.[1] ?? ''
const targets = [...targetsBlock.matchAll(/'([^']+)'/g)].map((m) => m[1])
check('CSS: press 대상 목록 파싱', targets.length >= 20, `대상 ${targets.length}개`)
for (const t of targets) {
  if (!t.startsWith('.')) continue
  const cls = t.slice(1)
  // 눌림 규칙에서 해당 클래스가 .is-pressed 와 함께 나오는지
  const re = new RegExp(`\\.${cls.replace(/[-]/g, '\\-')}\\.is-pressed`)
  check(`CSS: ${t} 눌림 규칙 존재`, re.test(CSS))
}

// 4-3) 인디케이터를 쓰는 컨테이너가 CSS 에서 position:relative 인지 (useIndicator 는 static 이면 JS 로 보정)
for (const c of ['.seg', '.folder-tree', '.ft-tools', '.ft-swatches', '.ft-widths']) {
  check(`CSS: ${c} position:relative`, new RegExp(`\\${c}\\s*[,{]`).test(CSS))
}

/* ───────────────────────── 리포트 ───────────────────────── */

console.log(`\n모션 DOM 시뮬레이션: ${pass}개 통과, ${failures.length}개 실패`)
if (failures.length) {
  console.log('\n실패 항목:')
  failures.forEach((f) => console.log('  ✗ ' + f))
  process.exitCode = 1
} else {
  console.log('모든 시뮬레이션 통과 ✓')
}
