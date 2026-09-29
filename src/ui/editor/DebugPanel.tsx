import { useState } from 'react'
import type { Engine } from '../../engine/engine'
import { useUI } from '../../app/store'
import { Icon } from '../Icon'

/** Phase 0 테스트 도구 (설정 > HUD 켜기 후 툴바에서 열 수 있음) */
export function DebugPanel({ engine }: { engine: Engine }) {
  const close = useUI((s) => s.setPanel)
  const [log, setLog] = useState<string[]>([])
  const push = (m: string) => setLog((l) => [m, ...l].slice(0, 8))
  return (
    <aside id="debug-panel" className="side-panel" aria-label="테스트 도구">
      <header className="panel-header">
        <h2>테스트 도구</h2>
        <button className="tb-btn" onClick={() => close('debug')} aria-label="닫기">
          <Icon name="close" />
        </button>
      </header>
      <section className="panel-section">
        <h3>대용량</h3>
        <div className="btn-row">
          {[1000, 10000].map((n) => (
            <button
              key={n}
              className="text-btn"
              onClick={() => {
                const ms = engine.stressTest(n)
                push(`획 ${n.toLocaleString()}개 추가 (${ms.toFixed(0)}ms)`)
                engine.fitAll()
              }}
            >
              +{n.toLocaleString()} 획
            </button>
          ))}
        </div>
        <p className="hint">문서에 실제로 저장됩니다. 끝나면 실행 취소로 지우세요.</p>
      </section>
      <section className="panel-section">
        <h3>원거리 좌표</h3>
        <div className="btn-row">
          <button className="text-btn" onClick={() => engine.jumpTo(1_000_000, 1_000_000)}>
            100만 단위로 이동
          </button>
          <button className="text-btn" onClick={() => engine.resetView()}>
            처음 위치
          </button>
          <button className="text-btn" onClick={() => (engine.resetStats(), push('측정 초기화'))}>
            지연 측정 초기화
          </button>
        </div>
      </section>
      {log.length > 0 && (
        <section className="panel-section">
          <ul className="log">
            {log.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  )
}
