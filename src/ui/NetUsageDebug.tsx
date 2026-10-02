import { useEffect, useState } from 'react'
import { getNetStats, resetNetStats, subscribeNetStats, type NetStats } from '../shared/netMeter'

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtElapsed(ms: number): string {
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m}분`
  return `${Math.floor(m / 60)}시간 ${m % 60}분`
}

/**
 * 디버그용: 앱을 켠 뒤(새로고침 전까지) 쓴 인터넷 사용량.
 * 누적 저장하지 않고, 브라우저가 Wi-Fi/셀룰러를 구분하지 못하므로 합계만 보여준다.
 */
export function NetUsageSection() {
  const [s, setS] = useState<NetStats>(getNetStats)
  const [conn, setConn] = useState('')

  useEffect(() => subscribeNetStats(() => setS(getNetStats())), [])
  useEffect(() => {
    const t = window.setInterval(() => setS(getNetStats()), 1000)
    const c = (navigator as unknown as { connection?: { effectiveType?: string; downlink?: number; saveData?: boolean } }).connection
    if (c) {
      setConn(
        [
          c.effectiveType ? `회선 ${c.effectiveType}` : '',
          typeof c.downlink === 'number' ? `하향 ${c.downlink}Mbps` : '',
          c.saveData ? '데이터 절약 켜짐' : ''
        ]
          .filter(Boolean)
          .join(' · ')
      )
    }
    return () => window.clearInterval(t)
  }, [])

  const total = s.down + s.up

  return (
    <section className="panel-section" id="net-usage-debug">
      <h3>네트워크 사용량 (디버그)</h3>
      <div className="net-usage">
        <div className="net-usage-total">{fmtBytes(total)}</div>
        <div className="net-usage-sub">
          내려받기 {fmtBytes(s.down)} · 올리기 {fmtBytes(s.up)} · 요청 {s.requests}건
          {s.unknown > 0 ? ` · 크기 미상 ${s.unknown}건` : ''}
        </div>
      </div>
      <p className="hint">
        앱을 켠 뒤 {fmtElapsed(Date.now() - s.since)} 경과 · 새로고침하면 0부터 다시 셉니다.
        <br />
        브라우저가 Wi-Fi와 셀룰러를 구분하지 못해 합계만 표시합니다.
        {conn ? ` 참고: ${conn}` : ''}
      </p>
      <div className="btn-row">
        <button className="text-btn" onClick={resetNetStats}>
          사용량 초기화
        </button>
      </div>
    </section>
  )
}
