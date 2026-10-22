import { useEffect, useRef, useState } from 'react'
import { useUI } from '../../app/store'
import { Icon } from '../Icon'
import { pickFiles } from '../../io/download'
import type { HtmlApp, ID } from '../../shared/model'
import { getApp, loadAppStorage, saveAppStorage } from '../../sync/apps'
import { buildSrcDoc } from './bridge'
import { emitThumbsChanged } from '../../io/docThumb'
import { appThumbKey, imageToThumb, putItemThumb } from '../../io/itemThumb'
import { InkpadFilePicker } from './InkpadFilePicker'

// allow-same-origin은 절대 넣지 않는다 — 넣으면 앱이 Inkpad의 IndexedDB(노트)와 Drive 토큰에 접근할 수 있다
const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads'

type FileReq = { id: number; accept: string; multiple: boolean }

// 카드 미리보기 — 앱이 iframe 안에서 지금 화면을 그려 보낸다(bridge의 snap). 열고 잠시 뒤 한 번,
// 손을 댄 뒤 조용해지면 다시 찍어(너무 자주는 말고) 마지막으로 본 화면이 카드에 남는다
const SNAP_FIRST = 1500
const SNAP_IDLE = 2500
const SNAP_GAP = 15000
/** 앱이 보내는 그림은 믿지 않는다 — 요청했을 때만, 이 크기 아래 PNG · SVG만 받고 다시 그려 저장한다 */
const SNAP_MAX_BYTES = 8 * 1024 * 1024
/** 그리는 라이브러리(html-to-image) 소스 — 앱 안에 넣어야 하므로 문자열로, 처음 찍을 때 불러온다 */
const loadSnapLib = () => import('html-to-image/dist/html-to-image.js?raw').then((m) => m.default)

export function AppRunner({ appId }: { appId: ID }) {
  const navigate = useUI((s) => s.navigate)
  const frame = useRef<HTMLIFrameElement>(null)
  const [app, setApp] = useState<HtmlApp | null | undefined>(undefined)
  const [srcDoc, setSrcDoc] = useState('')
  const [run, setRun] = useState(0)
  const [fileReq, setFileReq] = useState<FileReq | null>(null)
  const [inkpadPicker, setInkpadPicker] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      const a = await getApp(appId)
      if (!alive) return
      if (!a || a.deletedAt) return setApp(null)
      const store = await loadAppStorage(appId)
      if (!alive) return
      setApp(a)
      setSrcDoc(buildSrcDoc(a.html, store))
    })()
    return () => {
      alive = false
    }
  }, [appId, run])

  const reply = (msg: object) => frame.current?.contentWindow?.postMessage({ __inkpad: 1, ...msg }, '*')

  const snapWait = useRef(false) // 'snap'을 보내고 답을 기다리는 중
  const snapAt = useRef(0) // 마지막으로 찍은 시각
  const snapTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const snap = async () => {
    if (snapWait.current || document.hidden || !frame.current) return
    snapWait.current = true
    snapAt.current = Date.now()
    try {
      reply({ type: 'snap', lib: await loadSnapLib(), w: 320, ratio: 1.3 })
    } catch {
      snapWait.current = false
      return
    }
    setTimeout(() => (snapWait.current = false), 10000) // 답이 없으면 다음 기회에
  }
  /** delay 뒤 찍는다. 앞서 걸어 둔 것은 미룬다 — 손을 대는 동안은 찍지 않고 조용해지면 */
  const scheduleSnap = (delay: number) => {
    clearTimeout(snapTimer.current)
    snapTimer.current = setTimeout(() => void snap(), Math.max(delay, snapAt.current + SNAP_GAP - Date.now()))
  }
  useEffect(() => () => clearTimeout(snapTimer.current), [])
  /** PNG(blob)이 오면 카드 크기 JPEG로 다시 그린다. SVG(svg — PNG를 못 만든 브라우저)는 그려 보고, 이 브라우저도
      못 그리면 SVG 그대로 둔다 — <img>로만 보이므로 그 안의 스크립트·외부 파일은 돌지 않는다 */
  const onSnapped = async (m: { blob?: unknown; svg?: unknown }) => {
    if (!snapWait.current) return // 요청하지 않은 그림
    snapWait.current = false
    let src: Blob | null = null
    if (m.blob instanceof Blob && m.blob.type === 'image/png') src = m.blob
    else if (typeof m.svg === 'string' && m.svg.startsWith('data:image/svg+xml') && m.svg.length < SNAP_MAX_BYTES * 3) {
      try {
        src = new Blob([decodeURIComponent(m.svg.slice(m.svg.indexOf(',') + 1))], { type: 'image/svg+xml' })
      } catch {
        return // 망가진 주소
      }
    }
    if (!src || src.size > SNAP_MAX_BYTES) return
    const out = (await imageToThumb(src, 'screen').catch(() => null)) ?? (src.type === 'image/svg+xml' ? src : null)
    if (!out) return
    await putItemThumb(appThumbKey(appId), out)
    emitThumbsChanged()
  }

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return // 이 앱에서 온 메시지만
      const m = e.data as { __inkpad?: number; type?: string; id?: number; accept?: unknown; multiple?: unknown; data?: unknown }
      if (m?.__inkpad !== 1) return
      if (m.type === 'pick' && typeof m.id === 'number') {
        setFileReq({ id: m.id, accept: typeof m.accept === 'string' ? m.accept : '', multiple: !!m.multiple })
      } else if (m.type === 'storage' && m.data && typeof m.data === 'object') {
        void saveAppStorage(appId, m.data as Record<string, unknown>)
      } else if (m.type === 'snapped') {
        void onSnapped(m as { blob?: unknown; svg?: unknown })
      } else if (m.type === 'touched') {
        scheduleSnap(SNAP_IDLE)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [appId])

  // iPad Safari는 사용자 탭 없이 파일 선택 창을 열지 않으므로 Inkpad 쪽 버튼을 한 번 거친다
  const choose = (req: FileReq) => {
    setFileReq(null)
    void pickFiles(req.accept, req.multiple).then((files) => reply({ type: 'picked', id: req.id, files }))
  }

  return (
    <div className="app-runner">
      <header className="app-runner-bar">
        <button className="tb-btn" onClick={() => navigate(useUI.getState().returnRoute ?? { name: 'library' })} aria-label="뒤로">
          <Icon name="back" />
        </button>
        <h1 className="app-runner-title">{app?.title ?? ''}</h1>
        <button className="tb-btn" onClick={() => setRun((n) => n + 1)} aria-label="다시 실행" title="다시 실행">
          <Icon name="restore" />
        </button>
      </header>

      {app === null ? (
        <div className="empty-state">
          <p>앱을 찾을 수 없습니다.</p>
        </div>
      ) : (
        app && (
          <iframe
            key={run}
            ref={frame}
            className="app-runner-frame"
            title={app.title}
            sandbox={SANDBOX}
            allow="clipboard-write; fullscreen"
            srcDoc={srcDoc}
            onLoad={() => srcDoc && scheduleSnap(SNAP_FIRST)}
          />
        )
      )}

      {/* Inkpad가 만든 클라우드 파일(앱·원본)에서 고르기 */}
      {fileReq && inkpadPicker && (
        <InkpadFilePicker
          accept={fileReq.accept}
          multiple={fileReq.multiple}
          onBack={() => setInkpadPicker(false)}
          onPick={(files) => {
            reply({ type: 'picked', id: fileReq.id, files })
            setInkpadPicker(false)
            setFileReq(null)
          }}
        />
      )}

      {fileReq && !inkpadPicker && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2 className="modal-title">파일 불러오기</h2>
            <p>"{app?.title}" 앱이 파일을 요청합니다{fileReq.accept ? ` (${fileReq.accept})` : ''}.</p>
            <div className="modal-actions">
              <button
                className="text-btn"
                onClick={() => {
                  reply({ type: 'picked', id: fileReq.id, files: [] })
                  setFileReq(null)
                }}
              >
                취소
              </button>
              <button className="text-btn" onClick={() => setInkpadPicker(true)}>
                <Icon name="app" size={18} /> Inkpad에서 고르기
              </button>
              <button className="primary-btn" onClick={() => choose(fileReq)}>
                <Icon name="file" size={18} /> 기기에서 고르기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
