import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isTabRoute, routeKey, useUI, type Route, type Toast } from './store'
import { DialogHost } from './dialogs'
import { MergeHost } from '../ui/merge/MergeView'
import { ArchiveHost } from '../ui/ArchiveSheet'
import { ChangesHost } from '../ui/ChangesView'
import { installSyncReminders } from './syncReminders'
import { Library } from '../ui/library/Library'
import { Board } from '../ui/board/Board'
import { DocEditor } from '../ui/editor/DocEditor'
import { AppRunner } from '../ui/app/AppRunner'
import type { PaneSlot } from '../ui/app/RunnerNav'
import { FileRunner } from '../ui/app/FileRunner'
import { Icon } from '../ui/Icon'
import { TabBar, useSplitAllowed } from '../ui/TabBar'
import type { ID } from '../shared/model'
import { isStandalone } from '../shared/util'
import { purgeExpiredTrash } from '../storage/repo'
import { installPress } from '../ui/motion/press'
import { dur } from '../ui/motion/motion'

export function App() {
  useEffect(() => {
    // 휴지통 30일 정리 (로컬). 서버 쪽은 Phase 2에서 요청 시 lazy 정리
    void purgeExpiredTrash().catch(() => {})
  }, [])

  // 동기화 편의 — 앱 아이콘 배지, (켰다면) 앱을 열 때·돌아올 때 클라우드 확인
  useEffect(() => installSyncReminders(), [])

  // 모션 단계 결정 — auto는 OS '동작 줄이기'를 따르고, 결과를 <html data-motion>에 반영한다
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => {
      const pref = useUI.getState().settings.motion
      const level = pref === 'auto' ? (mq.matches ? 'off' : 'normal') : pref
      document.documentElement.dataset.motion = level
    }
    apply()
    mq.addEventListener('change', apply)
    const unsub = useUI.subscribe(apply) // 설정에서 모션을 바꾸면 즉시 반영
    return () => {
      mq.removeEventListener('change', apply)
      unsub()
    }
  }, [])

  // 테마 결정 — auto 는 기기 외관을 따르고, 결과를 <html data-theme> 에 반영한다.
  // 다크 팔레트는 styles/01-base.css 의 :root[data-theme='dark'] 블록에 있다.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const pref = useUI.getState().settings.theme ?? 'auto'
      const theme = pref === 'auto' ? (mq.matches ? 'dark' : 'light') : pref
      document.documentElement.dataset.theme = theme
    }
    apply()
    mq.addEventListener('change', apply)
    const unsub = useUI.subscribe(apply) // 설정에서 테마를 바꾸면 즉시 반영
    return () => {
      mq.removeEventListener('change', apply)
      unsub()
    }
  }, [])

  // 전역 누름 피드백 (ui/motion/press)
  useEffect(() => {
    installPress()
  }, [])
  return (
    <div className="app-shell">
      <TabBar />
      <Panes />
      <InstallHint />
      <Toasts />
      <MergeHost />
      <ArchiveHost />
      <ChangesHost />
      <DialogHost />
    </div>
  )
}

/** 숨겨 두고 켜 둘 앱 수 — 앱 탭을 오가도 앱 안의 상태가 남는다. 넘으면 가장 오래 안 본 앱부터 끈다 */
const ALIVE_APPS = 5

/**
 * 가운데 칸(지금 탭)과 옆 칸(듀얼). 모든 칸은 같은 부모 아래에서 CSS grid 자리(main·side·숨김)만 바꾼다 —
 * iframe은 DOM에서 옮기면 다시 로드되므로 앱 칸은 늘 같은 순서(앱 ID 순)로 먼저 그리고 자리만 바꾼다.
 * 노트·파일·라이브러리는 볼 때만 그린다 (노트 편집 화면은 무겁고, 보던 위치는 노트가 기억한다).
 */
function Panes() {
  const route = useUI((s) => s.route)
  const split = useUI((s) => s.split)
  const tabs = useUI((s) => s.tabs)
  const ratio = useUI((s) => s.splitRatio)
  const side = useUI((s) => s.splitSide)
  const splitAllowed = useSplitAllowed()
  const sideOn = !!split && splitAllowed
  const box = useRef<HTMLDivElement>(null)

  // 이번에 켠 앱 (최근 본 순서) — 다시 켜면 탭만 남고 앱은 볼 때 켠다
  const [recent, setRecent] = useState<ID[]>([])
  const now = [route.name === 'app' ? route.appId : null, split?.name === 'app' ? split.appId : null].filter((x): x is ID => !!x)
  const open = new Set(tabs.flatMap((t) => (t.name === 'app' ? [t.appId] : [])))
  useEffect(() => {
    setRecent((prev) => {
      const next = [...prev.filter((id) => !now.includes(id) && open.has(id)), ...now]
      while (next.length > ALIVE_APPS) next.splice(next.findIndex((id) => !now.includes(id)), 1)
      return next.length === prev.length && next.every((id, i) => id === prev[i]) ? prev : next
    })
  }) // 매 렌더 — 같으면 그대로 둔다
  const alive = [...new Set([...recent.filter((id) => open.has(id)), ...now])].sort()

  const mainKey = isTabRoute(route) ? routeKey(route) : route.name
  const sideKey = split ? routeKey(split) : null
  const slot = (key: string): PaneSlot => (key === mainKey ? 'main' : sideOn && key === sideKey ? 'side' : 'hidden')

  // ── 노트 열기·닫기 크로스페이드 ──
  // 홈(라이브러리·작업보드)과 노트를 오갈 때 바뀌기 전 화면을 잠깐 남겨 겹쳐 바꾼다: 열 때는 라이브러리 위로 편집 화면이
  // 서서히 나타나고, 닫을 때는 편집 화면이 라이브러리 위에서 서서히 사라진다. 같은 렌더에서 남겨야 바뀌기 전 화면이
  // 다시 마운트되지 않으므로 렌더 중에 판정한다(React의 '이전 값에서 상태 고치기' 방식)
  const [prevMain, setPrevMain] = useState({ key: mainKey, route })
  const [leaving, setLeaving] = useState<Leaving | null>(null)
  if (prevMain.key !== mainKey) {
    setPrevMain({ key: mainKey, route })
    setLeaving(fadeFor(prevMain, route))
  }
  const mainRef = useRef<HTMLElement>(null)
  const leaveRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (!leaving) return
    const open = leaving.dir === 'open'
    const el = open ? mainRef.current : leaveRef.current
    if (!el) return
    const a = el.animate(open ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], {
      duration: dur(FADE_MS),
      easing: 'ease',
      fill: open ? 'none' : 'forwards'
    })
    const end = () => setLeaving((l) => (l === leaving ? null : l))
    a.finished.then(end, end)
    return () => a.cancel()
  }, [leaving])
  const leavingPane = (dir: Leaving['dir']) =>
    leaving?.dir === dir && (
      <section key={`main:${leaving.key}`} ref={dir === 'close' ? leaveRef : undefined} className="pane pane-main pane-leaving" inert aria-hidden>
        {mainView(leaving.route)}
      </section>
    )

  return (
    <div ref={box} className={'panes' + (sideOn ? ' is-split' + (side === 'left' ? ' side-left' : '') : '')} style={sideOn ? ({ '--split-main': `${ratio * 100}%` } as React.CSSProperties) : undefined}>
      {alive.map((id) => {
        const where = slot(`app:${id}`)
        return (
          <section key={`app:${id}`} className={`pane pane-${where}`} aria-hidden={where === 'hidden' || undefined}>
            <AppRunner appId={id} pane={where} />
          </section>
        )
      })}
      {leavingPane('open')}
      {route.name !== 'app' && (
        <section key={`main:${mainKey}`} ref={mainRef} className="pane pane-main">
          {mainView(route)}
        </section>
      )}
      {leavingPane('close')}
      {sideOn && split.name === 'file' && (
        <section key={`side:${sideKey}`} className="pane pane-side">
          <FileRunner fileId={split.fileId} pane="side" />
        </section>
      )}
      {sideOn && <SplitDivider box={box} />}
    </div>
  )
}

/** 가운데 칸에 그릴 화면 (앱은 따로 — 위에서 늘 켜 둔 칸으로 그린다) */
function mainView(route: Route) {
  return route.name === 'editor' ? (
    <DocEditor docId={route.docId} />
  ) : route.name === 'file' ? (
    <FileRunner fileId={route.fileId} pane="main" />
  ) : route.name === 'board' ? (
    <Board />
  ) : (
    <Library />
  )
}

/** 크로스페이드로 남겨 둔 바뀌기 전 화면 — open: 아래(홈), 새 편집 화면이 그 위로 나타난다 / close: 위(편집 화면), 그대로 사라진다 */
interface Leaving {
  key: string
  route: Route
  dir: 'open' | 'close'
}
/** 열기·닫기 같은 시간 */
const FADE_MS = 450
const isHome = (r: Route) => r.name === 'library' || r.name === 'board'

/** 이 화면 바뀜을 겹쳐 바꿀지 — 홈에서 노트를 열 때와 노트에서 홈으로 돌아갈 때만 (모션 끄기면 바로) */
function fadeFor(prev: { key: string; route: Route }, next: Route): Leaving | null {
  if (document.documentElement.dataset.motion === 'off') return null
  if (isHome(prev.route) && next.name === 'editor') return { ...prev, dir: 'open' }
  if (prev.route.name === 'editor' && isHome(next)) return { ...prev, dir: 'close' }
  return null
}

/** 가운데·옆 칸 사이 막대 — 끌어 폭을 바꾼다 (화살표 키로도). 끄는 동안 앱(iframe)이 포인터를 가져가지 않게 막는다 */
function SplitDivider({ box }: { box: React.RefObject<HTMLDivElement | null> }) {
  const ratio = useUI((s) => s.splitRatio)
  const side = useUI((s) => s.splitSide)
  const setRatio = useUI((s) => s.setSplitRatio)
  // 비율은 늘 가운데 칸의 몫 — 옆 칸이 왼쪽이면 막대 오른쪽이 가운데 칸이다
  const at = (x: number) => {
    const r = box.current?.getBoundingClientRect()
    if (!r?.width) return
    const f = (x - r.left) / r.width
    setRatio(side === 'left' ? 1 - f : f)
  }
  const nudge = (dx: number) => setRatio(ratio + (side === 'left' ? -dx : dx))
  return (
    <div
      className="split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="칸 크기 조절"
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        box.current?.classList.add('is-resizing')
      }}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && at(e.clientX)}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId)
        box.current?.classList.remove('is-resizing')
      }}
      onPointerCancel={() => box.current?.classList.remove('is-resizing')}
      onDoubleClick={() => setRatio(0.6)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') nudge(-0.05)
        else if (e.key === 'ArrowRight') nudge(0.05)
      }}
    >
      <span className="split-grip" />
    </div>
  )
}

function Toasts() {
  const toasts = useUI((s) => s.toasts)
  const dismiss = useUI((s) => s.dismissToast)
  const [rendered, setRendered] = useState<(Toast & { out?: boolean })[]>([])

  // store에서 빠져도 퇴장 애니메이션이 끝날 때까지 DOM에 남긴다
  useEffect(() => {
    setRendered((prev) => {
      const present = new Set(toasts.map((t) => t.id))
      const next: (Toast & { out?: boolean })[] = prev.map((r) => (present.has(r.id) ? { ...r, out: false } : { ...r, out: true }))
      for (const t of toasts) if (!next.some((r) => r.id === t.id)) next.push({ ...t, out: false })
      return next
    })
  }, [toasts])

  useEffect(() => {
    const outIds = rendered.filter((r) => r.out).map((r) => r.id)
    if (!outIds.length) return
    const timers = outIds.map((id) => window.setTimeout(() => setRendered((prev) => prev.filter((p) => p.id !== id)), 300))
    return () => timers.forEach((t) => clearTimeout(t))
  }, [rendered])

  return (
    <div className="toasts" aria-live="polite">
      {rendered.map((t) => (
        <div key={t.id} className={'toast ' + t.kind + (t.out ? ' is-out' : '')}>
          <i className="toast-dot" aria-hidden="true" />
          <span>{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run()
                dismiss(t.id)
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="닫기">
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

/** 첫 실행 시 홈 화면 설치 + 저장소 보존 안내 — 홈 화면에 둔 PWA는 Safari가 데이터를 덜 지운다 */
function InstallHint() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (localStorage.getItem('inkpad.installHint') || isStandalone()) return
    const ios = /iPad|iPhone|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document
    if (ios) setShow(true)
  }, [])
  if (!show) return null
  const close = () => {
    localStorage.setItem('inkpad.installHint', '1')
    setShow(false)
  }
  return (
    <div className="install-hint" role="note">
      <Icon name="share" size={20} />
      <span>
        <b>홈 화면에 추가</b>하면 전체 화면으로 쓸 수 있고, Safari가 데이터를 지울 가능성이 줄어듭니다. 공유 버튼 → “홈 화면에 추가”.
      </span>
      <button className="text-btn small" onClick={close}>
        확인
      </button>
    </div>
  )
}
