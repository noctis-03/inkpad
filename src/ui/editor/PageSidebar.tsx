import { memo, useEffect, useRef, useState } from 'react'
import type { Engine } from '../../engine/engine'
import type { Page } from '../../shared/model'
import { useUI } from '../../app/store'
import { Icon } from '../Icon'
import { PageMenu } from './PageMenu'

const THUMB_W = 120

/** 썸네일 사이드바: 보이는 썸네일만 그리고, 길게 눌러 끌면 순서 변경 */
export function PageSidebar({ engine, pages, tick }: { engine: Engine; pages: Page[]; tick: number }) {
  const current = useUI((s) => s.view.currentPage)
  const listRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ index: number; x: number; y: number } | null>(null)
  const [drag, setDrag] = useState<{ from: number; over: number; y: number } | null>(null)
  const dragRef = useRef<{ from: number; pointerId: number; timer: number; active: boolean; startY: number } | null>(null)

  // 현재 페이지가 보이도록 스크롤
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const indexAt = (clientY: number) => {
    const items = listRef.current?.querySelectorAll<HTMLElement>('.thumb-item') ?? []
    for (const el of items) {
      const r = el.getBoundingClientRect()
      if (clientY < r.top + r.height / 2) return Number(el.dataset.index)
    }
    return pages.length
  }

  const onPointerDown = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return
    const target = e.currentTarget as HTMLElement
    const pointerId = e.pointerId
    const timer = window.setTimeout(() => {
      if (!dragRef.current) return
      dragRef.current.active = true
      try {
        target.setPointerCapture(pointerId)
      } catch {
        /* noop */
      }
      setDrag({ from: index, over: index, y: dragRef.current.startY })
    }, 350)
    dragRef.current = { from: index, pointerId, timer, active: false, startY: e.clientY }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    if (!d.active) {
      if (Math.abs(e.clientY - d.startY) > 8) {
        clearTimeout(d.timer)
        dragRef.current = null // 스크롤로 판단
      }
      return
    }
    setDrag({ from: d.from, over: indexAt(e.clientY), y: e.clientY })
  }
  const onPointerUp = (e: React.PointerEvent, index: number) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    clearTimeout(d.timer)
    if (d.active) {
      let to = indexAt(e.clientY)
      if (to > d.from) to -= 1
      setDrag(null)
      if (to !== d.from) engine.movePage(d.from, to)
    } else engine.scrollToPage(index)
  }

  return (
    <aside id="page-sidebar" className="page-sidebar" aria-label="페이지">
      <div className="thumb-list" ref={listRef}>
        {pages.map((p, i) => (
          <div
            key={p.id}
            data-index={i}
            className={
              'thumb-item' +
              (i === current ? ' is-current' : '') +
              (drag?.from === i ? ' is-dragging' : '') +
              (drag && drag.over === i && drag.from !== i ? ' drop-before' : '') +
              (drag && drag.over === pages.length && i === pages.length - 1 ? ' drop-after' : '')
            }
            onPointerDown={(e) => onPointerDown(e, i)}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => onPointerUp(e, i)}
            onPointerCancel={() => {
              if (dragRef.current) clearTimeout(dragRef.current.timer)
              dragRef.current = null
              setDrag(null)
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Thumb engine={engine} page={p} rev={engine.pageRev.get(p.id) ?? 0} tick={tick} />
            <div className="thumb-footer">
              <span>{i + 1}</span>
              <button
                className="icon-mini"
                aria-label={`${i + 1}페이지 메뉴`}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setMenu({ index: i, x: r.right + 220, y: r.top })
                }}
              >
                <Icon name="more" size={16} />
              </button>
            </div>
          </div>
        ))}
        <button className="add-page-btn" onClick={() => engine.addPage(pages.length - 1)}>
          <Icon name="plus" size={18} /> 페이지 추가
        </button>
      </div>
      {menu && <PageMenu engine={engine} index={menu.index} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </aside>
  )
}

/** 화면에 보일 때만 그리는 썸네일. 페이지 내용(rev)이 바뀌면 조금 기다렸다 다시 그린다 */
const Thumb = memo(function Thumb({ engine, page, rev }: { engine: Engine; page: Page; rev: number; tick: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const ratio = page.size ? page.size.h / page.size.w : 1.3

  useEffect(() => {
    const el = ref.current!
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const t = setTimeout(async () => {
      const c = await engine.renderPageThumb(page.id, THUMB_W * 2)
      if (cancelled || !c) return
      c.toBlob((b) => {
        if (cancelled || !b) return
        setUrl((old) => {
          if (old) URL.revokeObjectURL(old)
          return URL.createObjectURL(b)
        })
      }, 'image/png')
    }, url ? 600 : 0)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, rev, page.background, page.size?.w, page.size?.h, engine, page.id])

  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url])

  return (
    <div ref={ref} className="thumb" style={{ aspectRatio: `${1 / ratio}` }}>
      {url && <img src={url} alt="" draggable={false} />}
    </div>
  )
})
