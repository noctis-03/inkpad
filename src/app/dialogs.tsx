import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'

// 브라우저 기본 prompt/confirm 대신 쓰는 앱 내 대화상자 (홈 화면 PWA에서도 일관되게 동작)
type ConfirmDialog = {
  kind: 'confirm'
  title: string
  message?: string
  note?: string
  ok: string
  danger?: boolean
  resolve: (v: boolean) => void
}
type PromptDialog = {
  kind: 'prompt'
  title: string
  message?: string
  value: string
  ok: string
  password?: boolean
  resolve: (v: string | null) => void
}
/** 버튼 2~3개짜리 선택 창 (파일 추가 시 "이 기기에만 추가" 등) */
type ChoiceDialog = {
  kind: 'choice'
  title: string
  message?: string
  note?: string
  options: { key: string; label: string; primary?: boolean }[]
  resolve: (v: string | null) => void
}
type Dialog = ConfirmDialog | PromptDialog | ChoiceDialog

const useDialog = create<{ d: Dialog | null }>(() => ({ d: null }))

export function confirmDialog(title: string, opts: { message?: string; note?: string; ok?: string; danger?: boolean } = {}) {
  return new Promise<boolean>((resolve) =>
    useDialog.setState({
      d: { kind: 'confirm', title, message: opts.message, note: opts.note, ok: opts.ok ?? '확인', danger: opts.danger, resolve }
    })
  )
}

export function promptDialog(title: string, opts: { message?: string; value?: string; ok?: string; password?: boolean } = {}) {
  return new Promise<string | null>((resolve) =>
    useDialog.setState({
      d: { kind: 'prompt', title, message: opts.message, value: opts.value ?? '', ok: opts.ok ?? '확인', password: opts.password, resolve }
    })
  )
}

export function choiceDialog(
  title: string,
  opts: { message?: string; note?: string; options: { key: string; label: string; primary?: boolean }[] }
) {
  return new Promise<string | null>((resolve) =>
    useDialog.setState({ d: { kind: 'choice', title, message: opts.message, note: opts.note, options: opts.options, resolve } })
  )
}

export function askPdfPassword(incorrect: boolean) {
  return promptDialog(incorrect ? '비밀번호가 틀렸습니다' : '암호가 걸린 PDF', {
    message: '이 PDF를 열려면 비밀번호가 필요합니다. 비밀번호는 저장하지 않습니다.',
    password: true,
    ok: '열기'
  })
}

export function DialogHost() {
  const d = useDialog((s) => s.d)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (d?.kind === 'prompt') {
      setValue(d.value)
      const t = setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
      return () => clearTimeout(t)
    }
    if (d) {
      const t = setTimeout(() => cancelRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [d])

  // Esc = 취소
  useEffect(() => {
    if (!d) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      useDialog.setState({ d: null })
      if (d.kind === 'confirm') d.resolve(false)
      else d.resolve(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [d])

  if (!d) return null
  const finish = (v: string | null, ok: boolean) => {
    useDialog.setState({ d: null })
    if (d.kind === 'confirm') d.resolve(ok)
    else if (d.kind === 'prompt') d.resolve(ok ? value : null)
    else d.resolve(v)
  }
  return (
    <div className="modal-backdrop dialog-host" onPointerDown={(e) => e.target === e.currentTarget && finish(null, false)}>
      <form
        className="modal"
        role={d.kind === 'choice' ? 'alertdialog' : d.kind === 'confirm' ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        onSubmit={(e) => {
          e.preventDefault()
          if (d.kind !== 'choice') finish(null, true)
        }}
      >
        <h2 className="modal-title">{d.title}</h2>
        {d.message && <p className="modal-message">{d.message}</p>}
        {(d.kind === 'confirm' || d.kind === 'choice') && d.note && <p className="modal-note">{d.note}</p>}
        {d.kind === 'prompt' && (
          <input
            ref={inputRef}
            className="modal-input"
            type={d.password ? 'password' : 'text'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
          />
        )}
        {d.kind === 'choice' ? (
          <div className="modal-actions equal wrap">
            {d.options.map((o, i) => (
              <button
                key={o.key}
                ref={i === 0 ? cancelRef : undefined}
                type="button"
                className={'text-btn' + (o.primary ? ' primary' : '')}
                onClick={() => finish(o.key, o.key !== 'cancel')}
              >
                {o.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="modal-actions equal">
            <button ref={cancelRef} type="button" className="text-btn" onClick={() => finish(null, false)}>
              취소
            </button>
            <button type="submit" className={'text-btn primary' + (d.kind === 'confirm' && d.danger ? ' danger-fill' : '')}>
              {d.ok}
            </button>
          </div>
        )}
      </form>
    </div>
  )
}
