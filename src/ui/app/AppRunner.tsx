import { useEffect, useRef, useState } from 'react'
import { useUI } from '../../app/store'
import { errorText, startActivity, type ActivityHandle, type ActivityKind } from '../../shared/activity'
import { askPdfPassword, confirmDialog } from '../../app/dialogs'
import { Icon } from '../Icon'
import { pickFiles, saveFile } from '../../io/download'
import { fileRoute, type FileRoute } from '../../io/fileRoute'
import { importInkpad } from '../../io/inkpadFormat'
import { createDocumentFromPdf, ImportError, readPdf } from '../../io/pdfImport'
import { formatBytes } from '../../shared/util'
import type { HtmlApp, ID } from '../../shared/model'
import { updateDocument } from '../../storage/repo'
import { addApp, getApp, loadAppStorage, saveAppStorage } from '../../sync/apps'
import { addFile } from '../../sync/files'
import { uploadAsk, uploadChoice } from '../../sync/transfer'
import { buildSrcDoc } from './bridge'
import { InkpadFilePicker } from './InkpadFilePicker'
import { RunnerBack, RunnerSplit, type PaneSlot } from './RunnerNav'

// allow-same-origin은 절대 넣지 않는다 — 넣으면 앱이 Inkpad의 IndexedDB(노트)와 Drive 토큰에 접근할 수 있다
const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads'

type FileReq = { id: number; accept: string; multiple: boolean }
/** win: 요청한 iframe — 다시 실행한 뒤 늦게 끝난 저장의 답이 새 앱으로 가지 않게 */
type SaveReq = { id: number; file: File; win: Window; route: FileRoute }

/** 저장 창 안내 — 형식마다 어디에 들어가는지 (io/fileRoute: 라이브러리 "파일 추가"·끌어 놓기와 같다) */
const SAVE_NOTE: Record<FileRoute, string> = {
  file: 'Inkpad에 저장하면 기타 파일에 들어가고 클라우드에 바로 올라갑니다.',
  html: 'Inkpad에 저장하면 앱으로 추가되고 클라우드에 바로 올라갑니다.',
  inkpad: 'Inkpad에 저장하면 노트로 가져옵니다 — 클라우드에는 동기화의 올리기로 올라갑니다.',
  pdf: '노트로 저장하면 필기할 수 있는 노트가 됩니다(클라우드에는 동기화의 올리기로). 기타 파일로 저장하면 보관용으로 클라우드에 바로 올라갑니다.'
}

export function AppRunner({ appId, pane = 'main' }: { appId: ID; pane?: PaneSlot }) {
  const navigate = useUI((s) => s.navigate)
  const toast = useUI((s) => s.toast)
  const frame = useRef<HTMLIFrameElement>(null)
  const [app, setApp] = useState<HtmlApp | null | undefined>(undefined)
  const [srcDoc, setSrcDoc] = useState('')
  const [run, setRun] = useState(0)
  const [fileReq, setFileReq] = useState<FileReq | null>(null)
  const [inkpadPicker, setInkpadPicker] = useState(false)
  // 앱이 한 번에 여러 파일을 내보내면 차례로 묻는다
  const [saves, setSaves] = useState<SaveReq[]>([])
  // zip은 안을 들여다보느라 늦을 수 있다 — 형식 판정을 줄 세워 내보낸 순서대로 묻는다
  const routing = useRef(Promise.resolve())

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
        const id = m.id
        const file = new File([m.file], name, { type: m.file.type })
        const win = e.source as Window
        routing.current = routing.current.then(async () => {
          const route = await fileRoute(file)
          if (frame.current?.contentWindow !== win) return // 그 사이 다시 실행했다
          setSaves((q) => [...q, { id, file, win, route }])
        })
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

  /** 저장 창을 닫고 일을 한 뒤 앱에 저장 여부를 알린다 — 그동안은 화면을 막지 않고 탭 바 상태 칸(전송)에 보인다 */
  const finish = async (req: SaveReq, kind: ActivityKind, work: (a: ActivityHandle) => Promise<boolean>) => {
    setSaves((q) => q.slice(1))
    const act = startActivity(kind, req.file.name)
    let ok = false
    try {
      ok = await work(act)
      if (ok) act.done()
      else act.drop()
    } catch (e) {
      act.fail(errorText(e, '파일을 저장하지 못했습니다.'))
      toast(e instanceof Error ? e.message : '파일을 저장하지 못했습니다.', 'error')
    }
    saved(req, ok)
  }
  const category = app?.category ?? null

  /**
   * 기타 파일로 추가 — 라이브러리의 "파일 추가"와 같다: 업로드하면 그 파일만 바로 올린다.
   * 큰 파일 확인(sync/transfer)은 저장 창에 합쳐 두 번 묻지 않는다 — upload=false가 "이 기기에만".
   * PDF를 기타 파일로 고르면 그때 따로 묻는다(upload='ask')
   */
  const asFile = (req: SaveReq, upload: boolean | 'ask') =>
    finish(req, 'import', async () => {
      if (upload === 'ask') {
        const choice = await uploadChoice(req.file.size)
        if (choice === 'cancel') return false
        upload = choice === 'upload'
      }
      const r = await addFile(req.file, category, { upload })
      const open = { label: '열기', run: () => navigate({ name: 'file', fileId: r.file.id }) }
      if (!upload) toast('이 기기의 기타 파일에 저장했습니다. 업로드하려면 목록에서 재업로드를 눌러 주세요.', 'info', open)
      else if (!r.uploaded) toast('기타 파일에 저장했지만 오프라인이라 업로드하지 못했습니다. 연결된 뒤 목록에서 재업로드를 눌러 주세요.', 'error', open)
      else toast('기타 파일에 저장하고 클라우드에 업로드했습니다.', 'success', open)
      return true
    })

  const asApp = (req: SaveReq) =>
    finish(req, 'import', async () => {
      const r = await addApp(req.file, category)
      const run = { label: '실행', run: () => navigate({ name: 'app', appId: r.app.id }) }
      toast(r.uploaded ? '앱으로 추가하고 클라우드에 저장했습니다.' : '앱으로 추가했습니다. 클라우드에는 다음 올리기 때 저장됩니다.', 'success', run)
      return true
    })

  const asInkpad = (req: SaveReq) =>
    finish(req, 'import', async (a) => {
      const r = await importInkpad(req.file, null, (d, t) => a.update({ progress: d / t }))
      const one = r.documents.length === 1 ? r.documents[0] : null
      toast(
        `문서 ${r.documents.length}개를 가져왔습니다${r.skipped ? ` (${r.skipped}개 건너뜀)` : ''}${r.skippedBlocks ? ` — 새 버전에서 만든 블록 ${r.skippedBlocks}개를 가져오지 못했습니다` : ''}.`,
        'success',
        one ? { label: '열기', run: () => navigate({ name: 'editor', docId: one.id }) } : undefined
      )
      return r.documents.length > 0
    })

  /** PDF → 노트 (라이브러리의 PDF 가져오기와 같다). 앱과 같은 카테고리, 폴더 없이 */
  const asNote = (req: SaveReq) =>
    finish(req, 'import', async (a) => {
      const name = req.file.name
      a.update({ detail: '읽는 중', progress: 0 })
      const info = await readPdf(req.file, name, askPdfPassword, (p) => a.update({ progress: p }))
      if (!info.pages.length) throw new ImportError('읽을 수 있는 페이지가 없습니다.')
      if (info.failedPages.length) {
        const ok = await confirmDialog('일부 페이지를 읽을 수 없습니다', {
          message: `${info.failedPages.length}개 페이지가 손상되었습니다. 읽을 수 있는 ${info.pages.length}개 페이지만 가져올까요?`,
          ok: '가져오기'
        })
        if (!ok) return false
      }
      const doc = await createDocumentFromPdf(info, null)
      if (category) await updateDocument(doc.id, { category })
      toast('PDF를 노트로 저장했습니다. 클라우드에는 동기화의 올리기로 올라갑니다.', 'success', { label: '열기', run: () => navigate({ name: 'editor', docId: doc.id }) })
      return true
    })

  const save = saves[0]
  // 저장 창에 합치는 큰 파일 확인은 바로 올리는 기타 파일에만 (앱 추가는 묻지 않고, 노트는 올리지 않는다)
  const ask = save?.route === 'file' ? uploadAsk(save.file.size) : null

  return (
    <div className="app-runner">
      <header className="app-runner-bar">
        <RunnerBack pane={pane} />
        <h1 className="app-runner-title">{app?.title ?? ''}</h1>
        <RunnerSplit pane={pane} route={{ name: 'app', appId }} />
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
            <p className="modal-note">{SAVE_NOTE[save.route]}</p>
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
              {save.route === 'file' && (
                <>
                  {ask && (
                    <button className="text-btn" onClick={() => void asFile(save, false)}>
                      <Icon name="app" size={18} /> Inkpad 이 기기에만
                    </button>
                  )}
                  <button className="primary-btn" onClick={() => void asFile(save, true)}>
                    <Icon name="cloud" size={18} /> Inkpad에 저장
                  </button>
                </>
              )}
              {save.route === 'html' && (
                <button className="primary-btn" onClick={() => void asApp(save)}>
                  <Icon name="app" size={18} /> 앱으로 저장
                </button>
              )}
              {save.route === 'inkpad' && (
                <button className="primary-btn" onClick={() => void asInkpad(save)}>
                  <Icon name="notebook" size={18} /> 노트로 가져오기
                </button>
              )}
              {save.route === 'pdf' && (
                <>
                  <button className="text-btn" onClick={() => void asFile(save, 'ask')}>
                    <Icon name="file" size={18} /> 기타 파일로
                  </button>
                  <button className="primary-btn" onClick={() => void asNote(save)}>
                    <Icon name="notebook" size={18} /> 노트로 저장
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
