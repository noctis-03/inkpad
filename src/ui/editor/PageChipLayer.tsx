// 페이지 칩 — 페이지마다 바깥 왼쪽 위(회색 여백)에 '페이지 n'과 그 아래 버튼 한 줄(⋯ 페이지 메뉴 · 100 · 화면에 맞춤)을 띄운다.
// 100은 폭 맞춤 배율(페이지 노트의 100%), 화면에 맞춤은 페이지 한 장이 다 보이게.
// 페이지 위에는 절대 얹지 않는다: 왼쪽 여백에 자리가 없으면 페이지 위쪽 틈에 가로 한 줄로, 거기도 모자라면 숨긴다.
// 긴 페이지를 내려 읽는 동안에는 화면 위에 붙어 따라 내려온다(페이지 아래 끝까지).
// 칩은 배율을 따라 커지고 작아지지 않지만, 많이 축소하면 단계별로 작아진다(SIZES).
// 카메라가 움직이면 React를 거치지 않고 style만 고친다 (SheetLayer와 같게).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Engine } from '../../engine/engine'
import type { ID, Page } from '../../shared/model'
import { useUI } from '../../app/store'
import { Icon } from '../Icon'
import { PageMenu } from './PageMenu'

const GAP = 6 // 칩과 페이지(또는 왼쪽에 붙은 보조 용지) 사이
const EDGE = 4 // 화면 가장자리와의 최소 틈
/** 폭 맞춤(100%)에 대한 배율이 이보다 작으면 칩을 한 단계 작게 */
const SIZES: [number, string][] = [
  [0.45, 'xs'],
  [0.75, 's']
]

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
    const rel = zoom / engine.fitWidthZoom()
    layer.toggleAttribute('data-z100', Math.abs(rel - 1) < 0.005) // 100 버튼을 켜진 모양으로
    const size = SIZES.find(([max]) => rel < max)?.[1]
    if (layer.dataset.size !== size) {
      if (size) layer.dataset.size = size
      else delete layer.dataset.size
    }
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
      // ① 왼쪽 여백에 세로로 — 페이지 위 끝에 맞추고, 내려 읽는 동안에는 화면 위에 붙어 따라온다
      if (el.classList.contains('is-row')) el.classList.remove('is-row')
      let w = el.offsetWidth
      let h = el.offsetHeight
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
        // ② 페이지 위쪽 틈에 가로 한 줄로 — 왼쪽 끝에 맞춰 페이지 바로 위에
        el.classList.add('is-row')
        w = el.offsetWidth
        h = el.offsetHeight
        if (gapAbove < h + 2) {
          el.style.display = 'none'
          continue
        }
        x = Math.max(EDGE, Math.min(sx(r.x), layer.clientWidth - w - EDGE))
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
        <div
          key={p.id}
          ref={(el) => {
            if (el) chips.current.set(p.id, el)
            else chips.current.delete(p.id)
          }}
          className={'page-chip' + (i === current ? ' is-current' : '') + (menu?.index === i ? ' is-open' : '')}
          data-index={i}
          role="group"
          aria-label={`${i + 1}페이지`}
        >
          <span className="page-chip-label">페이지 {i + 1}</span>
          <div className="page-chip-btns">
            <button
              className="page-chip-btn page-chip-menu"
              aria-label={`${i + 1}페이지 메뉴`}
              aria-haspopup="menu"
              title="페이지 메뉴"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setMenu({ index: i, x: r.left + 184, y: r.bottom }) // 메뉴 최소 폭(184) — 버튼 왼쪽 끝에 맞춰 아래로
              }}
            >
              <Icon name="more" size={16} />
            </button>
            <button className="page-chip-btn page-chip-z100" aria-label="배율 100% (폭 맞춤)" title="배율 100% (폭 맞춤)" onClick={() => engine.zoomPage(i, engine.fitWidthZoom())}>
              100
            </button>
            <button className="page-chip-btn" aria-label="화면에 맞춤" title="화면에 맞춤 (페이지 전체)" onClick={() => engine.fitPage(i)}>
              <Icon name="fit" size={16} />
            </button>
          </div>
        </div>
      ))}
      {menu && <PageMenu engine={engine} index={menu.index} x={menu.x} y={menu.y} readOnly={readOnly} onClose={() => setMenu(null)} />}
    </div>
  )
}
