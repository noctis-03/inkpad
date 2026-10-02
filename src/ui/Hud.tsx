import { useUI } from '../app/store'

/** 성능 측정 HUD (설정 > 렌더링 > 성능 표시) */
export function Hud() {
  const stats = useUI((s) => s.stats)
  const show = useUI((s) => s.settings.showHud)
  const setPanel = useUI((s) => s.setPanel)
  if (!show || !stats) return null
  const s = stats
  const latClass = s.latencyP95 === 0 ? '' : s.latencyP95 <= 12 ? 'good' : s.latencyP95 <= 20 ? 'warn' : 'bad'
  return (
    <aside id="perf-hud" className="hud" aria-live="off" onClick={() => setPanel('debug')}>
      <div className="hud-row">
        <b>{s.fps}</b> fps · 획 {s.strokes.toLocaleString()} (보임 {s.visible.toLocaleString()}) · PDF {s.pdfCache}
      </div>
      <div className={'hud-row ' + latClass}>
        입력→그리기 평균 <b>{s.latencyAvg}</b>ms · p95 <b>{s.latencyP95}</b>ms
      </div>
      <div className="hud-row">
        이벤트 {s.eventHz}/s · 점 {s.pointHz}/s · coalesced ×{s.coalescedPerEvent} · 예측 {s.predictedCount}
      </div>
      <div className="hud-row">
        입력레이어 {s.liveMs.toFixed(1)}ms · 다시그리기 {s.committedMs.toFixed(1)}ms · {s.renderPath}
      </div>
      <div className="hud-row">
        {s.pointerType} · 필압 {s.pressure.toFixed(2)} · 굵기 방식 {s.pressureSource} · 기울기 {s.tiltX}/{s.tiltY}
        {s.altitude !== null ? ` · 고도 ${((s.altitude * 180) / Math.PI).toFixed(0)}°` : ''} · 접촉 {s.contactW.toFixed(0)}×{s.contactH.toFixed(0)}
      </div>
      <div className="hud-row dim">
        팜 무시 {s.palmRejected} · DPR {s.dpr} · 캔버스 {s.canvasPx} · coalesced {s.supportCoalesced ? '✓' : '✗'} · predicted {s.supportPredicted ? '✓' : '✗'} · 탭하면 테스트 도구
      </div>
    </aside>
  )
}
