import type { ReactNode } from 'react'
import { useUI } from '../app/store'
import { PEN_STYLES, PEN_STYLE_ORDER, type PenStyleId, type Settings } from '../engine/types'
import { Icon } from './Icon'
import { NetUsageSection } from './NetUsageDebug'
import { Segmented } from './Segmented'

/**
 * 설정 행. asLabel이 true면 <label>로 감싸 컨트롤이 하나뿐인 행(토글·슬라이더·셀렉트)에서
 * 라벨 클릭이 컨트롤을 향하게 한다. 세그먼트 버튼 묶음처럼 컨트롤이 여러 개인 행은
 * <div>로 그린다 — <label> 안에 버튼이 여러 개 있으면 라벨 클릭이 첫 번째 버튼을 눌러 버린다.
 */
function Row({ label, hint, children, asLabel = true }: { label: string; hint?: ReactNode; children: ReactNode; asLabel?: boolean }) {
  const Tag = asLabel ? 'label' : 'div'
  return (
    <Tag className="setting-row">
      <span className="setting-label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <span className="setting-control">{children}</span>
    </Tag>
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

/** 모션 단계 — 자동(OS '동작 줄이기'를 따름)·끄기·보통·풍부 */
function MotionSelect() {
  const v = useUI((s) => s.settings.motion)
  const set = useUI((s) => s.setSettings)
  return (
    <Segmented
      value={v}
      label="모션"
      onChange={(motion) => set({ motion })}
      options={[
        ['auto', '자동'],
        ['off', '끄기'],
        ['normal', '보통'],
        ['rich', '풍부']
      ]}
    />
  )
}

/** 테마 (다크 모드) */
function ThemeSelect() {
  const v = useUI((s) => s.settings.theme ?? 'auto')
  const set = useUI((s) => s.setSettings)
  return (
    <Segmented
      value={v}
      label="테마"
      onChange={(theme) => set({ theme })}
      options={[
        ['auto', '자동'],
        ['light', '라이트'],
        ['dark', '다크']
      ]}
    />
  )
}

/** 펜 스타일 — 두 가지뿐이다. 값 조절 슬라이더는 두지 않는다. */
function PenStylePicker() {
  const cur = useUI((s) => s.settings.penStyle)
  const set = useUI((s) => s.setSettings)
  return (
    <div className="pressure-modes" role="radiogroup" aria-label="펜 스타일">
      {PEN_STYLE_ORDER.map((id: PenStyleId) => (
        <button
          key={id}
          role="radio"
          aria-checked={cur === id}
          className={'pressure-mode' + (cur === id ? ' is-active' : '')}
          onClick={() => set({ penStyle: id })}
        >
          <strong>{PEN_STYLES[id].label}</strong>
          <small>{PEN_STYLES[id].hint}</small>
        </button>
      ))}
    </div>
  )
}

export function SettingsSections({ showDebug = true }: { showDebug?: boolean }) {
  return (
    <>
      <section className="panel-section">
        <h3>화면</h3>
        <Row label="테마" hint="자동은 기기의 외관(라이트/다크) 설정을 따릅니다" asLabel={false}>
          <ThemeSelect />
        </Row>
        <Row label="모션" hint="자동은 기기의 ‘동작 줄이기’ 설정을 따릅니다" asLabel={false}>
          <MotionSelect />
        </Row>
      </section>

      <section className="panel-section">
        <h3>펜</h3>
        <PenStylePicker />
        <Row label="손가락·터치펜으로 그리기" hint="정전식(고무팁) 터치펜은 손가락으로 인식됩니다. 켜면 한 손가락 = 그리기, 두 손가락 = 이동/확대">
          <Toggle k="fingerDraw" />
        </Row>
        <Row label="지우개 방식">
          <Select k="eraserMode" options={[['stroke', '획 단위'], ['partial', '부분 (닿은 곳만)']]} />
        </Row>
      </section>

      <section className="panel-section">
        <h3>파일 전송</h3>
        <Row label="큰 파일 전송 전 확인" hint="이 크기 이상을 다운로드·업로드하기 전에 한 번 더 묻습니다 (iPad는 셀룰러 여부를 알 수 없어 크기로 확인합니다). 메타데이터만 있는 노트를 열어 원본(PDF·이미지)을 받을 때도 묻습니다">
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

      {/* 자주 바꾸지 않는 항목 — 기본은 접어 둔다. API 이름이 들어간 힌트는 여기 안에서만 보인다. */}
      <details className="panel-section adv">
        <summary>고급</summary>
        <section className="panel-section">
          <h3>입력 · 지연</h3>
          <Row label="펜 끝 예측 그리기" hint="getPredictedEvents">
            <Toggle k="prediction" />
          </Row>
          <Row label="중간 점 수집" hint="getCoalescedEvents">
            <Toggle k="coalesced" />
          </Row>
          <Row label="손바닥 무시 시간" hint="펜을 뗀 뒤 이 시간의 '홑접촉'만 손바닥으로 봅니다. 두 번째 손가락이 오면 곧바로 제스처로 씁니다">
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
          <Row label="라이브 창 (점)" hint="입력 중 매 프레임 다시 그리는 최근 점 개수. 그 앞부분은 한 번만 굳혀 두어 획이 길어져도 지연이 늘지 않습니다">
            <Slider k="liveWindow" min={8} max={128} step={8} />
          </Row>
          </section>
        )}

        {/* 디버깅용: 앱 인터넷 사용량 (셀룰러 데이터 확인) — 이 한 줄과 import를 지우면 사라진다 */}
        {showDebug && <NetUsageSection />}
      </details>
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
