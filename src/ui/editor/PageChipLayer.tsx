// 페이지 칩 — 페이지마다 바깥 왼쪽 위(회색 여백)에 '번호 ⋯'를 띄우고, 누르면 그 페이지 메뉴(PageMenu)를 연다.
// 페이지 위에는 절대 얹지 않는다: 왼쪽 여백에 자리가 없으면 페이지 위쪽 틈으로, 거기도 모자라면 숨긴다.
// 긴 페이지를 내려 읽는 동안에는 화면 위에 붙어 따라 내려온다(페이지 아래 끝까지). 칩은 배율과 관계없이 같은 크기다.
// 카메라가 움직이면 React를 거치지 않고 style만 고친다 (SheetLayer와 같게).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Engine } from '../../engine/engine'
import type { ID, Page } from '../../shared/model'
import { useUI } from '../../app/store'
import { Icon } from '../Icon'
import { PageMenu } from './PageMenu'

const GAP = 6 // 칩과 페이지(또는 왼쪽에 붙은 보조 용지) 사이
const EDGE = 4 // 화면 가장자리와의 최소 틈

export function PageChipLayer({ engine, pages, readOnly }: { engine: Engine; pages: Page[]; readOnly: boolean }) {
  useSyncExternalStore(engine.subscribeSheets, engine.sheetsVersion) // 왼쪽 보조 용지를 비켜 선다
  const current = useUI((s) => s.view.currentPage)
  const layerRef = useRef<HTMLDivElement>(null)
  const chips = useRef(new Map<ID, HTMLElement>())
  const [menu, setMenu] = useState<{ index: number; x: number; y: number } | null>(null)

  const place = useCallback(() => {
    const layer = layerRef.current
    if (!layer) return
    const { x: cx, y: cy, zoom } = engine.cam
    const H = layer.clientHeight
    const sx = (wx: number) => (wx - cx) * zoom
    const sy = (wy: number) => (wy - cy) * zoom
    // 화면 좌표의 보조 용지 사각형 — 칩이 이것들과도 겹치지 않게
    const sheets: { l: number; t: number; r: number; b: number }[] = []
    for (const s of engine.sheets) {
      const r = engine.layout.rects.get(s.id)
      if (r) sheets.push({ l: sx(r.x), t: sy(r.y), r: sx(r.x + r.w), b: sy(r.y + r.h) })
    }
    let prevBottom = -Infinity // 바로 위 페이지의 아래 끝(화면) — 위쪽 틈 크기
    for (const p of engine.pages) {
      const el = chips.current.get(p.id)
      const r = engine.layout.rects.get(p.id)
      if (!el) continue
      const top = r ? sy(r.y) : 0
      const bottom = r ? sy(r.y + r.h) : 0
      const gapAbove = top - Math.max(prevBottom, 0)
      if (r) prevBottom = bottom
      if (!r || bottom < 0 || top > H) {
        el.style.display = 'none'
        continue
      }
      el.style.display = ''
      const w = el.offsetWidth
      const h = el.offsetHeight
      // ① 왼쪽 여백 — 페이지 위 끝에 맞추고, 내려 읽는 동안에는 화면 위에 붙어 따라온다
      let y = Math.min(Math.max(top, EDGE), bottom - h)
      let right = sx(r.x) - GAP
      for (let moved = true; moved; ) {
        moved = false
        for (const s of sheets)
          if (s.l < right && s.r > right - w && s.t < y + h && s.b > y) {
            right = s.l - GAP
            moved = true
          }
      }
      let x = right - w
      if (x < EDGE) {
        // ② 페이지 위쪽 틈 — 왼쪽 끝에 맞춰 페이지 바로 위에
        if (gapAbove < h + 2) {
          el.style.display = 'none'
          continue
        }
        x = Math.max(EDGE, sx(r.x))
        y = top - h - 2
      }
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
    }
  }, [engine])

  useEffect(() => engine.onCamera(place), [engine, place])
  useLayoutEffect(place)
  // 칸 크기가 바뀌면(사이드바 열고 닫기·창 크기) 다시 놓는다
  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    const ro = new ResizeObserver(place)
    ro.observe(layer)
    const onWheel = (e: WheelEvent) => engine.overlayWheel(e) // 칩 위 휠도 화면 이동·확대로
    layer.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      ro.disconnect()
      layer.removeEventListener('wheel', onWheel)
    }
  }, [engine, place])

  return (
    <div className="page-chip-layer" ref={layerRef}>
      {pages.map((p, i) => (
        <button
          key={p.id}
          ref={(el) => {
            if (el) chips.current.set(p.id, el)
            else chips.current.delete(p.id)
          }}
          className={'page-chip' + (i === current ? ' is-current' : '') + (menu?.index === i ? ' is-open' : '')}
          data-index={i}
          aria-label={`${i + 1}페이지 메뉴`}
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu({ index: i, x: r.left + 184, y: r.bottom }) // 메뉴 최소 폭(184) — 칩 왼쪽 끝에 맞춰 아래로
          }}
        >
          <span className="page-chip-num">{i + 1}</span>
          <Icon name="more" size={14} />
        </button>
      ))}
      {menu && <PageMenu engine={engine} index={menu.index} x={menu.x} y={menu.y} readOnly={readOnly} onClose={() => setMenu(null)} />}
    </div>
  )
}
