import { useCallback, useEffect, useMemo, useState } from 'react'
import { useUI } from '../../app/store'
import { askPdfPassword, confirmDialog, promptDialog } from '../../app/dialogs'
import { Icon } from '../Icon'
import { NewDocumentSheet } from './NewDocumentSheet'
import { LibrarySettings } from './LibrarySettings'
import type { DocumentMeta, Folder, ID } from '../../shared/model'
import { MAX_CATEGORY_CHARS, TRASH_RETENTION_DAYS, normalizeCategory } from '../../shared/model'
import { formatDate } from '../../shared/util'
import {
  createFolder,
  deleteFolder,
  duplicateDocument,
  getHiddenCategories,
  getThumbnails,
  listDocuments,
  listFolders,
  purgeDocument,
  restoreDocument,
  setFolderCategories,
  trashDocument,
  updateDocument,
  updateFolder
} from '../../storage/repo'
import { pickFiles, saveFile } from '../../io/download'
import { createDocumentFromPdf, ImportError, readPdf } from '../../io/pdfImport'
import { exportInkpad, importInkpad } from '../../io/inkpadFormat'
import { REMOTE_EVENT, pushOneNote } from '../../sync/sync'

type Section = { kind: 'all' } | { kind: 'folder'; id: ID } | { kind: 'uncategorized' } | { kind: 'trash' }

export function Library() {
  const navigate = useUI((s) => s.navigate)
  const prefs = useUI((s) => s.library)
  const setPrefs = useUI((s) => s.setLibrary)
  const toast = useUI((s) => s.toast)
  const setBusy = useUI((s) => s.setBusy)
  const [section, setSection] = useState<Section>(() => {
    const saved = sessionStorage.getItem('inkpad.section')
    return saved ? (JSON.parse(saved) as Section) : { kind: 'all' }
  })
  const [docs, setDocs] = useState<DocumentMeta[]>([])
  const [trash, setTrash] = useState<DocumentMeta[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [thumbs, setThumbs] = useState<Map<ID, string>>(new Map())
  const [query, setQuery] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [menu, setMenu] = useState<{ doc: DocumentMeta; x: number; y: number } | null>(null)
  const [folderMenu, setFolderMenu] = useState<{ folder: Folder; x: number; y: number } | null>(null)
  const [categorizing, setCategorizing] = useState<DocumentMeta | null>(null)
  const [hiddenCats, setHiddenCats] = useState<Set<string>>(new Set())
  const [treeOpen, setTreeOpen] = useState(() => window.innerWidth >= 900)

  useEffect(() => sessionStorage.setItem('inkpad.section', JSON.stringify(section)), [section])

  const refresh = useCallback(async () => {
    const [d, t, f, th, hid] = await Promise.all([listDocuments(), listDocuments({ trash: true }), listFolders(), getThumbnails(), getHiddenCategories()])
    setDocs(d)
    setTrash(t)
    setFolders(f)
    setHiddenCats(new Set(hid))
    setThumbs((old) => {
      old.forEach((url) => URL.revokeObjectURL(url))
      const m = new Map<ID, string>()
      th.forEach((blob, id) => m.set(id, URL.createObjectURL(blob)))
      return m
    })
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 다른 기기에서 받아온 변경 반영 (SDF 가이드 8장 3)
  useEffect(() => {
    const onRemote = () => void refresh()
    window.addEventListener(REMOTE_EVENT, onRemote)
    return () => window.removeEventListener(REMOTE_EVENT, onRemote)
  }, [refresh])

  // 폴더가 사라졌으면 전체로
  useEffect(() => {
    if (section.kind === 'folder' && folders.length && !folders.some((f) => f.id === section.id)) setSection({ kind: 'all' })
  }, [folders, section])

  const currentFolderId = section.kind === 'folder' ? section.id : null

  const mappedCategories = useMemo(() => new Set(folders.flatMap((f) => f.categories ?? [])), [folders])

  const visible = useMemo(() => {
    let list = section.kind === 'trash' ? trash : docs
    if (section.kind !== 'trash') list = list.filter((d) => !d.category || !hiddenCats.has(d.category)) // 숨긴 카테고리는 이 기기에서 미사용
    if (section.kind === 'folder') {
      const f = folders.find((x) => x.id === section.id)
      const cats = new Set(f?.categories ?? [])
      list = list.filter((d) => d.category != null && cats.has(d.category))
    } else if (section.kind === 'uncategorized') {
      list = list.filter((d) => d.category == null || !mappedCategories.has(d.category))
    }
    const q = query.trim().toLowerCase()
    if (q) list = list.filter((d) => d.title.toLowerCase().includes(q))
    const sorted = [...list]
    if (prefs.sort === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title, 'ko'))
    else if (prefs.sort === 'created') sorted.sort((a, b) => b.createdAt - a.createdAt)
    else sorted.sort((a, b) => (section.kind === 'trash' ? (b.deletedAt ?? 0) - (a.deletedAt ?? 0) : b.updatedAt - a.updatedAt))
    return sorted
  }, [docs, trash, folders, mappedCategories, hiddenCats, section, query, prefs.sort])

  const allCategories = useMemo(() => {
    const s = new Set<string>()
    for (const d of docs) if (d.category) s.add(d.category)
    for (const f of folders) for (const c of f.categories ?? []) s.add(c)
    return [...s].sort((a, b) => a.localeCompare(b, 'ko'))
  }, [docs, folders])

  const subfolders = useMemo(
    () => (section.kind === 'trash' || query ? [] : folders.filter((f) => f.parentId === currentFolderId)),
    [folders, section, currentFolderId, query]
  )

  const breadcrumb = useMemo(() => {
    const out: Folder[] = []
    let id = currentFolderId
    while (id) {
      const f = folders.find((x) => x.id === id)
      if (!f) break
      out.unshift(f)
      id = f.parentId
    }
    return out
  }, [folders, currentFolderId])

  // ───────── 작업 ─────────

  const open = (d: DocumentMeta) => navigate({ name: 'editor', docId: d.id })

  const importPdfFiles = async (files: File[], folderId: ID | null) => {
    let last: DocumentMeta | null = null
    for (const f of files) {
      try {
        setBusy({ text: `${f.name} 가져오는 중`, progress: 0 })
        const info = await readPdf(f, f.name, askPdfPassword, (p) => setBusy({ text: `${f.name} 읽는 중`, progress: p }))
        if (!info.pages.length) throw new ImportError('읽을 수 있는 페이지가 없습니다.')
        if (info.failedPages.length) {
          const ok = await confirmDialog('일부 페이지를 읽을 수 없습니다', {
            message: `${info.failedPages.length}개 페이지가 손상되었습니다. 읽을 수 있는 ${info.pages.length}개 페이지만 가져올까요?`,
            ok: '가져오기'
          })
          if (!ok) continue
        }
        last = await createDocumentFromPdf(info, folderId)
      } catch (e) {
        toast(e instanceof Error ? e.message : 'PDF를 가져오지 못했습니다.', 'error')
      } finally {
        setBusy(null)
      }
    }
    await refresh()
    if (last && files.length === 1) open(last)
  }

  const onImportPdf = async () => {
    const files = await pickFiles('application/pdf,.pdf', true)
    if (files.length) await importPdfFiles(files, currentFolderId)
  }

  const onImportInkpad = async () => {
    const files = await pickFiles('.inkpad,.zip,application/zip', true)
    for (const f of files) {
      try {
        setBusy({ text: `${f.name} 가져오는 중` })
        const r = await importInkpad(f, currentFolderId, (d, t) => setBusy({ text: `${f.name} 가져오는 중`, progress: d / t }))
        toast(`문서 ${r.documents.length}개를 가져왔습니다${r.skipped ? ` (${r.skipped}개 건너뜀)` : ''}.`, 'success')
      } catch (e) {
        toast(e instanceof Error ? e.message : '가져오기에 실패했습니다.', 'error')
      } finally {
        setBusy(null)
      }
    }
    await refresh()
  }

  // 드래그 앤 드롭 (Split View에서 파일 앱으로부터)
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    const files = [...e.dataTransfer.files]
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf')
    const inks = files.filter((f) => /\.(inkpad|zip)$/i.test(f.name))
    const others = files.length - pdfs.length - inks.length
    if (others) toast('지원 형식: PDF, .inkpad. Office 파일은 PDF로 변환한 뒤 가져와 주세요.', 'error')
    if (pdfs.length) await importPdfFiles(pdfs, currentFolderId)
    for (const f of inks) {
      try {
        await importInkpad(f, currentFolderId)
      } catch (err) {
        toast(err instanceof Error ? err.message : '가져오기 실패', 'error')
      }
    }
    if (inks.length) await refresh()
  }

  const onNewFolder = async (parentId: ID | null) => {
    const name = await promptDialog('새 폴더', { value: '새 폴더', ok: '만들기' })
    if (!name?.trim()) return
    const f = await createFolder(name.trim(), parentId)
    await refresh()
    setSection({ kind: 'folder', id: f.id })
  }

  const docAction = async (action: string, d: DocumentMeta) => {
    setMenu(null)
    switch (action) {
      case 'rename': {
        const t = await promptDialog('이름 바꾸기', { value: d.title, ok: '저장' })
        if (t?.trim()) await updateDocument(d.id, { title: t.trim() })
        break
      }
      case 'duplicate':
        setBusy({ text: '복제하는 중' })
        try {
          await duplicateDocument(d.id)
        } finally {
          setBusy(null)
        }
        break
      case 'category':
        setCategorizing(d)
        return
      case 'export':
        try {
          setBusy({ text: '내보내는 중' })
          const blob = await exportInkpad([d.id], 'document')
          await saveFile(blob, `${d.title}.inkpad`)
        } catch (e) {
          toast(e instanceof Error ? e.message : '내보내기 실패', 'error')
        } finally {
          setBusy(null)
        }
        break
      case 'cloudPush':
        setBusy({ text: `"${d.title}" 올리는 중` })
        try {
          await pushOneNote(d.id)
          toast(`"${d.title}"을(를) 클라우드에 올렸습니다.`, 'success')
        } catch (e) {
          toast(e instanceof Error ? e.message : '올리지 못했습니다.', 'error')
        } finally {
          setBusy(null)
        }
        break
      case 'trash':
        await trashDocument(d.id)
        toast(`"${d.title}"을(를) 휴지통으로 옮겼습니다.`, 'info', {
          label: '실행 취소',
          run: async () => {
            await restoreDocument(d.id)
            await refresh()
          }
        })
        break
      case 'restore':
        await restoreDocument(d.id)
        toast('복원했습니다.', 'success')
        break
      case 'purge':
        if (await confirmDialog('영구 삭제', { message: `"${d.title}"을(를) 영구 삭제합니다. 되돌릴 수 없습니다.`, ok: '삭제', danger: true }))
          await purgeDocument(d.id)
        break
    }
    await refresh()
  }

  const folderAction = async (action: string, f: Folder) => {
    setFolderMenu(null)
    if (action === 'rename') {
      const name = await promptDialog('폴더 이름', { value: f.name, ok: '저장' })
      if (name?.trim()) await updateFolder(f.id, { name: name.trim() })
    } else if (action === 'new') {
      return onNewFolder(f.id)
    } else if (action === 'delete') {
      const count = docs.filter((d) => d.category && (f.categories ?? []).includes(d.category)).length
      const ok = await confirmDialog(`"${f.name}" 폴더 삭제`, {
        message: count
          ? `이 폴더의 카테고리 매핑을 없앱니다. 노트 ${count}개는 삭제되지 않고 미분류로 표시됩니다.`
          : '이 폴더의 카테고리 매핑을 없앱니다. 하위 폴더도 함께 삭제됩니다.',
        ok: '삭제',
        danger: true
      })
      if (!ok) return
      await deleteFolder(f.id)
      if (currentFolderId === f.id) setSection({ kind: 'all' })
    }
    await refresh()
  }

  const emptyTrash = async () => {
    if (!trash.length) return
    if (!(await confirmDialog('휴지통 비우기', { message: `문서 ${trash.length}개를 영구 삭제합니다.`, ok: '비우기', danger: true }))) return
    for (const d of trash) await purgeDocument(d.id)
    await refresh()
  }

  const title =
    section.kind === 'trash'
      ? '휴지통'
      : section.kind === 'uncategorized'
        ? '미분류'
        : section.kind === 'folder'
          ? breadcrumb.at(-1)?.name ?? '폴더'
          : '모든 노트'

  return (
    <div className="library" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="library-header">
        <button className="tb-btn" onClick={() => setTreeOpen((v) => !v)} aria-label="폴더 목록">
          <Icon name="sidebar" />
        </button>
        <h1 className="library-title">{title}</h1>
        <div className="search-box">
          <Icon name="search" size={18} />
          <input id="doc-search" type="search" placeholder="제목 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <select
          className="sort-select"
          value={prefs.sort}
          onChange={(e) => setPrefs({ sort: e.target.value as typeof prefs.sort })}
          aria-label="정렬"
        >
          <option value="updated">수정일</option>
          <option value="created">만든 날</option>
          <option value="title">제목</option>
        </select>
        <button
          className="tb-btn"
          onClick={() => setPrefs({ view: prefs.view === 'grid' ? 'list' : 'grid' })}
          aria-label={prefs.view === 'grid' ? '리스트 보기' : '그리드 보기'}
        >
          <Icon name={prefs.view === 'grid' ? 'list' : 'grid'} />
        </button>
        <button className="tb-btn" onClick={() => setShowSettings(true)} aria-label="설정">
          <Icon name="gear" />
        </button>
        {section.kind !== 'trash' && (
          <button id="new-doc-btn" className="primary-btn" onClick={() => setShowNew(true)}>
            <Icon name="plus" size={18} /> 새로 만들기
          </button>
        )}
      </header>

      <div className="library-body">
        {treeOpen && (
          <nav className="folder-tree" aria-label="폴더">
            <button className={'tree-item' + (section.kind === 'all' ? ' is-active' : '')} onClick={() => setSection({ kind: 'all' })}>
              <Icon name="notebook" size={18} /> 모든 노트 <span className="count">{docs.length}</span>
            </button>
            <div className="tree-label">
              폴더
              <button className="icon-mini" onClick={() => onNewFolder(null)} aria-label="새 폴더">
                <Icon name="folderPlus" size={16} />
              </button>
            </div>
            <FolderTree
              folders={folders}
              parentId={null}
              depth={0}
              activeId={currentFolderId}
              docs={docs}
              onSelect={(id) => setSection({ kind: 'folder', id })}
              onMenu={(folder, x, y) => setFolderMenu({ folder, x, y })}
            />
            <button
              className={'tree-item' + (section.kind === 'uncategorized' ? ' is-active' : '')}
              onClick={() => setSection({ kind: 'uncategorized' })}
            >
              <Icon name="tag" size={18} /> 미분류{' '}
              <span className="count">
                {docs.filter((d) => (d.category == null || !mappedCategories.has(d.category)) && !(d.category && hiddenCats.has(d.category))).length}
              </span>
            </button>
            <button className={'tree-item trash' + (section.kind === 'trash' ? ' is-active' : '')} onClick={() => setSection({ kind: 'trash' })}>
              <Icon name="trash" size={18} /> 휴지통 <span className="count">{trash.length}</span>
            </button>
          </nav>
        )}

        <main className="library-main">
          {section.kind === 'folder' && (
            <nav className="breadcrumb" aria-label="경로">
              <button onClick={() => setSection({ kind: 'all' })}>모든 노트</button>
              {breadcrumb.map((f) => (
                <span key={f.id}>
                  <Icon name="chevronRight" size={14} />
                  <button onClick={() => setSection({ kind: 'folder', id: f.id })}>{f.name}</button>
                </span>
              ))}
            </nav>
          )}
          {section.kind === 'trash' && (
            <div className="trash-bar">
              <span>휴지통의 문서는 {TRASH_RETENTION_DAYS}일 뒤 영구 삭제됩니다.</span>
              <button className="text-btn danger" onClick={emptyTrash} disabled={!trash.length}>
                휴지통 비우기
              </button>
            </div>
          )}

          {subfolders.length > 0 && (
            <section className="folder-strip" aria-label="하위 폴더">
              {subfolders.map((f) => (
                <button key={f.id} className="folder-chip" onClick={() => setSection({ kind: 'folder', id: f.id })}>
                  <Icon name="folder" size={18} /> {f.name}
                </button>
              ))}
            </section>
          )}

          {visible.length === 0 ? (
            <div className="empty-state">
              {section.kind === 'trash' ? (
                <p>휴지통이 비어 있습니다.</p>
              ) : query ? (
                <p>“{query}”와(과) 일치하는 문서가 없습니다.</p>
              ) : (
                <>
                  <Icon name="notebook" size={48} />
                  <p>아직 노트가 없습니다.</p>
                  <div className="btn-row center">
                    <button className="primary-btn" onClick={() => setShowNew(true)}>
                      <Icon name="plus" size={18} /> 새 노트
                    </button>
                    <button className="text-btn" onClick={onImportPdf}>
                      <Icon name="filePdf" size={18} /> PDF 가져오기
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <section className={prefs.view === 'grid' ? 'doc-grid' : 'doc-list'} aria-label="문서">
              {visible.map((d) => (
                <article
                  key={d.id}
                  className="doc-card"
                  data-doc-id={d.id}
                  onClick={() => (section.kind === 'trash' ? setMenu({ doc: d, x: 0, y: 0 }) : open(d))}
                >
                  <div className="doc-thumb">
                    {thumbs.get(d.id) ? (
                      <img src={thumbs.get(d.id)} alt="" draggable={false} />
                    ) : (
                      <Icon name={d.mode === 'infinite' ? 'infinite' : 'page'} size={36} />
                    )}
                    <span className="doc-badge">{d.mode === 'infinite' ? '무한' : `${d.pageOrder.length}쪽`}</span>
                  </div>
                  <div className="doc-info">
                    <h3 className="doc-title">{d.title}</h3>
                    <p className="doc-date">
                      {section.kind === 'trash' && d.deletedAt ? `삭제 ${formatDate(d.deletedAt)}` : formatDate(d.updatedAt)}
                    </p>
                  </div>
                  <button
                    className="doc-more"
                    aria-label="더보기"
                    onClick={(e) => {
                      e.stopPropagation()
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setMenu({ doc: d, x: r.right, y: r.bottom })
                    }}
                  >
                    <Icon name="more" size={20} />
                  </button>
                </article>
              ))}
            </section>
          )}
        </main>
      </div>

      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {section.kind === 'trash' ? (
            <>
              <MenuItem icon="restore" label="복원" onClick={() => docAction('restore', menu.doc)} />
              <MenuItem icon="trash" label="영구 삭제" danger onClick={() => docAction('purge', menu.doc)} />
            </>
          ) : (
            <>
              <MenuItem icon="edit" label="이름 바꾸기" onClick={() => docAction('rename', menu.doc)} />
              <MenuItem icon="copy" label="복제" onClick={() => docAction('duplicate', menu.doc)} />
              <MenuItem icon="tag" label="카테고리 지정" onClick={() => docAction('category', menu.doc)} />
              <MenuItem icon="share" label=".inkpad로 내보내기" onClick={() => docAction('export', menu.doc)} />
              <MenuItem icon="upload" label="클라우드에 올리기" onClick={() => docAction('cloudPush', menu.doc)} />
              <MenuItem icon="trash" label="휴지통으로" danger onClick={() => docAction('trash', menu.doc)} />
            </>
          )}
        </Menu>
      )}

      {folderMenu && (
        <Menu x={folderMenu.x} y={folderMenu.y} onClose={() => setFolderMenu(null)}>
          <MenuItem icon="edit" label="이름 바꾸기" onClick={() => folderAction('rename', folderMenu.folder)} />
          <MenuItem icon="folderPlus" label="하위 폴더 만들기" onClick={() => folderAction('new', folderMenu.folder)} />
          <MenuItem icon="trash" label="폴더 삭제" danger onClick={() => folderAction('delete', folderMenu.folder)} />
        </Menu>
      )}

      {categorizing && (
        <CategoryPicker
          current={categorizing.category ?? null}
          categories={allCategories}
          onClose={() => setCategorizing(null)}
          onPick={async (cat) => {
            await updateDocument(categorizing.id, { category: cat })
            setCategorizing(null)
            await refresh()
          }}
        />
      )}

      {showNew && (
        <NewDocumentSheet
          folderId={currentFolderId}
          onClose={() => setShowNew(false)}
          onCreated={(d) => {
            setShowNew(false)
            open(d)
          }}
          onImportPdf={() => {
            setShowNew(false)
            void onImportPdf()
          }}
          onImportInkpad={() => {
            setShowNew(false)
            void onImportInkpad()
          }}
        />
      )}
      {showSettings && <LibrarySettings onClose={() => setShowSettings(false)} onChanged={refresh} />}
    </div>
  )
}

function FolderTree(props: {
  folders: Folder[]
  parentId: ID | null
  depth: number
  activeId: ID | null
  docs: DocumentMeta[]
  onSelect: (id: ID) => void
  onMenu: (f: Folder, x: number, y: number) => void
}) {
  const children = props.folders.filter((f) => f.parentId === props.parentId)
  if (!children.length) return null
  return (
    <>
      {children.map((f) => (
        <div key={f.id}>
          <div className={'tree-item folder' + (props.activeId === f.id ? ' is-active' : '')} style={{ paddingLeft: 12 + props.depth * 16 }}>
            <button className="tree-main" onClick={() => props.onSelect(f.id)}>
              <Icon name="folder" size={18} /> <span className="tree-name">{f.name}</span>
              <span className="count">{props.docs.filter((d) => d.category && (f.categories ?? []).includes(d.category)).length}</span>
            </button>
            <button
              className="icon-mini"
              aria-label={`${f.name} 메뉴`}
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                props.onMenu(f, r.right, r.bottom)
              }}
            >
              <Icon name="more" size={16} />
            </button>
          </div>
          <FolderTree {...props} parentId={f.id} depth={props.depth + 1} />
        </div>
      ))}
    </>
  )
}

export function Menu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: React.ReactNode }) {
  const centered = x === 0 && y === 0
  const style: React.CSSProperties = centered
    ? {}
    : { top: Math.min(y + 4, window.innerHeight - 280), left: Math.max(8, Math.min(x - 220, window.innerWidth - 232)) }
  return (
    <div className="menu-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'menu' + (centered ? ' centered' : '')} style={style} role="menu">
        {children}
      </div>
    </div>
  )
}

export function MenuItem({ icon, label, onClick, danger }: { icon: string; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button className={'menu-item' + (danger ? ' danger' : '')} role="menuitem" onClick={onClick}>
      <Icon name={icon} size={18} /> {label}
    </button>
  )
}

function CategoryPicker({
  current,
  categories,
  onPick,
  onClose
}: {
  current: string | null
  categories: string[]
  onPick: (category: string | null) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const submit = () => {
    const c = normalizeCategory(name)
    if (!c) return
    onPick(c)
  }
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2 className="modal-title">카테고리 지정</h2>
        <div className="picker-list">
          <button className={'menu-item' + (current === null ? ' is-current' : '')} onClick={() => onPick(null)}>
            <Icon name="notebook" size={18} /> 미분류
          </button>
          {categories.map((c) => (
            <button key={c} className={'menu-item' + (current === c ? ' is-current' : '')} onClick={() => onPick(c)}>
              <Icon name="tag" size={18} /> {c}
            </button>
          ))}
        </div>
        <div className="field inline" style={{ padding: '4px 16px 12px' }}>
          <input
            value={name}
            maxLength={MAX_CATEGORY_CHARS}
            placeholder="새 카테고리 만들기"
            aria-label="새 카테고리 이름"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && submit()}
          />
          <button className="text-btn small" disabled={!name.trim()} onClick={submit}>
            추가
          </button>
        </div>
        <div className="modal-actions">
          <button className="text-btn" onClick={onClose}>
            취소
          </button>
        </div>
      </div>
    </div>
  )
}
