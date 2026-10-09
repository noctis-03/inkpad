import { useEffect, useState } from 'react'
import { useUI } from '../../app/store'
import { confirmDialog, promptDialog } from '../../app/dialogs'
import { Icon } from '../Icon'
import { SettingsSections } from '../SettingsPanel'
import { formatBytes, isStandalone } from '../../shared/util'
import { MAX_CATEGORY_CHARS, normalizeCategory, type DocumentMeta, type Folder, type ID } from '../../shared/model'
import {
  createFolder,
  deleteFolder,
  getHiddenCategories,
  listDocuments,
  listFolders,
  purgeExpiredTrash,
  setHiddenCategories,
  setFolderCategories,
  storageStats
} from '../../storage/repo'
import { exportInkpad, importInkpad } from '../../io/inkpadFormat'
import { pickFiles, saveFile } from '../../io/download'
import { clearAppCaches, wipeLocalData } from '../../storage/db'

type Stats = Awaited<ReturnType<typeof storageStats>>

export function LibrarySettings({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const toast = useUI((s) => s.toast)
  const setBusy = useUI((s) => s.setBusy)
  const reset = useUI((s) => s.resetSettings)
  const [stats, setStats] = useState<Stats | null>(null)
  const [tab, setTab] = useState<'pen' | 'data' | 'folders'>('pen')

  const load = () => void storageStats().then(setStats)
  useEffect(load, [])

  const backup = async () => {
    try {
      const docs = await listDocuments()
      if (!docs.length) return toast('백업할 문서가 없습니다.')
      setBusy({ text: '전체 백업 만드는 중', progress: 0 })
      const blob = await exportInkpad(
        docs.map((d) => d.id),
        'backup',
        (d, t) => setBusy({ text: '전체 백업 만드는 중', progress: d / t })
      )
      const date = new Date().toISOString().slice(0, 10)
      await saveFile(blob, `inkpad_backup_${date}.inkpad`)
    } catch (e) {
      toast(e instanceof Error ? e.message : '백업 실패', 'error')
    } finally {
      setBusy(null)
    }
  }

  const restore = async () => {
    const [f] = await pickFiles('.inkpad,.zip,application/zip')
    if (!f) return
    const ok = await confirmDialog('백업에서 가져오기', {
      message: '백업의 문서와 폴더를 새 사본으로 추가합니다. 기존 문서는 그대로 둡니다.',
      ok: '가져오기'
    })
    if (!ok) return
    try {
      setBusy({ text: '백업 가져오는 중' })
      const r = await importInkpad(f, null, (d, t) => setBusy({ text: '백업 가져오는 중', progress: d / t }))
      toast(`문서 ${r.documents.length}개를 가져왔습니다.${r.skippedBlocks ? ` 새 버전에서 만든 블록 ${r.skippedBlocks}개를 가져오지 못했습니다.` : ''}`, 'success')
      onChanged()
      load()
    } catch (e) {
      toast(e instanceof Error ? e.message : '가져오기 실패', 'error')
    } finally {
      setBusy(null)
    }
  }

  const persist = async () => {
    const ok = await navigator.storage?.persist?.()
    toast(ok ? '저장소 보존이 허용되었습니다.' : '브라우저가 보존 요청을 거절했습니다. 홈 화면에 추가하면 허용될 가능성이 높습니다.', ok ? 'success' : 'info')
    load()
  }

  const cleanTrash = async () => {
    const n = await purgeExpiredTrash()
    toast(n ? `오래된 휴지통 문서 ${n}개를 정리했습니다.` : '정리할 문서가 없습니다.')
    onChanged()
    load()
  }

  /** 캐시 삭제 — 노트·앱·파일·설정은 두고, 다시 만들 수 있는 것(미리보기·오프라인 캐시)만 지운다 */
  const clearCache = async () => {
    const ok = await confirmDialog('캐시 삭제', {
      message: '미리보기와 오프라인 캐시를 지웁니다. 노트·앱·파일·설정은 그대로 남습니다.',
      note: '미리보기는 노트를 열거나 받을 때 다시 만들어지고, 오프라인 캐시는 다음 실행 때 다시 채워집니다.',
      ok: '캐시 삭제'
    })
    if (!ok) return
    setBusy({ text: '캐시를 지우는 중' })
    try {
      const r = await clearAppCaches()
      const parts: string[] = []
      if (r.thumbnails) parts.push(`미리보기 ${r.thumbnails}개(${formatBytes(r.thumbBytes)})`)
      if (r.swCaches) parts.push(`오프라인 캐시 ${r.swCaches}개`)
      toast(parts.length ? `캐시를 삭제했습니다 — ${parts.join(', ')}.` : '지울 캐시가 없습니다.', 'success')
      load()
    } catch (e) {
      toast(e instanceof Error ? e.message : '캐시 삭제 실패', 'error')
    } finally {
      setBusy(null)
    }
  }

  /** 앱 초기화 (로컬 초기화) — 이 기기의 데이터만 지우고, 클라우드는 건드리지 않는다 (받기로 복구) */
  const resetLocal = async () => {
    const ok = await confirmDialog('앱 초기화 (로컬 초기화)', {
      message: '이 기기의 노트·앱·파일·설정을 모두 지우고 처음부터 다시 시작합니다. 클라우드에 저장된 노트는 남아 있고, 동기화 창의 받기로 다시 내려받을 수 있습니다.',
      note: '클라우드에 아직 올리지 못한 변경은 지우면 되살릴 수 없습니다. 전체 백업을 받아 두면 안전합니다.',
      ok: '다음',
      danger: true
    })
    if (!ok) return
    const ok2 = await confirmDialog('정말 초기화할까요?', {
      message: '이 기기의 모든 데이터를 지웁니다. 되돌릴 수 없습니다.',
      ok: '모두 지우고 초기화',
      danger: true
    })
    if (!ok2) return
    setBusy({ text: '로컬 데이터를 지우는 중' })
    try {
      await wipeLocalData()
    } finally {
      location.reload() // DB를 닫았으니 새로 열어 빈 상태로 시작한다
    }
  }

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet tall" role="dialog" aria-label="설정">
        <header className="sheet-header">
          <h2>설정</h2>
          <div className="seg small">
            <button className={tab === 'pen' ? 'is-active' : ''} onClick={() => setTab('pen')}>
              필기
            </button>
            <button className={tab === 'folders' ? 'is-active' : ''} onClick={() => setTab('folders')}>
              폴더 · 카테고리
            </button>
            <button className={tab === 'data' ? 'is-active' : ''} onClick={() => setTab('data')}>
              저장소 · 백업
            </button>
          </div>
          <button className="tb-btn" onClick={onClose} aria-label="닫기">
            <Icon name="close" />
          </button>
        </header>
        <div className="sheet-scroll">
          {tab === 'folders' ? (
            <FolderCategorySettings onChanged={onChanged} />
          ) : tab === 'pen' ? (
            <>
              <SettingsSections />
              <div className="panel-footer">
                <button className="text-btn" onClick={reset}>
                  필기 설정 기본값으로
                </button>
              </div>
            </>
          ) : (
            <>
              <section className="panel-section">
                <h3>기기 저장소</h3>
                {stats && (
                  <>
                    <div className="usage-bar">
                      <span style={{ width: `${stats.quota ? Math.min(100, (stats.usage / stats.quota) * 100) : 0}%` }} />
                    </div>
                    <dl className="stat-list">
                      <div>
                        <dt>사용 중</dt>
                        <dd>
                          {formatBytes(stats.usage)} {stats.quota ? `/ ${formatBytes(stats.quota)}` : ''}
                        </dd>
                      </div>
                      <div>
                        <dt>문서 / 페이지</dt>
                        <dd>
                          {stats.docs} / {stats.pages}
                        </dd>
                      </div>
                      <div>
                        <dt>PDF 원본</dt>
                        <dd>
                          {stats.assets}개 · {formatBytes(stats.assetBytes)}
                        </dd>
                      </div>
                      <div>
                        <dt>미리보기 캐시</dt>
                        <dd>
                          {stats.thumbs}개 · {formatBytes(stats.thumbBytes)}
                        </dd>
                      </div>
                      <div>
                        <dt>동기화 대기 (Drive)</dt>
                        <dd>{stats.pending}건</dd>
                      </div>
                      <div>
                        <dt>저장소 보존</dt>
                        <dd>{stats.persisted ? '허용됨 ✓' : '허용 안 됨'}</dd>
                      </div>
                      <div>
                        <dt>실행 방식</dt>
                        <dd>{isStandalone() ? '홈 화면 앱' : 'Safari 탭'}</dd>
                      </div>
                    </dl>
                  </>
                )}
                {stats && !stats.persisted && (
                  <p className="hint warn">
                    Safari는 오래 쓰지 않은 사이트의 데이터를 지울 수 있습니다. 홈 화면에 추가하고, 정기적으로 전체 백업을 받아 두세요. 동기화를 설정해 두면 Drive에서 복구할 수 있습니다. (설정 탭의 "동기화 · Google Drive")
                  </p>
                )}
                <div className="btn-row">
                  {stats && !stats.persisted && (
                    <button className="text-btn" onClick={persist}>
                      보존 요청
                    </button>
                  )}
                  <button className="text-btn" onClick={cleanTrash}>
                    오래된 휴지통 정리
                  </button>
                  <button className="text-btn" onClick={clearCache}>
                    캐시 삭제
                  </button>
                  <button className="text-btn danger" onClick={resetLocal}>
                    앱 초기화 (로컬 초기화)
                  </button>
                </div>
              </section>
              <section className="panel-section">
                <h3>백업</h3>
                <p className="hint">모든 문서, 폴더, PDF 원본을 .inkpad 파일 하나로 저장합니다. 가져올 때는 새 사본으로 추가됩니다.</p>
                <div className="btn-row">
                  <button id="backup-btn" className="primary-btn" onClick={backup}>
                    <Icon name="download" size={18} /> 전체 백업 내보내기
                  </button>
                  <button className="text-btn" onClick={restore}>
                    <Icon name="upload" size={18} /> 백업 가져오기
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** 폴더 ↔ 카테고리 매핑과 숨김 카테고리 관리 (기기별 로컬 설정) */
function FolderCategorySettings({ onChanged }: { onChanged: () => void }) {
  const [folders, setFolders] = useState<Folder[]>([])
  const [docs, setDocs] = useState<DocumentMeta[]>([])
  const [hidden, setHiddenList] = useState<string[]>([])
  const [newCat, setNewCat] = useState<Record<ID, string>>({})

  const reload = async () => {
    const [f, d, h] = await Promise.all([listFolders(), listDocuments(), getHiddenCategories()])
    setFolders(f)
    setDocs(d)
    setHiddenList(h)
  }
  useEffect(() => {
    void reload()
  }, [])

  const allCategories = (() => {
    const s = new Set<string>()
    for (const d of docs) if (d.category) s.add(d.category)
    for (const f of folders) for (const c of f.categories ?? []) s.add(c)
    return [...s].sort((a, b) => a.localeCompare(b, 'ko'))
  })()

  const addFolder = async () => {
    const name = await promptDialog('새 폴더', { value: '새 폴더', ok: '만들기' })
    if (!name?.trim()) return
    await createFolder(name.trim(), null)
    await reload()
    onChanged()
  }

  const addCategory = async (folderId: ID) => {
    const c = normalizeCategory(newCat[folderId] ?? '')
    if (!c) return
    const f = folders.find((x) => x.id === folderId)
    if (!f) return
    await setFolderCategories(folderId, [...(f.categories ?? []), c])
    setNewCat((m) => ({ ...m, [folderId]: '' }))
    await reload()
    onChanged()
  }

  const removeCategory = async (folderId: ID, cat: string) => {
    const f = folders.find((x) => x.id === folderId)
    if (!f) return
    await setFolderCategories(folderId, (f.categories ?? []).filter((x) => x !== cat))
    await reload()
    onChanged()
  }

  const removeFolder = async (f: Folder) => {
    const ok = await confirmDialog(`"${f.name}" 폴더 삭제`, {
      message: '이 폴더의 카테고리 매핑을 없앱니다. 노트는 삭제되지 않고 각 카테고리 메뉴에서 계속 볼 수 있습니다.',
      ok: '삭제',
      danger: true
    })
    if (!ok) return
    await deleteFolder(f.id)
    await reload()
    onChanged()
  }

  const toggleHidden = async (cat: string) => {
    const next = hidden.includes(cat) ? hidden.filter((x) => x !== cat) : [...hidden, cat]
    await setHiddenCategories(next)
    await reload()
    onChanged()
  }

  return (
    <>
      <section className="panel-section">
        <h3>폴더 · 카테고리 매핑</h3>
        <p className="hint">폴더는 이 기기의 정리 도구이고, 카테고리가 기기 사이에서 동기화됩니다. 폴더 하나가 카테고리 여러 개를 담을 수 있어요.</p>
        <div className="folder-map-list">
          {folders.map((f) => (
            <div key={f.id} className="folder-map-card">
              <div className="folder-map-head">
                <Icon name="folder" size={18} />
                <strong>{f.name}</strong>
                <button className="text-btn small danger" onClick={() => void removeFolder(f)}>
                  삭제
                </button>
              </div>
              {(f.categories ?? []).length > 0 ? (
                <div className="cat-chip-row">
                  {(f.categories ?? []).map((c) => (
                    <span key={c} className="cat-chip">
                      <Icon name="tag" size={13} /> {c}
                      <button className="cat-chip-x" aria-label={`${c} 매핑 제거`} title="매핑 제거" onClick={() => void removeCategory(f.id, c)}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="hint">매핑 없음 — 이 폴더에는 표시될 노트가 없습니다.</p>
              )}
              <div className="cat-add-row">
                <input
                  value={newCat[f.id] ?? ''}
                  maxLength={MAX_CATEGORY_CHARS}
                  placeholder="카테고리 추가"
                  aria-label={`${f.name}에 카테고리 추가`}
                  onChange={(e) => setNewCat((m) => ({ ...m, [f.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && newCat[f.id]?.trim() && void addCategory(f.id)}
                />
                <button className="text-btn small" disabled={!newCat[f.id]?.trim()} onClick={() => void addCategory(f.id)}>
                  추가
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="btn-row">
          <button className="text-btn" onClick={() => void addFolder()}>
            <Icon name="folderPlus" size={16} /> 새 폴더
          </button>
        </div>
      </section>
      <section className="panel-section">
        <h3>숨긴 카테고리</h3>
        <p className="hint">숨긴 카테고리의 노트는 이 기기 목록에서 감춰지고 받기에서도 제외됩니다. 클라우드 목록에는 계속 표시됩니다. 눌러서 숨기거나 해제하세요.</p>
        {allCategories.length === 0 ? (
          <p className="hint">아직 카테고리가 없습니다.</p>
        ) : (
          <div className="hidden-cat-grid">
            {allCategories.map((c) => {
              const hid = hidden.includes(c)
              return (
                <button
                  key={c}
                  className={'hidden-cat-chip' + (hid ? ' is-hidden' : '')}
                  title={hid ? '숨김 해제' : '이 기기에서 숨기기'}
                  aria-pressed={hid}
                  onClick={() => void toggleHidden(c)}
                >
                  <Icon name={hid ? 'close' : 'check'} size={13} /> {c}
                  {hid && <small>숨김</small>}
                </button>
              )
            })}
          </div>
        )}
      </section>
    </>
  )
}
