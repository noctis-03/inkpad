import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useUI } from '../app/store'
import type { PressureMode, Settings } from '../engine/types'
import { Icon } from './Icon'
import { NetUsageSection } from './NetUsageDebug'

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="setting-row">
      <span className="setting-label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <span className="setting-control">{children}</span>
    </label>
  )
}

function Slider({ k, min, max, step, fmt }: { k: keyof Settings; min: number; max: number; step: number; fmt?: (v: number) => string }) {
  const v = useUI((s) => s.settings[k]) as number
  const set = useUI((s) => s.setSettings)
  return (
    <>
      <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => set({ [k]: Number(e.target.value) } as Partial<Settings>)} />
      <output>{fmt ? fmt(v) : v}</output>
    </>
  )
}

function Toggle({ k }: { k: keyof Settings }) {
  const v = useUI((s) => s.settings[k]) as boolean
  const set = useUI((s) => s.setSettings)
  return <input type="checkbox" className="switch" checked={v} onChange={(e) => set({ [k]: e.target.checked } as Partial<Settings>)} />
}

function Select({ k, options }: { k: keyof Settings; options: [string, string][] }) {
  const v = useUI((s) => s.settings[k]) as string
  const set = useUI((s) => s.setSettings)
  return (
    <select value={v} onChange={(e) => set({ [k]: e.target.value } as Partial<Settings>)}>
      {options.map(([val, label]) => (
        <option key={val} value={val}>
          {label}
        </option>
      ))}
    </select>
  )
}

const MODE_INFO: Record<PressureMode, { title: string; desc: string }> = {
  auto: { title: '자동 감지', desc: '펜이 필압을 보내면 필압을, 아니면 아래 대체 방식을 씁니다.' },
  pressure: { title: '필압', desc: 'Apple Pencil처럼 필압을 보내는 펜. 누르는 힘에 따라 굵기가 바뀝니다.' },
  velocity: { title: '속도', desc: '필압이 없는 펜·손가락용. 빠르게 그리면 가늘어집니다.' },
  constant: { title: '일정한 굵기', desc: '굵기 변화 없이 항상 같은 굵기로 그립니다.' }
}

const CAP_LABEL = { unknown: '아직 모름 (펜으로 몇 획 그려 보세요)', yes: '필압 지원 ✓', no: '필압 없음 (고정값만 보냄)' }

export function PressureSection() {
  const s = useUI((st) => st.settings)
  const set = useUI((st) => st.setSettings)
  return (
    <section className="panel-section" id="pressure-settings">
      <h3>펜 · 필압</h3>
      <div className="pressure-modes" role="radiogroup" aria-label="필압 처리 방식">
        {(Object.keys(MODE_INFO) as PressureMode[]).map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={s.pressureMode === m}
            className={'pressure-mode' + (s.pressureMode === m ? ' is-active' : '')}
            onClick={() => set({ pressureMode: m })}
          >
            <strong>{MODE_INFO[m].title}</strong>
            <small>{MODE_INFO[m].desc}</small>
          </button>
        ))}
      </div>

      {s.pressureMode === 'auto' && (
        <div className="detect-box">
          <div>
            <b>감지 결과:</b> {CAP_LABEL[s.pressureCapability]}
          </div>
          <button className="text-btn small" onClick={() => set({ pressureCapability: 'unknown' })}>
            다시 감지
          </button>
        </div>
      )}

      {(s.pressureMode === 'auto' || s.pressureMode === 'pressure') && (
        <Row label="필압이 없을 때" hint="자동 감지에서 필압이 없거나, 손가락·정전식 터치펜·마우스로 그릴 때">
          <Select k="fallbackMode" options={[['velocity', '속도로 굵기 흉내'], ['constant', '일정한 굵기']]} />
        </Row>
      )}

      {s.pressureMode !== 'constant' && (
        <Row label="굵기 변화 폭" hint="0이면 굵기 일정">
          <Slider k="thinning" min={0} max={0.95} step={0.05} />
        </Row>
      )}
      {(s.pressureMode === 'auto' || s.pressureMode === 'pressure') && (
        <>
          <Row label="필압 곡선" hint="<1 살짝만 눌러도 굵게 · >1 세게 눌러야 굵게">
            <Slider k="pressureGamma" min={0.4} max={2} step={0.1} />
          </Row>
          <Row label="최소 필압" hint="아주 약하게 눌러도 이만큼은 굵게">
            <Slider k="minPressure" min={0} max={0.5} step={0.05} />
          </Row>
          <Row label="필압 평활화" hint="높을수록 굵기 변화가 부드러워지고, 낮을수록 필압에 즉시 반응합니다">
            <Slider k="pressureSmoothing" min={0} max={0.9} step={0.05} />
          </Row>
        </>
      )}

      <Row label="손가락·터치펜으로 그리기" hint="정전식(고무팁) 터치펜은 손가락으로 인식됩니다. 켜면 한 손가락 = 그리기, 두 손가락 = 이동/확대">
        <Toggle k="fingerDraw" />
      </Row>

      <PressureTester />
    </section>
  )
}

/** 펜으로 그어 보면 필압 값이 실제로 들어오는지 보여준다 */
function PressureTester() {
  const ref = useRef<HTMLCanvasElement>(null)
  const [info, setInfo] = useState<{ type: string; min: number; max: number; n: number; verdict: string } | null>(null)
  const setSettings = useUI((s) => s.setSettings)

  useEffect(() => {
    const c = ref.current!
    const ctx = c.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    const resize = () => {
      c.width = c.clientWidth * dpr
      c.height = c.clientHeight * dpr
    }
    resize()
    let raw: number[] = []
    let last: { x: number; y: number } | null = null
    let type = ''
    const pos = (e: PointerEvent) => {
      const r = c.getBoundingClientRect()
      return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr }
    }
    const down = (e: PointerEvent) => {
      e.preventDefault()
      c.setPointerCapture(e.pointerId)
      ctx.clearRect(0, 0, c.width, c.height)
      raw = []
      type = e.pointerType
      last = pos(e)
    }
    const move = (e: PointerEvent) => {
      if (!last) return
      for (const ev of e.getCoalescedEvents?.() ?? [e]) {
        const p = pos(ev)
        raw.push(ev.pressure)
        ctx.beginPath()
        ctx.moveTo(last.x, last.y)
        ctx.lineTo(p.x, p.y)
        ctx.lineCap = 'round'
        ctx.lineWidth = Math.max(0.5, ev.pressure * 14 * dpr)
        ctx.strokeStyle = '#2563eb'
        ctx.stroke()
        last = p
      }
    }
    const up = () => {
      if (!last) return
      last = null
      if (!raw.length) return
      const min = Math.min(...raw)
      const max = Math.max(...raw)
      let verdict: string
      if (type !== 'pen') verdict = `${type === 'touch' ? '손가락/정전식 터치펜' : '마우스'}으로 인식됨 → 필압 없음`
      else {
        verdict = max - min > 0.02 ? '필압이 들어옵니다 ✓' : raw.length >= 8 ? '펜이지만 필압이 고정값입니다' : '조금 더 길게 그어 보세요'
        if (max - min > 0.02) setSettings({ pressureCapability: 'yes' })
        else if (raw.length >= 8) setSettings({ pressureCapability: 'no' })
      }
      setInfo({ type, min, max, n: raw.length, verdict })
    }
    c.addEventListener('pointerdown', down)
    c.addEventListener('pointermove', move)
    c.addEventListener('pointerup', up)
    c.addEventListener('pointercancel', up)
    return () => {
      c.removeEventListener('pointerdown', down)
      c.removeEventListener('pointermove', move)
      c.removeEventListener('pointerup', up)
      c.removeEventListener('pointercancel', up)
    }
  }, [setSettings])

  return (
    <div className="pressure-tester">
      <div className="tester-label">필압 테스트 — 약하게 시작해 점점 세게 그어 보세요</div>
      <canvas ref={ref} className="tester-canvas" />
      {info && (
        <div className="tester-result">
          <b>{info.verdict}</b>
          <span>
            {info.type} · 필압 {info.min.toFixed(2)}~{info.max.toFixed(2)} · 점 {info.n}개
          </span>
        </div>
      )}
    </div>
  )
}

export function SettingsSections({ showDebug = true }: { showDebug?: boolean }) {
  return (
    <>
      <PressureSection />
      <section className="panel-section">
        <h3>필기</h3>
        <Row label="손떨림 보정" hint="높을수록 부드럽지만 펜 끝에서 뒤처짐">
          <Slider k="streamline" min={0} max={0.9} step={0.05} />
        </Row>
        <Row label="외곽선 매끄럽게">
          <Slider k="smoothing" min={0} max={1} step={0.05} />
        </Row>
        <Row label="지우개 방식">
          <Select k="eraserMode" options={[['stroke', '획 단위'], ['partial', '부분 (닿은 곳만)']]} />
        </Row>
      </section>

      <section className="panel-section">
        <h3>기타 파일</h3>
        <Row label="큰 파일 전송 전 확인" hint="이 크기 이상을 다운로드·업로드하기 전에 한 번 더 묻습니다 (iPad는 셀룰러 여부를 알 수 없어 크기로 확인합니다)">
          <Select
            k="largeFileConfirm"
            options={[
              ['always', '무조건 확인'],
              ['5', '5MB 이상'],
              ['10', '10MB 이상'],
              ['50', '50MB 이상'],
              ['off', '끄기']
            ]}
          />
        </Row>
      </section>

      <section className="panel-section">
        <h3>입력 · 지연</h3>
        <Row label="펜 끝 예측 그리기" hint="getPredictedEvents">
          <Toggle k="prediction" />
        </Row>
        <Row label="중간 점 수집" hint="getCoalescedEvents">
          <Toggle k="coalesced" />
        </Row>
        <Row label="팜 리젝션 시간" hint="펜을 뗀 뒤 터치 무시">
          <Slider k="palmWindowMs" min={0} max={1500} step={50} fmt={(v) => `${v}ms`} />
        </Row>
        <Row label="큰 접촉면 무시" hint="0 = 끔">
          <Slider k="palmMaxContact" min={0} max={80} step={2} fmt={(v) => (v ? `${v}px` : '끔')} />
        </Row>
        <Row label="입력이 끊겼을 때">
          <Select k="cancelBehavior" options={[['commit', '그린 데까지 확정'], ['discard', '폐기']]} />
        </Row>
        <Row label="한 손가락 스크롤 관성">
          <Toggle k="momentum" />
        </Row>
      </section>

      {showDebug && (
        <section className="panel-section">
          <h3>렌더링</h3>
          <Row label="팬/줌 중 렌더링">
            <Select k="gestureRender" options={[['auto', '자동'], ['transform', '변환만 (빠름)'], ['redraw', '매 프레임 다시 그림']]} />
          </Row>
          <Row label="해상도" hint="낮추면 빠르지만 흐려짐">
            <Slider k="resolution" min={0.5} max={1} step={0.25} fmt={(v) => `${v * 100}%`} />
          </Row>
          <Row label="성능 표시 (HUD)">
            <Toggle k="showHud" />
          </Row>
        </section>
      )}

      {/* 디버깅용: 앱 인터넷 사용량 (셀룰러 데이터 확인) — 이 한 줄과 import를 지우면 사라진다 */}
      {showDebug && <NetUsageSection />}
    </>
  )
}

export function SettingsPanel() {
  const close = useUI((s) => s.setPanel)
  const reset = useUI((s) => s.resetSettings)
  return (
    <aside id="settings-panel" className="side-panel" aria-label="설정">
      <header className="panel-header">
        <h2>설정</h2>
        <button className="tb-btn" onClick={() => close('settings')} aria-label="닫기">
          <Icon name="close" />
        </button>
      </header>
      <SettingsSections />
      <footer className="panel-footer">
        <button className="text-btn" onClick={reset}>
          기본값으로
        </button>
      </footer>
    </aside>
  )
}
