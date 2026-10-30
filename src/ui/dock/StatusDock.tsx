// 탭 바 오른쪽 상태 칸 — 전송(올리기·받기·가져오기·내보내기)·동기화·저장 공간을 한 줄로 보여 준다.
// 좌우로 넘겨(손가락·트랙패드는 밀기, 마우스는 끌기·휠, 키보드는 ←/→) 다른 쪽을 본다. 쪽은 pages.tsx의 DOCK_PAGES.
// 누르면 칸이 그 자리에서 커지며 자세히 보는 창이 된다(닫으면 다시 칸으로 줄어든다). 화면은 막지 않는다.
// 알림(토스트)이 오면 칸이 알림 쪽으로 넘어가며 그 자리에서 알림창으로 커지고, 시간이 지나면 다시 칸으로 줄어든다.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SPRING, dur } from '../motion/motion'
import { Segmented } from '../Segmented'
import { Icon } from '../Icon'
import { useEscClose } from '../sheetParts'
import { DOCK_PAGES, useActivities, useNotices } from './pages'
import { markNoticesRead, registerDock } from '../../shared/notices'
import { useUI, type Toast } from '../../app/store'

/** 마우스로 이만큼 끌면 누르기가 아니라 넘기기 */
const DRAG_PX = 6
/** 펼친 창 크기 */
const PANEL_W = 400
const PANEL_H = 540
const GAP = 6
const MARGIN = 6 // 탭 바 안쪽 여백과 같게 — 창 오른쪽 끝이 칸 오른쪽 끝과 맞는다
/** 넘기기가 멈췄다고 볼 때까지 */
const SETTLE_MS = 120
/** 알림창(칸이 커진 것) 폭 */
const NOTICE_W = 360
/** 알림 쪽 — 토스트가 이 쪽에서 나온다 */
const NOTICES_PAGE = DOCK_PAGES.findIndex((p) => p.id === 'notices')

interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** 칸 아래로 펼칠 자리 — 칸 오른쪽 끝에 맞춘다 */
function panelBox(anchor: DOMRect): Box {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(PANEL_W, vw - MARGIN * 2)
  const top = anchor.bottom + GAP
  const height = Math.max(200, Math.min(PANEL_H, vh - top - MARGIN))
  const left = Math.max(MARGIN, Math.min(anchor.right - width, vw - MARGIN - width))
  return { left, top, width, height }
}

const px = (b: Box) => ({ left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` })

export function StatusDock() {
  const [page, setPage] = useState(0)
  const [open, setOpen] = useState(false)
  /** 닫는 중 — 줄어드는 동안 창을 남긴다 */
  const [closing, setClosing] = useState(false)
  const dock = useRef<HTMLDivElement>(null)
  /** 눈에 보이는 알약 — 누르는 자리(.dock)는 탭 바 높이만큼 넉넉하고, 펼친 창은 이 알약에서 자란다 */
  const pill = useRef<HTMLDivElement>(null)
  const pager = useRef<HTMLDivElement>(null)
  const activities = useActivities()

  // ── 칸 넘기기 ──
  const goTo = useCallback((i: number, smooth = true) => {
    const n = DOCK_PAGES.length
    const next = (i + n) % n
    setPage(next)
    const el = pager.current
    if (el) el.scrollTo({ left: next * el.clientWidth, behavior: smooth && dur(1) ? 'smooth' : 'auto' })
  }, [])
  // 손가락·트랙패드로 넘긴 뒤 멈춘 자리를 지금 쪽으로 — 스크롤이 잠깐 멈춘 뒤에 본다
  // (부드럽게 넘기는 도중의 자리를 쪽으로 읽으면 출발한 쪽으로 되돌아간다)
  const settle = useSettle(pager, (i) => {
    if (!drag.current?.moved) setPage(i)
  })
  // 새 일이 시작되면 전송 쪽으로 돌아와 보여 준다
  const lastId = useRef(0)
  useEffect(() => {
    const newest = activities.filter((a) => a.state === 'running').reduce((m, a) => Math.max(m, a.id), 0)
    if (newest > lastId.current) {
      lastId.current = newest
      if (page !== 0) goTo(0)
    }
  }, [activities, page, goTo])
  // 알림(토스트)이 오면 알림 쪽으로 넘어온다 — 토스트는 이 칸 바로 아래로 내려온다(app/App Toasts)
  const notices = useNotices()
  const lastNotice = useRef(0)
  useEffect(() => {
    const newest = notices.length ? notices[notices.length - 1].id : 0
    if (newest > lastNotice.current) {
      lastNotice.current = newest
      if (page !== NOTICES_PAGE) goTo(NOTICES_PAGE)
    }
  }, [notices, page, goTo])
  // 칸 폭이 바뀌면(창 크기) 지금 쪽에 다시 맞춘다
  const pageRef = useRef(page)
  pageRef.current = page
  useLayoutEffect(() => {
    const el = pager.current
    if (!el) return
    let w = el.clientWidth
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w) return
      w = el.clientWidth
      el.scrollLeft = pageRef.current * w
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 마우스: 끌어서 넘기기 · 세로 휠도 옆으로 (손가락·펜은 브라우저가 밀어 준다)
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null)
  const swallow = useRef(false)
  const onPointerDown = (e: React.PointerEvent) => {
    swallow.current = false
    if (e.pointerType !== 'mouse' || e.button !== 0 || !pager.current) return
    drag.current = { x: e.clientX, left: pager.current.scrollLeft, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    const el = pager.current
    if (!d || !el) return
    const dx = e.clientX - d.x
    if (!d.moved && Math.abs(dx) < DRAG_PX) return
    if (!d.moved) {
      d.moved = true
      el.setPointerCapture(e.pointerId)
      el.classList.add('is-dragging')
    }
    el.scrollLeft = d.left - dx
  }
  const onPointerUp = () => {
    const d = drag.current
    const el = pager.current
    drag.current = null
    if (!d?.moved || !el) return
    swallow.current = true
    const moved = el.scrollLeft - d.left
    const step = Math.abs(moved) > el.clientWidth * 0.2 ? Math.sign(moved) : 0
    goTo(Math.round(d.left / el.clientWidth) + step)
    el.classList.remove('is-dragging') // 끈 자리에서 목표 쪽으로 미끄러진 뒤에 다시 쪽에 붙는다
  }
  const wheelAt = useRef(0)
  const onWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return // 옆으로 미는 건 브라우저가 넘긴다
    const now = Date.now()
    if (now - wheelAt.current < 350 || Math.abs(e.deltaY) < 4) return
    wheelAt.current = now
    goTo(page + Math.sign(e.deltaY))
  }

  // ── 펼치기 ──
  const panel = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<Box | null>(null)
  const anchor = () => pill.current!.getBoundingClientRect()
  const toggle = () => {
    if (swallow.current) {
      swallow.current = false
      return
    }
    if (open) close()
    else {
      setBox(panelBox(anchor()))
      setOpen(true)
    }
  }
  // 칸 자리에서 창 크기까지 커진다 — 안의 글자는 창 크기로 먼저 놓아 두고 겉모양만 자라서 글자가 늘어나지 않는다
  useLayoutEffect(() => {
    const el = panel.current
    if (!open || closing || !el || !box) return
    const from = anchor()
    const t = dur(460)
    if (!t) return
    el.animate(
      [
        // 둥근 정도는 칸의 실제 반지름(높이의 절반)에서 — 999px에서 줄이면 자라는 동안 큰 타원이 된다
        { ...px({ left: from.left, top: from.top, width: from.width, height: from.height }), borderRadius: `${from.height / 2}px` },
        { ...px(box), borderRadius: 'var(--r-xl)' }
      ],
      { duration: t, easing: SPRING }
    )
    el.querySelector('.dock-panel-inner')?.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], {
      duration: dur(260),
      delay: dur(120),
      easing: 'ease-out',
      fill: 'backwards'
    })
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const close = useCallback(() => {
    const el = panel.current
    if (!el || closing) return
    const to = pill.current!.getBoundingClientRect()
    const t = dur(320)
    const done = () => {
      setOpen(false)
      setClosing(false)
    }
    if (!t) return done()
    setClosing(true)
    el.querySelector('.dock-panel-inner')?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur(110), fill: 'forwards' })
    el.animate([{ ...px(box!), borderRadius: 'var(--r-xl)' }, { ...px({ left: to.left, top: to.top, width: to.width, height: to.height }), borderRadius: `${to.height / 2}px` }], {
      duration: t,
      easing: 'cubic-bezier(.3,0,.2,1)',
      fill: 'forwards'
    }).onfinish = done
  }, [box, closing])
  useEscClose(close, open)

  // 창 밖을 누르면 닫는다 (칸을 누르면 칸이 닫는다)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (panel.current?.contains(t) || dock.current?.contains(t)) return
      if ((t as Element).closest?.('.dialog-host, .menu')) return
      close()
    }
    const onResize = () => setBox(panelBox(anchor()))
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, close])

  // 실패한 일이 있는데 아직 창을 열어 보지 않았으면 칸에 빨간 점
  const [seenAt, setSeenAt] = useState(0)
  useEffect(() => {
    if (open) setSeenAt(Date.now())
  }, [open, activities])
  const unseenError = activities.some((a) => a.state === 'error' && (a.endedAt ?? 0) > seenAt)

  // 알림 쪽을 펼쳐 보면 읽은 것으로
  useEffect(() => {
    if (open && page === NOTICES_PAGE) markNoticesRead()
  }, [open, page, notices])

  // ── 알림창 — 칸 자체가 커져 알림을 보여 준다 ──
  // 칸 오른쪽 위 모서리에 붙어 아래·왼쪽으로 자라고, 알림이 모두 사라지면 다시 칸으로 줄어든다.
  // 펼친 창(자세히)이 열려 있으면 알림창을 띄우지 않는다 — 창의 알림 쪽에 바로 쌓인다
  useEffect(registerDock, [])
  const toasts = useUI((s) => s.toasts)
  const dismissToast = useUI((s) => s.dismissToast)
  const noticeOn = toasts.length > 0 && !open
  /** 보이는 알림 — 사라지는 동안(줄어드는 동안)에도 마지막 내용을 남긴다 */
  const [shown, setShown] = useState<Toast[]>([])
  const [noticeLeaving, setNoticeLeaving] = useState(false)
  const notice = useRef<HTMLDivElement>(null)
  const noticeH = useRef(0)
  useEffect(() => {
    if (noticeOn) {
      // 줄어드는 도중에 새 알림이 오면 줄어들기를 멈추고 그 크기에서 다시 맞춘다
      if (noticeLeaving) for (const a of notice.current?.getAnimations({ subtree: true }) ?? []) a.cancel()
      setShown(toasts)
      setNoticeLeaving(false)
    } else if (shown.length && !noticeLeaving) setNoticeLeaving(true)
  }, [noticeOn, toasts]) // eslint-disable-line react-hooks/exhaustive-deps
  const noticeBox = () => {
    const a = anchor()
    const vw = window.innerWidth
    const width = Math.min(NOTICE_W, vw - MARGIN * 2)
    return { left: Math.max(MARGIN, Math.min(a.right - width, vw - MARGIN - width)), top: a.top, width }
  }
  const [nPos, setNPos] = useState<{ left: number; top: number; width: number } | null>(null)
  const noticeMounted = shown.length > 0
  // 칸 자리에서 알림창 크기로 커진다 / 알림이 늘거나 줄면 높이를 부드럽게
  useLayoutEffect(() => {
    const el = notice.current
    if (!el || noticeLeaving) return
    const r = el.getBoundingClientRect()
    const first = noticeH.current === 0
    const prevH = noticeH.current
    noticeH.current = r.height
    const t = dur(first ? 460 : 260)
    if (!t) return
    if (first) {
      const from = anchor()
      el.animate(
        [
          { ...px({ left: from.left, top: from.top, width: from.width, height: from.height }), borderRadius: `${from.height / 2}px` },
          { ...px({ left: r.left, top: r.top, width: r.width, height: r.height }), borderRadius: 'var(--r-xl)' }
        ],
        { duration: t, easing: SPRING }
      )
      el.querySelector('.dock-notice-inner')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur(220), delay: dur(100), easing: 'ease-out', fill: 'backwards' })
    } else if (Math.abs(prevH - r.height) > 1) {
      el.animate([{ height: `${prevH}px` }, { height: `${r.height}px` }], { duration: t, easing: SPRING })
    }
  }, [shown, noticeLeaving, nPos])
  // 다 사라지면 칸으로 줄어든 뒤 내린다
  useLayoutEffect(() => {
    const el = notice.current
    if (!noticeLeaving) return
    const done = () => {
      setShown([])
      setNoticeLeaving(false)
      noticeH.current = 0
    }
    const t = dur(320)
    if (!el || !t) return done()
    const r = el.getBoundingClientRect()
    const to = anchor()
    el.querySelector('.dock-notice-inner')?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur(110), fill: 'forwards' })
    el.animate(
      [
        { ...px({ left: r.left, top: r.top, width: r.width, height: r.height }), borderRadius: 'var(--r-xl)' },
        { ...px({ left: to.left, top: to.top, width: to.width, height: to.height }), borderRadius: `${to.height / 2}px` }
      ],
      { duration: t, easing: 'cubic-bezier(.3,0,.2,1)', fill: 'forwards' }
    ).onfinish = done
  }, [noticeLeaving])
  // 자리는 띄울 때와 창 크기가 바뀔 때 칸을 다시 재서
  useLayoutEffect(() => {
    if (!noticeMounted) return setNPos(null)
    setNPos(noticeBox())
    const onResize = () => setNPos(noticeBox())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [noticeMounted]) // eslint-disable-line react-hooks/exhaustive-deps
  /** 알림창을 누르면 — 알림을 닫고 그 자리에서 자세히 보는 창(알림 쪽)을 연다 */
  const openNotices = () => {
    for (const t of useUI.getState().toasts) dismissToast(t.id)
    setShown([])
    setNoticeLeaving(false)
    noticeH.current = 0
    goTo(NOTICES_PAGE, false)
    setBox(panelBox(anchor()))
    setOpen(true)
  }

  const cur = DOCK_PAGES[page]
  return (
    <>
      <div
        ref={dock}
        className={'dock' + (open ? ' is-open' : '') + (noticeMounted ? ' is-noticing' : '')}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`상태: ${cur.label} — 눌러서 자세히 보기`}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault()
            goTo(page + (e.key === 'ArrowLeft' ? -1 : 1))
          }
        }}
      >
        <div className="dock-pill" ref={pill}>
          <div
            ref={pager}
            className="dock-pager"
            onScroll={settle}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
          >
            {DOCK_PAGES.map((p, i) => (
              <div key={p.id} className="dock-page" aria-hidden={i !== page}>
                <p.Compact />
              </div>
            ))}
          </div>
          <div className="dock-dots" aria-hidden="true">
            {DOCK_PAGES.map((p, i) => (
              <i key={p.id} className={i === page ? 'is-on' : ''} />
            ))}
          </div>
          {unseenError && <span className="dock-alert" aria-label="실패한 일이 있습니다" />}
        </div>
      </div>

      {/* 화면 읽기 도구에는 알림창이 뜨기 전부터 있는 자리에서 읽어 준다 */}
      <div className="dock-live" aria-live="polite">
        {toasts.length ? toasts[toasts.length - 1].text : ''}
      </div>

      {noticeMounted &&
        nPos &&
        createPortal(
          <div
            ref={notice}
            className="dock-notice"
            style={{ left: nPos.left, top: nPos.top, width: nPos.width }}
            role="group"
            aria-label="알림"
            onClick={openNotices}
          >
            <div className="dock-notice-inner" style={{ width: nPos.width }}>
              {shown
                .slice()
                .reverse()
                .map((t) => (
                  <div key={t.id} className={'toast dock-notice-row ' + t.kind}>
                    <span className="dock-notice-ic" aria-hidden="true">
                      <Icon name={t.kind === 'error' ? 'xCircle' : t.kind === 'success' ? 'checkCircle' : 'bell'} size={16} />
                    </span>
                    <span className="dock-notice-text">{t.text}</span>
                    {t.action && (
                      <button
                        className="dock-notice-action"
                        onClick={(e) => {
                          e.stopPropagation()
                          t.action!.run()
                          dismissToast(t.id)
                        }}
                      >
                        {t.action.label}
                      </button>
                    )}
                    <button
                      className="toast-close"
                      onClick={(e) => {
                        e.stopPropagation()
                        dismissToast(t.id)
                      }}
                      aria-label="닫기"
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                ))}
            </div>
          </div>,
          document.body
        )}

      {open &&
        box &&
        createPortal(
          <div ref={panel} className="dock-panel" style={px(box)} role="dialog" aria-label="상태">
            <div className="dock-panel-inner" style={{ width: box.width, height: box.height }}>
              <header className="dock-panel-head">
                <Segmented value={cur.id} options={DOCK_PAGES.map((p) => [p.id, p.label] as [string, string])} onChange={(id) => goTo(DOCK_PAGES.findIndex((p) => p.id === id), false)} label="상태 쪽" />
                <button className="tb-btn" onClick={close} aria-label="닫기">
                  <Icon name="close" size={18} />
                </button>
              </header>
              <DetailPager page={page} onPage={(i) => goTo(i, false)} />
            </div>
          </div>,
          document.body
        )}
    </>
  )
}

/** 펼친 창의 쪽들 — 칸과 같은 쪽을 보여 주고, 좌우로 밀어 넘긴다 */
function DetailPager({ page, onPage }: { page: number; onPage: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const first = useRef(true)
  const settle = useSettle(ref, (i) => i !== page && onPage(i))
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const left = page * el.clientWidth
    if (Math.abs(el.scrollLeft - left) < 2) return
    el.scrollTo({ left, behavior: first.current || !dur(1) ? 'auto' : 'smooth' })
    first.current = false
  }, [page])
  return (
    <div ref={ref} className="dock-panel-pager" onScroll={settle}>
      {DOCK_PAGES.map((p, i) => (
        <div key={p.id} className="dock-panel-page" aria-hidden={i !== page}>
          <p.Detail />
        </div>
      ))}
    </div>
  )
}

/** 가로로 넘기는 칸이 멈추면 몇째 쪽에 섰는지 알린다 — onScroll에 건다 */
function useSettle(ref: React.RefObject<HTMLDivElement | null>, onPage: (i: number) => void) {
  const timer = useRef(0)
  const cb = useRef(onPage)
  cb.current = onPage
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const el = ref.current
      if (el?.clientWidth) cb.current(Math.round(el.scrollLeft / el.clientWidth))
    }, SETTLE_MS)
  }, [ref])
}
