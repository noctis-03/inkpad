import { useCallback, useEffect, useMemo, useState } from 'react'
import { useUI } from '../app/store'
import { confirmDialog } from '../app/dialogs'
import { formatBytes, formatDate } from '../shared/util'
import { AuthRequiredError, login } from '../sync/token'
import { onSyncStatus, type SyncStatus } from '../sync/sync'
import {
  FILES_EVENT,
  addFileFromCloud,
  deleteFileFromCloud,
  dropFileOriginal,
  ensureFileLocal,
  flushPendingFiles,
  listCloudFiles,
  removeFileLocal,
  reuploadFile,
  updateFileFromCloud,
  type CloudFileInfo,
  type CloudFileState
} from '../sync/files'
import { Icon } from './Icon'

// 기타 파일 메뉴: Drive의 Inkpad/files/ = 스토어. 메타만 받아 두고 원본은 열 때 지연 로딩한다.
const STATE_META: Record<CloudFileState, { label: string; tone: 'recv' | 'push' | 'fresh' | 'gone' }> = {
  update: { label: '업데이트', tone: 'recv' },
  pending: { label: '올릴 것', tone: 'push' },
  'local-only': { label: '올릴 것', tone: 'push' },
  local: { label: '이 기기에 있음', tone: 'fresh' },
  'meta-only': { label: '메타만', tone: 'fresh' },
  available: { label: '클라우드에만', tone: 'recv' },
  'cloud-missing': { label: '사라짐', tone: 'gone' }
}

const GROUPS: { key: 'update' | 'push' | 'local' | 'meta' | 'available' | 'missing'; title: string; tone: 'recv' | 'push' | 'fresh' | 'gone' }[] = [
  { key: 'update', title: '업데이트 있음', tone: 'recv' },
  { key: 'push', title: '올릴 것', tone: 'push' },
  { key: 'local', title: '이 기기에 있음', tone: 'fresh' },
  { key: 'meta', title: '메타만 있음', tone: 'fresh' },
  { key: 'available', title: '클라우드에만 있음', tone: 'recv' },
  { key: 'missing', title: '클라우드에서 사라짐', tone: 'gone' }
]

function groupOf(state: CloudFileState) {
  if (state === 'update') return 'update'
  if (state === 'pending' || state === 'local-only') return 'push'
  if (state === 'local') return 'local'
  if (state === 'meta-only') return 'meta'
  if (state === 'available') return 'available'
  return 'missing'
}

type Filter = 'all' | 'installed' | 'update' | 'available'
const matchFilter = (state: CloudFileState, f: Filter) =>
  f === 'all' ||
  (f === 'installed' && (state === 'local' || state === 'meta-only')) ||
  (f === 'update' && state === 'update') ||
  (f === 'available' && state === 'available')

export function FilesSheet({ onClose }: { onClose: () => void }) {
  const toast = useUI((s) => s.toast)
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [items, setItems] = useState<CloudFileInfo[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [openMenu, setOpenMenu] = useState<string | null>(null)

  useEffect(() => onSyncStatus(setStatus), [])

  const load = useCallback(async () => {
    try {
      setItems(await listCloudFiles())
    } catch (e) {
      setItems([])
      if (e instanceof AuthRequiredError) setStatus('auth-required')
      else toast(e instanceof Error ? e.message : '파일 목록을 가져오지 못했습니다.', 'error')
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const on = () => void load()
    window.addEventListener(FILES_EVENT, on)
    return () => window.removeEventListener(FILES_EVENT, on)
  }, [load])

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try {
      await fn()
      if (ok) toast(ok)
    } catch (e) {
      toast(e instanceof Error ? e.message : '작업 실패', 'error')
    } finally {
      setBusy(false)
      void load()
    }
  }

  const updateCount = useMemo(() => (items ?? []).filter((f) => f.state === 'update').length, [items])
  const pendingCount = useMemo(() => (items ?? []).filter((f) => f.state === 'pending' || f.state === 'local-only').length, [items])
  const localBytes = useMemo(() => (items ?? []).reduce((n, f) => n + (f.hasOriginal ? f.size : 0), 0), [items])

  const addMeta = (f: CloudFileInfo) => run(() => addFileFromCloud(f.id), `"${f.title}" 메타를 받았습니다.`)
  const addFull = (f: CloudFileInfo) => run(() => addFileFromCloud(f.id, { withOriginal: true }), `"${f.title}"을(를) 받았습니다.`)
  const download = (f: CloudFileInfo) => run(() => ensureFileLocal(f.id), `"${f.title}" 원본을 받았습니다.`)

  const removeLocal = async (f: CloudFileInfo) => {
    const warn = f.state === 'pending' || f.state === 'local-only' ? '클라우드에 없는 변경이 사라집니다. ' : ''
    if (!(await confirmDialog('이 기기에서 제거', { message: `${warn}"${f.title}"을(를) 이 기기에서만 제거합니다. 클라우드 사본은 남습니다.`, ok: '제거', danger: true }))) return
    await run(() => removeFileLocal(f.id), `"${f.title}"을(를) 이 기기에서 제거했습니다.`)
  }

  const removeCloud = async (f: CloudFileInfo) => {
    if (!(await confirmDialog('클라우드에서 삭제', { message: `"${f.title}"을(를) 클라우드에서 지웁니다. 모든 기기의 스토어에서 사라집니다. 이미 받은 기기에는 남아 있습니다.`, ok: '삭제', danger: true }))) return
    await run(() => deleteFileFromCloud(f.id), '클라우드에서 지웠습니다.')
  }

  const dropOriginal = async (f: CloudFileInfo) => {
    if (!(await confirmDialog('원본 지우기', { message: `"${f.title}"의 원본을 이 기기에서 지웁니다(메타는 남습니다). 열 때 다시 받습니다.`, ok: '지우기', danger: true }))) return
    await run(() => dropFileOriginal(f.id), '원본을 지웠습니다. 열 때 다시 받습니다.')
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (items ?? []).filter((f) => {
      if (!matchFilter(f.state, filter)) return false
      if (!q) return true
      return `${f.title} ${f.name} ${f.category ?? ''}`.toLowerCase().includes(q)
    })
  }, [items, filter, query])

  const groups = GROUPS.map((g) => ({ ...g, items: filtered.filter((f) => groupOf(f.state) === g.key) })).filter((g) => g.items.length > 0)
  const offline = !navigator.onLine

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-label="기타 파일">
        <header className="sheet-header">
          <h2>기타 파일</h2>
          <button className="tb-btn" onClick={onClose} aria-label="닫기">
            <Icon name="close" />
          </button>
        </header>
        <div className="sheet-scroll">
          {status === 'auth-required' ? (
            <div className="cloud-empty">
              <p>파일 스토어를 보려면 Google 로그인이 필요합니다.</p>
              <div className="btn-row center">
                <button className="primary-btn" onClick={() => login()}>
                  <Icon name="upload" size={18} /> Google로 로그인
                </button>
              </div>
            </div>
          ) : (
            <>
              {offline && <p className="hint warn">오프라인입니다. 이 기기에 있는 파일만 보입니다.</p>}
              <p className="hint">
                이 기기에 저장된 원본 합계: <b>{formatBytes(localBytes)}</b>
              </p>
              <div className="btn-row">
                {pendingCount > 0 && (
                  <button className="text-btn" onClick={() => void run(() => flushPendingFiles(), '올렸습니다.')} disabled={busy}>
                    <Icon name="upload" size={16} /> 올리기 ({pendingCount})
                  </button>
                )}
              </div>

              <div className="cloud-panel">
                <div className="cloud-toolbar">
                  <span className="cloud-search">
                    <Icon name="search" size={16} />
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="파일 검색" aria-label="파일 검색" />
                    {query && (
                      <button className="cloud-clear" onClick={() => setQuery('')} aria-label="검색 지우기">
                        <Icon name="close" size={13} />
                      </button>
                    )}
                  </span>
                </div>
                <div className="cloud-summary" role="group" aria-label="상태 필터">
                  {(
                    [
                      ['all', '전체'],
                      ['installed', '이 기기에 있음'],
                      ['update', '업데이트'],
                      ['available', '클라우드에만']
                    ] as [Filter, string][]
                  ).map(([k, label]) => {
                    const on = filter === k
                    return (
                      <button key={k} className={'cloud-sum fresh' + (on ? ' is-active' : '')} aria-pressed={on} onClick={() => setFilter(on && k !== 'all' ? 'all' : k)}>
                        <b>{(items ?? []).filter((f) => matchFilter(f.state, k)).length}</b>
                        <span>{label}</span>
                      </button>
                    )
                  })}
                </div>

                {groups.length === 0 && <p className="cloud-empty">{items === null ? '파일 목록을 불러오는 중…' : '조건에 맞는 파일이 없습니다.'}</p>}

                {groups.map((g) => (
                  <section className="cloud-group" key={g.key}>
                    <div className={'cloud-group-head ' + g.tone}>
                      <Icon name="chevronDown" size={13} />
                      <span>{g.title}</span>
                      <b>{g.items.length}</b>
                    </div>
                    <div className="cloud-items">
                      {g.items.map((f) => {
                        const m = STATE_META[f.state]
                        const at = f.remoteUpdatedAt ?? f.localUpdatedAt
                        const tappable = f.state === 'available'
                        const get = () => addFull(f)
                        return (
                          <div key={f.id} className="cloud-item-wrap">
                            <div
                              className={'cloud-item ' + m.tone + (tappable ? ' is-tappable' : '')}
                              role={tappable ? 'button' : undefined}
                              tabIndex={tappable ? 0 : undefined}
                              aria-label={tappable ? `${f.title} — 받기` : undefined}
                              onClick={tappable ? get : undefined}
                              onKeyDown={
                                tappable
                                  ? (e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault()
                                        get()
                                      }
                                    }
                                  : undefined
                              }
                            >
                              <div className="cloud-body">
                                <div className="cloud-name">{f.title}</div>
                                <div className="cloud-sub">
                                  <span>{formatBytes(f.size)}</span>
                                  {f.category && <span>{f.category}</span>}
                                  {at ? <span>{formatDate(at)}</span> : null}
                                </div>
                              </div>
                              {f.state === 'available' ? <span className="cloud-badge recv">받기</span> : <span className={'cloud-badge ' + m.tone}>{m.label}</span>}
                              {f.state !== 'available' && (
                                <button
                                  className="cloud-more"
                                  aria-label="더보기"
                                  aria-expanded={openMenu === f.id}
                                  disabled={busy}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setOpenMenu((p) => (p === f.id ? null : f.id))
                                  }}
                                >
                                  <Icon name="more" size={16} />
                                </button>
                              )}
                            </div>

                            {openMenu === f.id && (
                              <div className="cloud-actions">
                                {f.state === 'update' && (
                                  <button className="cloud-act" disabled={busy} onClick={() => { setOpenMenu(null); void run(() => updateFileFromCloud(f.id), `"${f.title}"을(를) 업데이트했습니다.`) }}>
                                    <Icon name="download" size={14} /> 업데이트
                                  </button>
                                )}
                                {f.state === 'meta-only' && (
                                  <button className="cloud-act" disabled={busy} onClick={() => { setOpenMenu(null); void download(f) }}>
                                    <Icon name="download" size={14} /> 원본 받기
                                  </button>
                                )}
                                {f.state === 'local' && (
                                  <button className="cloud-act" disabled={busy} onClick={() => { setOpenMenu(null); void dropOriginal(f) }}>
                                    <Icon name="eraser" size={14} /> 원본 지우기
                                  </button>
                                )}
                                {(f.state === 'pending' || f.state === 'local-only') && (
                                  <button className="cloud-act" disabled={busy} onClick={() => { setOpenMenu(null); void run(() => flushPendingFiles(), '올렸습니다.') }}>
                                    <Icon name="upload" size={14} /> 지금 올리기
                                  </button>
                                )}
                                {f.state === 'cloud-missing' && (
                                  <button className="cloud-act" disabled={busy} onClick={() => { setOpenMenu(null); void run(() => reuploadFile(f.id), '다시 올렸습니다.') }}>
                                    <Icon name="upload" size={14} /> 다시 올리기
                                  </button>
                                )}
                                <button className="cloud-act danger" disabled={busy} onClick={() => { setOpenMenu(null); void removeLocal(f) }}>
                                  <Icon name="trash" size={14} /> 이 기기에서 제거
                                </button>
                                <button className="cloud-act danger" disabled={busy} onClick={() => { setOpenMenu(null); void removeCloud(f) }}>
                                  <Icon name="trash" size={14} /> 클라우드에서 삭제
                                </button>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </section>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
