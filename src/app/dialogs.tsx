import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { a4FitFactor } from '../shared/model'

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

const LS_PDF_FIT = 'inkpad.pdfFit'

/**
 * PDF를 가져올 때 페이지 폭이 A4에서 많이 벗어나면(farFromA4) 원본 크기로 둘지 A4 폭에 맞출지 묻는다.
 * true = A4 폭에 맞춤, false = 원본 크기, null = 가져오기 취소. 지난 선택을 이 기기에 기억해 그 버튼을 강조한다
 */
export async function askPdfFit(pages: { w: number; h: number }[]): Promise<boolean | null> {
  // 가장 많이 벗어난 페이지로 설명한다
  let worst = pages[0]
  let wf = 1
  for (const p of pages) {
    const f = a4FitFactor(p)
    if (Math.abs(Math.log(f)) > Math.abs(Math.log(wf))) {
      worst = p
      wf = f
    }
  }
  const ratio = 1 / wf
  const rel = ratio >= 1 ? `A4의 ${ratio.toFixed(1)}배` : `A4의 ${Math.round(ratio * 100)}%`
  let last = 'original'
  try {
    last = localStorage.getItem(LS_PDF_FIT) ?? 'original'
  } catch {
    /* 기억하지 못해도 묻기는 한다 */
  }
  const v = await choiceDialog('PDF 페이지 크기', {
    message: `페이지 폭이 ${rel}입니다 (${Math.round(worst.w)}×${Math.round(worst.h)}pt). 원본 크기 그대로 두면 다른 노트와 펜 굵기가 다르게 보일 수 있습니다.`,
    note: '나중에 페이지 메뉴에서 언제든 바꿀 수 있습니다. 필기도 페이지와 함께 늘고 줄어듭니다.',
    options: [
      { key: 'original', label: '원본 크기', primary: last !== 'a4' },
      { key: 'a4', label: 'A4 폭에 맞춤', primary: last === 'a4' }
    ]
  })
  if (v === null) return null
  try {
    localStorage.setItem(LS_PDF_FIT, v)
  } catch {
    /* 무시 */
  }
  return v === 'a4'
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
