import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useUI } from '../../app/store'
import { useIndicator } from '../motion/useIndicator'
import { useFlip } from '../motion/useFlip'
import { settle } from '../motion/settle'
import { CountUp } from '../motion/CountUp'
import { SPRING, dur, motionLevel } from '../motion/motion'
import { Icon } from '../Icon'
import { askPdfPassword, confirmDialog, promptDialog } from '../../app/dialogs'
import { NewDocumentSheet } from './NewDocumentSheet'
import { LibrarySettings } from './LibrarySettings'
import { SyncSheet } from '../SyncSection'
import { AppsSheet } from '../AppsSheet'
import { FilesSheet } from '../FilesSheet'
import { AssetsSheet } from '../AssetsSheet'
import type { DocumentMeta, Folder, HtmlApp, ID } from '../../shared/model'
import { MAX_CATEGORY_CHARS, TRASH_RETENTION_DAYS, extOf, normalizeCategory } from '../../shared/model'
import { categoryColor, categoryTag, formatDate } from '../../shared/util'
import { loadRecentDocs } from '../../shared/recentDocs'
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
import { CLOUD_STATES_EVENT, REMOTE_EVENT, cardSyncStates, onSyncStatus, pushOneNote, type CardSyncState } from '../../sync/sync'
import { APPS_EVENT, addApp, listApps, uninstallApp, updateAppHtml, updateAppMeta } from '../../sync/apps'
import { FILES_EVENT, addFile, fileToBlob, getFile, listFiles, removeFileLocal, updateFileMeta } from '../../sync/files'
import { confirmTransfer, uploadChoice } from '../../sync/transfer'
import type { FileRow } from '../../storage/db'

type Section =
  | { kind: 'all' }
  | { kind: 'notes' }
  | { kind: 'apps' }
  | { kind: 'files' }
  | { kind: 'category'; name: string }
  | { kind: 'folder'; id: ID }
  | { kind: 'uncategorized' }
  | { kind: 'trash' }

type Item = { kind: 'doc'; d: DocumentMeta } | { kind: 'app'; a: HtmlApp } | { kind: 'file'; f: FileRow }

/**
 * 카드 캡션의 동기화 상태 라벨 (변경안 A).
 * 8px 색 점은 색만으로 뜻을 전달해 색각 이상 사용자에게 닿지 않는다 — 말로 바꾼다.
 * 클라우드 없음 / 올리기 대기 / 최신 / 클라우드에 새 버전.
 */
const SYNC_LABEL: Record<CardSyncState, string> = {
  new: '클라우드 없음',
  pending: '올리기 필요',
  same: '동기화됨',
  'remote-new': '새 버전'
}

/** 앱·파일 행의 점 상태 — 행의 pending·fileId 표식만으로 판정한다 (노트와 같은 색 체계) */
const rowSyncState = (r: { fileId?: string; pending?: 'upsert' | 'delete'; cloudDetachedAt?: number }): CardSyncState =>
  r.pending ? 'pending' : r.fileId && !r.cloudDetachedAt ? 'same' : 'new'

/** 점 + 라벨 pill (명세 5.5). 상태가 바뀌면 pop 한다. */
function SyncPill({ state, overlay }: { state: CardSyncState; overlay?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  const prev = useRef(state)
  useEffect(() => {
    if (prev.current !== state && ref.current && document.documentElement.dataset.motion !== 'off') {
      ref.current.animate([{ scale: '0.7' }, { scale: '1.08' }, { scale: '1' }], { duration: dur(450), easing: SPRING })
    }
    prev.current = state
  }, [state])
  return (
    <span ref={ref} className={'doc-state s-' + state + (overlay ? ' is-overlay' : '')}>
      <i className="doc-state-dot" aria-hidden="true" />
      {SYNC_LABEL[state]}
    </span>
  )
}

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
  const [syncStates, setSyncStates] = useState<Map<ID, CardSyncState>>(new Map())
  const [query, setQuery] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showSync, setShowSync] = useState(false)
  const [showApps, setShowApps] = useState(false)
  const [showFiles, setShowFiles] = useState(false)
  const [showAssets, setShowAssets] = useState(false)
  const [menu, setMenu] = useState<{ doc: DocumentMeta; x: number; y: number } | null>(null)
  const [folderMenu, setFolderMenu] = useState<{ folder: Folder; x: number; y: number } | null>(null)
  const [categorizing, setCategorizing] = useState<DocumentMeta | null>(null)
  const [appMenu, setAppMenu] = useState<{ app: HtmlApp; x: number; y: number } | null>(null)
  const [categorizingApp, setCategorizingApp] = useState<HtmlApp | null>(null)
  const [fileMenu, setFileMenu] = useState<{ file: FileRow; x: number; y: number } | null>(null)
  const [categorizingFile, setCategorizingFile] = useState<FileRow | null>(null)
  const [hiddenCats, setHiddenCats] = useState<Set<string>>(new Set())
  const [ready, setReady] = useState(false) // 첫 데이터 로드가 끝났는지 — 복원한 섹션 가드가 빈 목록으로 판정하지 않게 한다
  const [treeOpen, setTreeOpen] = useState(() => window.innerWidth >= 900)
  // 사이드바 선택 항목 슬라이딩 인디케이터 (5.2, 세로)
  const treeRef = useRef<HTMLElement>(null)
  const treeActiveKey =
    section.kind === 'category' ? `cat:${section.name}` : section.kind === 'folder' ? `folder:${section.id}` : section.kind
  useIndicator(treeRef, treeOpen ? treeActiveKey : null, 'y')
  // '전체'를 눌러 있던 상태에서 한 번 더 누르면 최근 열람한 노트만 보여 준다
  const [recent, setRecent] = useState(() => loadRecentDocs())
  const [recentOnly, setRecentOnly] = useState(false)
  // 검색어 디바운스 — FLIP 트리거(120ms). 메모(useMemo)들이 렌더 중 이 값을 읽으므로 반드시 위쪽에서 선언한다
  const [dq, setDq] = useState('')
  const recentActive = section.kind === 'all' && recentOnly

  useEffect(() => sessionStorage.setItem('inkpad.section', JSON.stringify(section)), [section])

  // '전체'가 아닌 다른 항목을 고르면 최근 열람 모드를 끈다
  useEffect(() => {
    if (section.kind !== 'all') setRecentOnly(false)
  }, [section])

  const refresh = useCallback(async () => {
    const [d, t, f, th, hid, ap, fls, st] = await Promise.all([listDocuments(), listDocuments({ trash: true }), listFolders(), getThumbnails(), getHiddenCategories(), listApps(), listFiles(), cardSyncStates()])
    setDocs(d)
    setTrash(t)
    setFolders(f)
    setHiddenCats(new Set(hid))
    setApps(ap)
    setFiles(fls)
    setSyncStates(st)
    setThumbs((old) => {
      old.forEach((url) => URL.revokeObjectURL(url))
      const m = new Map<ID, string>()
      th.forEach((blob, id) => m.set(id, URL.createObjectURL(blob)))
      return m
    })
    setReady(true)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 다른 기기에서 받아온 변경 반영 (SDF 가이드 8장 3)
  useEffect(() => {
    const onRemote = () => void refresh()
    window.addEventListener(REMOTE_EVENT, onRemote)
    window.addEventListener(CLOUD_STATES_EVENT, onRemote) // 동기화창에서 클라우드 목록을 새로고침하면 점도 다시 계산
    return () => {
      window.removeEventListener(REMOTE_EVENT, onRemote)
      window.removeEventListener(CLOUD_STATES_EVENT, onRemote)
    }
  }, [refresh])

  // 모바일: 사이드바에서 항목을 고르면 서랍을 닫아 결과를 가리지 않게 한다
  useEffect(() => {
    if (window.innerWidth < 900) setTreeOpen(false)
  }, [section])

  /** 노트 카드 좌측 하단에 얹는 동기화 라벨 (그리드 전용) */
  const syncPillFor = (id: ID) => {
    const s = syncStates.get(id)
    return s ? <SyncPill state={s} overlay /> : null
  }
  /** 캡션 안에 들어가는 동기화 라벨 (리스트 전용) */
  const syncLabelFor = (id: ID) => {
    const s = syncStates.get(id)
    return s ? <SyncPill state={s} /> : null
  }

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

  /** 최근 열람한 노트 — 열람 순서(최신이 먼저)를 그대로 유지한다 */
  const recentDocs = useMemo(() => {
    const order = new Map(recent.map((r, i) => [r.id, i] as const))
    return docs
      .filter((d) => order.has(d.id) && (!d.category || !hiddenCats.has(d.category)))
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  }, [docs, recent, hiddenCats])

  /** '전체' 버튼 — 눌러 있던 상태에서 한 번 더 누르면 최근 열람 모드를 토글한다 */
  const onAllClick = () => {
    if (section.kind === 'all') {
      setRecentOnly((v) => !v)
      setRecent(loadRecentDocs()) // 노트를 열었다 돌아온 사이 늘어난 기록을 반영
    } else {
      setSection({ kind: 'all' })
      setRecentOnly(false)
    }
  }

  const visible = useMemo(() => {
    if (recentActive) {
      const q = dq.trim().toLowerCase()
      return q ? recentDocs.filter((d) => d.title.toLowerCase().includes(q)) : recentDocs // 최근 열람 모드
    }
    let list: DocumentMeta[] = section.kind === 'apps' || section.kind === 'files' ? [] : section.kind === 'trash' ? trash : docs // 모든 앱·기타 파일에서는 노트를 숨긴다
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
    const q = dq.trim().toLowerCase()
    if (q) list = list.filter((d) => d.title.toLowerCase().includes(q))
    const sorted = [...list]
    if (prefs.sort === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title, 'ko'))
    else if (prefs.sort === 'created') sorted.sort((a, b) => b.createdAt - a.createdAt)
    else sorted.sort((a, b) => (section.kind === 'trash' ? (b.deletedAt ?? 0) - (a.deletedAt ?? 0) : b.updatedAt - a.updatedAt))
    return sorted
  }, [recentActive, recentDocs, docs, trash, folders, hiddenCats, section, query, prefs.sort])

  /** HTML 앱 — 노트와 같은 필터 규칙을 적용한다 (휴지통·모든 노트·기타 파일에는 표시하지 않는다) */
  const visibleApps = useMemo(() => {
    if (recentActive || section.kind === 'trash' || section.kind === 'notes' || section.kind === 'files') return []
    let list = apps.filter((a) => !a.category || !hiddenCats.has(a.category))
    if (section.kind === 'folder') {
      const cats = new Set(folders.find((x) => x.id === section.id)?.categories ?? [])
      list = list.filter((a) => a.category != null && cats.has(a.category))
    } else if (section.kind === 'category') list = list.filter((a) => a.category === section.name)
    else if (section.kind === 'uncategorized') list = list.filter((a) => a.category == null)
    const q = dq.trim().toLowerCase()
    if (q) list = list.filter((a) => a.title.toLowerCase().includes(q))
    return list
  }, [recentActive, apps, folders, hiddenCats, section, query])

  /** 일반 파일 — 노트와 같은 필터 규칙 (휴지통·모든 노트·모든 앱에는 표시하지 않는다) */
  const visibleFiles = useMemo(() => {
    if (recentActive || section.kind === 'trash' || section.kind === 'notes' || section.kind === 'apps') return []
    let list = files.filter((f) => !f.category || !hiddenCats.has(f.category))
    if (section.kind === 'folder') {
      const cats = new Set(folders.find((x) => x.id === section.id)?.categories ?? [])
      list = list.filter((f) => f.category != null && cats.has(f.category))
    } else if (section.kind === 'category') list = list.filter((f) => f.category === section.name)
    else if (section.kind === 'uncategorized') list = list.filter((f) => f.category == null)
    const q = dq.trim().toLowerCase()
    if (q) list = list.filter((f) => f.title.toLowerCase().includes(q))
    return list
  }, [recentActive, files, folders, hiddenCats, section, query])

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

  // 보고 있던 카테고리가 숨김 처리되면 전체로 — 데이터를 다 읽기 전(복원 직후)에는 빈 목록으로 판정하지 않는다
  useEffect(() => {
    if (!ready) return
    if (section.kind === 'category' && !shownCategories.includes(section.name)) setSection({ kind: 'all' })
  }, [ready, shownCategories, section])

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

  // ───────── 인터랙티브 모션 (MOTION_SPEC) ─────────
  const gridRef = useRef<HTMLElement>(null)
  const thumbsRef = useRef<Map<ID, string>>(thumbs)
  const seenReveal = useRef<Set<string>>(new Set())
  const enteredRef = useRef(false)
  const tiltLast = useRef<HTMLElement | null>(null)
  const tiltRaf = useRef(0)
  const prevSync = useRef<Map<ID, CardSyncState>>(new Map())
  const [enter, setEnter] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const settleDoc = useCallback(
    (id: ID) =>
      requestAnimationFrame(() => settle(document.querySelector<HTMLElement>(`[data-doc-id="${CSS.escape(id)}"]`))),
    []
  )

  useEffect(() => {
    thumbsRef.current = thumbs
  }, [thumbs])

  // 검색어 120ms 디바운스 (명세 5.4)
  useEffect(() => {
    const t = setTimeout(() => setDq(query), 120)
    return () => clearTimeout(t)
  }, [query])

  // 최초 마운트 시 1회 카드 등장 (5.3-1) — rich에서만 지연을 준다
  useEffect(() => {
    if (!ready || enteredRef.current) return
    enteredRef.current = true
    setEnter(true)
    const t = setTimeout(() => setEnter(false), 900)
    return () => clearTimeout(t)
  }, [ready])

  // 썸네일 리빌 (5.3-2) — 처음 보일 때 1회, 이번 세션에 본 문서는 다시 재생하지 않는다
  useEffect(() => {
    const root = gridRef.current
    if (!root) return
    const imgs = [...root.querySelectorAll<HTMLImageElement>('img[data-reveal]')]
    if (!imgs.length) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue
          const img = en.target as HTMLImageElement
          io.unobserve(img)
          const id = img.dataset.reveal!
          if (seenReveal.current.has(id)) img.classList.add('no-anim')
          seenReveal.current.add(id)
          img.classList.add('is-revealed')
        }
      },
      { threshold: 0.1 }
    )
    imgs.forEach((im) => io.observe(im))
    return () => io.disconnect()
  }, [items, prefs.view])

  // 동기화 버튼 회전 (5.5)
  useEffect(() => onSyncStatus((s) => setSyncing(s === 'syncing')), [])

  // 동기화가 끝나 '최신'이 된 카드에 settle (5.3-5)
  useEffect(() => {
    const prev = prevSync.current
    syncStates.forEach((s, id) => {
      if (s === 'same' && prev.get(id) && prev.get(id) !== 'same') settleDoc(id)
    })
    prevSync.current = new Map(syncStates)
  }, [syncStates, settleDoc])

  // 편집 화면에서 복귀: 고스트를 카드로 축소하고 settle (5.6 닫기)
  useEffect(() => {
    if (!ready) return
    const rid = useUI.getState().returnDocId
    if (!rid) return
    useUI.setState({ returnDocId: null })
    requestAnimationFrame(() => {
      const card = document.querySelector<HTMLElement>(`[data-doc-id="${CSS.escape(rid)}"]`)
      if (!card) return
      if (document.documentElement.dataset.motion === 'off') return settle(card)
      const r = card.getBoundingClientRect()
      if (r.bottom < 0 || r.top > window.innerHeight) return settle(card) // 화면 밖이면 강제 스크롤 없이 settle만
      const ghost = document.createElement('div')
      ghost.className = 'doc-return-ghost'
      const url = thumbsRef.current.get(rid)
      if (url) ghost.style.backgroundImage = `url(${url})`
      Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
      document.body.appendChild(ghost)
      const anim = ghost.animate(
        [
          { transform: `scale(${Math.max(1, window.innerWidth / r.width)})`, opacity: 0.4 },
          { transform: 'none', opacity: 1 }
        ],
        { duration: dur(480), easing: SPRING, fill: 'both' }
      )
      const done = () => {
        ghost.remove()
        settle(card)
      }
      anim.addEventListener('finish', done, { once: true })
      anim.addEventListener('cancel', () => ghost.remove(), { once: true })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  // 목록 변화 FLIP (5.4)
  const flipSig = items.map((i) => (i.kind === 'doc' ? i.d.id : i.kind === 'app' ? i.a.id : i.f.id)).join('|')
  useFlip(gridRef, [treeActiveKey, dq, prefs.sort, prefs.view, flipSig], treeActiveKey)

  // 틸트 + 광택 (5.3-3) — mouse/pen hover에서만, 목록 보기·모션 끄기에서는 안 함
  const onGridMove = (e: React.PointerEvent) => {
    if (prefs.view === 'list' || e.pointerType === 'touch') return
    const lvl = motionLevel()
    if (lvl === 'off') return
    const card = (e.target as HTMLElement).closest<HTMLElement>('.doc-card')
    if (!card || tiltRaf.current) return
    const cx = e.clientX
    const cy = e.clientY
    tiltRaf.current = requestAnimationFrame(() => {
      tiltRaf.current = 0
      if (tiltLast.current && tiltLast.current !== card) {
        tiltLast.current.classList.remove('is-tilt')
        tiltLast.current.style.transform = ''
      }
      tiltLast.current = card
      const r = card.getBoundingClientRect()
      const px = (cx - r.left) / r.width
      const py = (cy - r.top) / r.height
      const angle = lvl === 'rich' ? 8 : 3
      card.style.transform = `perspective(700px) rotateX(${-(py - 0.5) * 2 * angle}deg) rotateY(${(px - 0.5) * 2 * angle}deg)`
      card.style.setProperty('--gx', `${px * 100}%`)
      card.style.setProperty('--gy', `${py * 100}%`)
      card.classList.add('is-tilt')
    })
  }
  const onGridLeave = () => {
    if (tiltRaf.current) {
      cancelAnimationFrame(tiltRaf.current)
      tiltRaf.current = 0
    }
    const el = tiltLast.current
    if (el) {
      el.classList.remove('is-tilt')
      el.style.transform = ''
      tiltLast.current = null
    }
  }

  // ───────── 작업 ─────────

  /** 노트 열기 — 누른 카드의 화면 위치를 기억해 편집 화면이 그 카드에서 확대되듯 열리게 한다 */
  const open = (d: DocumentMeta, card?: HTMLElement | null) => {
    useUI.setState({ docCardRect: card?.getBoundingClientRect() ?? null })
    navigate({ name: 'editor', docId: d.id })
  }

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
      case 'remove': {
        const warn = a.pending ? '클라우드에 없는 변경이 사라집니다. ' : ''
        if (!(await confirmDialog('이 기기에서 제거', { message: `${warn}"${a.title}"을(를) 이 기기에서만 제거합니다. 클라우드 사본은 남습니다.`, ok: '제거', danger: true }))) return
        await uninstallApp(a.id)
        toast(`"${a.title}"을(를) 이 기기에서 제거했습니다.`, 'info')
        break
      }
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
    const total = list.reduce((n, f) => n + f.size, 0)
    // 추가하기 전에 3버튼 확인 (명세 11.4) — 이 기기에만 추가 / 업로드 / 취소
    const choice = await uploadChoice(total, list.length)
    if (choice === 'cancel') return
    const upload = choice === 'upload'
    let last: FileRow | null = null
    let offline = false
    for (const f of list) {
      try {
        setBusy({ text: `${f.name} 추가하는 중` })
        const r = await addFile(f, defaultCategory(), { upload })
        last = (await getFile(r.file.id)) ?? null
        if (upload && !r.uploaded) offline = true
      } catch (e) {
        toast(e instanceof Error ? e.message : '파일을 추가하지 못했습니다.', 'error')
      } finally {
        setBusy(null)
      }
    }
    await refresh()
    const lastFile = last
    if (!lastFile) return
    if (!upload) toast('이 기기에 추가했습니다. 업로드하려면 목록에서 재업로드를 눌러 주세요.', 'info')
    else
      toast(
        offline ? '오프라인이라 업로드하지 못했습니다. 연결된 뒤 목록에서 재업로드를 눌러 주세요.' : '파일을 추가하고 클라우드에 업로드했습니다.',
        offline ? 'error' : 'success'
      )
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
          // 원본이 이 기기에 없으면 내보내기가 다운로드를 일으킨다 — 기준 이상이면 먼저 묻는다 (11.3)
          const hasOrig = f.text !== undefined || !!f.blob
          if (!hasOrig && !(await confirmTransfer('down', f.size))) return
          await saveFile(await fileToBlob(f), f.name)
        } catch (e) {
          toast(e instanceof Error ? e.message : '내보내기 실패', 'error')
        }
        return
      case 'remove': {
        const warn = f.pending ? '클라우드에 없는 변경이 사라집니다. ' : ''
        if (!(await confirmDialog('이 기기에서 제거', { message: `${warn}"${f.title}"을(를) 이 기기에서만 제거합니다. 클라우드 사본은 남습니다.`, ok: '제거', danger: true }))) return
        await removeFileLocal(f.id)
        toast(`"${f.title}"을(를) 이 기기에서 제거했습니다.`, 'info')
        break
      }
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
          void refresh() // 올리기가 끝나면 카드의 동기화 상태 점을 다시 계산한다
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
        await refresh()
        settleDoc(d.id)
        return
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

  const title = recentActive
    ? '최근 열람한 노트'
    : section.kind === 'trash'
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
                : section.kind === 'files'
                  ? '기타 파일'
                  : '전체'

  return (
    <div className="library" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="library-header">
        <button className="tb-btn" onClick={() => setTreeOpen((v) => !v)} aria-label="폴더 목록">
          <Icon name="sidebar" />
        </button>
        <h1 key={title} className="library-title">{title}</h1>
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
        <button className={'tb-btn sync-btn' + (syncing ? ' is-syncing' : '')} onClick={() => setShowSync(true)} aria-label="동기화" title="동기화">
          <Icon name="cloud" />
        </button>
        <button className="tb-btn" onClick={() => setShowAssets(true)} aria-label="에셋 원본" title="에셋 원본 (PDF·이미지)">
          <Icon name="filePdf" />
        </button>
        <button className="tb-btn" onClick={() => setShowApps(true)} aria-label="앱" title="앱">
          <Icon name="apps" />
        </button>
        <button className="tb-btn" onClick={() => setShowFiles(true)} aria-label="기타 파일" title="기타 파일">
          <Icon name="files" />
        </button>
        {section.kind !== 'trash' && (
          <button id="new-doc-btn" className="primary-btn" onClick={() => setShowNew(true)}>
            <Icon name="plus" size={18} /> 새로 만들기
          </button>
        )}
      </header>

      <div className="library-body">
        {treeOpen && <div className="tree-backdrop" role="presentation" onClick={() => setTreeOpen(false)} />}
        {treeOpen && (
          <nav className="folder-tree" aria-label="폴더" ref={treeRef}>
            <button
              data-indicator-key="all"
              className={'tree-item' + (section.kind === 'all' ? ' is-active' : '')}
              onClick={onAllClick}
              title="다시 누르면 최근에 열어 본 노트"
            >
              <Icon name={recentActive ? 'restore' : 'grid'} size={18} /> {recentActive ? '최근 열람' : '전체'}{' '}
              <span className="count">
                {recentActive ? recentDocs.length : <CountUp value={docs.length + apps.length + files.length} />}
              </span>
            </button>
            <button data-indicator-key="notes" className={'tree-item' + (section.kind === 'notes' ? ' is-active' : '')} onClick={() => setSection({ kind: 'notes' })}>
              <Icon name="notebook" size={18} /> 모든 노트 <span className="count"><CountUp value={docs.length} /></span>
            </button>
            <button data-indicator-key="apps" className={'tree-item' + (section.kind === 'apps' ? ' is-active' : '')} onClick={() => setSection({ kind: 'apps' })}>
              <Icon name="app" size={18} /> 모든 앱 <span className="count"><CountUp value={apps.length} /></span>
            </button>
            <button data-indicator-key="files" className={'tree-item' + (section.kind === 'files' ? ' is-active' : '')} onClick={() => setSection({ kind: 'files' })}>
              <Icon name="file" size={18} /> 기타 파일 <span className="count"><CountUp value={files.length} /></span>
            </button>
            <div className="tree-label">카테고리</div>
            {shownCategories.map((c) => (
              <button
                key={c}
                data-indicator-key={'cat:' + c}
                className={'tree-item' + (section.kind === 'category' && section.name === c ? ' is-active' : '')}
                onClick={() => setSection({ kind: 'category', name: c })}
              >
                <span className="tree-cat-dot" style={{ background: categoryColor(c) }} aria-hidden="true" />
                <span className="tree-name">{c}</span>
                <span className="count">{docs.filter((d) => d.category === c).length + apps.filter((a) => a.category === c).length + files.filter((f) => f.category === c).length}</span>
              </button>
            ))}
            <button
              data-indicator-key="uncategorized"
              className={'tree-item' + (section.kind === 'uncategorized' ? ' is-active' : '')}
              onClick={() => setSection({ kind: 'uncategorized' })}
            >
              <span className="tree-cat-dot" style={{ background: categoryColor(null) }} aria-hidden="true" />
              <span className="tree-name">미분류</span>
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
            <button data-indicator-key="trash" className={'tree-item trash' + (section.kind === 'trash' ? ' is-active' : '')} onClick={() => setSection({ kind: 'trash' })}>
              <Icon name="trash" size={18} /> 휴지통 <span className="count"><CountUp value={trash.length} /></span>
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
              {recentActive ? (
                <p>최근에 열람한 노트가 없습니다. 노트를 열면 여기에 표시됩니다.</p>
              ) : section.kind === 'trash' ? (
                <p>휴지통이 비어 있습니다.</p>
              ) : section.kind === 'apps' ? (
                <>
                  <Icon name="app" size={48} />
                  <p>아직 앱이 없습니다.</p>
                  <div className="btn-row center">
                    <button className="text-btn" onClick={() => setShowApps(true)}>
                      <Icon name="apps" size={18} /> 앱 메뉴에서 설치하기
                    </button>
                    <button className="text-btn" onClick={() => void onAddApp()}>
                      <Icon name="plus" size={18} /> 앱 추가
                    </button>
                  </div>
                </>
              ) : section.kind === 'files' ? (
                <>
                  <Icon name="file" size={48} />
                  <p>아직 파일이 없습니다.</p>
                  <div className="btn-row center">
                    <button className="text-btn" onClick={() => void onAddFile()}>
                      <Icon name="plus" size={18} /> 파일 추가
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
            <section
              ref={gridRef}
              className={prefs.view === 'grid' ? 'doc-grid' : 'doc-list'}
              data-enter={enter ? '' : undefined}
              aria-label="문서"
              onPointerMove={onGridMove}
              onPointerLeave={onGridLeave}
            >
              {items.map((i, idx) =>
                i.kind === 'app' ? (
                  <article
                    key={'app:' + i.a.id}
                    className="doc-card app-card"
                    data-flip-key={'app:' + i.a.id}
                    style={idx < 20 ? ({ ['--i' as string]: idx } as React.CSSProperties) : undefined}
                    onClick={() => navigate({ name: 'app', appId: i.a.id })}
                  >
                    <div className="doc-thumb">
                      {i.a.category && (
                        <span className="doc-tag" style={categoryTag(i.a.category)}>{i.a.category}</span>
                      )}
                      <Icon name="app" size={36} />
                      <SyncPill state={rowSyncState(i.a)} overlay />
                    </div>
                    <div className="doc-info">
                      <h3 className="doc-title">{i.a.title}</h3>
                      <div className="doc-foot">
                        <p className="doc-meta">
                          {i.a.category && <span className="doc-cat-text" style={categoryTag(i.a.category)}>{i.a.category}</span>}
                          <span className="doc-meta-date">HTML 앱 · {formatDate(i.a.updatedAt)}</span>
                        </p>
                        <SyncPill state={rowSyncState(i.a)} />
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
                      </div>
                    </div>
                  </article>
                ) : i.kind === 'file' ? (
                  <article
                    key={'file:' + i.f.id}
                    className="doc-card file-card"
                    data-flip-key={'file:' + i.f.id}
                    style={idx < 20 ? ({ ['--i' as string]: idx } as React.CSSProperties) : undefined}
                    onClick={() => navigate({ name: 'file', fileId: i.f.id })}
                  >
                    <div className="doc-thumb">
                      {i.f.category && (
                        <span className="doc-tag" style={categoryTag(i.f.category)}>{i.f.category}</span>
                      )}
                      <Icon name="file" size={36} />
                      <SyncPill state={rowSyncState(i.f)} overlay />
                    </div>
                    <div className="doc-info">
                      <h3 className="doc-title">{i.f.title}</h3>
                      <div className="doc-foot">
                        <p className="doc-meta">
                          {i.f.category && <span className="doc-cat-text" style={categoryTag(i.f.category)}>{i.f.category}</span>}
                          <span className="doc-meta-date">
                            {extOf(i.f.name).toUpperCase() || '파일'} · {formatDate(i.f.updatedAt)}
                          </span>
                        </p>
                        <SyncPill state={rowSyncState(i.f)} />
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
                      </div>
                    </div>
                  </article>
                ) : (
                  <article
                    key={i.d.id}
                    className="doc-card"
                    data-doc-id={i.d.id}
                    data-flip-key={i.d.id}
                    style={idx < 20 ? ({ ['--i' as string]: idx } as React.CSSProperties) : undefined}
                    onClick={(e) => (section.kind === 'trash' ? setMenu({ doc: i.d, x: 0, y: 0 }) : open(i.d, e.currentTarget))}
                  >
                    <div className="doc-thumb">
                      {i.d.category && (
                        <span className="doc-tag" style={categoryTag(i.d.category)}>{i.d.category}</span>
                      )}
                      {thumbs.get(i.d.id) ? (
                        <img src={thumbs.get(i.d.id)} alt="" draggable={false} data-reveal={i.d.id} />
                      ) : (
                        <Icon name={i.d.mode === 'infinite' ? 'infinite' : 'page'} size={36} />
                      )}
                      <span className="doc-edge" aria-hidden="true" />
                      <span className="doc-gloss" aria-hidden="true" />
                      {syncPillFor(i.d.id)}
                    </div>
                    <div className="doc-info">
                      <h3 className="doc-title">{i.d.title}</h3>
                      <div className="doc-foot">
                        <p className="doc-meta">
                          {i.d.category && <span className="doc-cat-text" style={categoryTag(i.d.category)}>{i.d.category}</span>}
                          <span className="doc-meta-date">
                            {i.d.mode === 'infinite' ? '무한' : `${i.d.pageOrder.length}쪽`} ·{' '}
                            {section.kind === 'trash' && i.d.deletedAt
                              ? `삭제 ${formatDate(i.d.deletedAt)}`
                              : formatDate(i.d.updatedAt)}
                          </span>
                        </p>
                        {syncLabelFor(i.d.id)}
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
                      </div>
                    </div>
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
          <MenuItem icon="trash" label="이 기기에서 제거" danger onClick={() => appAction('remove', appMenu.app)} />
        </Menu>
      )}

      {fileMenu && (
        <Menu x={fileMenu.x} y={fileMenu.y} onClose={() => setFileMenu(null)}>
          <MenuItem icon="play" label="열기" onClick={() => fileAction('open', fileMenu.file)} />
          <MenuItem icon="edit" label="이름 바꾸기" onClick={() => fileAction('rename', fileMenu.file)} />
          <MenuItem icon="tag" label="카테고리 지정" onClick={() => fileAction('category', fileMenu.file)} />
          <MenuItem icon="download" label="내보내기" onClick={() => fileAction('export', fileMenu.file)} />
          <MenuItem icon="trash" label="이 기기에서 제거" danger onClick={() => fileAction('remove', fileMenu.file)} />
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
      {showApps && <AppsSheet onClose={() => setShowApps(false)} />}
      {showFiles && <FilesSheet onClose={() => setShowFiles(false)} />}
      {showAssets && <AssetsSheet onClose={() => setShowAssets(false)} />}
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
          <div className={'tree-item folder' + (props.activeId === f.id ? ' is-active' : '')} data-indicator-key={'folder:' + f.id} style={{ paddingLeft: 12 + props.depth * 16 }}>
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
