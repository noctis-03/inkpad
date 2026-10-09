import { useEffect, useState } from 'react'
import { useUI, type Toast } from './store'
import { DialogHost } from './dialogs'
import { Library } from '../ui/library/Library'
import { Editor } from '../ui/editor/Editor'
import { AppRunner } from '../ui/app/AppRunner'
import { FileRunner } from '../ui/app/FileRunner'
import { Icon } from '../ui/Icon'
import { isStandalone } from '../shared/util'
import { purgeExpiredTrash } from '../storage/repo'
import { installPress } from '../ui/motion/press'

export function App() {
  const route = useUI((s) => s.route)
  useEffect(() => {
    // 휴지통 30일 정리 (로컬). 서버 쪽은 Phase 2에서 요청 시 lazy 정리
    void purgeExpiredTrash().catch(() => {})
  }, [])

  // 모션 단계 결정 (명세 4장) — auto는 OS '동작 줄이기'를 따르고, 결과를 <html data-motion>에 반영한다
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

  // 전역 누름 피드백 (명세 5.1)
  useEffect(() => {
    installPress()
  }, [])
  return (
    <div className="app-shell">
      {route.name === 'editor' ? (
        <Editor key={route.docId} docId={route.docId} />
      ) : route.name === 'app' ? (
        <AppRunner key={route.appId} appId={route.appId} />
      ) : route.name === 'file' ? (
        <FileRunner key={route.fileId} fileId={route.fileId} />
      ) : (
        <Library />
      )}
      <InstallHint />
      <Toasts />
      <Busy />
      <DialogHost />
    </div>
  )
}

function Toasts() {
  const toasts = useUI((s) => s.toasts)
  const dismiss = useUI((s) => s.dismissToast)
  const [rendered, setRendered] = useState<(Toast & { out?: boolean })[]>([])

  // store에서 빠져도 퇴장 애니메이션이 끝날 때까지 DOM에 남긴다 (명세 5.9)
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

function Busy() {
  const busy = useUI((s) => s.busy)
  if (!busy) return null
  return (
    <div className="busy-backdrop">
      <div className="busy">
        <div className="spinner" />
        <div>{busy.text}</div>
        {busy.progress !== undefined && (
          <div className="progress">
            <span style={{ width: `${Math.round(busy.progress * 100)}%` }} />
          </div>
        )}
      </div>
    </div>
  )
}

/** 첫 실행 시 홈 화면 설치 + 저장소 보존 안내 (NFR-07) */
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
