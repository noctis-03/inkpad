import { useEffect } from 'react'

const prefersReduced = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** 카드 3D 틸트를 적용할 대상 */
const TILT_SELECTOR = '.doc-grid .doc-card, .library-main .doc-card'

/**
 * 전역 인터랙티브 모션그래픽 레이어.
 *
 * - 탭/클릭 지점에 리플(잉크 번짐) + 스파크 버스트
 * - 마우스 hover 시 문서 카드가 시선을 따라 기우는 3D 틸트 (+ 광원 하이라이트)
 * - DOM을 직접 조작해 React 리렌더 없이 애니메이션한다 (필기 엔진 성능에 영향 없음)
 */
export function MotionLayer() {
  useEffect(() => {
    if (prefersReduced()) return
    const host = document.createElement('div')
    host.className = 'mg-layer'
    host.setAttribute('aria-hidden', 'true')
    document.body.appendChild(host)

    const spawn = (type: string, x: number, y: number) => {
      const el = document.createElement('span')
      el.className = `mg-bit mg-${type}`
      el.style.left = `${x}px`
      el.style.top = `${y}px`
      host.appendChild(el)
      const done = () => el.remove()
      el.addEventListener('animationend', done, { once: true })
      window.setTimeout(done, 1400)
      return el
    }

    const burst = (x: number, y: number) => {
      spawn('ripple', x, y)
      const n = 7
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.8
        const d = 20 + Math.random() * 30
        const el = spawn('spark', x, y)
        el.style.setProperty('--dx', `${Math.cos(a) * d}px`)
        el.style.setProperty('--dy', `${Math.sin(a) * d}px`)
        el.style.setProperty('--h', `${195 + Math.random() * 70}`)
      }
    }

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const t = e.target as HTMLElement | null
      // 필기 면(캔버스)·명시적 제외 영역에서는 잉크 리플을 띄우지 않는다
      if (t?.closest?.('.editor-area, .mg-ignore')) return
      burst(e.clientX, e.clientY)
    }

    const canHover = !!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches
    let tiltEl: HTMLElement | null = null
    const resetTilt = () => {
      if (!tiltEl) return
      const el = tiltEl
      tiltEl = null
      el.removeAttribute('data-mg-tilt')
      el.style.removeProperty('--tx')
      el.style.removeProperty('--ty')
      el.style.removeProperty('--gx')
      el.style.removeProperty('--gy')
    }
    const onMove = (e: PointerEvent) => {
      if (!canHover || e.pointerType !== 'mouse') return
      const card = (e.target as HTMLElement | null)?.closest?.(TILT_SELECTOR) as HTMLElement | null
      if (!card) {
        resetTilt()
        return
      }
      if (tiltEl && tiltEl !== card) resetTilt()
      tiltEl = card
      const r = card.getBoundingClientRect()
      const px = r.width ? (e.clientX - r.left) / r.width - 0.5 : 0
      const py = r.height ? (e.clientY - r.top) / r.height - 0.5 : 0
      card.setAttribute('data-mg-tilt', '')
      card.style.setProperty('--tx', `${(-py * 7).toFixed(2)}deg`)
      card.style.setProperty('--ty', `${(px * 9).toFixed(2)}deg`)
      card.style.setProperty('--gx', `${((px + 0.5) * 100).toFixed(1)}%`)
      card.style.setProperty('--gy', `${((py + 0.5) * 100).toFixed(1)}%`)
    }

    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerleave', resetTilt, true)
    window.addEventListener('blur', resetTilt)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerleave', resetTilt, true)
      window.removeEventListener('blur', resetTilt)
      host.remove()
    }
  }, [])

  return null
}
