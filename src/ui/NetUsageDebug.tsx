import { useEffect, useState } from 'react'
import {
  getNetDestinations,
  getNetLog,
  getNetStats,
  resetNetStats,
  subscribeNetStats,
  type NetDest,
  type NetEntry,
  type NetStats
} from '../shared/netMeter'

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

function fmtTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function statusText(e: NetEntry): string {
  if (e.status === null) return '…'
  if (e.status === 0) return '실패'
  return String(e.status)
}

/** 목적지별 사용량 — 어디에 얼마나 썼는지 */
function DestinationList({ dests }: { dests: NetDest[] }) {
  return (
    <>
      <div className="net-log-title">어디에 썼나 (목적지별, {dests.length}곳)</div>
      <ul className="net-dest-list">
        {dests.map((d) => (
          <li key={d.label}>
            <span className="net-dest-label" title={d.label}>
              {d.label}
            </span>
            <span className="net-dest-bytes">
              ↓{fmtBytes(d.down)} · ↑{fmtBytes(d.up)}
            </span>
            <span className="net-dest-req">{d.requests}건</span>
          </li>
        ))}
      </ul>
    </>
  )
}

/** 최근 요청 기록 — 언제 무엇으로 얼마나 오갔는지 */
function RequestLog({ log }: { log: NetEntry[] }) {
  return (
    <>
      <div className="net-log-title">최근 요청 (최신순 · {log.length}건 기록됨)</div>
      <ul className="net-entry-list">
        {log.map((e) => (
          <li key={e.id}>
            <span className="net-entry-time">{fmtTime(e.at)}</span>
            <span className="net-entry-method">{e.method}</span>
            <span className="net-entry-label" title={e.url}>
              {e.label}
            </span>
            <span className="net-entry-bytes">
              ↓{fmtBytes(e.down)}
              {e.up ? ` ↑${fmtBytes(e.up)}` : ''}
            </span>
            <span className={'net-entry-status' + (e.status === 0 || (e.status !== null && e.status >= 400) ? ' is-bad' : '')}>
              {statusText(e)}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * 디버그용: 앱을 켠 뒤(새로고침 전까지) 쓴 인터넷 사용량과 사용 로그.
 * 누적 저장하지 않고, 브라우저가 Wi-Fi/셀룰러를 구분하지 못하므로 합계만 보여준다.
 */
export function NetUsageSection() {
  const [s, setS] = useState<NetStats>(getNetStats)
  const [conn, setConn] = useState('')
  const [showLog, setShowLog] = useState(true)

  // 통계가 갱신될 때마다 로그/목적지도 함께 다시 읽는다.
  const [log, setLog] = useState<NetEntry[]>(getNetLog)
  const [dests, setDests] = useState<NetDest[]>(getNetDestinations)

  const sync = () => {
    setS(getNetStats())
    setLog(getNetLog())
    setDests(getNetDestinations())
  }

  useEffect(() => subscribeNetStats(sync), [])
  useEffect(() => {
    const t = window.setInterval(sync, 1000)
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

      {log.length > 0 && (
        <div className="net-log">
          <div className="net-log-head">
            <span className="net-log-head-title">사용 로그</span>
            <button className="text-btn small" onClick={() => setShowLog((v) => !v)}>
              {showLog ? '접기' : '펼치기'}
            </button>
          </div>
          {showLog && (
            <>
              <DestinationList dests={dests} />
              <RequestLog log={log} />
              <p className="hint">
                목적지별로 내려받기(↓)·올리기(↑) 바이트를 합산합니다. 로그는 최근 200건까지만 남고 새로고침하면 사라집니다.
              </p>
            </>
          )}
        </div>
      )}

      <div className="btn-row">
        <button className="text-btn" onClick={resetNetStats}>
          사용량 · 로그 초기화
        </button>
      </div>
    </section>
  )
}
