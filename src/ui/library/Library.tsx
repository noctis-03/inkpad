import { useCallback, useEffect, useMemo, useState } from 'react'
import { useUI } from '../../app/store'
import { askPdfPassword, confirmDialog, promptDialog } from '../../app/dialogs'
import { Icon } from '../Icon'
import { NewDocumentSheet } from './NewDocumentSheet'
import { LibrarySettings } from './LibrarySettings'
import { SyncSheet } from '../SyncSection'
import type { DocumentMeta, Folder, HtmlApp, ID } from '../../shared/model'
import { MAX_CATEGORY_CHARS, TRASH_RETENTION_DAYS, extOf, normalizeCategory } from '../../shared/model'
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
import { APPS_EVENT, addApp, deleteApp, listApps, updateAppHtml, updateAppMeta } from '../../sync/apps'
import { FILES_EVENT, addFile, deleteFile, fileToBlob, getFile, listFiles, updateFileMeta } from '../../sync/files'
import type { FileRow } from '../../storage/db'

type Section =
  | { kind: 'all' }
  | { kind: 'notes' }
  | { kind: 'apps' }
  | { kind: 'category'; name: string }
  | { kind: 'folder'; id: ID }
  | { kind: 'uncategorized' }
  | { kind: 'trash' }

type Item = { kind: 'doc'; d: DocumentMeta } | { kind: 'app'; a: HtmlApp } | { kind: 'file'; f: FileRow }

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
  const [apps, setApps] = useState<HtmlApp[]>([])
  const [files, setFiles] = useState<FileRow[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [thumbs, setThumbs] = useState<Map<ID, string>>(new Map())
  const [query, setQuery] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showSync, setShowSync] = useState(false)
  const [menu, setMenu] = useState<{ doc: DocumentMeta; x: number; y: number } | null>(null)
  const [folderMenu, setFolderMenu] = useState<{ folder: Folder; x: number; y: number } | null>(null)
  const [categorizing, setCategorizing] = useState<DocumentMeta | null>(null)
  const [appMenu, setAppMenu] = useState<{ app: HtmlApp; x: number; y: number } | null>(null)
  const [categorizingApp, setCategorizingApp] = useState<HtmlApp | null>(null)
  const [fileMenu, setFileMenu] = useState<{ file: FileRow; x: number; y: number } | null>(null)
  const [categorizingFile, setCategorizingFile] = useState<FileRow | null>(null)
  const [hiddenCats, setHiddenCats] = useState<Set<string>>(new Set())
  const [treeOpen, setTreeOpen] = useState(() => window.innerWidth >= 900)

  useEffect(() => sessionStorage.setItem('inkpad.section', JSON.stringify(section)), [section])

  const refresh = useCallback(async () => {
    const [d, t, f, th, hid, ap, fls] = await Promise.all([listDocuments(), listDocuments({ trash: true }), listFolders(), getThumbnails(), getHiddenCategories(), listApps(), listFiles()])
    setDocs(d)
    setTrash(t)
    setFolders(f)
    setHiddenCats(new Set(hid))
    setApps(ap)
    setFiles(fls)
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

  // HTML 앱 변경 반영 (추가·업데이트·삭제는 곧바로 클라우드 반영을 시도한다)
  useEffect(() => {
    const onApps = () => void refresh()
    window.addEventListener(APPS_EVENT, onApps)
    return () => window.removeEventListener(APPS_EVENT, onApps)
  }, [refresh])

  // 일반 파일 변경 반영
  useEffect(() => {
    const onFiles = () => void refresh()
    window.addEventListener(FILES_EVENT, onFiles)
    return () => window.removeEventListener(FILES_EVENT, onFiles)
  }, [refresh])

  // 폴더가 사라졌으면 전체로
  useEffect(() => {
    if (section.kind === 'folder' && folders.length && !folders.some((f) => f.id === section.id)) setSection({ kind: 'all' })
  }, [folders, section])

  const currentFolderId = section.kind === 'folder' ? section.id : null

  const visible = useMemo(() => {
    let list: DocumentMeta[] = section.kind === 'apps' ? [] : section.kind === 'trash' ? trash : docs // 모든 앱에서는 노트를 숨긴다
    if (section.kind !== 'trash') list = list.filter((d) => !d.category || !hiddenCats.has(d.category)) // 숨긴 카테고리는 이 기기에서 미사용
    if (section.kind === 'folder') {
      const f = folders.find((x) => x.id === section.id)
      const cats = new Set(f?.categories ?? [])
      list = list.filter((d) => d.category != null && cats.has(d.category))
    } else if (section.kind === 'category') {
      list = list.filter((d) => d.category === section.name)
    } else if (section.kind === 'uncategorized') {
      list = list.filter((d) => d.category == null) // 카테고리가 아예 없는 노트만 — 매핑 안 된 카테고리는 사이드바의 카테고리 항목으로 보인다
    }
    const q = query.trim().toLowerCase()
    if (q) list = list.filter((d) => d.title.toLowerCase().includes(q))
    const sorted = [...list]
    if (prefs.sort === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title, 'ko'))
    else if (prefs.sort === 'created') sorted.sort((a, b) => b.createdAt - a.createdAt)
    else sorted.sort((a, b) => (section.kind === 'trash' ? (b.deletedAt ?? 0) - (a.deletedAt ?? 0) : b.updatedAt - a.updatedAt))
    return sorted
  }, [docs, trash, folders, hiddenCats, section, query, prefs.sort])

  /** HTML 앱 — 노트와 같은 필터 규칙을 적용한다 (휴지통과 모든 노트에는 표시하지 않는다) */
  const visibleApps = useMemo(() => {
    if (section.kind === 'trash' || section.kind === 'notes') return []
    let list = apps.filter((a) => !a.category || !hiddenCats.has(a.category))
    if (section.kind === 'folder') {
      const cats = new Set(folders.find((x) => x.id === section.id)?.categories ?? [])
      list = list.filter((a) => a.category != null && cats.has(a.category))
    } else if (section.kind === 'category') list = list.filter((a) => a.category === section.name)
    else if (section.kind === 'uncategorized') list = list.filter((a) => a.category == null)
    const q = query.trim().toLowerCase()
    if (q) list = list.filter((a) => a.title.toLowerCase().includes(q))
    return list
  }, [apps, folders, hiddenCats, section, query])

  /** 일반 파일 — 노트와 같은 필터 규칙 (휴지통·모든 노트·모든 앱에는 표시하지 않는다) */
  const visibleFiles = useMemo(() => {
    if (section.kind === 'trash' || section.kind === 'notes' || section.kind === 'apps') return []
    let list = files.filter((f) => !f.category || !hiddenCats.has(f.category))
    if (section.kind === 'folder') {
      const cats = new Set(folders.find((x) => x.id === section.id)?.categories ?? [])
      list = list.filter((f) => f.category != null && cats.has(f.category))
    } else if (section.kind === 'category') list = list.filter((f) => f.category === section.name)
    else if (section.kind === 'uncategorized') list = list.filter((f) => f.category == null)
    const q = query.trim().toLowerCase()
    if (q) list = list.filter((f) => f.title.toLowerCase().includes(q))
    return list
  }, [files, folders, hiddenCats, section, query])

  /** 노트 + 앱 + 파일을 한 목록으로 합쳐 정렬한다 (노트만 있으면 기존 노트 정렬을 그대로 쓴다) */
  const items = useMemo<Item[]>(() => {
    const list: Item[] = [
      ...visible.map((d) => ({ kind: 'doc' as const, d })),
      ...visibleApps.map((a) => ({ kind: 'app' as const, a })),
      ...visibleFiles.map((f) => ({ kind: 'file' as const, f }))
    ]
    if (!visibleApps.length && !visibleFiles.length) return list
    const m = (i: Item) => (i.kind === 'doc' ? i.d : i.kind === 'app' ? i.a : i.f)
    if (prefs.sort === 'title') list.sort((x, y) => m(x).title.localeCompare(m(y).title, 'ko'))
    else if (prefs.sort === 'created') list.sort((x, y) => m(y).createdAt - m(x).createdAt)
    else list.sort((x, y) => m(y).updatedAt - m(x).updatedAt)
    return list
  }, [visible, visibleApps, visibleFiles, prefs.sort])

  const allCategories = useMemo(() => {
    const s = new Set<string>()
    for (const d of docs) if (d.category) s.add(d.category)
    for (const a of apps) if (a.category) s.add(a.category)
    for (const f of files) if (f.category) s.add(f.category)
    for (const f of folders) for (const c of f.categories ?? []) s.add(c)
    return [...s].sort((a, b) => a.localeCompare(b, 'ko'))
  }, [docs, apps, files, folders])

  /** 사이드바에 보일 카테고리 — 숨긴 것은 이 기기에서 미사용 */
  const shownCategories = useMemo(() => allCategories.filter((c) => !hiddenCats.has(c)), [allCategories, hiddenCats])

  // 보고 있던 카테고리가 숨김 처리되면 전체로
  useEffect(() => {
    if (section.kind === 'category' && !shownCategories.includes(section.name)) setSection({ kind: 'all' })
  }, [shownCategories, section])

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
        toast(
          `문서 ${r.documents.length}개를 가져왔습니다${r.skipped ? ` (${r.skipped}개 건너뜀)` : ''}${r.skippedBlocks ? ` — 새 버전에서 만든 블록 ${r.skippedBlocks}개를 가져오지 못했습니다` : ''}.`,
          'success'
        )
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
    const htmls = files.filter((f) => /\.html?$/i.test(f.name) || f.type === 'text/html')
    const rest = files.filter((f) => !pdfs.includes(f) && !inks.includes(f) && !htmls.includes(f))
    if (pdfs.length) await importPdfFiles(pdfs, currentFolderId)
    if (htmls.length) await addAppFiles(htmls)
    for (const f of inks) {
      try {
        await importInkpad(f, currentFolderId)
      } catch (err) {
        toast(err instanceof Error ? err.message : '가져오기 실패', 'error')
      }
    }
    if (rest.length) await addFileItems(rest)
    if (inks.length) await refresh()
  }

  const onNewFolder = async (parentId: ID | null) => {
    const name = await promptDialog('새 폴더', { value: '새 폴더', ok: '만들기' })
    if (!name?.trim()) return
    const f = await createFolder(name.trim(), parentId)
    await refresh()
    setSection({ kind: 'folder', id: f.id })
  }

  // ───────── HTML 앱 ─────────

  /** 카테고리 뷰/폴더 뷰에서 추가하면 그 카테고리를 기본값으로 */
  const defaultCategory = () =>
    section.kind === 'category' ? section.name
    : section.kind === 'folder' ? folders.find((f) => f.id === section.id)?.categories?.[0] ?? null
    : null

  const addAppFiles = async (files: File[]) => {
    let last: HtmlApp | null = null
    let offline = false
    for (const f of files) {
      try {
        setBusy({ text: `${f.name} 추가하는 중` })
        const r = await addApp(f, defaultCategory())
        last = r.app
        if (!r.uploaded) offline = true
      } catch (e) {
        toast(e instanceof Error ? e.message : '앱을 추가하지 못했습니다.', 'error')
      } finally {
        setBusy(null)
      }
    }
    await refresh()
    const lastApp = last
    if (!lastApp) return
    toast(offline ? '앱을 추가했습니다. 클라우드에는 다음 올리기 때 저장됩니다.' : '앱을 추가하고 클라우드에 저장했습니다.', 'success')
    if (files.length === 1) navigate({ name: 'app', appId: lastApp.id })
  }

  const onAddApp = async () => {
    const files = await pickFiles('.html,.htm,text/html', true)
    if (files.length) await addAppFiles(files)
  }

  const appAction = async (action: string, a: HtmlApp) => {
    setAppMenu(null)
    switch (action) {
      case 'run':
        navigate({ name: 'app', appId: a.id })
        return
      case 'rename': {
        const t = await promptDialog('이름 바꾸기', { value: a.title, ok: '저장' })
        if (t?.trim()) await updateAppMeta(a.id, { title: t.trim() })
        break
      }
      case 'category':
        setCategorizingApp(a)
        return
      case 'update': {
        const [f] = await pickFiles('.html,.htm,text/html')
        if (!f) return
        setBusy({ text: `"${a.title}" 업데이트하는 중` })
        try {
          const up = await updateAppHtml(a.id, f)
          toast(up ? `"${a.title}"을(를) 업데이트했습니다.` : '업데이트했습니다. 클라우드에는 다음 올리기 때 저장됩니다.', 'success')
        } catch (e) {
          toast(e instanceof Error ? e.message : '업데이트 실패', 'error')
        } finally {
          setBusy(null)
        }
        break
      }
      case 'export':
        await saveFile(new Blob([a.html], { type: 'text/html' }), `${a.title}.html`)
        return
      case 'delete':
        if (!(await confirmDialog('앱 삭제', { message: `"${a.title}"을(를) 이 기기와 클라우드에서 삭제합니다.`, ok: '삭제', danger: true }))) return
        await deleteApp(a.id)
        toast(`"${a.title}"을(를) 삭제했습니다.`, 'info')
        break
    }
    await refresh()
  }

  // ───────── 일반 파일 ─────────

  /** "파일 추가"가 여는 파일 종류 — PDF·HTML은 기존 경로로, 나머지는 파일로 저장한다 */
  const FILE_ACCEPT =
    '.pdf,.html,.htm,image/*,text/*,.md,.markdown,.csv,.tsv,.json,.jsonc,.xml,.yaml,.yml,.toml,.ini,.log,.txt' +
    ',.js,.mjs,.cjs,.ts,.tsx,.jsx,.py,.rb,.go,.rs,.java,.kt,.c,.h,.cpp,.cs,.php,.sh,.sql,.css,.scss,.vue,.svelte' +
    ',.docx,.xlsx,.pptx,.zip'

  const addFileItems = async (list: File[]) => {
    let last: FileRow | null = null
    let offline = false
    for (const f of list) {
      try {
        setBusy({ text: `${f.name} 추가하는 중` })
        const r = await addFile(f, defaultCategory())
        last = (await getFile(r.file.id)) ?? null
        if (!r.uploaded) offline = true
      } catch (e) {
        toast(e instanceof Error ? e.message : '파일을 추가하지 못했습니다.', 'error')
      } finally {
        setBusy(null)
      }
    }
    await refresh()
    const lastFile = last
    if (!lastFile) return
    toast(offline ? '파일을 추가했습니다. 클라우드에는 다음 올리기 때 저장됩니다.' : '파일을 추가하고 클라우드에 저장했습니다.', 'success')
    if (list.length === 1) navigate({ name: 'file', fileId: lastFile.id })
  }

  /** 형식에 따라 PDF 노트 가져오기 / HTML 앱 / 일반 파일로 나눠 처리한다 */
  const addAnyFiles = async (list: File[]) => {
    const pdfs = list.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf')
    const htmls = list.filter((f) => /\.html?$/i.test(f.name) || f.type === 'text/html')
    const rest = list.filter((f) => !pdfs.includes(f) && !htmls.includes(f))
    if (pdfs.length) await importPdfFiles(pdfs, currentFolderId)
    if (htmls.length) await addAppFiles(htmls)
    if (rest.length) await addFileItems(rest)
  }

  const onAddFile = async () => {
    const list = await pickFiles(FILE_ACCEPT, true)
    if (list.length) await addAnyFiles(list)
  }

  const fileAction = async (action: string, f: FileRow) => {
    setFileMenu(null)
    switch (action) {
      case 'open':
        navigate({ name: 'file', fileId: f.id })
        return
      case 'rename': {
        const t = await promptDialog('이름 바꾸기', { value: f.title, ok: '저장' })
        if (t?.trim()) await updateFileMeta(f.id, { title: t.trim() })
        break
      }
      case 'category':
        setCategorizingFile(f)
        return
      case 'export':
        try {
          await saveFile(await fileToBlob(f), f.name)
        } catch (e) {
          toast(e instanceof Error ? e.message : '내보내기 실패', 'error')
        }
        return
      case 'delete':
        if (!(await confirmDialog('파일 삭제', { message: `"${f.title}"을(를) 이 기기와 클라우드에서 삭제합니다.`, ok: '삭제', danger: true }))) return
        await deleteFile(f.id)
        toast(`"${f.title}"을(를) 삭제했습니다.`, 'info')
        break
    }
    await refresh()
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
      const ok = await confirmDialog(`"${f.name}" 폴더 삭제`, {
        message: '이 폴더의 카테고리 매핑을 없앱니다. 노트는 삭제되지 않고 각 카테고리 메뉴에서 계속 볼 수 있습니다.',
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
        : section.kind === 'category'
          ? section.name
          : section.kind === 'folder'
            ? breadcrumb.at(-1)?.name ?? '폴더'
            : section.kind === 'notes'
              ? '모든 노트'
              : section.kind === 'apps'
                ? '모든 앱'
                : '전체'

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
        <button className="tb-btn sync-btn" onClick={() => setShowSync(true)} aria-label="동기화" title="동기화">
          <Icon name="cloud" />
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
              <Icon name="grid" size={18} /> 전체 <span className="count">{docs.length + apps.length + files.length}</span>
            </button>
            <button className={'tree-item' + (section.kind === 'notes' ? ' is-active' : '')} onClick={() => setSection({ kind: 'notes' })}>
              <Icon name="notebook" size={18} /> 모든 노트 <span className="count">{docs.length}</span>
            </button>
            <button className={'tree-item' + (section.kind === 'apps' ? ' is-active' : '')} onClick={() => setSection({ kind: 'apps' })}>
              <Icon name="app" size={18} /> 모든 앱 <span className="count">{apps.length}</span>
            </button>
            <div className="tree-label">카테고리</div>
            {shownCategories.map((c) => (
              <button
                key={c}
                className={'tree-item' + (section.kind === 'category' && section.name === c ? ' is-active' : '')}
                onClick={() => setSection({ kind: 'category', name: c })}
              >
                <Icon name="tag" size={18} /> <span className="tree-name">{c}</span>
                <span className="count">{docs.filter((d) => d.category === c).length + apps.filter((a) => a.category === c).length + files.filter((f) => f.category === c).length}</span>
              </button>
            ))}
            <button
              className={'tree-item' + (section.kind === 'uncategorized' ? ' is-active' : '')}
              onClick={() => setSection({ kind: 'uncategorized' })}
            >
              <Icon name="tag" size={18} /> <span className="tree-name">미분류</span>
              <span className="count">{docs.filter((d) => d.category == null).length + apps.filter((a) => a.category == null).length + files.filter((f) => f.category == null).length}</span>
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
              apps={apps}
              files={files}
              onSelect={(id) => setSection({ kind: 'folder', id })}
              onMenu={(folder, x, y) => setFolderMenu({ folder, x, y })}
            />
            <button className={'tree-item trash' + (section.kind === 'trash' ? ' is-active' : '')} onClick={() => setSection({ kind: 'trash' })}>
              <Icon name="trash" size={18} /> 휴지통 <span className="count">{trash.length}</span>
            </button>
          </nav>
        )}

        <main className="library-main">
          {section.kind === 'folder' && (
            <nav className="breadcrumb" aria-label="경로">
              <button onClick={() => setSection({ kind: 'all' })}>전체</button>
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

          {items.length === 0 ? (
            <div className="empty-state">
              {section.kind === 'trash' ? (
                <p>휴지통이 비어 있습니다.</p>
              ) : section.kind === 'apps' ? (
                <>
                  <Icon name="app" size={48} />
                  <p>아직 앱이 없습니다.</p>
                  <div className="btn-row center">
                    <button className="text-btn" onClick={() => void onAddApp()}>
                      <Icon name="plus" size={18} /> 앱 추가
                    </button>
                  </div>
                </>
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
              {items.map((i) =>
                i.kind === 'app' ? (
                  <article key={'app:' + i.a.id} className="doc-card app-card" onClick={() => navigate({ name: 'app', appId: i.a.id })}>
                    <div className="doc-thumb">
                      <Icon name="app" size={36} />
                      <span className="doc-badge">HTML 앱</span>
                      {i.a.category && <span className="doc-cat">{i.a.category}</span>}
                      {i.a.pending && <span className="app-pending" title="클라우드 저장 대기" />}
                    </div>
                    <div className="doc-info">
                      <h3 className="doc-title">{i.a.title}</h3>
                      <p className="doc-date">{formatDate(i.a.updatedAt)}</p>
                    </div>
                    <button
                      className="doc-more"
                      aria-label="더보기"
                      onClick={(e) => {
                        e.stopPropagation()
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        setAppMenu({ app: i.a, x: r.right, y: r.bottom })
                      }}
                    >
                      <Icon name="more" size={20} />
                    </button>
                  </article>
                ) : i.kind === 'file' ? (
                  <article key={'file:' + i.f.id} className="doc-card file-card" onClick={() => navigate({ name: 'file', fileId: i.f.id })}>
                    <div className="doc-thumb">
                      <Icon name="file" size={36} />
                      <span className="doc-badge">{extOf(i.f.name).toUpperCase() || '파일'}</span>
                      {i.f.category && <span className="doc-cat">{i.f.category}</span>}
                      {i.f.pending && <span className="app-pending" title="클라우드 저장 대기" />}
                    </div>
                    <div className="doc-info">
                      <h3 className="doc-title">{i.f.title}</h3>
                      <p className="doc-date">{formatDate(i.f.updatedAt)}</p>
                    </div>
                    <button
                      className="doc-more"
                      aria-label="더보기"
                      onClick={(e) => {
                        e.stopPropagation()
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        setFileMenu({ file: i.f, x: r.right, y: r.bottom })
                      }}
                    >
                      <Icon name="more" size={20} />
                    </button>
                  </article>
                ) : (
                  <article
                    key={i.d.id}
                    className="doc-card"
                    data-doc-id={i.d.id}
                    onClick={() => (section.kind === 'trash' ? setMenu({ doc: i.d, x: 0, y: 0 }) : open(i.d))}
                  >
                    <div className="doc-thumb">
                      {thumbs.get(i.d.id) ? (
                        <img src={thumbs.get(i.d.id)} alt="" draggable={false} />
                      ) : (
                        <Icon name={i.d.mode === 'infinite' ? 'infinite' : 'page'} size={36} />
                      )}
                      <span className="doc-badge">{i.d.mode === 'infinite' ? '무한' : `${i.d.pageOrder.length}쪽`}</span>
                      {i.d.category && <span className="doc-cat">{i.d.category}</span>}
                    </div>
                    <div className="doc-info">
                      <h3 className="doc-title">{i.d.title}</h3>
                      <p className="doc-date">
                        {i.d.category && <span className="doc-cat-text">{i.d.category}</span>}
                        {section.kind === 'trash' && i.d.deletedAt ? `삭제 ${formatDate(i.d.deletedAt)}` : formatDate(i.d.updatedAt)}
                      </p>
                    </div>
                    <button
                      className="doc-more"
                      aria-label="더보기"
                      onClick={(e) => {
                        e.stopPropagation()
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        setMenu({ doc: i.d, x: r.right, y: r.bottom })
                      }}
                    >
                      <Icon name="more" size={20} />
                    </button>
                  </article>
                )
              )}
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

      {appMenu && (
        <Menu x={appMenu.x} y={appMenu.y} onClose={() => setAppMenu(null)}>
          <MenuItem icon="play" label="실행" onClick={() => appAction('run', appMenu.app)} />
          <MenuItem icon="upload" label="업데이트 (새 HTML 올리기)" onClick={() => appAction('update', appMenu.app)} />
          <MenuItem icon="edit" label="이름 바꾸기" onClick={() => appAction('rename', appMenu.app)} />
          <MenuItem icon="tag" label="카테고리 지정" onClick={() => appAction('category', appMenu.app)} />
          <MenuItem icon="download" label=".html로 내보내기" onClick={() => appAction('export', appMenu.app)} />
          <MenuItem icon="trash" label="삭제" danger onClick={() => appAction('delete', appMenu.app)} />
        </Menu>
      )}

      {fileMenu && (
        <Menu x={fileMenu.x} y={fileMenu.y} onClose={() => setFileMenu(null)}>
          <MenuItem icon="play" label="열기" onClick={() => fileAction('open', fileMenu.file)} />
          <MenuItem icon="edit" label="이름 바꾸기" onClick={() => fileAction('rename', fileMenu.file)} />
          <MenuItem icon="tag" label="카테고리 지정" onClick={() => fileAction('category', fileMenu.file)} />
          <MenuItem icon="download" label="내보내기" onClick={() => fileAction('export', fileMenu.file)} />
          <MenuItem icon="trash" label="삭제" danger onClick={() => fileAction('delete', fileMenu.file)} />
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

      {categorizingApp && (
        <CategoryPicker
          current={categorizingApp.category ?? null}
          categories={allCategories}
          onClose={() => setCategorizingApp(null)}
          onPick={async (cat) => {
            await updateAppMeta(categorizingApp.id, { category: cat })
            setCategorizingApp(null)
            await refresh()
          }}
        />
      )}

      {categorizingFile && (
        <CategoryPicker
          current={categorizingFile.category ?? null}
          categories={allCategories}
          onClose={() => setCategorizingFile(null)}
          onPick={async (cat) => {
            await updateFileMeta(categorizingFile.id, { category: cat })
            setCategorizingFile(null)
            await refresh()
          }}
        />
      )}

      {showNew && (
        <NewDocumentSheet
          folderId={currentFolderId}
          category={section.kind === 'category' ? section.name : undefined}
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
          onAddApp={() => {
            setShowNew(false)
            void onAddApp()
          }}
          onAddFile={() => {
            setShowNew(false)
            void onAddFile()
          }}
        />
      )}
      {showSettings && <LibrarySettings onClose={() => setShowSettings(false)} onChanged={refresh} />}
      {showSync && <SyncSheet onClose={() => setShowSync(false)} />}
    </div>
  )
}

function FolderTree(props: {
  folders: Folder[]
  parentId: ID | null
  depth: number
  activeId: ID | null
  docs: DocumentMeta[]
  apps: HtmlApp[]
  files: FileRow[]
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
              <span className="count">
                {props.docs.filter((d) => d.category && (f.categories ?? []).includes(d.category)).length +
                  props.apps.filter((a) => a.category && (f.categories ?? []).includes(a.category)).length +
                  props.files.filter((x) => x.category && (f.categories ?? []).includes(x.category)).length}
              </span>
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
        <div className="cat-new-row">
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
