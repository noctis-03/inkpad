// 날짜 고르기 — 칩(또는 아이콘 버튼) 위에 투명한 날짜 입력을 덮어, 누르면 기기의 달력이 뜬다.
// 덮기만 하면 데스크톱 크롬 등은 날짜 입력의 글자 칸만 잡고 달력을 띄우지 않으므로, 누를 때 showPicker()를 부른다.
// (iPad Safari처럼 입력을 누르면 스스로 달력을 띄우는 곳은 그대로 — showPicker가 없거나 실패해도 문제없다)
import type { ReactNode } from 'react'

export function DatePick({
  value,
  on,
  disabled,
  className = 'lib-chip task-date',
  label = '마감 날짜 고르기',
  onPick,
  children
}: {
  value: string | null
  on?: boolean
  disabled?: boolean
  className?: string
  label?: string
  onPick: (day: string) => void
  children: ReactNode
}) {
  return (
    <label className={className + (on ? ' is-on' : '')}>
      {children}
      <input
        type="date"
        value={value ?? ''}
        disabled={disabled}
        aria-label={label}
        onClick={(e) => {
          try {
            e.currentTarget.showPicker?.()
          } catch {
            /* 이미 떠 있거나 지원하지 않는다 — 입력이 스스로 띄운다 */
          }
        }}
        onChange={(e) => e.target.value && onPick(e.target.value)}
      />
    </label>
  )
}
