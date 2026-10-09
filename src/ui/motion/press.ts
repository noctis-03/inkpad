// 전역 누름 피드백 (명세 5.1).
// [data-press] 및 주요 버튼에 "눌림 + 탄성 복원"을 준다.
// 패시브 리스너만 사용하고 preventDefault 하지 않는다.

// 명세는 [data-press] 속성을 대상으로 한다. 실제 파일의 버튼들은 클래스로 스타일되므로
// 속성과 함께 기존 버튼 클래스를 대상 목록에 넣어 코드 수정 없이도 통일된 눌림을 준다.
const TARGETS = [
  '[data-press]',
  '.tb-btn',
  '.primary-btn',
  '.text-btn',
  '.icon-mini',
  '.doc-card',
  '.mode-card',
  '.menu-item',
  '.store-pop-item',
  '.tree-item',
  '.tree-main',
  '.folder-chip',
  '.seg button',
  '.paper-option',
  '.hidden-cat-chip',
  '.cloud-chip',
  '.cloud-bulk',
  '.cloud-act-main',
  '.cloud-icon-btn',
  '.store-btn',
  '.store-tab',
  '.sync-big',
  '.sync-mini'
].join(',')

// 필기 캔버스와 그 하위, 블록 레이어, 플로팅 도구바/팝오버, 빠른 전환은 제외한다.
const EXCLUDE = '#canvas-root, .block-layer, .blk, .ft-bar, .ft-pop, .ft-probe, .quick-switch'

let installed = false

export function installPress() {
  if (installed || typeof document === 'undefined') return
  installed = true

  let el: HTMLElement | null = null
  let pressedAt = 0
  let pendingTimer = 0
  let releaseTimer = 0

  const clearTimers = () => {
    window.clearTimeout(pendingTimer)
    window.clearTimeout(releaseTimer)
    pendingTimer = 0
    releaseTimer = 0
  }

  const release = () => {
    const target = el
    el = null
    if (!target || !pressedAt) return
    // 눌린 상태를 최소 110ms 유지 (짧은 탭도 눌림이 보이게)
    const held = performance.now() - pressedAt
    const wait = Math.max(0, 110 - held)
    pressedAt = 0
    if (wait > 0) releaseTimer = window.setTimeout(() => target.classList.remove('is-pressed'), wait)
    else target.classList.remove('is-pressed')
  }

  const onDown = (e: PointerEvent) => {
    if (document.documentElement.dataset.motion === 'off') return
    const t = e.target as HTMLElement | null
    const found = t?.closest?.(TARGETS) as HTMLElement | null
    if (!found || found.closest(EXCLUDE)) return
    // 여러 손가락으로 다른 요소를 눌러도 이전 요소의 눌림 표시가 남지 않게 먼저 푼다
    if (el && el !== found) el.classList.remove('is-pressed')
    clearTimers()
    el = found
    if (e.pointerType === 'touch') {
      // 터치는 스크롤과 구분하려고 40ms 지연
      pendingTimer = window.setTimeout(() => {
        if (el !== found) return
        pressedAt = performance.now()
        found.classList.add('is-pressed')
      }, 40)
    } else {
      pressedAt = performance.now()
      found.classList.add('is-pressed')
    }
  }

  const onUp = () => {
    window.clearTimeout(pendingTimer)
    if (pressedAt) release()
    else el = null
  }

  const onScroll = () => {
    clearTimers()
    if (el) {
      el.classList.remove('is-pressed')
      el = null
    }
    pressedAt = 0
  }

  document.addEventListener('pointerdown', onDown, { passive: true, capture: true })
  document.addEventListener('pointerup', onUp, { passive: true, capture: true })
  document.addEventListener('pointercancel', onUp, { passive: true, capture: true })
  window.addEventListener('scroll', onScroll, { passive: true, capture: true })
}
