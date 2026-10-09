/* jsdom 환경을 만들고 번들된 검증 스크립트를 실행한다.
 * 사용: node tools/verify/jsdom-env.mjs <번들 경로> */
import { JSDOM } from 'jsdom'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const bundle = process.argv[2]
if (!bundle) {
  console.error('사용법: node tools/verify/jsdom-env.mjs <번들 경로>')
  process.exit(2)
}

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/'
})
const { window } = dom

globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.Element = window.Element
globalThis.Node = window.Node
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const _RAF = window.requestAnimationFrame.bind(window)
globalThis.requestAnimationFrame = (cb) => _RAF(() => cb(performance.now()))

window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
window.document.fonts = { ready: Promise.resolve() }
globalThis.ResizeObserver = window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.IntersectionObserver = window.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.CSS = window.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c) }

// WAAPI 기록 — jsdom 에는 Element.animate 가 없다
globalThis.__anim = []
window.Element.prototype.animate = function (keyframes, options) {
  globalThis.__anim.push({ key: this.dataset ? this.dataset.flipKey : undefined, cls: this.className, keyframes, options })
  return { addEventListener() {}, cancel() {}, finish() {}, onfinish: null }
}

await import(pathToFileURL(resolve(process.cwd(), bundle)).href)
