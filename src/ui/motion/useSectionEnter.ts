import { useLayoutEffect, useRef, useState } from 'react'

/**
 * 목록 등장 연출(data-enter)을 '첫 데이터 로드'와 '섹션 전환'에 재무장한다.
 *
 * 카드가 새로 나타나는 순간을 FLIP 의 내부 기억(prev/first)에 맡기면,
 * 컨테이너가 사라졌다 다시 나타나거나 카드가 60개를 넘을 때 조용히 생략돼
 * "등장 효과가 안 나온다"가 된다. 섹션 키가 바뀌면 CSS 등장 연출을 확실히 다시 켠다.
 * useLayoutEffect 로 페인트 전에 켜서 카드가 한 프레임 번쩍이지 않게 한다.
 */
export function useSectionEnter(ready: boolean, sectionKey: string, holdMs = 700) {
  const [enter, setEnter] = useState(false)
  const armed = useRef(false)
  const prevKey = useRef<string | null>(null)

  useLayoutEffect(() => {
    if (!ready) return
    if (armed.current && prevKey.current === sectionKey) return
    armed.current = true
    prevKey.current = sectionKey
    setEnter(true)
    const t = window.setTimeout(() => setEnter(false), holdMs)
    return () => window.clearTimeout(t)
  }, [ready, sectionKey, holdMs])

  return enter
}
