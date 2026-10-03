import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../Icon'
import { listInkpadFiles, readInkpadFile, type InkpadFile } from '../../sync/inkpadFiles'

/** 앱이 요청한 accept 문자열에 맞는 파일인지 ('.pdf', 'image/*', 'text/html' 등) */
function matchesAccept(accept: string, mime: string, name: string): boolean {
  const a = accept.trim().toLowerCase()
  if (!a) return true
  const nm = name.toLowerCase()
  const m = mime.toLowerCase()
  return a
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((tok) => {
      if (tok.startsWith('.')) return nm.endsWith(tok)
      if (tok.endsWith('/*')) return m.startsWith(tok.slice(0, -1))
      return m === tok
    })
}

function humanSize(n: number) {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

/** "Inkpad에서 고르기" — 앱·원본 목록에서 파일을 고른다 */
export function InkpadFilePicker({
  accept,
  multiple,
  onPick,
  onBack
}: {
  accept: string
  multiple: boolean
  onPick: (files: File[]) => void
  onBack: () => void
}) {
  const [files, setFiles] = useState<InkpadFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void listInkpadFiles()
      .then((list) => alive && setFiles(list))
      .catch((e) => alive && setError(e instanceof Error ? e.message : '목록을 불러오지 못했습니다.'))
    return () => {
      alive = false
    }
  }, [])

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (files ?? [])
      .filter((f) => matchesAccept(accept, f.mime, f.name))
      .filter((f) => !q || f.name.toLowerCase().includes(q))
  }, [files, accept, query])

  const groups = useMemo(
    () => [
      { kind: 'app' as const, icon: 'app', title: 'HTML 앱', items: items.filter((f) => f.kind === 'app') },
      { kind: 'file' as const, icon: 'file', title: '파일', items: items.filter((f) => f.kind === 'file') },
      { kind: 'asset' as const, icon: 'file', title: '노트 원본 (PDF·이미지)', items: items.filter((f) => f.kind === 'asset') }
    ].filter((g) => g.items.length > 0),
    [items]
  )

  const take = async (list: InkpadFile[]) => {
    if (!list.length || busy) return
    setBusy(true)
    setError(null)
    try {
      const out: File[] = []
      for (const f of list) out.push(await readInkpadFile(f))
      onPick(out)
    } catch (e) {
      setError(e instanceof Error ? e.message : '파일을 가져오지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  const tap = (f: InkpadFile) => {
    if (busy) return
    if (!multiple) {
      void take([f])
      return
    }
    setPicked((s) => {
      const n = new Set(s)
      if (n.has(f.key)) n.delete(f.key)
      else n.add(f.key)
      return n
    })
  }

  const chosen = items.filter((f) => picked.has(f.key))

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onBack()}>
      <div className="modal inkpad-pick-modal" role="dialog" aria-label="Inkpad에서 고르기">
        <h2 className="modal-title">Inkpad에서 고르기</h2>
        <p className="modal-message">
          Inkpad에 저장된 앱·파일·원본에서 고릅니다.
          {accept ? ` (앱이 요청한 형식: ${accept})` : ''}
        </p>

        <div className="inkpad-pick-search">
          <Icon name="search" size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="이름 검색" aria-label="Inkpad 파일 검색" />
        </div>

        {error && <p className="hint warn">{error}</p>}

        {files === null && !error && <p className="inkpad-pick-empty">목록을 불러오는 중…</p>}

        {files !== null && groups.length === 0 && <p className="inkpad-pick-empty">조건에 맞는 Inkpad 파일이 없습니다.</p>}

        {groups.length > 0 && (
          <div className="inkpad-pick-list">
            {groups.map((g) => (
              <section key={g.kind} className="inkpad-pick-group">
                <h3 className="inkpad-pick-group-title">
                  <Icon name={g.icon} size={13} /> {g.title} <b>{g.items.length}</b>
                </h3>
                {g.items.map((f) => (
                  <button key={f.key} className={'inkpad-pick-row' + (picked.has(f.key) ? ' is-picked' : '')} onClick={() => tap(f)}>
                    <Icon name={f.kind === 'app' ? 'app' : 'file'} size={18} />
                    <span className="inkpad-pick-body">
                      <span className="inkpad-pick-name">{f.name}</span>
                      <span className="inkpad-pick-sub">
                        {humanSize(f.size)}
                        {f.local ? ' · 이 기기에 있음' : ' · 클라우드에서 받아옴'}
                      </span>
                    </span>
                    {multiple && <Icon name={picked.has(f.key) ? 'check' : 'plus'} size={18} />}
                  </button>
                ))}
              </section>
            ))}
          </div>
        )}

        <div className="modal-actions">
          <button className="text-btn" onClick={onBack} disabled={busy}>
            <Icon name="back" size={16} /> 뒤로
          </button>
          {multiple && (
            <button className="primary-btn" disabled={!chosen.length || busy} onClick={() => void take(chosen)}>
              {busy ? '가져오는 중…' : `${chosen.length}개 가져오기`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
