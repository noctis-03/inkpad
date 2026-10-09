import { useRef } from 'react'
import { useIndicator } from './motion/useIndicator'

/**
 * 공용 세그먼트 선택 — 슬라이딩 흰 칩 인디케이터(5.2).
 * 설정 패널과 새로 만들기 창이 함께 쓴다 (C-7에서 SettingsPanel에서 추출).
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className
}: {
  value: T
  options: [T, string][]
  onChange: (v: T) => void
  label: string
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useIndicator(ref, value, 'x')
  return (
    <div className={'seg' + (className ? ' ' + className : '')} ref={ref} role="radiogroup" aria-label={label}>
      {options.map(([val, text]) => (
        <button
          key={val}
          data-indicator-key={val}
          role="radio"
          aria-checked={value === val}
          className={value === val ? 'is-active' : ''}
          onClick={() => onChange(val)}
        >
          {text}
        </button>
      ))}
    </div>
  )
}
