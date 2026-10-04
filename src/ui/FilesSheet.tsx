import { useCallback, useEffect, useMemo, useState } from 'react'
import { useUI } from '../app/store'
import { confirmDialog } from '../app/dialogs'
import { extOf } from '../shared/model'
import { formatBytes, formatDate } from '../shared/util'
import { confirmTransfer } from '../sync/transfer'
import { AuthRequiredError, login } from '../sync/token'
import { onSyncStatus, type SyncStatus } from '../sync/sync'
import {
  FILES_EVENT,
  addFileFromCloud,
  deleteFileFromCloud,
  dropFileOriginal,
  ensureFileLocal,
  listCloudFiles,
  removeFileLocal,
  reuploadFile,
  type CloudFileInfo,
  type CloudFileState
} from '../sync/files'
import { Icon } from './Icon'
import { FilterTabs, MenuItem, MenuSep, MenuTitle, Popover, SearchBox, SheetBanner, SheetEmpty, SheetErrorBoundary, SheetHeader, useOnline } from './sheetParts'

// 기타 파일 시트 (명세 4장). 그룹 없이 리스트 하나, 정렬 탭과 저장 공간 카드.
type Tone = 'push' | 'recv' | 'gone' | 'gray'
type Primary = 'download' | 'reupload' | 'upload'
type FilterKey = 'all' | 'downloaded' | 'cloud' | 'confirm'
type Sort = 'recent' | 'size' | 'name'

const FILE_STATE: Record<CloudFileState, { chip?: string; tone: Tone; primary?: Primary; rail: boolean }> = {
  local: { tone: 'gray', rail: false },
  'meta-only': { tone: 'gray', primary: 'download', rail: false },
  available: { tone: 'gray', primary: 'download', rail: false },
  pending: { chip: '업로드 안 됨', tone: 'push', primary: 'reupload', rail: true },
  'local-only': { chip: '업로드 안 됨', tone: 'push', primary: 'reupload', rail: true },
  'cloud-missing': { chip: '클라우드에서 삭제됨', tone: 'gone', primary: 'reupload', rail: true },
  detached: { chip: '이 기기에만 있음', tone: 'gray', primary: 'upload', rail: false },
  update: { tone: 'gray', rail: false } // 없앤 상태 (4.6-1) — UI에서 쓰지 않는다
}
const PRIMARY_LABEL: Record<Primary, string> = { download: '다운로드', reupload: '재업로드', upload: '업로드' }

const matchFilter = (s: CloudFileState, f: FilterKey) =>
  f === 'all' ||
  (f === 'downloaded' && (s === 'local' || s === 'detached')) ||
  (f === 'cloud' && (s === 'available' || s === 'meta-only')) ||
  (f === 'confirm' && (s === 'pending' || s === 'local-only' || s === 'cloud-missing'))

function extLabel(f: CloudFileInfo) {
  const e = extOf(f.name)
  if (e) return e.slice(0, 4).toUpperCase()
  return f.kind === 'image' ? 'IMG' : f.kind === 'text' ? 'TXT' : 'FILE'
}

export function FilesSheet({ onClose }: { onClose: () => void }) {
  const toast = useUI((s) => s.toast)
  const confirmMode = useUI((s) => s.settings.largeFileConfirm)
  const online = useOnline()
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [items, setItems] = useState<CloudFileInfo[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FilterKey>('all')
  const [sort, setSort] = useState<Sort>('recent')
  const [menu, setMenu] = useState<{ id: string; rect: DOMRect } | null>(null)

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

  const all = items ?? []
  const threshold = confirmMode === 'off' ? 0 : confirmMode === '10' ? 10 * 1024 * 1024 : 50 * 1024 * 1024

  const counts = useMemo(
    () => ({
      downloaded: all.filter((f) => matchFilter(f.state, 'downloaded')).length,
      cloud: all.filter((f) => matchFilter(f.state, 'cloud')).length,
      confirm: all.filter((f) => matchFilter(f.state, 'confirm')).length
    }),
    [all]
  )

  const localBytes = useMemo(() => all.reduce((n, f) => n + (f.hasOriginal ? f.size : 0), 0), [all])
  const totalBytes = useMemo(() => all.reduce((n, f) => n + f.size, 0), [all])

  const removeLocal = async (f: CloudFileInfo) => {
    const ok = await confirmDialog('이 기기에서 삭제', {
      message: `"${f.title}"은(는) 클라우드에 사본이 없습니다. 삭제하면 복구할 수 없습니다.`,
      ok: '삭제',
      danger: true
    })
    if (!ok) return
    await run(() => removeFileLocal(f.id), `"${f.title}"을(를) 이 기기에서 삭제했습니다.`)
  }

  const removeCloud = async (f: CloudFileInfo) => {
    const downloaded = f.hasOriginal
    const ok = await confirmDialog('클라우드에서 삭제', {
      message: downloaded
        ? `"${f.title}"을(를) 클라우드에서 삭제합니다. 다른 기기의 목록에서 사라지며, 이 기기의 파일은 그대로 남습니다.`
        : `"${f.title}"을(를) 클라우드에서 삭제합니다. 이 기기에는 사본이 없어서, 다른 기기에 다운로드되어 있지 않다면 Inkpad에서 다시 받을 수 없습니다.`,
      note: 'Google Drive 휴지통에서 30일 동안 되살릴 수 있습니다.',
      ok: '삭제',
      danger: true
    })
    if (!ok) return
    await run(
      () => deleteFileFromCloud(f.id),
      downloaded ? '클라우드에서 삭제했습니다. 이 기기의 파일은 남아 있습니다.' : '클라우드에서 삭제했습니다.'
    )
  }

  const download = (f: CloudFileInfo) =>
    run(async () => {
      if (!(await confirmTransfer('down', f.size))) return
      if (f.state === 'available') await addFileFromCloud(f.id, { withOriginal: true })
      else await ensureFileLocal(f.id)
      toast(`"${f.title}" 원본을 다운로드했습니다.`)
    })

  const reupload = (f: CloudFileInfo) =>
    run(async () => {
      // 이름·카테고리 변경(pending + 메타만)은 본문을 보내지 않으므로 확인 창을 띄우지 않는다
      const bodyless = f.state === 'pending' && f.pendingKind === 'meta'
      if (!bodyless && !(await confirmTransfer('up', f.size))) return
      const ok = await reuploadFile(f.id)
      if (!ok) throw new Error('오프라인이라 업로드하지 못했습니다. 연결된 뒤 다시 시도해 주세요.')
      toast(`"${f.title}"을(를) 클라우드에 업로드했습니다.`)
    })

  const dropOriginal = (f: CloudFileInfo) =>
    run(async () => {
      await dropFileOriginal(f.id)
      toast(`${formatBytes(f.size)}를 확보했습니다. 열 때 다시 다운로드합니다.`)
    })

  const doReuploadAll = () =>
    run(async () => {
      const targets = all.filter((f) => matchFilter(f.state, 'confirm'))
      // 본문을 보내는 대상만 합계에 더한다 (이름 변경은 메타만 보낸다)
      const bodyTargets = targets.filter((f) => !(f.state === 'pending' && f.pendingKind === 'meta'))
      const total = bodyTargets.reduce((n, f) => n + f.size, 0)
      if (bodyTargets.length && !(await confirmTransfer('up', total, bodyTargets.length))) return
      let n = 0
      for (const f of targets) {
        try {
          if (await reuploadFile(f.id)) n++
        } catch (e) {
          console.warn('[files] 재업로드 실패', f.id, e)
        }
      }
      toast(n ? `${n}개를 업로드했습니다.` : '업로드할 파일이 없습니다.', n ? 'success' : 'info')
    })

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const arr = all.filter((f) => {
      if (!matchFilter(f.state, filter)) return false
      if (!q) return true
      return `${f.title} ${f.name} ${f.category ?? ''}`.toLowerCase().includes(q)
    })
    arr.sort((a, b) => {
      if (sort === 'size') return b.size - a.size
      if (sort === 'name') return a.title.localeCompare(b.title, 'ko')
      return (b.remoteUpdatedAt ?? b.localUpdatedAt ?? 0) - (a.remoteUpdatedAt ?? a.localUpdatedAt ?? 0)
    })
    return arr
  }, [all, filter, query, sort])

  const menuFile = menu ? all.find((f) => f.id === menu.id) : undefined
  const pct = totalBytes ? Math.round((localBytes / totalBytes) * 100) : 0

  const renderMenu = (f: CloudFileInfo) => {
    const close = () => setMenu(null)
    const act = (fn: () => void) => () => {
      close()
      fn()
    }
    const size = formatBytes(f.size)
    const removeItem = (desc: string) => (
      <MenuItem icon="trash" label="이 기기에서 삭제" desc={desc} danger disabled={busy} onClick={act(() => void removeLocal(f))} />
    )
    switch (f.state) {
      case 'local':
        return (
          <>
            <MenuItem icon="eraser" label="다운로드 제거" desc={`${size} 확보 · 목록에는 남습니다`} disabled={busy} onClick={act(() => void dropOriginal(f))} />
            <MenuSep />
            <MenuItem icon="cloud" label="클라우드에서 삭제" desc="다른 기기의 목록에서 사라집니다 · 이 기기 사본은 남습니다" danger disabled={busy || !online} onClick={act(() => void removeCloud(f))} />
          </>
        )
      case 'meta-only':
      case 'available':
        return (
          <>
            <MenuItem icon="download" label="다운로드" desc={size} disabled={busy || !online} onClick={act(() => void download(f))} />
            <MenuSep />
            <MenuItem icon="cloud" label="클라우드에서 삭제" desc="이 기기에는 사본이 없습니다" danger disabled={busy || !online} onClick={act(() => void removeCloud(f))} />
          </>
        )
      case 'pending':
      case 'local-only':
      case 'cloud-missing':
        return (
          <>
            <MenuItem icon="upload" label="재업로드" desc={size} disabled={busy || !online} onClick={act(() => void reupload(f))} />
            <MenuSep />
            {removeItem('클라우드에 사본이 없어 복구할 수 없습니다')}
          </>
        )
      case 'detached':
        return (
          <>
            <MenuItem icon="upload" label="업로드" desc={size} disabled={busy || !online} onClick={act(() => void reupload(f))} />
            <MenuSep />
            {removeItem('클라우드에 사본이 없어 복구할 수 없습니다')}
          </>
        )
      case 'update':
        return null
    }
  }

  return (
    <SheetErrorBoundary onClose={onClose}>
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="store-sheet" role="dialog" aria-label="기타 파일">
        <SheetHeader icon="folder" title="기타 파일" subtitle="Google Drive · Inkpad/files" offline={!online} onClose={onClose} />
        <div className="store-body">
          {status === 'auth-required' ? (
            <SheetEmpty
              icon="lock"
              title="로그인이 필요합니다"
              desc="파일 스토어를 보려면 Google 로그인을 해 주세요."
              action={
                <button className="primary-btn" onClick={() => login()}>
                  <Icon name="upload" size={18} /> Google로 로그인
                </button>
              }
            />
          ) : (
            <>
              {!online ? (
                <SheetBanner tone="offline">오프라인입니다. 다운로드된 파일만 열 수 있습니다. 새로 추가한 파일은 연결된 뒤 재업로드를 눌러 주세요.</SheetBanner>
              ) : counts.confirm > 0 ? (
                <SheetBanner
                  tone="warn"
                  actions={
                    <>
                      <button className="store-banner-btn" disabled={busy} onClick={() => setFilter('confirm')}>
                        보기
                      </button>
                      <button className="store-banner-btn" disabled={busy} onClick={() => void doReuploadAll()}>
                        모두 재업로드
                      </button>
                    </>
                  }
                >
                  클라우드에 업로드되지 않은 파일이 {counts.confirm}개 있습니다. 다른 기기에서는 보이지 않습니다.
                </SheetBanner>
              ) : null}

              <div className="store-storage">
                <div className="store-storage-top">
                  <span>
                    이 기기에 저장된 파일 <b>{formatBytes(localBytes)}</b>
                  </span>
                  <span className="store-storage-total">전체 {formatBytes(totalBytes)}</span>
                </div>
                <div className="store-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <div className="store-bar-fill" style={{ width: pct + '%' }} />
                </div>
                <div className="store-legend">
                  <span>
                    <Icon name="checkCircle" size={13} /> 다운로드됨
                  </span>
                  <span>
                    <Icon name="cloudDown" size={13} /> 클라우드에만
                  </span>
                  <button className="store-legend-btn" disabled={!counts.downloaded} onClick={() => { setFilter('downloaded'); setSort('size') }}>
                    큰 파일부터 보기
                  </button>
                </div>
              </div>

              <div className="store-toolbar">
                <SearchBox value={query} onChange={setQuery} placeholder="파일 검색" />
                <FilterTabs<FilterKey>
                  value={filter}
                  onChange={setFilter}
                  tabs={[
                    { key: 'all', label: '전체', count: all.filter((f) => matchFilter(f.state, 'all')).length },
                    { key: 'downloaded', label: '다운로드됨', count: counts.downloaded },
                    { key: 'cloud', label: '클라우드에만', count: counts.cloud },
                    ...(counts.confirm ? [{ key: 'confirm' as FilterKey, label: '확인 필요', count: counts.confirm, warn: true }] : [])
                  ]}
                />
              </div>

              {items === null ? (
                <p className="store-hint">파일 목록을 불러오는 중…</p>
              ) : filtered.length === 0 ? (
                <SheetEmpty
                  icon="folder"
                  title={all.length === 0 ? '아직 파일이 없습니다' : '조건에 맞는 파일이 없습니다'}
                  desc={all.length === 0 ? '추가한 파일은 클라우드에 업로드되고, 다른 기기의 목록에도 나타납니다.' : undefined}
                />
              ) : (
                <div className="store-list">
                  <div className="store-list-head">
                    <h3>
                      파일 <b>{filtered.length}</b>
                    </h3>
                    <div className="store-sort" role="group" aria-label="정렬">
                      {(
                        [
                          ['recent', '최근순'],
                          ['size', '크기순'],
                          ['name', '이름순']
                        ] as [Sort, string][]
                      ).map(([k, label]) => (
                        <button key={k} className={'store-sort-btn' + (sort === k ? ' is-active' : '')} aria-pressed={sort === k} onClick={() => setSort(k)}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {filtered.map((f) => {
                    const m = FILE_STATE[f.state]
                    const at = f.remoteUpdatedAt ?? f.localUpdatedAt
                    const primary = m.primary
                    const dim = !online && (f.state === 'available' || f.state === 'meta-only')
                    const onPrimary = () => {
                      if (primary === 'download') void download(f)
                      else void reupload(f)
                    }
                    const statusIcon =
                      f.state === 'local' || f.state === 'detached' ? 'checkCircle' : f.state === 'meta-only' || f.state === 'available' ? 'cloudDown' : null
                    return (
                      <div key={f.id} className={'store-row tone-' + m.tone + (m.rail ? ' is-confirm' : '') + (dim ? ' is-dim' : '')}>
                        <span className="store-file-icon" data-kind={f.kind}>
                          {extLabel(f)}
                        </span>
                        <div className="store-row-main">
                          <div className="store-row-title" title={f.title}>
                            {f.title}
                          </div>
                          <div className="store-row-sub">
                            <span className="store-row-name">{f.name}</span>
                            <span className={threshold && f.size >= threshold ? 'store-size big' : 'store-size'}>{formatBytes(f.size)}</span>
                            {f.category && <span>{f.category}</span>}
                            {at ? <span>{formatDate(at)}</span> : null}
                          </div>
                        </div>
                        {m.chip && <span className={'store-chip ' + m.tone}>{m.chip}</span>}
                        {statusIcon && (
                          <span className={'store-status-icon ' + (statusIcon === 'checkCircle' ? 'ok' : 'cloud')} aria-hidden="true">
                            <Icon name={statusIcon} size={16} />
                          </span>
                        )}
                        {primary && (
                          <button className="store-btn" disabled={busy || !online} onClick={onPrimary}>
                            {PRIMARY_LABEL[primary]}
                          </button>
                        )}
                        <button
                          className="store-more"
                          data-pop-anchor=""
                          aria-label={`${f.title} 더보기`}
                          aria-expanded={menu?.id === f.id}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation()
                            // rect 를 지금 계산해 둔다 — e.currentTarget 은 핸들러가 끝나면 null 이 된다
                            const rect = e.currentTarget.getBoundingClientRect()
                            setMenu((p) => (p?.id === f.id ? null : { id: f.id, rect }))
                          }}
                        >
                          <Icon name="more" size={16} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {menu && menuFile && (
        <Popover anchor={menu.rect} onClose={() => setMenu(null)}>
          <MenuTitle>{menuFile.title}</MenuTitle>
          {renderMenu(menuFile)}
        </Popover>
      )}
    </div>
    </SheetErrorBoundary>
  )
}
