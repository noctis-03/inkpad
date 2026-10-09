// 작업보드 — 노트·앱·파일을 배경화면 위에 '그리드 시각화'로 보여 준다.
// 바로가기(자유 배치) 개념은 없다: 보드는 설정(배경화면·시각화 형태·카드 크기·정렬·필터)만 갖고,
// 그 설정을 프리셋으로 저장해 Drive(Inkpad/boards)로 공유한다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useUI } from '../../app/store'
import { Icon } from '../Icon'
import { Segmented } from '../Segmented'
import { promptDialog } from '../../app/dialogs'
import {
  BOARD_FILTERS,
  BOARD_SIZES,
  BOARD_SORTS,
  BOARD_VISUALS,
  BOARD_WALLPAPERS,
  cloneBoard,
  DEFAULT_BOARD,
  hexSpiral,
  normalizeBoard,
  type Board as BoardModel,
  type BoardFilter,
  type BoardPreset,
  type BoardSize,
  type BoardSort,
  type BoardVisual
} from '../../shared/board'
import { extOf, type DocumentMeta, type HtmlApp, type ID } from '../../shared/model'
import { formatDate } from '../../shared/util'
import { getThumbnails, listDocuments } from '../../storage/repo'
import { listApps } from '../../sync/apps'
import { listFiles } from '../../sync/files'
import { createPreset, uploadPreset } from '../../sync/board'
import { BoardPresetsSheet } from '../BoardPresetsSheet'
import type { FileRow } from '../../storage/db'

const LS_BOARD = 'inkpad.board.v2'

function loadBoard(): BoardModel {
  try {
    const raw = localStorage.getItem(LS_BOARD)
    if (raw) return normalizeBoard(JSON.parse(raw))
  } catch {
    /* 저장소 차단 환경 */
  }
  return cloneBoard(DEFAULT_BOARD)
}

function gradient(title: string) {
  let h = 0
  for (const ch of title) h = (h + ch.charCodeAt(0)) % 360
  return `linear-gradient(135deg, hsl(${h} 68% 62%), hsl(${(h + 42) % 360} 68% 44%))`
}

type Item = { kind: 'doc'; d: DocumentMeta } | { kind: 'app'; a: HtmlApp } | { kind: 'file'; f: FileRow }

const keyOf = (it: Item) => (it.kind === 'doc' ? `doc:${it.d.id}` : it.kind === 'app' ? `app:${it.a.id}` : `file:${it.f.id}`)
const labelOf = (it: Item) => (it.kind === 'doc' ? it.d.title : it.kind === 'app' ? it.a.title : it.f.name)
const titleOf = (it: Item) => (it.kind === 'file' ? it.f.title : labelOf(it))
const stamped = (it: Item) => (it.kind === 'doc' ? it.d : it.kind === 'app' ? it.a : it.f)

export function Board() {
  const navigate = useUI((s) => s.navigate)
  const toast = useUI((s) => s.toast)

  const [board, setBoard] = useState<BoardModel>(loadBoard)
  const [docs, setDocs] = useState<DocumentMeta[]>([])
  const [apps, setApps] = useState<HtmlApp[]>([])
  const [files, setFiles] = useState<FileRow[]>([])
  const [thumbs, setThumbs] = useState<Map<ID, string>>(new Map())
  const [query, setQuery] = useState('')
  const [wallMenu, setWallMenu] = useState(false)
  const [showPresets, setShowPresets] = useState(false)
  const thumbUrls = useRef<string[]>([])

  useEffect(() => {
    try {
      localStorage.setItem(LS_BOARD, JSON.stringify(board))
    } catch {
      /* 저장소 차단 환경 */
    }
  }, [board])

  const refresh = useCallback(async () => {
    const [d, a, f, th] = await Promise.all([listDocuments(), listApps(), listFiles(), getThumbnails()])
    setDocs(d)
    setApps(a)
    setFiles(f)
    thumbUrls.current.forEach((u) => URL.revokeObjectURL(u))
    const urls: string[] = []
    const m = new Map<ID, string>()
    th.forEach((blob, id) => {
      const u = URL.createObjectURL(blob)
      urls.push(u)
      m.set(id, u)
    })
    thumbUrls.current = urls
    setThumbs(m)
  }, [])

  useEffect(() => {
    void refresh()
    return () => thumbUrls.current.forEach((u) => URL.revokeObjectURL(u))
  }, [refresh])

  // Esc: 팝오버/시트 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (wallMenu) setWallMenu(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wallMenu])

  /** 필터 · 정렬 · 검색을 적용한 표시 목록 */
  const items = useMemo<Item[]>(() => {
    const list: Item[] = []
    if (board.filter === 'all' || board.filter === 'docs') for (const d of docs) list.push({ kind: 'doc', d })
    if (board.filter === 'all' || board.filter === 'apps') for (const a of apps) list.push({ kind: 'app', a })
    if (board.filter === 'all' || board.filter === 'files') for (const f of files) list.push({ kind: 'file', f })
    const q = query.trim().toLowerCase()
    const out = q ? list.filter((i) => `${titleOf(i)} ${labelOf(i)}`.toLowerCase().includes(q)) : list
    const sorted = [...out]
    if (board.sort === 'title') sorted.sort((x, y) => String(stamped(x).title).localeCompare(String(stamped(y).title), 'ko'))
    else if (board.sort === 'created') sorted.sort((x, y) => stamped(y).createdAt - stamped(x).createdAt)
    else sorted.sort((x, y) => stamped(y).updatedAt - stamped(x).updatedAt)
    return sorted
  }, [docs, apps, files, board.filter, board.sort, query])

  const open = (it: Item) => {
    if (it.kind === 'doc') return navigate({ name: 'editor', docId: it.d.id })
    if (it.kind === 'app') return navigate({ name: 'app', appId: it.a.id })
    navigate({ name: 'file', fileId: it.f.id })
  }

  const metaOf = (it: Item) => {
    if (it.kind === 'doc') return `${it.d.mode === 'infinite' ? '무한' : `${it.d.pageOrder.length}쪽`} · ${formatDate(it.d.updatedAt)}`
    if (it.kind === 'app') return `HTML 앱 · ${formatDate(it.a.updatedAt)}`
    return `${extOf(it.f.name).toUpperCase() || '파일'} · ${formatDate(it.f.updatedAt)}`
  }

  /** 썸네일/아이콘 면 — 격자·벌집이 함께 쓴다 */
  const face = (it: Item, size: number) => {
    if (it.kind === 'doc') {
      const url = thumbs.get(it.d.id)
      return (
        <span className="board-face" style={url ? { backgroundImage: `url(${url})` } : undefined}>
          {!url && <Icon name={it.d.mode === 'infinite' ? 'infinite' : 'page'} size={size} />}
        </span>
      )
    }
    if (it.kind === 'app') {
      return (
        <span className="board-face board-face-app" style={{ background: gradient(it.a.title) }}>
          {it.a.title.slice(0, 1)}
        </span>
      )
    }
    return <span className="board-face board-face-file">{extOf(it.f.name).toUpperCase().slice(0, 5) || 'FILE'}</span>
  }

  // 벌집 배치 — 가운데가 크고 바깥으로 갈수록 작아진다 (애플 워치 앱 보관소 느낌)
  const honey = useMemo(() => {
    const cell = board.size === 'sm' ? 52 : board.size === 'lg' ? 88 : 68
    const pos = hexSpiral(Math.max(1, items.length), cell)
    let maxR = cell
    for (const p of pos) maxR = Math.max(maxR, Math.hypot(p.x, p.y))
    return { cell, pos, maxR, size: maxR * 2 + cell * 2.4, circle: cell * 1.06 }
  }, [items.length, board.size])

  const savePreset = async () => {
    const name = await promptDialog('프리셋으로 저장', {
      value: `작업보드 ${new Date().getMonth() + 1}/${new Date().getDate()}`,
      ok: '저장'
    })
    if (!name?.trim()) return
    const p = await createPreset(name.trim(), board)
    const up = await uploadPreset(p.id)
    toast(
      up ? `"${p.name}" 프리셋을 저장하고 Drive에 올렸습니다.` : `"${p.name}" 프리셋을 저장했습니다. 클라우드에는 나중에 올릴 수 있습니다.`,
      up ? 'success' : 'info'
    )
    setShowPresets(true)
  }

  const applyPreset = (p: BoardPreset) => {
    setBoard(normalizeBoard(p))
    toast(`"${p.name}" 프리셋을 불러왔습니다.`, 'success')
  }

  return (
    <div className={'board board-wall-' + board.wallpaper}>
      <header className="board-topbar">
        <h1 className="board-brand">작업보드</h1>
        <span className="board-count">{items.length}개</span>
        <div className="board-actions">
          <button className="tb-btn" onClick={() => setWallMenu((v) => !v)} aria-label="배경화면" title="배경화면">
            <Icon name="wallpaper" />
          </button>
          <button className="tb-btn" onClick={() => void savePreset()} aria-label="프리셋으로 저장" title="프리셋으로 저장">
            <Icon name="save" />
          </button>
          <button className="tb-btn" onClick={() => setShowPresets(true)} aria-label="프리셋 목록" title="프리셋 · 드라이브 공유">
            <Icon name="board" />
          </button>
          <button className="tb-btn" onClick={() => navigate({ name: 'library' })} aria-label="노트 목록" title="노트 목록">
            <Icon name="back" />
          </button>
        </div>
      </header>

      <div className="board-controls">
        <span className="board-search">
          <Icon name="search" size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="찾기" aria-label="보드에서 찾기" />
        </span>
        <Segmented
          className="board-seg"
          value={board.visual}
          options={BOARD_VISUALS.map((v) => [v.key, v.name] as [BoardVisual, string])}
          onChange={(v) => setBoard((b) => ({ ...b, visual: v }))}
          label="시각화 형태"
        />
        <select className="sort-select" value={board.filter} onChange={(e) => setBoard((b) => ({ ...b, filter: e.target.value as BoardFilter }))} aria-label="표시할 항목">
          {BOARD_FILTERS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.name}
            </option>
          ))}
        </select>
        <select className="sort-select" value={board.sort} onChange={(e) => setBoard((b) => ({ ...b, sort: e.target.value as BoardSort }))} aria-label="정렬">
          {BOARD_SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.name}
            </option>
          ))}
        </select>
        <select className="sort-select" value={board.size} onChange={(e) => setBoard((b) => ({ ...b, size: e.target.value as BoardSize }))} aria-label="카드 크기">
          {BOARD_SIZES.map((s) => (
            <option key={s.key} value={s.key}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {items.length === 0 ? (
        <div className="board-empty">
          <Icon name="board" size={48} />
          <h2>표시할 항목이 없습니다</h2>
          <p>노트를 만들면 이 보드에 격자로 한눈에 표시됩니다.</p>
          <button className="primary-btn" onClick={() => navigate({ name: 'library' })}>
            <Icon name="notebook" size={18} /> 노트 목록으로
          </button>
        </div>
      ) : board.visual === 'grid' ? (
        <div className="board-stage">
          <div className={'board-grid size-' + board.size}>
            {items.map((it) => (
              <button key={keyOf(it)} className={'board-cell kind-' + it.kind} onClick={() => open(it)} title={labelOf(it)}>
                <span className="board-cell-thumb">{face(it, board.size === 'lg' ? 38 : board.size === 'sm' ? 22 : 30)}</span>
                <span className="board-cell-body">
                  <b className="board-cell-title">{titleOf(it)}</b>
                  <small className="board-cell-meta">{metaOf(it)}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="board-hex-stage">
          <div className="board-hex-wrap" style={{ width: honey.size, height: honey.size }}>
            {items.map((it, i) => {
              const p = honey.pos[Math.min(i, honey.pos.length - 1)]
              const d = Math.hypot(p.x, p.y) / honey.maxR
              const scale = 1.1 - Math.min(0.3, d * 0.3)
              return (
                <button
                  key={keyOf(it)}
                  className={'board-hex kind-' + it.kind}
                  style={{ left: honey.size / 2 + p.x, top: honey.size / 2 + p.y, transform: `translate(-50%,-50%) scale(${scale})` }}
                  onClick={() => open(it)}
                  title={labelOf(it)}
                >
                  <span className="board-hex-circle" style={{ width: honey.circle, height: honey.circle }}>
                    {face(it, Math.round(honey.circle * 0.34))}
                  </span>
                  <span className="board-hex-label">{titleOf(it)}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      <p className="board-tip">
        <Icon name="board" size={14} /> 카드를 누르면 열립니다. 배경화면과 시각화 설정은 자동 저장되며, 프리셋으로 Drive에 공유할 수 있습니다.
      </p>

      {wallMenu && (
        <div className="board-pop" role="dialog" aria-label="배경화면">
          <div className="board-pop-title">배경화면</div>
          <div className="board-wall-list">
            {BOARD_WALLPAPERS.map((w) => (
              <button
                key={w.key}
                className={'board-wall-chip board-wall-' + w.key + (board.wallpaper === w.key ? ' is-on' : '')}
                onClick={() => setBoard((b) => ({ ...b, wallpaper: w.key }))}
              >
                <span className="board-wall-dot" aria-hidden="true" />
                {w.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {showPresets && <BoardPresetsSheet board={board} onApply={applyPreset} onClose={() => setShowPresets(false)} />}
    </div>
  )
}
