import { useEffect, useRef, useState } from 'react'
import { useUI } from '../../app/store'
import { Icon } from '../Icon'
import { pickFiles, saveFile } from '../../io/download'
import { formatBytes } from '../../shared/util'
import type { HtmlApp, ID } from '../../shared/model'
import { getApp, loadAppStorage, saveAppStorage } from '../../sync/apps'
import { addFile } from '../../sync/files'
import { uploadAsk } from '../../sync/transfer'
import { buildSrcDoc } from './bridge'
import { InkpadFilePicker } from './InkpadFilePicker'

// allow-same-origin은 절대 넣지 않는다 — 넣으면 앱이 Inkpad의 IndexedDB(노트)와 Drive 토큰에 접근할 수 있다
const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads'

type FileReq = { id: number; accept: string; multiple: boolean }
/** win: 요청한 iframe — 다시 실행한 뒤 늦게 끝난 저장의 답이 새 앱으로 가지 않게 */
type SaveReq = { id: number; file: File; win: Window }

export function AppRunner({ appId }: { appId: ID }) {
  const navigate = useUI((s) => s.navigate)
  const toast = useUI((s) => s.toast)
  const setBusy = useUI((s) => s.setBusy)
  const frame = useRef<HTMLIFrameElement>(null)
  const [app, setApp] = useState<HtmlApp | null | undefined>(undefined)
  const [srcDoc, setSrcDoc] = useState('')
  const [run, setRun] = useState(0)
  const [fileReq, setFileReq] = useState<FileReq | null>(null)
  const [inkpadPicker, setInkpadPicker] = useState(false)
  // 앱이 한 번에 여러 파일을 내보내면 차례로 묻는다
  const [saves, setSaves] = useState<SaveReq[]>([])

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
      const m = e.data as { __inkpad?: number; type?: string; id?: number; accept?: unknown; multiple?: unknown; data?: unknown; name?: unknown; file?: unknown }
      if (m?.__inkpad !== 1) return
      if (m.type === 'pick' && typeof m.id === 'number') {
        setFileReq({ id: m.id, accept: typeof m.accept === 'string' ? m.accept : '', multiple: !!m.multiple })
      } else if (m.type === 'save' && typeof m.id === 'number' && m.file instanceof Blob) {
        const name = (typeof m.name === 'string' && m.name.trim()) || (m.file instanceof File && m.file.name) || '내보낸 파일'
        const req: SaveReq = { id: m.id, file: new File([m.file], name, { type: m.file.type }), win: e.source as Window }
        setSaves((q) => [...q, req])
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

  const saved = (req: SaveReq, ok: boolean) => req.win.postMessage({ __inkpad: 1, type: 'saved', id: req.id, ok }, '*')

  // 공유 시트(iPad)는 사용자 탭 안에서 열어야 하므로 버튼 처리기에서 바로 부른다
  const saveToDevice = (req: SaveReq) => {
    setSaves((q) => q.slice(1))
    void saveFile(req.file, req.file.name).then(
      () => saved(req, true),
      (e) => {
        toast(e instanceof Error ? e.message : '저장하지 못했습니다.', 'error')
        saved(req, false)
      }
    )
  }

  /**
   * 기타 파일로 추가 — 라이브러리의 "파일 추가"와 같다: 업로드하면 그 파일만 바로 올린다.
   * 큰 파일 확인(sync/transfer)은 저장 창에 합쳐 두 번 묻지 않는다 — upload=false가 "이 기기에만".
   */
  const saveToInkpad = async (req: SaveReq, upload: boolean) => {
    setSaves((q) => q.slice(1))
    let ok = false
    try {
      setBusy({ text: `${req.file.name} 저장하는 중` })
      const r = await addFile(req.file, app?.category ?? null, { upload })
      ok = true
      const open = { label: '열기', run: () => navigate({ name: 'file', fileId: r.file.id }) }
      if (!upload) toast('이 기기의 기타 파일에 저장했습니다. 업로드하려면 목록에서 재업로드를 눌러 주세요.', 'info', open)
      else if (!r.uploaded) toast('기타 파일에 저장했지만 오프라인이라 업로드하지 못했습니다. 연결된 뒤 목록에서 재업로드를 눌러 주세요.', 'error', open)
      else toast('기타 파일에 저장하고 클라우드에 업로드했습니다.', 'success', open)
    } catch (e) {
      toast(e instanceof Error ? e.message : '파일을 저장하지 못했습니다.', 'error')
    } finally {
      setBusy(null)
    }
    saved(req, ok)
  }

  const save = saves[0]
  const ask = save ? uploadAsk(save.file.size) : null

  return (
    <div className="app-runner">
      <header className="app-runner-bar">
        <button className="tb-btn" onClick={() => navigate(useUI.getState().returnRoute ?? { name: 'library' })} aria-label="뒤로">
          <Icon name="back" />
        </button>
        <h1 className="app-runner-title">{app?.title ?? ''}</h1>
        <button
          className="tb-btn"
          onClick={() => {
            setSaves([])
            setRun((n) => n + 1)
          }}
          aria-label="다시 실행"
          title="다시 실행"
        >
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

      {save && !fileReq && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2 className="modal-title">파일 저장</h2>
            <p>
              "{app?.title}" 앱이 파일을 내보냅니다: {save.file.name} ({formatBytes(save.file.size)})
            </p>
            <p className="modal-note">Inkpad에 저장하면 기타 파일에 들어가고 클라우드에 바로 올라갑니다.</p>
            {ask && (
              <p className="modal-note">
                {ask.message} {ask.note}
              </p>
            )}
            <div className="modal-actions wrap">
              <button
                className="text-btn"
                onClick={() => {
                  setSaves((q) => q.slice(1))
                  saved(save, false)
                }}
              >
                취소
              </button>
              <button className="text-btn" onClick={() => saveToDevice(save)}>
                <Icon name="download" size={18} /> 기기에 저장
              </button>
              {ask && (
                <button className="text-btn" onClick={() => void saveToInkpad(save, false)}>
                  <Icon name="app" size={18} /> Inkpad 이 기기에만
                </button>
              )}
              <button className="primary-btn" onClick={() => void saveToInkpad(save, true)}>
                <Icon name="cloud" size={18} /> Inkpad에 저장
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
