import { useEffect, useState } from 'react'
import { useUI } from '../../app/store'
import { Icon } from '../Icon'
import { saveFile } from '../../io/download'
import type { ID } from '../../shared/model'
import type { FileRow } from '../../storage/db'
import { ensureFileLocal, fileToBlob, getFile } from '../../sync/files'
import { confirmTransfer } from '../../sync/transfer'

/** 일반 파일 뷰어 — 종류별로 읽기 전용 표시 (텍스트 / 이미지 / 그 외 다운로드) */
export function FileRunner({ fileId }: { fileId: ID }) {
  const navigate = useUI((s) => s.navigate)
  const [row, setRow] = useState<FileRow | null | undefined>(undefined)
  const [url, setUrl] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    let objectUrl = ''
    setRow(undefined)
    setUrl('')
    setText('')
    setError(null)
    void (async () => {
      const f = await getFile(fileId)
      if (!alive) return
      if (!f || f.deletedAt) return setRow(null)
      setRow(f)
      try {
        if (!(await confirmTransfer('down', f.size))) throw new Error('다운로드를 취소했습니다.')
        const full = await ensureFileLocal(fileId)
        if (!alive) return
        setRow(full)
        if (full.kind === 'text') setText(full.text ?? '')
        else if (full.kind === 'image') {
          const blob = full.blob ?? (await fileToBlob(full))
          if (!alive) return
          objectUrl = URL.createObjectURL(blob)
          setUrl(objectUrl)
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : '파일을 열지 못했습니다.')
      }
    })()
    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [fileId])

  const download = async () => {
    if (!row) return
    try {
      // 원본이 이 기기에 없으면 내보내기가 다운로드를 일으킨다 — 기준 이상이면 먼저 묻는다 (11.3)
      const hasOrig = row.text !== undefined || !!row.blob
      if (!hasOrig && !(await confirmTransfer('down', row.size))) return
      await saveFile(await fileToBlob(row), row.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : '내보내기 실패')
    }
  }

  return (
    <div className="file-runner">
      <header className="app-runner-bar">
        <button className="tb-btn" onClick={() => navigate({ name: 'library' })} aria-label="뒤로">
          <Icon name="back" />
        </button>
        <h1 className="app-runner-title">{row ? row.title : ''}</h1>
        <button className="tb-btn" onClick={() => void download()} aria-label="내보내기" title="파일로 내보내기" disabled={!row}>
          <Icon name="download" />
        </button>
      </header>

      {row === null ? (
        <div className="empty-state">
          <p>파일을 찾을 수 없습니다.</p>
        </div>
      ) : row && error ? (
        <div className="empty-state">
          <Icon name="alert" size={40} />
          <p>{error}</p>
        </div>
      ) : row && row.kind === 'text' ? (
        <pre className="file-text">{text}</pre>
      ) : row && row.kind === 'image' ? (
        <div className="file-image">{url ? <img src={url} alt={row.title} /> : <div className="spinner" />}</div>
      ) : row ? (
        <div className="empty-state file-other">
          <Icon name="file" size={48} />
          <p>
            {row.name}
            <br />
            {Math.round(row.size / 1024)}KB · 이 형식은 미리보기를 지원하지 않습니다.
          </p>
          <button className="primary-btn" onClick={() => void download()}>
            <Icon name="download" size={18} /> 내보내기
          </button>
        </div>
      ) : (
        <div className="empty-state">
          <div className="spinner" />
        </div>
      )}
    </div>
  )
}
