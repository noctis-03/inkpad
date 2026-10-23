// 이미지로 보내기 — 페이지(또는 올가미로 고른 영역)를 읽기 좋은 해상도로 다시 그려 복사·공유한다.
// 화면 분할로 옆에 띄운 Claude 같은 AI 앱에 붙여넣어 묻는 용도. 이 기기 안에서만 만들고 어디에도 올리지 않는다(네트워크 0).
import { useEffect, useState } from 'react'
import { useUI, type SendImageTarget } from '../../app/store'
import type { Engine } from '../../engine/engine'
import { saveFile } from '../../io/download'
import { Icon } from '../Icon'

type ShareNav = Navigator & { canShare?: (d: ShareData) => boolean }

/** 클립보드에 이미지를 쓸 수 있는가 (iPadOS Safari 13.4+, 크롬) */
const canCopyImage = () => typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write

export function SendImageSheet({ engine, title, target }: { engine: Engine; title: string; target: SendImageTarget }) {
  const toast = useUI((s) => s.toast)
  const close = () => useUI.setState({ sendImage: null })
  const [blob, setBlob] = useState<Blob | null>(null)
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  const name = `${title || '노트'} ${target === 'selection' ? '부분' : `${target.page + 1}쪽`}.png`

  useEffect(() => {
    let alive = true
    let u = ''
    void engine.exportImage(target).then(
      (b) => {
        if (!alive) return
        if (!b) return setFailed(true)
        u = URL.createObjectURL(b)
        setBlob(b)
        setUrl(u)
      },
      () => alive && setFailed(true)
    )
    return () => {
      alive = false
      if (u) URL.revokeObjectURL(u)
    }
  }, [engine, target])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const file = blob ? new File([blob], name, { type: 'image/png' }) : null
  const canShare = !!file && !!(navigator as ShareNav).canShare?.({ files: [file] })

  // 복사·공유는 누른 처리기 안에서 바로 부른다 — Safari는 사용자 탭 밖의 클립보드 쓰기·공유를 막는다
  const copy = () => {
    if (!blob) return
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(
      () => {
        toast('이미지를 복사했습니다 — AI 앱 입력창을 길게 눌러 붙여넣으세요.', 'success')
        close()
      },
      () => toast(canShare ? '복사하지 못했습니다. 공유로 보내 보세요.' : '복사하지 못했습니다. 저장해서 보내 보세요.', 'error')
    )
  }
  const share = () => {
    if (!file) return
    navigator.share({ files: [file], title: name }).then(close, (e) => {
      if ((e as DOMException)?.name !== 'AbortError') toast('공유하지 못했습니다.', 'error')
    })
  }
  const save = () => {
    if (!blob) return
    void saveFile(blob, name, false).then(close)
  }

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal send-image" role="dialog" aria-label="이미지로 보내기">
        <h2 className="modal-title">이미지로 보내기</h2>
        <div className="send-image-preview">
          {url ? <img src={url} alt={target === 'selection' ? '고른 영역' : `${target.page + 1}쪽`} /> : failed ? <p>이미지를 만들지 못했습니다.</p> : <div className="spinner" />}
        </div>
        <p className="modal-note">
          Claude 같은 AI 앱을 옆에 띄우고(화면 분할) 붙여넣어 물어보세요. 이 기기에서만 만들고 어디에도 올리지 않습니다. 메모·할 일 블록은 담기지 않습니다.
        </p>
        <div className="modal-actions wrap">
          <button className="text-btn" onClick={close}>
            닫기
          </button>
          {canShare ? (
            <button className="text-btn" onClick={share} disabled={!blob}>
              <Icon name="share" size={18} /> 공유
            </button>
          ) : (
            <button className="text-btn" onClick={save} disabled={!blob}>
              <Icon name="download" size={18} /> 저장
            </button>
          )}
          {canCopyImage() && (
            <button className="primary-btn" onClick={copy} disabled={!blob}>
              <Icon name="copy" size={18} /> 복사
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
