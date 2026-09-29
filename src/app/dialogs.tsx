import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'

// 브라우저 기본 prompt/confirm 대신 쓰는 앱 내 대화상자 (홈 화면 PWA에서도 일관되게 동작)
type Dialog =
  | { kind: 'confirm'; title: string; message?: string; ok: string; danger?: boolean; resolve: (v: boolean) => void }
  | { kind: 'prompt'; title: string; message?: string; value: string; ok: string; password?: boolean; resolve: (v: string | null) => void }

const useDialog = create<{ d: Dialog | null }>(() => ({ d: null }))

export function confirmDialog(title: string, opts: { message?: string; ok?: string; danger?: boolean } = {}) {
  return new Promise<boolean>((resolve) =>
    useDialog.setState({ d: { kind: 'confirm', title, message: opts.message, ok: opts.ok ?? '확인', danger: opts.danger, resolve } })
  )
}

export function promptDialog(title: string, opts: { message?: string; value?: string; ok?: string; password?: boolean } = {}) {
  return new Promise<string | null>((resolve) =>
    useDialog.setState({
      d: { kind: 'prompt', title, message: opts.message, value: opts.value ?? '', ok: opts.ok ?? '확인', password: opts.password, resolve }
    })
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
  useEffect(() => {
    if (d?.kind === 'prompt') {
      setValue(d.value)
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
    }
  }, [d])
  if (!d) return null
  const close = (v: boolean) => {
    useDialog.setState({ d: null })
    if (d.kind === 'confirm') d.resolve(v)
    else d.resolve(v ? value : null)
  }
  return (
    <div className="modal-backdrop dialog-host" onPointerDown={(e) => e.target === e.currentTarget && close(false)}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        onSubmit={(e) => {
          e.preventDefault()
          close(true)
        }}
      >
        <h2 className="modal-title">{d.title}</h2>
        {d.message && <p className="modal-message">{d.message}</p>}
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
        <div className="modal-actions">
          <button type="button" className="text-btn" onClick={() => close(false)}>
            취소
          </button>
          <button type="submit" className={'text-btn primary' + (d.kind === 'confirm' && d.danger ? ' danger-fill' : '')}>
            {d.ok}
          </button>
        </div>
      </form>
    </div>
  )
}
