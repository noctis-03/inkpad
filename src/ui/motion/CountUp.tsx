import { useEffect, useRef, useState } from 'react'
import { dur } from './motion'

/** 숫자 카운트업 (명세 5.4): 450ms 동안 이전 값에서 새 값으로 세어 올린다. */
export function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  const shownRef = useRef(value)

  useEffect(() => {
    const start = from.current
    if (start === value) return
    const d = dur(450)
    if (!d) {
      from.current = value
      shownRef.current = value
      setShown(value)
      return
    }
    let raf = 0
    const t0 = performance.now()
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / d)
      const eased = 1 - Math.pow(1 - p, 3)
      const v = Math.round(start + (value - start) * eased)
      shownRef.current = v
      setShown(v)
      if (p < 1) raf = requestAnimationFrame(step)
      else {
        from.current = value
        shownRef.current = value
        setShown(value)
      }
    }
    raf = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(raf)
      // 세는 도중 값이 또 바뀌면 지금 보이는 값에서 이어 센다 (0 으로 튀지 않게)
      from.current = shownRef.current
    }
  }, [value])

  return <>{shown}</>
}
