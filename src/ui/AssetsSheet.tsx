import { useCallback, useEffect, useMemo, useState } from 'react'
import { useUI } from '../app/store'
import { confirmDialog } from '../app/dialogs'
import { formatBytes, formatDate } from '../shared/util'
import type { ID } from '../shared/model'
import { db, type AssetRow } from '../storage/db'
import { confirmTransfer } from '../sync/transfer'
import { AssetUnavailableError, ensureAssetLocal, downloadAllMissing, onAssetProgress } from '../sync/assets'
import { Icon } from './Icon'
import { FilterTabs, MenuItem, MenuSep, MenuTitle, Popover, SearchBox, SheetEmpty, SheetErrorBoundary, SheetHeader, SheetBanner, useOnline } from './sheetParts'

// 에셋 원본(PDF·이미지) 관리 시트. 동기화의 지연 로딩(asset.ts)과 같은 규칙을 따른다:
//   - 이 시트는 이 기기(IndexedDB assets 테이블) 기준으로 원본 바이트를 보고 관리한다.
//   - 원본을 지워도 노트·필기는 그대로고, 클라우드 사본이 있으면 나중에 다시 받는다.
type Tone = 'push' | 'recv' | 'gone' | 'gray'
type FilterKey = 'all' | 'local' | 'cloud'
type Sort = 'recent' | 'size' | 'name'

interface AssetInfo extends AssetRow {
  /** 이 원본을 속지(PDF)로 쓰는 살아 있는 노트 제목 */
  docs: string[]
  /** 업로드 대기 (outbox에 asset 항목이 있음 — 클라우드에 아직 없을 수 있다) */
  pending: boolean
}

const shaLabel = (a: AssetInfo) => a.sha256.slice(0, 8)
const titleOf = (a: AssetInfo) => a.name?.trim() || `${a.kind === 'pdf' ? 'PDF' : '이미지'} 원본 ${shaLabel(a)}`

export function AssetsSheet({ onClose }: { onClose: () => void }) {
  const toast = useUI((s) => s.toast)
  const setBusy = useUI((s) => s.setBusy)
  const online = useOnline()
  const [items, setItems] = useState<AssetInfo[] | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FilterKey>('all')
  const [sort, setSort] = useState<Sort>('recent')
  const [menu, setMenu] = useState<{ id: ID; rect: DOMRect } | null>(null)
  const [downloading, setDownloading] = useState<Set<ID>>(new Set())

  const load = useCallback(async () => {
    const [assets, pages, outbox, docs] = await Promise.all([
      db.assets.toArray(),
      db.pages.toArray(),
      db.outbox.filter((r) => r.entity === 'asset').toArray(),
      db.documents.toArray()
    ])
    // 원본 → 이 원본을 속지로 쓰는 문서 (page.pdf 참조, 삭제된 페이지 제외)
    const docTitle = new Map(docs.map((d) => [d.id, d.title]))
    const usedBy = new Map<ID, string[]>()
    for (const p of pages) {
      if (p.deletedAt || !p.pdf) continue
      const list = usedBy.get(p.pdf.assetId) ?? []
      const t = docTitle.get(p.documentId)
      if (t && !list.includes(t)) list.push(t)
      usedBy.set(p.pdf.assetId, list)
    }
    const pending = new Set(outbox.map((r) => r.entityId))
    setItems(assets.map((a) => ({ ...a, docs: usedBy.get(a.id) ?? [], pending: pending.has(a.id) })))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 원본 다운로드 진행률 — 받는 중 표시, 끝나면 목록을 다시 읽는다
  useEffect(
    () =>
      onAssetProgress((e) => {
        setDownloading((old) => {
          const next = new Set(old)
          if (e.done) next.delete(e.assetId)
          else next.add(e.assetId)
          return next
        })
        if (e.done) void load()
      }),
    [load]
  )

  const all = items ?? []
  const counts = useMemo(
    () => ({
      local: all.filter((a) => a.blob).length,
      cloud: all.filter((a) => !a.blob).length
    }),
    [all]
  )
  const localBytes = useMemo(() => all.reduce((n, a) => n + (a.blob ? a.size : 0), 0), [all])
  const totalBytes = useMemo(() => all.reduce((n, a) => n + a.size, 0), [all])
  const pct = totalBytes ? Math.round((localBytes / totalBytes) * 100) : 0

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const arr = all.filter((a) => {
      if (filter === 'local' && !a.blob) return false
      if (filter === 'cloud' && a.blob) return false
      if (!q) return true
      return `${a.name ?? ''} ${a.sha256}`.toLowerCase().includes(q)
    })
    arr.sort((a, b) => {
      if (sort === 'size') return b.size - a.size
      if (sort === 'name') return titleOf(a).localeCompare(titleOf(b), 'ko')
      return b.createdAt - a.createdAt
    })
    return arr
  }, [all, filter, query, sort])

  /** 원본 바이트를 이 기기에서만 지운다 (노트·필기는 그대로) */
  const dropOriginal = async (a: AssetInfo) => {
    const cloudNote = a.pending
      ? '업로드 대기 중이라 클라우드 사본이 없을 수 있습니다. 지우면 되살릴 수 없습니다.'
      : '클라우드에 사본이 있으면 나중에 다시 받을 수 있습니다.'
    if (
      !(await confirmDialog('다운로드 제거', {
        message: `"${titleOf(a)}"의 원본 ${formatBytes(a.size)}를 이 기기에서 지웁니다. 노트와 필기는 그대로 남습니다. ${cloudNote}`,
        ok: '제거',
        danger: true
      }))
    )
      return
    try {
      await db.assets.update(a.id, { blob: undefined })
      toast(`${formatBytes(a.size)}를 확보했습니다. 필요하면 클라우드에서 다시 받습니다.`)
    } catch (e) {
      toast(e instanceof Error ? e.message : '제거하지 못했습니다.', 'error')
    }
    await load()
  }

  /** 원본 한 개를 클라우드에서 받는다 */
  const download = async (a: AssetInfo) => {
    if (!(await confirmTransfer('down', a.size))) return
    try {
      await ensureAssetLocal(a.id)
      toast(`"${titleOf(a)}" 원본을 받았습니다.`)
    } catch (e) {
      toast(e instanceof AssetUnavailableError ? e.message : '원본을 받지 못했습니다. 네트워크 상태를 확인해 주세요.', 'error')
    }
    await load()
  }

  /** 클라우드에만 있는 원본을 모두 받는다 (설정 > 동기화의 "원본 모두 받기"와 같은 동작) */
  const downloadAll = async () => {
    const missing = all.filter((a) => !a.blob)
    if (!missing.length) return
    const total = missing.reduce((n, a) => n + a.size, 0)
    if (!(await confirmTransfer('down', total, missing.length))) return
    setBusy({ text: `원본 받는 중 (0/${missing.length})`, progress: 0 })
    try {
      const r = await downloadAllMissing((done, tot) => setBusy({ text: `원본 받는 중 (${done}/${tot})`, progress: done / tot }))
      toast(
        r.failed ? `원본 ${r.ok}개를 받았습니다. ${r.failed}개는 받지 못했습니다.` : `원본 ${r.ok}개를 모두 받았습니다.`,
        r.failed ? 'error' : 'success'
      )
    } finally {
      setBusy(null)
      await load()
    }
  }

  const menuAsset = menu ? all.find((a) => a.id === menu.id) : undefined

  const renderMenu = (a: AssetInfo) => {
    const close = () => setMenu(null)
    const act = (fn: () => void) => () => {
      close()
      fn()
    }
    const size = formatBytes(a.size)
    if (a.blob) {
      return (
        <>
          <MenuItem icon="eraser" label="다운로드 제거" desc={`${size} 확보 · 목록에는 남습니다`} onClick={act(() => void dropOriginal(a))} />
          {a.docs.length > 0 && (
            <>
              <MenuSep />
              <MenuTitle>이 원본을 쓰는 노트</MenuTitle>
              {a.docs.slice(0, 6).map((t) => (
                <MenuTitle key={t}>{t}</MenuTitle>
              ))}
              {a.docs.length > 6 && <MenuTitle>외 {a.docs.length - 6}개</MenuTitle>}
            </>
          )}
        </>
      )
    }
    return (
      <MenuItem icon="download" label="원본 받기" desc={`${size} · 클라우드에서 받습니다`} disabled={!online} onClick={act(() => void download(a))} />
    )
  }

  return (
    <SheetErrorBoundary onClose={onClose}>
      <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="store-sheet" role="dialog" aria-label="에셋 원본">
          <SheetHeader
            icon="filePdf"
            title="에셋 원본"
            subtitle="PDF·이미지 원본 · 이 기기에 저장된 바이트"
            offline={!online}
            action={
              <button className="tb-btn" onClick={() => void load()} aria-label="목록 새로 고침" title="목록 새로 고침">
                <Icon name="restore" />
              </button>
            }
            onClose={onClose}
          />
          <div className="store-body">
            {!online ? (
              <SheetBanner tone="offline">오프라인입니다. 이 기기에 받아 둔 원본만 사용할 수 있습니다.</SheetBanner>
            ) : counts.cloud > 0 ? (
              <SheetBanner
                tone="warn"
                actions={
                  <button className="store-banner-btn" onClick={() => void downloadAll()}>
                    모두 받기
                  </button>
                }
              >
                클라우드에만 있는 원본이 {counts.cloud}개 있습니다. 해당 노트를 열 때 자동으로 받으며, 여기서 미리 받을 수도 있습니다.
              </SheetBanner>
            ) : null}

            <div className="store-storage">
              <div className="store-storage-top">
                <span>
                  이 기기에 저장된 원본 <b>{formatBytes(localBytes)}</b>
                </span>
                <span className="store-storage-total">전체 {formatBytes(totalBytes)}</span>
              </div>
              <div className="store-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="store-bar-fill" style={{ width: pct + '%' }} />
              </div>
              <div className="store-legend">
                <span>
                  <Icon name="checkCircle" size={13} /> 이 기기에 있음
                </span>
                <span>
                  <Icon name="cloudDown" size={13} /> 클라우드에만
                </span>
                <button
                  className="store-legend-btn"
                  disabled={!counts.local}
                  onClick={() => {
                    setFilter('local')
                    setSort('size')
                  }}
                >
                  큰 파일부터 보기
                </button>
              </div>
            </div>

            <div className="store-toolbar">
              <SearchBox value={query} onChange={setQuery} placeholder="원본 검색" />
              <FilterTabs<FilterKey>
                value={filter}
                onChange={setFilter}
                tabs={[
                  { key: 'all', label: '전체', count: all.length },
                  { key: 'local', label: '이 기기에 있음', count: counts.local },
                  { key: 'cloud', label: '클라우드에만', count: counts.cloud }
                ]}
              />
            </div>

            {items === null ? (
              <p className="store-hint">원본 목록을 불러오는 중…</p>
            ) : filtered.length === 0 ? (
              <SheetEmpty
                icon="filePdf"
                title={all.length === 0 ? '아직 원본이 없습니다' : '조건에 맞는 원본이 없습니다'}
                desc={all.length === 0 ? 'PDF를 가져오면 그 원본이 여기에 저장됩니다.' : undefined}
              />
            ) : (
              <div className="store-list">
                <div className="store-list-head">
                  <h3>
                    원본 <b>{filtered.length}</b>
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
                {filtered.map((a) => {
                  const isDown = downloading.has(a.id)
                  const tone: Tone = a.pending ? 'push' : 'gray'
                  return (
                    <div key={a.id} className={'store-row tone-' + tone}>
                      <span className="store-file-icon" data-kind={a.kind === 'pdf' ? 'pdf' : 'image'}>
                        {a.kind === 'pdf' ? 'PDF' : 'IMG'}
                      </span>
                      <div className="store-row-main">
                        <div className="store-row-title" title={a.name ?? a.sha256}>
                          {titleOf(a)}
                        </div>
                        <div className="store-row-sub">
                          <span className="store-row-name">{shaLabel(a)}…</span>
                          <span className="store-size">{formatBytes(a.size)}</span>
                          {a.docs.length > 0 ? <span>노트 {a.docs.length}개</span> : <span>사용 중인 노트 없음</span>}
                          <span>{formatDate(a.createdAt)}</span>
                        </div>
                      </div>
                      {a.pending && <span className="store-chip push">업로드 안 됨</span>}
                      {isDown ? (
                        <span className="store-chip recv">받는 중…</span>
                      ) : a.blob ? (
                        <span className={'store-status-icon ok'} aria-hidden="true">
                          <Icon name="checkCircle" size={16} />
                        </span>
                      ) : (
                        <span className={'store-status-icon cloud'} aria-hidden="true">
                          <Icon name="cloudDown" size={16} />
                        </span>
                      )}
                      <button
                        className="store-more"
                        data-pop-anchor=""
                        aria-label={`${titleOf(a)} 더보기`}
                        aria-expanded={menu?.id === a.id}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          const rect = e.currentTarget.getBoundingClientRect()
                          setMenu((p) => (p?.id === a.id ? null : { id: a.id, rect }))
                        }}
                      >
                        <Icon name="more" size={16} />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
        {menu && menuAsset && (
          <Popover anchor={menu.rect} onClose={() => setMenu(null)}>
            <MenuTitle>{titleOf(menuAsset)}</MenuTitle>
            {renderMenu(menuAsset)}
          </Popover>
        )}
      </div>
    </SheetErrorBoundary>
  )
}
