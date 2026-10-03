import { useEffect, useRef, useState } from 'react'
import { useUI } from '../../app/store'
import { Icon } from '../Icon'
import { pickFiles } from '../../io/download'
import type { HtmlApp, ID } from '../../shared/model'
import { getApp, loadAppStorage, saveAppStorage } from '../../sync/apps'
import { buildSrcDoc } from './bridge'

// allow-same-origin은 절대 넣지 않는다 — 넣으면 앱이 Inkpad의 IndexedDB(노트)와 Drive 토큰에 접근할 수 있다
const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads'

type FileReq = { id: number; accept: string; multiple: boolean }

export function AppRunner({ appId }: { appId: ID }) {
  const navigate = useUI((s) => s.navigate)
  const frame = useRef<HTMLIFrameElement>(null)
  const [app, setApp] = useState<HtmlApp | null | undefined>(undefined)
  const [srcDoc, setSrcDoc] = useState('')
  const [run, setRun] = useState(0)
  const [fileReq, setFileReq] = useState<FileReq | null>(null)

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

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return // 이 앱에서 온 메시지만
      const m = e.data as { __inkpad?: number; type?: string; id?: number; accept?: unknown; multiple?: unknown; data?: unknown }
      if (m?.__inkpad !== 1) return
      if (m.type === 'pick' && typeof m.id === 'number') {
        setFileReq({ id: m.id, accept: typeof m.accept === 'string' ? m.accept : '', multiple: !!m.multiple })
      } else if (m.type === 'storage' && m.data && typeof m.data === 'object') {
        void saveAppStorage(appId, m.data as Record<string, unknown>)
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
        <button className="tb-btn" onClick={() => navigate({ name: 'library' })} aria-label="뒤로">
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
          />
        )
      )}

      {fileReq && (
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
              <button className="primary-btn" onClick={() => choose(fileReq)}>
                <Icon name="file" size={18} /> 파일 선택
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
