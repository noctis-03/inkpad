// 작업보드 프리셋 목록 — 앱 · 기타 파일 시트와 같은 규칙의 전용 창.
// 이 기기의 프리셋과 Drive(Inkpad/boards)에 올라간 프리셋을 한 목록으로 보여 주고
// 저장 · 적용(불러오기) · 업로드 · 받기 · 삭제를 항목별로 한다.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useUI } from '../app/store'
import { confirmDialog, promptDialog } from '../app/dialogs'
import { formatDate } from '../shared/util'
import { cfgSummary, type Board as BoardModel, type BoardPreset } from '../shared/board'
import { AuthRequiredError, login } from '../sync/token'
import { onSyncStatus, type SyncStatus } from '../sync/sync'
import {
  BOARDS_EVENT,
  createPreset,
  deletePresetFromCloud,
  downloadPreset,
  flushPendingPresets,
  getPreset,
  listCloudPresets,
  overwritePreset,
  removePresetLocal,
  renamePreset,
  reuploadPreset,
  uploadPreset,
  type CloudPresetInfo,
  type CloudPresetState
} from '../sync/board'
import { Icon } from './Icon'
import { FilterTabs, MenuItem, MenuSep, MenuTitle, Popover, SearchBox, SheetBanner, SheetEmpty, SheetErrorBoundary, SheetHeader, useOnline } from './sheetParts'

type Tone = 'push' | 'recv' | 'gone' | 'gray'
type Primary = 'apply' | 'upload' | 'reupload' | 'receive'
type Group = 'confirm' | 'mine' | 'store'

const PRESET_STATE: Record<CloudPresetState, { chip?: string; tone: Tone; primary?: Primary; group: Group }> = {
  update: { chip: '새 버전 있음', tone: 'recv', primary: 'receive', group: 'confirm' },
  pending: { chip: '업로드 안 됨', tone: 'push', primary: 'reupload', group: 'confirm' },
  'local-only': { chip: '업로드 안 됨', tone: 'push', primary: 'upload', group: 'confirm' },
  'cloud-missing': { chip: '클라우드에서 삭제됨', tone: 'gone', primary: 'reupload', group: 'confirm' },
  detached: { chip: '이 기기에만 있음', tone: 'gray', primary: 'upload', group: 'mine' },
  installed: { tone: 'gray', primary: 'apply', group: 'mine' },
  available: { chip: '이 기기에 없음', tone: 'gray', primary: 'receive', group: 'store' }
}
const PRIMARY_LABEL: Record<Primary, string> = { apply: '적용', upload: '업로드', reupload: '재업로드', receive: '받기' }
const GROUPS: { key: Group; title: string }[] = [
  { key: 'confirm', title: '확인이 필요한 프리셋' },
  { key: 'mine', title: '이 기기의 프리셋' },
  { key: 'store', title: '클라우드 · 받기 가능' }
]
type Filter = 'all' | 'mine' | 'confirm' | 'available'
const matchFilter = (s: CloudPresetState, f: Filter) =>
  f === 'all' || (f === 'mine' && s !== 'available') || (f === 'confirm' && PRESET_STATE[s].group === 'confirm') || (f === 'available' && s === 'available')
const NEEDS_UPLOAD: CloudPresetState[] = ['pending', 'local-only', 'cloud-missing']

export function BoardPresetsSheet({
  board,
  onApply,
  onClose
}: {
  board: BoardModel
  onApply: (p: BoardPreset) => void
  onClose: () => void
}) {
  const toast = useUI((s) => s.toast)
  const online = useOnline()
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [items, setItems] = useState<CloudPresetInfo[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [menu, setMenu] = useState<{ presetId: string; rect: DOMRect } | null>(null)

  useEffect(() => onSyncStatus(setStatus), [])

  const load = useCallback(async () => {
    try {
      setItems(await listCloudPresets())
    } catch (e) {
      setItems([])
      if (e instanceof AuthRequiredError) setStatus('auth-required')
      else toast(e instanceof Error ? e.message : '프리셋 목록을 가져오지 못했습니다.', 'error')
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    const on = () => void load()
    window.addEventListener(BOARDS_EVENT, on)
    return () => window.removeEventListener(BOARDS_EVENT, on)
  }, [load])

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try {
      await fn()
      if (ok) toast(ok, 'success')
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
      confirm: all.filter((a) => PRESET_STATE[a.state].group === 'confirm').length
    }),
    [all]
  )

  /** 지금 보드 설정을 새 프리셋으로 */
  const onSaveCurrent = async () => {
    const name = await promptDialog('프리셋으로 저장', {
      value: `작업보드 ${new Date().getMonth() + 1}/${new Date().getDate()}`,
      ok: '저장'
    })
    if (!name?.trim()) return
    await run(async () => {
      const p = await createPreset(name.trim(), board)
      const up = await uploadPreset(p.id)
      if (!up) toast('오프라인이라 업로드하지 못했습니다. 연결된 뒤 업로드를 눌러 주세요.', 'error')
      else toast(`"${p.name}" 저장했습니다. (${cfgSummary(p)})`, 'success')
    })
  }

  /** 지금 보드 설정을 기존 프리셋에 덮어쓰기 */
  const onOverwrite = (p: CloudPresetInfo) =>
    run(async () => {
      const up = await overwritePreset(p.presetId, board)
      toast(up ? `"${p.name}"을(를) 지금 설정으로 덮어썼습니다.` : `"${p.name}"을(를) 덮어썼습니다. 클라우드에는 나중에 올릴 수 있습니다.`, up ? 'success' : 'info')
    })

  const applyLocal = async (presetId: string) => {
    const p = await getPreset(presetId)
    if (!p) throw new Error('프리셋을 찾지 못했습니다.')
    onApply(p)
  }

  const doReceive = (p: CloudPresetInfo) =>
    run(async () => {
      const got = await downloadPreset(p.presetId)
      onApply(got)
      toast(`"${got.name}"을(를) 받아 보드에 적용했습니다.`, 'success')
    })

  const doUpload = (p: CloudPresetInfo) =>
    run(async () => {
      const ok = await reuploadPreset(p.presetId)
      if (!ok) throw new Error('오프라인이라 업로드하지 못했습니다. 연결된 뒤 다시 시도해 주세요.')
      toast(`"${p.name}"을(를) Drive에 올렸습니다.`, 'success')
    })

  const doUploadAll = () =>
    run(async () => {
      const before = all.filter((a) => NEEDS_UPLOAD.includes(a.state)).length
      const n = await flushPendingPresets()
      toast(n ? `${n}개를 올렸습니다.` : before ? '올리지 못했습니다. 연결을 확인해 주세요.' : '업로드할 프리셋이 없습니다.', n ? 'success' : 'info')
    })

  const doRename = async (p: CloudPresetInfo) => {
    const name = await promptDialog('프리셋 이름', { value: p.name, ok: '저장' })
    if (!name?.trim()) return
    await run(() => renamePreset(p.presetId, name.trim()), '이름을 바꿨습니다.')
  }

  const doRemoveLocal = async (p: CloudPresetInfo) => {
    const ok = await confirmDialog('이 기기에서 제거', {
      message: `"${p.name}" 프리셋을 이 기기에서 제거합니다. ${p.state === 'available' ? '' : '클라우드 사본은 남습니다.'}`.trim(),
      ok: '제거',
      danger: true
    })
    if (!ok) return
    await run(async () => {
      await removePresetLocal(p.presetId)
    }, `"${p.name}"을(를) 이 기기에서 제거했습니다.`)
  }

  const doRemoveCloud = async (p: CloudPresetInfo) => {
    const ok = await confirmDialog('클라우드에서 삭제', {
      message: `"${p.name}"을(를) Google Drive에서 삭제합니다. 다른 기기의 목록에서도 사라집니다.`,
      note: 'Drive 휴지통에서 30일 동안 되살릴 수 있습니다.',
      ok: '삭제',
      danger: true
    })
    if (!ok) return
    await run(() => deletePresetFromCloud(p.presetId), '클라우드에서 삭제했습니다.')
  }

  const filtered = useMemo(() => {
    const qq = query.trim().toLowerCase()
    return all.filter((a) => (matchFilter(a.state, filter) ? !qq || a.name.toLowerCase().includes(qq) : false))
  }, [all, filter, query])

  const groups = GROUPS.map((g) => ({ ...g, items: filtered.filter((a) => PRESET_STATE[a.state].group === g.key) })).filter((g) => g.items.length > 0)
  const menuItem = menu ? all.find((a) => a.presetId === menu.presetId) : undefined

  const bannerText = () => {
    const parts: string[] = []
    if (counts.update) parts.push(`새 버전 ${counts.update}개`)
    if (counts.upload) parts.push(`업로드되지 않은 프리셋 ${counts.upload}개`)
    return `${parts.join(', ')}가 있습니다.`
  }

  const renderMenu = (p: CloudPresetInfo) => {
    const close = () => setMenu(null)
    const act = (fn: () => void) => () => {
      close()
      fn()
    }
    const local = p.state !== 'available'
    return (
      <>
        {local && (
          <MenuItem icon="check" label="보드에 적용" desc="저장된 배경화면·시각화 설정을 지금 보드로 불러옵니다" disabled={busy} onClick={act(() => void applyLocal(p.presetId))} />
        )}
        {local && <MenuItem icon="replace" label="지금 설정으로 덮어쓰기" desc="현재 보드 설정으로 프리셋을 갱신합니다" disabled={busy} onClick={act(() => void onOverwrite(p))} />}
        {(p.state === 'available' || p.state === 'update') && (
          <MenuItem icon="download" label="받기" desc="Drive의 프리셋을 받아 보드에 적용합니다" disabled={busy || !online} onClick={act(() => void doReceive(p))} />
        )}
        {NEEDS_UPLOAD.includes(p.state) && (
          <MenuItem icon="upload" label="업로드" desc="Drive(공유)에 올려 다른 기기에서도 쓸 수 있게 합니다" disabled={busy || !online} onClick={act(() => void doUpload(p))} />
        )}
        <MenuSep />
        {local && <MenuItem icon="edit" label="이름 바꾸기" disabled={busy} onClick={act(() => void doRename(p))} />}
        {local && <MenuItem icon="trash" label="이 기기에서 제거" desc="Drive 사본은 남습니다" danger disabled={busy} onClick={act(() => void doRemoveLocal(p))} />}
        <MenuItem
          icon="cloud"
          label="클라우드에서 삭제"
          desc={local ? '다른 기기의 목록에서도 사라집니다 · 이 기기 프리셋은 남습니다' : '이 기기에는 사본이 없습니다'}
          danger
          disabled={busy || !online}
          onClick={act(() => void doRemoveCloud(p))}
        />
      </>
    )
  }

  return (
    <SheetErrorBoundary onClose={onClose}>
      <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="store-sheet" role="dialog" aria-label="작업보드 프리셋">
          <SheetHeader
            icon="board"
            title="작업보드 프리셋"
            subtitle="Google Drive · Inkpad/boards"
            offline={!online}
            onClose={onClose}
            action={
              <button className="primary-btn" onClick={() => void onSaveCurrent()} disabled={busy}>
                <Icon name="plus" size={16} /> 지금 설정 저장
              </button>
            }
          />
          <div className="store-body">
            {status === 'auth-required' ? (
              <SheetEmpty
                icon="lock"
                title="로그인이 필요합니다"
                desc="프리셋을 주고받으려면 Google 로그인을 해 주세요. 로그인 없이도 이 기기의 프리셋은 쓸 수 있습니다."
                action={
                  <button className="primary-btn" onClick={() => login()}>
                    <Icon name="upload" size={18} /> Google로 로그인
                  </button>
                }
              />
            ) : (
              <>
                {!online ? (
                  <SheetBanner tone="offline">오프라인입니다. 이 기기의 프리셋만 보이며, 업로드·받기는 연결된 뒤에 직접 눌러 주세요.</SheetBanner>
                ) : counts.confirm > 0 ? (
                  <SheetBanner
                    tone="warn"
                    actions={
                      counts.upload > 0 ? (
                        <button className="store-banner-btn" disabled={busy} onClick={() => void doUploadAll()}>
                          모두 업로드
                        </button>
                      ) : undefined
                    }
                  >
                    {bannerText()}
                  </SheetBanner>
                ) : null}

                <div className="store-toolbar">
                  <SearchBox value={query} onChange={setQuery} placeholder="프리셋 검색" />
                  <FilterTabs<Filter>
                    value={filter}
                    onChange={setFilter}
                    tabs={[
                      { key: 'all', label: '전체', count: all.length },
                      { key: 'mine', label: '이 기기', count: all.filter((a) => matchFilter(a.state, 'mine')).length },
                      { key: 'confirm', label: '확인 필요', count: all.filter((a) => matchFilter(a.state, 'confirm')).length },
                      { key: 'available', label: '받기 가능', count: all.filter((a) => matchFilter(a.state, 'available')).length }
                    ]}
                  />
                </div>

                <p className="store-hint">
                  배경화면·시각화 형태·카드 크기·정렬·필터만 저장합니다. 노트·앱·파일 내용은 각자의 동기화 경로로 오갑니다.
                </p>

                {items === null ? (
                  <p className="store-hint">프리셋 목록을 불러오는 중…</p>
                ) : groups.length === 0 ? (
                  <SheetEmpty
                    icon="board"
                    title={all.length === 0 ? '프리셋이 없습니다' : '조건에 맞는 프리셋이 없습니다'}
                    desc={all.length === 0 ? '“지금 설정 저장”을 누르면 이 보드 설정을 프리셋으로 남기고 Drive에 올릴 수 있습니다.' : undefined}
                  />
                ) : (
                  groups.map((g) => (
                    <section className="store-group" key={g.key}>
                      <h3 className="store-group-head">
                        {g.title}
                        <b>{g.items.length}</b>
                      </h3>
                      <div className="store-grid">
                        {g.items.map((p) => {
                          const m = PRESET_STATE[p.state]
                          const at = p.remoteUpdatedAt ?? p.localUpdatedAt
                          const primary = m.primary
                          const onPrimary = () => {
                            if (primary === 'apply') void run(() => applyLocal(p.presetId))
                            else if (primary === 'receive') void doReceive(p)
                            else void doUpload(p)
                          }
                          return (
                            <div key={p.presetId} className={'store-card tone-' + m.tone + (m.group === 'confirm' ? ' is-confirm' : '')}>
                              <div className="store-card-top">
                                <span className="store-app-icon board-preset-icon" aria-hidden="true">
                                  <Icon name="board" size={20} />
                                </span>
                                <div className="store-card-text">
                                  <div className="store-card-title" title={p.name}>
                                    {p.name}
                                  </div>
                                  <div className="store-card-sub">{[cfgSummary(p.cfg), at ? formatDate(at) : ''].filter(Boolean).join(' · ')}</div>
                                </div>
                                <button
                                  className="store-more"
                                  data-pop-anchor=""
                                  aria-label={`${p.name} 더보기`}
                                  aria-expanded={menu?.presetId === p.presetId}
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    const rect = e.currentTarget.getBoundingClientRect()
                                    setMenu((prev) => (prev?.presetId === p.presetId ? null : { presetId: p.presetId, rect }))
                                  }}
                                >
                                  <Icon name="more" size={16} />
                                </button>
                              </div>
                              <div className="store-card-bottom">
                                <span className="store-chip-slot">{m.chip && <span className={'store-chip ' + m.tone}>{m.chip}</span>}</span>
                                {primary && (
                                  <button className={'store-btn' + (primary === 'apply' ? ' primary' : '')} disabled={busy || (!online && primary !== 'apply')} onClick={onPrimary}>
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
        {menu && menuItem && (
          <Popover anchor={menu.rect} onClose={() => setMenu(null)}>
            <MenuTitle>{menuItem.name}</MenuTitle>
            {renderMenu(menuItem)}
          </Popover>
        )}
      </div>
    </SheetErrorBoundary>
  )
}
