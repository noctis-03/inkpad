import { useCallback, useEffect, useMemo, useState } from 'react'
import { useUI } from '../app/store'
import { confirmDialog } from '../app/dialogs'
import { formatBytes, formatDate } from '../shared/util'
import type { ID } from '../shared/model'
import { db } from '../storage/db'
import { confirmTransfer } from '../sync/transfer'
import * as drive from '../sync/drive'
import { ensureFolders } from '../sync/folders'
import { AuthRequiredError, login } from '../sync/token'
import { AssetUnavailableError, ensureAssetLocal, downloadAllMissing, onAssetProgress } from '../sync/assets'
import { saveFile } from '../io/download'
import { Icon } from './Icon'
import { FilterTabs, MenuItem, MenuSep, MenuTitle, Popover, SearchBox, SheetEmpty, SheetErrorBoundary, SheetHeader, SheetBanner, useOnline } from './sheetParts'

// 에셋 원본(PDF·이미지) 관리 시트. 동기화의 지연 로딩(asset.ts)과 같은 규칙을 따른다:
//   - 이 기기(IndexedDB assets 테이블)의 원본과 클라우드(Drive · Inkpad/assets)의 원본을 합쳐서 보여준다.
//   - 원본을 지워도 노트·필기는 그대로고, 클라우드 사본이 있으면 나중에 다시 받는다.
//   - 클라우드에서 지운 원본은 Drive 휴지통으로 가므로 30일 동안 되살릴 수 있다.
type Tone = 'push' | 'recv' | 'gone' | 'gray'
type FilterKey = 'all' | 'local' | 'cloud' | 'confirm'
type Sort = 'recent' | 'size' | 'name'

/** 행 상태 — local(원본 있음) / pending(업로드 대기) / meta-only(이 기기에 원본 없음·클라우드에 있음)
 *  / cloud-only(이 기기에 참조 정보조차 없는 클라우드 전용 원본) / cloud-missing(클라우드 사본이 없음) */
type RowState = 'local' | 'pending' | 'meta-only' | 'cloud-only' | 'cloud-missing'

interface AssetInfo {
  key: string
  /** 이 기기 assets 행 (클라우드 전용 원본은 없다) */
  assetId?: ID
  /** Drive 파일 (아직 올라가지 않았으면 없다) */
  fileId?: string
  kind: 'pdf' | 'image'
  mime: string
  size: number
  sha256: string
  name?: string
  createdAt: number
  /** 이 기기에 받아 둔 원본 바이트 */
  blob?: Blob
  /** 이 원본을 속지(PDF)로 쓰는 살아 있는 노트 제목 */
  docs: string[]
  /** 업로드 대기 (outbox에 asset 항목이 있음) */
  pending: boolean
}

const shaOfRemote = (r: drive.RemoteFile) => r.appProperties?.sha256 || r.name.replace(/^assets\//, '').replace(/\.[^.]*$/, '')
const baseName = (name: string) => name.split('/').pop() || name
const shaLabel = (a: AssetInfo) => a.sha256.slice(0, 8)
const titleOf = (a: AssetInfo) => a.name?.trim() || `${a.kind === 'pdf' ? 'PDF' : '이미지'} 원본 ${shaLabel(a)}`

export function AssetsSheet({ onClose }: { onClose: () => void }) {
  const toast = useUI((s) => s.toast)
  const setBusy = useUI((s) => s.setBusy)
  const online = useOnline()
  const [items, setItems] = useState<AssetInfo[] | null>(null)
  const [cloudKnown, setCloudKnown] = useState(false) // 클라우드 목록을 읽었는가 (오프라인·미로그인이면 false)
  const [cloudAuth, setCloudAuth] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FilterKey>('all')
  const [sort, setSort] = useState<Sort>('recent')
  const [menu, setMenu] = useState<{ key: string; rect: DOMRect } | null>(null)
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
    const pendingIds = new Set(outbox.map((r) => r.entityId))
    const bySha = new Map<string, AssetInfo>()
    const infos: AssetInfo[] = []
    for (const a of assets) {
      const info: AssetInfo = { ...a, key: a.id, docs: usedBy.get(a.id) ?? [], pending: pendingIds.has(a.id) }
      bySha.set(a.sha256, info)
      infos.push(info)
    }

    // 클라우드(Drive · Inkpad/assets)의 원본을 합친다 — 이 기기에 참조 정보가 없는 원본도 그대로 보인다
    let known = false
    let auth = false
    if (navigator.onLine) {
      try {
        const folder = (await ensureFolders()).assets
        const remotes = await drive.listFiles(folder)
        known = true
        for (const r of remotes) {
          const sha = shaOfRemote(r)
          if (!sha) continue
          const hit = bySha.get(sha)
          const name = baseName(r.name)
          const size = Math.max(0, Number(r.size ?? 0) || 0)
          const at = Date.parse(r.modifiedTime) || 0
          if (hit) {
            hit.fileId = r.id
            if (!hit.name && name) hit.name = name
            if (size && !hit.blob) hit.size = size // 이 기기에 원본이 없으면 원격 크기를 쓴다
          } else {
            const isPdf = /\.pdf$/i.test(name)
            const info: AssetInfo = {
              key: 'sha:' + sha,
              fileId: r.id,
              kind: isPdf ? 'pdf' : 'image',
              mime: isPdf ? 'application/pdf' : 'image/*',
              size,
              sha256: sha,
              name,
              createdAt: at,
              docs: [],
              pending: false
            }
            bySha.set(sha, info)
            infos.push(info)
          }
        }
      } catch (e) {
        if (e instanceof AuthRequiredError) auth = true
        else console.warn('[assets] 클라우드 원본 목록을 읽지 못했습니다.', e)
      }
    }
    setCloudKnown(known)
    setCloudAuth(auth)
    setItems(infos)
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

  const stateOf = (a: AssetInfo): RowState => {
    if (a.blob) {
      if (a.pending) return 'pending'
      if (cloudKnown && !a.fileId) return 'cloud-missing'
      return 'local'
    }
    if (a.fileId) return a.assetId ? 'meta-only' : 'cloud-only'
    return cloudKnown ? 'cloud-missing' : 'meta-only'
  }

  const all = items ?? []
  const counts = useMemo(() => {
    const st = new Map(all.map((a) => [a.key, stateOf(a)]))
    return {
      local: all.filter((a) => st.get(a.key) === 'local').length,
      cloud: all.filter((a) => st.get(a.key) === 'meta-only' || st.get(a.key) === 'cloud-only').length,
      confirm: all.filter((a) => st.get(a.key) === 'pending' || st.get(a.key) === 'cloud-missing').length,
      st
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, cloudKnown])

  const matchFilter = (s: RowState, f: FilterKey) =>
    f === 'all' ||
    (f === 'local' && (s === 'local' || s === 'pending' || s === 'cloud-missing')) || // 이 기기에 원본 바이트가 있는 것
    (f === 'cloud' && (s === 'meta-only' || s === 'cloud-only')) ||
    (f === 'confirm' && (s === 'pending' || s === 'cloud-missing'))

  const localBytes = useMemo(() => all.reduce((n, a) => n + (a.blob ? a.size : 0), 0), [all])
  const totalBytes = useMemo(() => {
    // 이 기기 원본 + 클라우드에만 있는 원본 — 같은 원본을 두 번 세지 않는다
    return all.reduce((n, a) => n + (a.blob ? a.size : stateOf(a) === 'meta-only' || stateOf(a) === 'cloud-only' ? a.size : 0), 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, cloudKnown])
  const pct = totalBytes ? Math.min(100, Math.round((localBytes / totalBytes) * 100)) : 0

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const arr = all.filter((a) => {
      if (!matchFilter(stateOf(a), filter)) return false
      if (!q) return true
      return `${a.name ?? ''} ${a.sha256}`.toLowerCase().includes(q)
    })
    arr.sort((a, b) => {
      if (sort === 'size') return b.size - a.size
      if (sort === 'name') return titleOf(a).localeCompare(titleOf(b), 'ko')
      return b.createdAt - a.createdAt
    })
    return arr
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, filter, query, sort, cloudKnown])

  /** 원본 바이트를 이 기기에서만 지운다 (노트·필기는 그대로) */
  const dropOriginal = async (a: AssetInfo) => {
    if (!a.assetId) return
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
      await db.assets.update(a.assetId, { blob: undefined })
      toast(`${formatBytes(a.size)}를 확보했습니다. 필요하면 클라우드에서 다시 받습니다.`)
    } catch (e) {
      toast(e instanceof Error ? e.message : '제거하지 못했습니다.', 'error')
    }
    await load()
  }

  /** 이 기기에 참조가 있는 원본을 클라우드에서 받는다 (지연 로딩 캐시에 들어간다) */
  const download = async (a: AssetInfo) => {
    if (!a.assetId) return
    if (!(await confirmTransfer('down', a.size))) return
    try {
      await ensureAssetLocal(a.assetId)
      toast(`"${titleOf(a)}" 원본을 받았습니다.`)
    } catch (e) {
      toast(e instanceof AssetUnavailableError ? e.message : '원본을 받지 못했습니다. 네트워크 상태를 확인해 주세요.', 'error')
    }
    await load()
  }

  /** 이 기기에 참조가 없는 클라우드 전용 원본 — 앱 저장소가 아니라 기기(다운로드)로 내려받는다 */
  const saveToDevice = async (a: AssetInfo) => {
    if (!a.fileId) return
    if (!(await confirmTransfer('down', a.size))) return
    try {
      const blob = await drive.downloadBlob(a.fileId)
      await saveFile(blob, a.name || `${a.sha256}.pdf`)
      toast(`"${titleOf(a)}" 원본을 기기에 저장했습니다.`)
    } catch (e) {
      toast(e instanceof Error ? e.message : '내려받지 못했습니다.', 'error')
    }
  }

  /** 클라우드 사본을 Drive 휴지통으로 옮긴다 (30일 동안 되살릴 수 있다) */
  const deleteFromCloud = async (a: AssetInfo) => {
    if (!a.fileId) return
    const hasLocal = !!a.blob
    const ok = await confirmDialog('클라우드에서 삭제', {
      message: hasLocal
        ? `"${titleOf(a)}"을(를) 클라우드에서 삭제합니다. 이 기기의 원본은 그대로 남지만, 다른 기기에서는 받을 수 없게 됩니다.`
        : `"${titleOf(a)}"을(를) 클라우드에서 삭제합니다. 이 기기에 사본이 없어서, 다른 기기에도 받아 둔 곳이 없다면 Inkpad에서 다시 받을 수 없습니다.`,
      note: 'Google Drive 휴지통에서 30일 동안 되살릴 수 있습니다.',
      ok: '삭제',
      danger: true
    })
    if (!ok) return
    try {
      await drive.trash(a.fileId)
      await db.syncState.delete('asset:' + a.sha256) // 위치 기록을 지워 다음 받기 때 다시 찾게 한다
      toast(hasLocal ? '클라우드에서 삭제했습니다. 이 기기의 원본은 남아 있습니다.' : '클라우드에서 삭제했습니다.')
    } catch (e) {
      toast(e instanceof Error ? e.message : '삭제하지 못했습니다.', 'error')
    }
    await load()
  }

  /** 클라우드에만 있는(이 기기에 참조가 있는) 원본을 모두 받는다 */
  const downloadAll = async () => {
    const missing = all.filter((a) => a.assetId && !a.blob && a.fileId)
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

  const menuAsset = menu ? all.find((a) => a.key === menu.key) : undefined

  const renderMenu = (a: AssetInfo) => {
    const close = () => setMenu(null)
    const act = (fn: () => void) => () => {
      close()
      fn()
    }
    const size = formatBytes(a.size)
    const s = stateOf(a)
    const cloudDelete = (
      <MenuItem
        icon="cloud"
        label="클라우드에서 삭제"
        desc={a.blob ? '이 기기 원본은 남습니다 · 다른 기기에서 사라집니다' : '이 기기에 사본이 없어 복구할 수 없습니다'}
        danger
        disabled={!online}
        onClick={act(() => void deleteFromCloud(a))}
      />
    )
    const usedByDocs =
      a.docs.length > 0 ? (
        <>
          <MenuSep />
          <MenuTitle>이 원본을 쓰는 노트</MenuTitle>
          {a.docs.slice(0, 6).map((t) => (
            <MenuTitle key={t}>{t}</MenuTitle>
          ))}
          {a.docs.length > 6 && <MenuTitle>외 {a.docs.length - 6}개</MenuTitle>}
        </>
      ) : null
    switch (s) {
      case 'local':
        return (
          <>
            <MenuItem icon="eraser" label="다운로드 제거" desc={`${size} 확보 · 목록에는 남습니다`} onClick={act(() => void dropOriginal(a))} />
            <MenuSep />
            {cloudDelete}
            {usedByDocs}
          </>
        )
      case 'pending':
        return (
          <>
            <MenuItem icon="upload" label="재업로드는 동기화에서" desc="설정 > 동기화의 올리기를 실행해 주세요" disabled onClick={act(() => {})} />
            <MenuSep />
            {cloudDelete}
            {usedByDocs}
          </>
        )
      case 'meta-only':
        return (
          <>
            <MenuItem icon="download" label="원본 받기" desc={`${size} · 클라우드에서 받습니다`} disabled={!online} onClick={act(() => void download(a))} />
            <MenuSep />
            {cloudDelete}
            {usedByDocs}
          </>
        )
      case 'cloud-only':
        return (
          <>
            <MenuItem icon="download" label="기기에 저장" desc={`${size} · 이 앱 말고 기기 저장소로`} disabled={!online} onClick={act(() => void saveToDevice(a))} />
            <MenuSep />
            {cloudDelete}
          </>
        )
      case 'cloud-missing':
        return (
          <>
            {a.blob ? (
              <MenuItem icon="eraser" label="다운로드 제거" desc={`${size} 확보 · 목록에는 남습니다`} onClick={act(() => void dropOriginal(a))} />
            ) : (
              <MenuTitle>이 기기에도 클라우드에도 원본이 없습니다</MenuTitle>
            )}
            {usedByDocs}
          </>
        )
    }
  }

  const chipOf = (s: RowState): { chip?: string; tone: Tone } => {
    switch (s) {
      case 'pending':
        return { chip: '업로드 안 됨', tone: 'push' }
      case 'cloud-missing':
        return { chip: '클라우드에 없음', tone: 'gone' }
      default:
        return { tone: 'gray' }
    }
  }

  return (
    <SheetErrorBoundary onClose={onClose}>
      <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="store-sheet" role="dialog" aria-label="에셋 원본">
          <SheetHeader
            icon="filePdf"
            title="에셋 원본"
            subtitle="PDF·이미지 원본 · Google Drive · Inkpad/assets"
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
              <SheetBanner tone="offline">오프라인입니다. 이 기기에 받아 둔 원본만 사용할 수 있고, 클라우드 목록은 보이지 않습니다.</SheetBanner>
            ) : cloudAuth ? (
              <SheetBanner
                tone="warn"
                actions={
                  <button
                    className="store-banner-btn"
                    onClick={() => {
                      void login()
                    }}
                  >
                    로그인
                  </button>
                }
              >
                Google 로그인이 필요합니다. 로그인하면 클라우드의 모든 원본이 표시됩니다.
              </SheetBanner>
            ) : !cloudKnown ? (
              <SheetBanner tone="warn">클라우드 목록을 아직 읽지 못했습니다. 새로 고침을 눌러 주세요.</SheetBanner>
            ) : counts.cloud > 0 ? (
              <SheetBanner
                tone="warn"
                actions={
                  <button className="store-banner-btn" disabled={!all.some((a) => a.assetId && !a.blob && a.fileId)} onClick={() => void downloadAll()}>
                    모두 받기
                  </button>
                }
              >
                클라우드에만 있는 원본이 {counts.cloud}개 있습니다. 노트가 쓰는 원본은 열 때 자동으로 받으며, 여기서 미리 받을 수도 있습니다.
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
                  { key: 'cloud', label: '클라우드에만', count: counts.cloud },
                  ...(counts.confirm ? [{ key: 'confirm' as FilterKey, label: '확인 필요', count: counts.confirm, warn: true }] : [])
                ]}
              />
            </div>

            {items === null ? (
              <p className="store-hint">원본 목록을 불러오는 중…</p>
            ) : filtered.length === 0 ? (
              <SheetEmpty
                icon="filePdf"
                title={all.length === 0 ? '아직 원본이 없습니다' : '조건에 맞는 원본이 없습니다'}
                desc={all.length === 0 ? 'PDF를 가져오면 그 원본이 여기에 저장되고, 클라우드(Inkpad/assets)의 원본도 함께 표시됩니다.' : undefined}
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
                  const s = stateOf(a)
                  const { chip, tone } = chipOf(s)
                  const isDown = a.assetId != null && downloading.has(a.assetId)
                  const dim = !online && (s === 'meta-only' || s === 'cloud-only')
                  const statusIcon = s === 'local' ? 'checkCircle' : s === 'meta-only' || s === 'cloud-only' ? 'cloudDown' : null
                  return (
                    <div key={a.key} className={'store-row tone-' + tone + (dim ? ' is-dim' : '')}>
                      <span className="store-file-icon" data-kind={a.kind === 'pdf' ? 'pdf' : 'image'}>
                        {a.kind === 'pdf' ? 'PDF' : 'IMG'}
                      </span>
                      <div className="store-row-main">
                        <div className="store-row-title" title={a.name ?? a.sha256}>
                          {titleOf(a)}
                        </div>
                        <div className="store-row-sub">
                          <span className="store-row-name">{shaLabel(a)}…</span>
                          <span className={a.size >= 50 * 1024 * 1024 ? 'store-size big' : 'store-size'}>{formatBytes(a.size)}</span>
                          {a.docs.length > 0 ? <span>노트 {a.docs.length}개</span> : s === 'cloud-only' ? <span>클라우드 전용</span> : <span>사용 중인 노트 없음</span>}
                          <span>{formatDate(a.createdAt)}</span>
                        </div>
                      </div>
                      {chip && <span className={'store-chip ' + tone}>{chip}</span>}
                      {isDown ? (
                        <span className="store-chip recv">받는 중…</span>
                      ) : (
                        statusIcon && (
                          <span className={'store-status-icon ' + (statusIcon === 'checkCircle' ? 'ok' : 'cloud')} aria-hidden="true">
                            <Icon name={statusIcon} size={16} />
                          </span>
                        )
                      )}
                      <button
                        className="store-more"
                        data-pop-anchor=""
                        aria-label={`${titleOf(a)} 더보기`}
                        aria-expanded={menu?.key === a.key}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          const rect = e.currentTarget.getBoundingClientRect()
                          setMenu((p) => (p?.key === a.key ? null : { key: a.key, rect }))
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
