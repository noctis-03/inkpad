import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { useUI } from './app/store'
import { startSync } from './sync/sync'
import './styles.css'
import { installNetMeter, isNetMeterEnabled } from './shared/netMeter'

// 디버깅용 네트워크 사용량 계량 (셀룰러 데이터 확인용). 기본은 꺼짐 — 설정에서 켜면 다음 실행부터 센다
if (isNetMeterEnabled()) installNetMeter()

createRoot(document.getElementById('root')!).render(<App />)

// 시작 화면(index.html) — 첫 화면이 그려진 뒤에 닫게 한다(모션 한 번은 다 보인 뒤에 사라진다)
requestAnimationFrame(() => requestAnimationFrame(() => (window as unknown as { __inkpadReady?: () => void }).__inkpadReady?.()))

// 저장소 보존 요청 — 브라우저가 공간이 부족할 때 데이터를 지우지 않게. Safari는 홈 화면 설치 시 허용하는 경우가 많다.
navigator.storage?.persist?.().catch(() => {})

// Google Drive 동기화: 로컬은 항상 즉시 저장되고,
// 받기/올리기는 사용자가 설정 > 동기화의 버튼을 눌렀을 때만 실행된다.
startSync() // 온라인/오프라인 상태 표시 + 세션 확인만 담당

// 오프라인 실행 (서비스 워커 public/sw.js)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js')
      reg.addEventListener('updatefound', () => {
        const w = reg.installing
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            useUI.getState().toast('새 버전이 준비되었습니다.', 'info', {
              label: '새로고침',
              run: () => location.reload()
            })
          }
        })
      })
    } catch {
      /* 개발 환경 등 */
    }
  })
}

// 앱이 백그라운드에서 오래 있다가 돌아오면 캔버스 메모리를 Safari가 비웠을 수 있다 → 다시 그리기는 엔진이 resize로 처리
