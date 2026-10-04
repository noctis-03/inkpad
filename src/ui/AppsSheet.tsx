import { useCallback, useEffect, useMemo, useState } from 'react'
import { useUI } from '../app/store'
import { confirmDialog } from '../app/dialogs'
import { pickFiles } from '../io/download'
import { formatDate } from '../shared/util'
import { AuthRequiredError, login } from '../sync/token'
import { onSyncStatus, type SyncStatus } from '../sync/sync'
import {
  APPS_EVENT,
  addApp,
  deleteAppFromCloud,
  installApp,
  listCloudApps,
  reuploadApp,
  uninstallApp,
  updateAllApps,
  updateAppHtml,
  updateInstalledApp,
  uploadAppVersionToCloud,
  type CloudAppInfo,
  type CloudAppState
} from '../sync/apps'
import { Icon } from './Icon'
import { FilterTabs, MenuItem, MenuSep, MenuTitle, Popover, SearchBox, SheetBanner, SheetEmpty, SheetHeader, useOnline } from './sheetParts'

// 앱 시트 (명세 3장). 모든 항목에 ⋯ 메뉴가 있고, 상태에 맞는 대표 버튼 하나를 바로 보여 준다.
type Tone = 'push' | 'recv' | 'gone' | 'gray'
type Primary = 'update' | 'reupload' | 'upload' | 'install'
type AppGroup = 'confirm' | 'installed' | 'store'

const APP_STATE: Record<CloudAppState, { chip?: string; tone: Tone; primary?: Primary; group: AppGroup }> = {
  update: { chip: '새 버전 있음', tone: 'recv', primary: 'update', group: 'confirm' },
  pending: { chip: '업로드 안 됨', tone: 'push', primary: 'reupload', group: 'confirm' },
  'local-only': { chip: '업로드 안 됨', tone: 'push', primary: 'upload', group: 'confirm' },
  'cloud-missing': { chip: '클라우드에서 삭제됨', tone: 'gone', primary: 'reupload', group: 'confirm' },
  detached: { chip: '이 기기에만 있음', tone: 'gray', primary: 'upload', group: 'installed' },
  installed: { tone: 'gray', group: 'installed' },
  available: { tone: 'gray', primary: 'install', group: 'store' }
}
const PRIMARY_LABEL: Record<Primary, string> = { update: '업데이트', reupload: '재업로드', upload: '업로드', install: '설치' }
const GROUPS: { key: AppGroup; title: string }[] = [
  { key: 'confirm', title: '확인이 필요한 앱' },
  { key: 'installed', title: '이 기기에 설치됨' },
  { key: 'store', title: '스토어 · 설치 가능' }
]
type Filter = 'all' | 'installed' | 'update' | 'available'
const matchFilter = (s: CloudAppState, f: Filter) =>
  f === 'all' ||
  (f === 'installed' && s !== 'available') ||
  (f === 'update' && s === 'update') ||
  (f === 'available' && s === 'available')

/** 업로드가 필요한(확인 필요) 상태 — detached 는 여기 포함되지 않는다 */
const NEEDS_UPLOAD: CloudAppState[] = ['pending', 'local-only', 'cloud-missing']

function gradient(title: string) {
  let h = 0
  for (const ch of title) h = (h + ch.charCodeAt(0)) % 360
  return `linear-gradient(135deg, hsl(${h} 68% 62%), hsl(${(h + 42) % 360} 68% 44%))`
}

export function AppsSheet({ onClose }: { onClose: () => void }) {
  const toast = useUI((s) => s.toast)
  const online = useOnline()
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [items, setItems] = useState<CloudAppInfo[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [menu, setMenu] = useState<{ appId: string; rect: DOMRect } | null>(null)

  useEffect(() => onSyncStatus(setStatus), [])

  const load = useCallback(async () => {
    try {
      setItems(await listCloudApps())
    } catch (e) {
      setItems([])
      if (e instanceof AuthRequiredError) setStatus('auth-required')
      else toast(e instanceof Error ? e.message : '앱 목록을 가져오지 못했습니다.', 'error')
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const on = () => void load()
    window.addEventListener(APPS_EVENT, on)
    return () => window.removeEventListener(APPS_EVENT, on)
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
  const counts = useMemo(
    () => ({
      update: all.filter((a) => a.state === 'update').length,
      upload: all.filter((a) => NEEDS_UPLOAD.includes(a.state)).length,
      confirm: all.filter((a) => APP_STATE[a.state].group === 'confirm').length
    }),
    [all]
  )

  const onAdd = async () => {
    const files = await pickFiles('.html,.htm,text/html', true)
    if (!files.length) return
    setBusy(true)
    let offline = false
    try {
      for (const f of files) {
        const r = await addApp(f, null)
        if (!r.uploaded) offline = true
      }
      if (offline) toast('오프라인이라 업로드하지 못했습니다. 연결된 뒤 목록에서 업로드를 눌러 주세요.', 'error')
      else toast(files.length > 1 ? `${files.length}개를 업로드했습니다.` : '앱을 추가하고 클라우드에 업로드했습니다.', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : '앱을 추가하지 못했습니다.', 'error')
    } finally {
      setBusy(false)
      void load()
    }
  }

  const doUpdate = (a: CloudAppInfo) => run(() => updateInstalledApp(a.appId), `"${a.title}"을(를) 업데이트했습니다.`)
  const doInstall = (a: CloudAppInfo) => run(() => installApp(a.appId), `"${a.title}"을(를) 설치했습니다.`)

  const doUpload = (a: CloudAppInfo) =>
    run(async () => {
      const ok = await reuploadApp(a.appId)
      if (!ok) throw new Error('오프라인이라 업로드하지 못했습니다. 연결된 뒤 다시 시도해 주세요.')
      toast(`"${a.title}"을(를) 클라우드에 업로드했습니다.`)
    })

  const doUpdateAll = () =>
    run(async () => {
      const n = await updateAllApps()
      toast(n ? `${n}개를 업데이트했습니다.` : '업데이트할 앱이 없습니다.', n ? 'success' : 'info')
    })

  const doUploadAll = () =>
    run(async () => {
      const targets = all.filter((a) => NEEDS_UPLOAD.includes(a.state))
      let n = 0
      for (const a of targets) {
        try {
          if (await reuploadApp(a.appId)) n++
        } catch (e) {
          console.warn('[apps] 업로드 실패', a.appId, e)
        }
      }
      toast(n ? `${n}개를 업로드했습니다.` : '업로드할 앱이 없습니다.', n ? 'success' : 'info')
    })

  /** 새 버전 업로드 — 설치된 앱은 로컬도 갱신(updateAppHtml), available 은 클라우드만 바꾼다 */
  const doUploadVersion = async (a: CloudAppInfo) => {
    const [file] = await pickFiles('.html,.htm,text/html', false)
    if (!file) return
    setBusy(true)
    try {
      if (a.state === 'available') {
        await uploadAppVersionToCloud(a.appId, file)
        toast(`"${a.title}"을(를) 클라우드에 업로드했습니다.`)
      } else {
        const up = await updateAppHtml(a.appId, file)
        toast(
          up ? `"${a.title}"을(를) 업데이트했습니다.` : '오프라인이라 업로드하지 못했습니다. 연결된 뒤 목록에서 업로드를 눌러 주세요.',
          up ? 'success' : 'error'
        )
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : '업로드 실패', 'error')
    } finally {
      setBusy(false)
      void load()
    }
  }

  const removeSuffix = (s: CloudAppState) =>
    s === 'pending'
      ? '업로드하지 않은 변경은 사라집니다.'
      : s === 'local-only' || s === 'detached' || s === 'cloud-missing'
        ? '클라우드에 사본이 없어 복구할 수 없습니다.'
        : '클라우드 사본은 남습니다.'

  const removeLocal = async (a: CloudAppInfo) => {
    const ok = await confirmDialog('이 기기에서 제거', {
      message: `"${a.title}"을(를) 이 기기에서 제거합니다. ${removeSuffix(a.state)}`,
      ok: '제거',
      danger: true
    })
    if (!ok) return
    await run(() => uninstallApp(a.appId), `"${a.title}"을(를) 이 기기에서 제거했습니다.`)
  }

  const clearAndRemove = async (a: CloudAppInfo) => {
    const ok = await confirmDialog('앱 데이터까지 지우기', {
      message: `"${a.title}"을(를) 저장값과 함께 이 기기에서 제거합니다. 되돌릴 수 없습니다.`,
      ok: '지우고 제거',
      danger: true
    })
    if (!ok) return
    await run(() => uninstallApp(a.appId, { clearData: true }), '"' + a.title + '"을(를) 앱 데이터까지 지웠습니다.')
  }

  const removeCloud = async (a: CloudAppInfo) => {
    const available = a.state === 'available'
    const ok = await confirmDialog('클라우드에서 삭제', {
      message: available
        ? `"${a.title}"을(를) 클라우드에서 삭제합니다. 이 기기에는 사본이 없어서, 다른 기기에 설치되어 있지 않다면 Inkpad에서 다시 받을 수 없습니다.`
        : `"${a.title}"을(를) 클라우드에서 삭제합니다. 다른 기기의 스토어에서 사라지며, 이 기기의 앱은 그대로 남습니다.`,
      note: 'Google Drive 휴지통에서 30일 동안 되살릴 수 있습니다.',
      ok: '삭제',
      danger: true
    })
    if (!ok) return
    await run(
      () => deleteAppFromCloud(a.appId),
      available ? '클라우드에서 삭제했습니다.' : '클라우드에서 삭제했습니다. 이 기기의 앱은 남아 있습니다.'
    )
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all.filter((a) => {
      if (!matchFilter(a.state, filter)) return false
      if (!q) return true
      return `${a.title} ${a.category ?? ''}`.toLowerCase().includes(q)
    })
  }, [all, filter, query])

  const groups = GROUPS.map((g) => ({ ...g, items: filtered.filter((a) => APP_STATE[a.state].group === g.key) })).filter((g) => g.items.length > 0)

  const menuApp = menu ? all.find((a) => a.appId === menu.appId) : undefined

  const bannerText = () => {
    const parts: string[] = []
    if (counts.update) parts.push(`새 버전 ${counts.update}개`)
    if (counts.upload) parts.push(`업로드되지 않은 앱 ${counts.upload}개`)
    return `${parts.join(', ')}가 있습니다.`
  }

  const renderMenu = (a: CloudAppInfo) => {
    const net = online
    const close = () => setMenu(null)
    const act = (fn: () => void) => () => {
      close()
      fn()
    }
    switch (a.state) {
      case 'update':
        return (
          <>
            <MenuItem icon="download" label="업데이트" desc="클라우드의 새 버전을 이 기기에 받습니다" disabled={busy || !net} onClick={act(() => void doUpdate(a))} />
            <MenuSep />
            <MenuItem icon="trash" label="이 기기에서 제거" desc="클라우드 사본은 남습니다" danger disabled={busy} onClick={act(() => void removeLocal(a))} />
            <MenuItem icon="cloud" label="클라우드에서 삭제" desc="다른 기기의 스토어에서 사라집니다 · 이 기기의 앱은 남습니다" danger disabled={busy || !net} onClick={act(() => void removeCloud(a))} />
          </>
        )
      case 'pending':
        return (
          <>
            <MenuItem icon="upload" label="재업로드" desc="이 기기에서 바뀐 내용을 클라우드에 올립니다" disabled={busy || !net} onClick={act(() => void doUpload(a))} />
            <MenuSep />
            <MenuItem icon="trash" label="이 기기에서 제거" desc="업로드하지 않은 변경은 사라집니다" danger disabled={busy} onClick={act(() => void removeLocal(a))} />
            <MenuItem icon="cloud" label="클라우드에서 삭제" desc="다른 기기의 스토어에서 사라집니다 · 이 기기의 앱은 남습니다" danger disabled={busy || !net} onClick={act(() => void removeCloud(a))} />
          </>
        )
      case 'local-only':
      case 'detached':
        return (
          <>
            <MenuItem icon="upload" label="업로드" desc="클라우드에 올려 다른 기기에서도 보이게 합니다" disabled={busy || !net} onClick={act(() => void doUpload(a))} />
            <MenuSep />
            <MenuItem icon="trash" label="이 기기에서 제거" desc="클라우드에 사본이 없어 복구할 수 없습니다" danger disabled={busy} onClick={act(() => void removeLocal(a))} />
          </>
        )
      case 'cloud-missing':
        return (
          <>
            <MenuItem icon="upload" label="재업로드" desc="이 기기의 사본을 클라우드에 다시 올립니다" disabled={busy || !net} onClick={act(() => void doUpload(a))} />
            <MenuSep />
            <MenuItem icon="trash" label="이 기기에서 제거" desc="클라우드에 사본이 없어 복구할 수 없습니다" danger disabled={busy} onClick={act(() => void removeLocal(a))} />
          </>
        )
      case 'installed':
        return (
          <>
            <MenuItem icon="replace" label="새 버전 업로드" desc="HTML 파일로 클라우드 사본을 바꿉니다" disabled={busy || !net} onClick={act(() => void doUploadVersion(a))} />
            <MenuSep />
            <MenuItem icon="trash" label="이 기기에서 제거" desc="클라우드 사본은 남습니다" danger disabled={busy} onClick={act(() => void removeLocal(a))} />
            <MenuItem icon="eraser" label="앱 데이터까지 지우고 제거" desc="저장값도 삭제 · 되돌릴 수 없습니다" danger disabled={busy} onClick={act(() => void clearAndRemove(a))} />
            <MenuItem icon="cloud" label="클라우드에서 삭제" desc="다른 기기의 스토어에서 사라집니다 · 이 기기의 앱은 남습니다" danger disabled={busy || !net} onClick={act(() => void removeCloud(a))} />
          </>
        )
      case 'available':
        return (
          <>
            <MenuItem icon="replace" label="새 버전 업로드" desc="HTML 파일로 클라우드 사본을 바꿉니다 · 이 기기에는 설치되지 않습니다" disabled={busy || !net} onClick={act(() => void doUploadVersion(a))} />
            <MenuSep />
            <MenuItem icon="cloud" label="클라우드에서 삭제" desc="이 기기에는 사본이 없습니다" danger disabled={busy || !net} onClick={act(() => void removeCloud(a))} />
          </>
        )
    }
  }

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="store-sheet" role="dialog" aria-label="앱">
        <SheetHeader
          icon="grid"
          title="앱"
          subtitle="Google Drive · Inkpad/apps"
          offline={!online}
          onClose={onClose}
          action={
            <button className="primary-btn" onClick={() => void onAdd()} disabled={busy}>
              <Icon name="plus" size={16} /> 새 앱
            </button>
          }
        />
        <div className="store-body">
          {status === 'auth-required' ? (
            <SheetEmpty
              icon="lock"
              title="로그인이 필요합니다"
              desc="앱 스토어를 보려면 Google 로그인을 해 주세요."
              action={
                <button className="primary-btn" onClick={() => login()}>
                  <Icon name="upload" size={18} /> Google로 로그인
                </button>
              }
            />
          ) : (
            <>
              {!online ? (
                <SheetBanner tone="offline">오프라인입니다. 이 기기에 설치된 앱만 보이며, 업데이트와 업로드는 연결된 뒤에 직접 눌러 주세요.</SheetBanner>
              ) : counts.confirm > 0 ? (
                <SheetBanner
                  tone="warn"
                  actions={
                    <>
                      {counts.upload > 0 && (
                        <button className="store-banner-btn" disabled={busy} onClick={() => void doUploadAll()}>
                          모두 업로드
                        </button>
                      )}
                      {counts.update > 0 && (
                        <button className="store-banner-btn" disabled={busy} onClick={() => void doUpdateAll()}>
                          모두 업데이트
                        </button>
                      )}
                    </>
                  }
                >
                  {bannerText()}
                </SheetBanner>
              ) : null}

              <div className="store-toolbar">
                <SearchBox value={query} onChange={setQuery} placeholder="앱 검색" />
                <FilterTabs<Filter>
                  value={filter}
                  onChange={setFilter}
                  tabs={[
                    { key: 'all', label: '전체', count: all.filter((a) => matchFilter(a.state, 'all')).length },
                    { key: 'installed', label: '설치됨', count: all.filter((a) => matchFilter(a.state, 'installed')).length },
                    { key: 'update', label: '새 버전', count: all.filter((a) => matchFilter(a.state, 'update')).length },
                    { key: 'available', label: '설치 안 됨', count: all.filter((a) => matchFilter(a.state, 'available')).length }
                  ]}
                />
              </div>

              {items === null ? (
                <p className="store-hint">앱 목록을 불러오는 중…</p>
              ) : groups.length === 0 ? (
                <SheetEmpty
                  icon="grid"
                  title={all.length === 0 ? '앱이 없습니다' : '조건에 맞는 앱이 없습니다'}
                  desc={all.length === 0 ? 'HTML 파일을 추가해 앱을 등록할 수 있습니다.' : undefined}
                />
              ) : (
                groups.map((g) => (
                  <section className="store-group" key={g.key}>
                    <h3 className="store-group-head">
                      {g.title}
                      <b>{g.items.length}</b>
                    </h3>
                    <div className="store-grid">
                      {g.items.map((a) => {
                        const m = APP_STATE[a.state]
                        const at = a.remoteUpdatedAt ?? a.localUpdatedAt
                        const primary = m.primary
                        const onPrimary = () => {
                          if (primary === 'update') void doUpdate(a)
                          else if (primary === 'install') void doInstall(a)
                          else void doUpload(a)
                        }
                        return (
                          <div key={a.appId} className={'store-card tone-' + m.tone + (m.group === 'confirm' ? ' is-confirm' : '')}>
                            <div className="store-card-top">
                              <span className="store-app-icon" style={{ background: gradient(a.title) }} aria-hidden="true">
                                {a.title.slice(0, 1)}
                              </span>
                              <div className="store-card-text">
                                <div className="store-card-title" title={a.title}>
                                  {a.title}
                                </div>
                                <div className="store-card-sub">{[a.category, at ? formatDate(at) : ''].filter(Boolean).join(' · ')}</div>
                              </div>
                              <button
                                className="store-more"
                                aria-label={`${a.title} 더보기`}
                                aria-expanded={menu?.appId === a.appId}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setMenu((p) => (p?.appId === a.appId ? null : { appId: a.appId, rect: e.currentTarget.getBoundingClientRect() }))
                                }}
                              >
                                <Icon name="more" size={16} />
                              </button>
                            </div>
                            <div className="store-card-bottom">
                              <span className="store-chip-slot">{m.chip && <span className={'store-chip ' + m.tone}>{m.chip}</span>}</span>
                              {primary && (
                                <button className={'store-btn' + (primary === 'install' ? ' primary' : '')} disabled={busy || !online} onClick={onPrimary}>
                                  {PRIMARY_LABEL[primary]}
                                </button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </section>
                ))
              )}
            </>
          )}
        </div>
      </div>
      {menu && menuApp && (
        <Popover anchor={menu.rect} onClose={() => setMenu(null)}>
          <MenuTitle>{menuApp.title}</MenuTitle>
          {renderMenu(menuApp)}
        </Popover>
      )}
    </div>
  )
}
