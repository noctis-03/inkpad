import { useLayoutEffect, useRef } from 'react'
import type { Engine } from '../../engine/engine'
import { useUI } from '../../app/store'

/**
 * 텍스트 편집 오버레이.
 *
 * 편집하는 동안에만 DOM textarea를 띄우고, 확정되면 캔버스 확정 레이어로 넘긴다.
 * 한글 IME 조합·커서·선택·모바일 키보드는 브라우저가 처리하므로 직접 구현하지 않는다.
 */
export function TextOverlay({ engine }: { engine: Engine }) {
  const edit = useUI((s) => s.textEdit)
  const ref = useRef<HTMLTextAreaElement>(null)

  // 세션이 바뀔 때마다 포커스 (iPad에서 키보드가 뜨도록 레이아웃 단계에서 동기 실행)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    const n = el.value.length
    try {
      el.setSelectionRange(n, n)
    } catch {
      /* noop */
    }
    autoGrow(el)
  }, [edit?.sessionId])

  if (!edit) return null

  return (
    <textarea
      ref={ref}
      className="text-overlay"
      value={edit.value}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      aria-label="텍스트 입력"
      onChange={(e) => {
        engine.updateTextDraft(e.target.value)
        autoGrow(e.target)
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={() => engine.commitText()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          engine.cancelText()
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          engine.commitText()
        }
      }}
      style={{
        left: edit.sx,
        top: edit.sy,
        width: edit.width,
        minHeight: edit.fontSize * edit.lineHeight,
        fontSize: edit.fontSize,
        lineHeight: edit.lineHeight,
        color: edit.color
      }}
    />
  )
}

function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}
