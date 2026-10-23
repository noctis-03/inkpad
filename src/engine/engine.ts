import { BlockStore, anchorBlock, refreshBlockIds } from './blocks'
import { Camera, clampZoom } from './camera'
import { AUTO_REDRAW_BUDGET_MS, GESTURE_SETTLE_MS, TAP_MAX_MS, TAP_SLOP_PX, WHEEL_ZOOM_SENSITIVITY } from './constants'
import { hitStroke, pointsBBox, q2, strokeInPolygon } from './geometry'
import { History, type Command, type PageSnapshot, type SheetChange } from './history'
import { Layout, PAGE_GAP } from './layout'
import { PdfCache } from './pdf/pdfCache'
import { PressureDetector, PRESSURE_LABEL, resolvePressure, strokeOptsFor, type ResolvedPressure } from './pressure'
import { minPointDist, smoothPressure } from './quality'
import { Renderer, type Box, type Cursor, type LiveDraw, type Overlay } from './render'
import { Scene, getPath, groupKey, type Entry, type StrokeRec } from './scene'
import { drawPattern } from './background'
import type {
  EngineStats,
  PressureCapability,
  SelectionInfo,
  Settings,
  Tool,
  ToolStyle,
  ViewInfo
} from './types'
import type { Background, Block, DocumentMeta, ID, Page, Stroke, StrokeOpts, ViewState } from '../shared/model'
import { BLOCK_MAX_OUTSIDE, SCHEMA_VERSION, SHEET_MAX, SHEET_MIN, makeBackground, type SheetInfo } from '../shared/model'
import { ulid } from '../shared/ulid'
import type { LoadedDocument, SaveBatch } from '../storage/repo'

export type SaveState = 'saved' | 'pending' | 'saving' | 'error'

export interface EngineCallbacks {
  onStats?: (s: EngineStats) => void
  onView?: (v: ViewInfo) => void
  onSelection?: (s: SelectionInfo | null) => void
  onSaveState?: (s: SaveState, error?: unknown) => void
  onPressureCapability?: (c: PressureCapability) => void
  onPagesChanged?: (pages: Page[]) => void
  onPageContentChanged?: (pageId: ID) => void
}

export interface EngineOptions {
  settings: Settings
  style: ToolStyle
  doc: LoadedDocument
  pdf: PdfCache
  persist: (b: SaveBatch) => Promise<void>
  readOnly?: boolean
  callbacks?: EngineCallbacks
}

interface ActiveStroke {
  pointerId: number
  pointerType: string
  tool: Tool
  pageId: ID
  key: string
  ox: number
  oy: number
  points: number[]
  raw: number[] // 원래 필압 값 (감지용)
  predicted: number[][]
  lastT: number
  width: number
  color: string
  opts: StrokeOpts
  pressure: ResolvedPressure
  /** 직전까지의 평활된 필압 (-1 = 아직 없음) */
  smoothP: number
  // 지우개
  removed: Map<ID, Entry>
  added: Map<ID, Entry>
  // 올가미
  lasso: number[]
  moveFrom: { x: number; y: number } | null
  moveD: { x: number; y: number }
}

interface TouchInfo {
  id: number
  x: number
  y: number
  sx: number
  sy: number
  ignored: boolean
}

interface Gesture {
  startCam: Camera
  startMid: { x: number; y: number }
  startDist: number
  count: number // 0 = 무시, 1 = 팬, 2 = 팬/줌
  maxTouches: number
  t0: number
  moved: boolean
  panning: boolean
  samples: { t: number; x: number; y: number }[]
}

const LAT_SAMPLES = 120
const SAVE_DEBOUNCE_MS = 500
/** 미리보기에 쓰는 예측 점 상한 — 너무 많으면 펜 끝이 실제보다 길게 튀어나온다 */
const MAX_PREDICTED = 6

/** 페이지 기준 상대 좌표를 허용 범위(페이지 밖 BLOCK_MAX_OUTSIDE까지)로 clamp한다 */
const clampBlockRel = (v: number, max: number) => Math.min(Math.max(v, -BLOCK_MAX_OUTSIDE), Math.max(-BLOCK_MAX_OUTSIDE, max))

/** 보조 용지가 페이지 가장자리에 붙는 거리(화면 px) */
const SHEET_SNAP_PX = 18
/** 새 보조 용지 폭(pt) — 페이지보다 넓지 않게 */
const SHEET_DEFAULT_W = 320
const clampSheetSize = (w: number, h: number) => ({
  w: Math.round(Math.min(SHEET_MAX.w, Math.max(SHEET_MIN.w, w))),
  h: Math.round(Math.min(SHEET_MAX.h, Math.max(SHEET_MIN.h, h)))
})

export class Engine {
  readonly root: HTMLElement
  readonly layout: Layout
  readonly scene: Scene
  readonly cam = new Camera()
  /** 편집 블록 저장소 — Element 청크와 별개(PDF 내보내기 제외) */
  readonly blocks = new BlockStore()
  readonly pdf: PdfCache
  private renderer: Renderer
  private history = new History()
  doc: DocumentMeta

  settings: Settings
  style: ToolStyle
  tool: Tool = 'pen'
  readOnly: boolean
  private cb: EngineCallbacks
  private persist: (b: SaveBatch) => Promise<void>
  private detector: PressureDetector

  // 페이지
  private allPages = new Map<ID, Page>()
  /** 페이지별 콘텐츠 리비전 (썸네일 캐시 무효화용) */
  pageRev = new Map<ID, number>()

  // 입력
  private active: ActiveStroke | null = null
  private touches = new Map<number, TouchInfo>()
  private gesture: Gesture | null = null
  private lastPenUp = -Infinity
  private cursor: Cursor | null = null
  private rectLeft = 0
  private rectTop = 0
  private _momentum: { vx: number; vy: number; t: number } | null = null
  /** 한 손가락 스크롤 관성 — 남아 있는 동안 프레임을 돌린다 */
  private get momentum() {
    return this._momentum
  }
  private set momentum(v: { vx: number; vy: number; t: number } | null) {
    this._momentum = v
    if (v) this.wake()
  }
  /** 가운데(휠) 버튼 드래그 팬 상태 */
  private middlePan: { id: number; sx: number; sy: number; camX: number; camY: number } | null = null

  // 선택
  private selection: StrokeRec[] = []
  private selectionBox: Box | null = null
  /**
   * 지금 고른 올가미 영역(월드 다각형) — 이미지로 보낼 때 이 모양대로 자른다(고른 획의 크기가 아니라).
   * 획 없이 감싸도 남는다(영역만 고른 상태 — 보내기만 할 수 있다). 고른 획을 옮기면 함께 옮긴다
   */
  private lassoPoly: number[] | null = null

  // 렌더 — 프레임은 할 일이 있을 때만 돈다.
  // 예전에는 노트를 열어 두기만 해도 매 프레임(120Hz iPad에서 초당 120번) 깨어났다. 이제 아래 표시를
  // 켜는 순간 다음 프레임을 예약(wake)하고, 프레임이 끝날 때 남은 일이 없으면 멈춘다.
  // 표시는 setter라서 엔진 곳곳의 `this.liveDirty = true` 같은 기존 코드를 고치지 않아도 된다.
  private raf = 0
  private _liveDirty = true
  private _committedDirty = true
  private _pagesDirty = true
  private get liveDirty() {
    return this._liveDirty
  }
  private set liveDirty(v: boolean) {
    this._liveDirty = v
    if (v) this.wake()
  }
  private get committedDirty() {
    return this._committedDirty
  }
  private set committedDirty(v: boolean) {
    this._committedDirty = v
    if (v) this.wake()
  }
  private get pagesDirty() {
    return this._pagesDirty
  }
  private set pagesDirty(v: boolean) {
    this._pagesDirty = v
    if (v) this.wake()
  }
  private settleTimer = 0
  private pendingEventTs = Infinity
  private lastViewKey = ''

  // 저장
  private dirtyGroups = new Set<string>()
  private dirtyPages = new Set<ID>()
  private deletedPages = new Set<ID>()
  private dirtyBlocks = new Map<ID, Block>()
  private deletedBlocks = new Set<ID>()
  private orderDirty = false
  /** 되돌리기·다시 실행이 이번 저장에 끼어 있으면 true — 되돌린 내용이 마지막 동기화와 같아졌는지 확인하는 힌트 */
  private undoneSinceFlush = false
  private saveTimer = 0
  private saving: Promise<void> | null = null
  private saveState: SaveState = 'saved'

  // 보조 용지 구독 (SheetLayer의 useSyncExternalStore) — 용지 목록·배치가 바뀔 때마다 rev가 오른다
  private sheetListeners = new Set<() => void>()
  private sheetRev = 0

  // 카메라 리스너 — React state가 아니라 DOM transform을 직접 갱신하는 UI(BlockLayer)용
  private camListeners = new Set<(cam: { x: number; y: number; zoom: number }) => void>()
  private lastCamNotified = { x: NaN, y: NaN, zoom: NaN }

  // 통계
  private stats: EngineStats
  private frameCount = 0
  private eventCount = 0
  private pointCount = 0
  private coalescedTotal = 0
  private coalescedEvents = 0
  private latencies: number[] = []
  private lastStatsAt = performance.now()
  private palmRejected = 0

  private ro: ResizeObserver
  private disposers: (() => void)[] = []
  private destroyed = false

  constructor(root: HTMLElement, o: EngineOptions) {
    this.root = root
    this.settings = o.settings
    this.style = o.style
    this.cb = o.callbacks ?? {}
    this.persist = o.persist
    this.readOnly = !!o.readOnly
    this.pdf = o.pdf
    this.doc = o.doc.doc
    this.detector = new PressureDetector(o.settings.pressureCapability)

    this.layout = new Layout(this.doc.mode)
    for (const p of o.doc.pages) this.allPages.set(p.id, p)
    this.layout.setPages(o.doc.pages)
    // 보조 용지는 문서형에서만 — 획을 읽기 전에 배치해야 용지 위 획의 원점이 잡힌다
    const sheets = this.layout.paged ? (o.doc.sheets ?? []) : []
    for (const sh of sheets) this.allPages.set(sh.id, sh)
    this.layout.setSheets(sheets)
    this.scene = new Scene(this.layout)
    this.loadChunks(o.doc)
    this.blocks.load(o.doc.blocks ?? [])

    this.renderer = new Renderer(root)
    this.pdf.onReady = () => {
      this.pagesDirty = true
    }

    const proto = typeof PointerEvent !== 'undefined' ? PointerEvent.prototype : ({} as PointerEvent)
    this.stats = {
      fps: 0, latencyAvg: 0, latencyP95: 0, eventHz: 0, pointHz: 0, coalescedPerEvent: 0,
      predictedCount: 0, liveMs: 0, committedMs: 0, pointerType: '-', pressure: 0, tiltX: 0,
      tiltY: 0, altitude: null, contactW: 0, contactH: 0, strokes: 0, visible: 0, zoom: 1,
      dpr: 1, canvasPx: '', supportCoalesced: 'getCoalescedEvents' in proto,
      supportPredicted: 'getPredictedEvents' in proto, renderPath: 'idle', palmRejected: 0,
      pressureSource: '-', pdfCache: ''
    }

    this.ro = new ResizeObserver(() => this.handleResize())
    this.ro.observe(root)
    this.handleResize(true)
    this.initialView(this.doc.lastView)

    this.bindEvents()
    this.wake()
    this.emitView(true)
  }

  /** 다음 프레임을 예약한다 (이미 예약돼 있으면 그대로) */
  private wake() {
    if (this.raf || this.destroyed) return
    this.raf = requestAnimationFrame(this.frame)
  }

  /** 이번 프레임 뒤에도 계속 돌아야 하는가 — 그릴 것·관성·진행 중인 입력이 있거나, 성능 표시(HUD)가 켜져 있을 때 */
  private needsFrame(): boolean {
    return (
      this._liveDirty ||
      this._committedDirty ||
      this._pagesDirty ||
      this._momentum !== null ||
      this.active !== null ||
      this.settings.showHud // fps 측정은 프레임이 계속 돌아야 의미가 있다
    )
  }

  private loadChunks(d: LoadedDocument) {
    const entries: Entry[] = []
    for (const c of d.chunks) {
      const gk = groupKey(c.pageId, c.key)
      for (const el of c.elements) {
        if (el.type === 'stroke') entries.push({ stroke: el, pageId: c.pageId, key: c.key })
        else {
          const arr = this.scene.extras.get(gk) ?? []
          arr.push(el)
          this.scene.extras.set(gk, arr)
        }
      }
    }
    this.scene.addMany(entries)
  }

  async destroy() {
    if (this.destroyed) return
    this.destroyed = true
    cancelAnimationFrame(this.raf)
    clearTimeout(this.settleTimer)
    this.ro.disconnect()
    this.disposers.forEach((d) => d())
    await this.flush()
    this.renderer.destroy()
  }

  // ─────────────────────────── 외부 API: 설정 ───────────────────────────

  setSettings(s: Settings) {
    const prev = this.settings
    this.settings = s
    if (prev.pressureCapability !== s.pressureCapability) this.detector.capability = s.pressureCapability
    if (prev.resolution !== s.resolution) this.handleResize(true)
    if (s.showHud && !prev.showHud) this.wake() // 성능 표시를 켜면 측정용으로 계속 돈다
  }

  setTool(t: Tool) {
    if (t !== 'lasso') this.clearSelection()
    this.tool = t
    this.cursor = null
    this.liveDirty = true
  }

  setStyle(s: ToolStyle) {
    this.style = s
  }

  setReadOnly(v: boolean) {
    this.readOnly = v
    if (v) this.finishActive(false)
  }

  private frozenFrom: boolean | null = null

  /**
   * 동기화가 이 노트를 바꾸기 직전에 부른다 (storage/docGuard) — 입력을 막고(쓰던 획은 설정대로
   * 확정/취소) 메모리에만 있던 변경을 모두 기록한다. 이 엔진은 곧 내려지고 DB에서 다시 만들어진다.
   * 기록하지 못한 변경이 남으면 던진다 — 호출한 쪽은 unfreeze()로 편집을 돌려주고 동기화를 멈춘다.
   */
  async freeze(): Promise<void> {
    if (this.frozenFrom === null) {
      this.frozenFrom = this.readOnly
      if (!this.readOnly) this.finishActive(this.settings.cancelBehavior === 'commit')
      this.readOnly = true
    }
    await this.flush()
    if (this.hasPendingChanges) throw new Error('편집 내용을 기기에 저장하지 못해 동기화를 멈췄습니다. 잠시 뒤 다시 시도해 주세요.')
  }

  /** freeze 이전 상태로 편집을 돌려준다 */
  unfreeze() {
    if (this.frozenFrom === null) return
    this.readOnly = this.frozenFrom
    this.frozenFrom = null
  }

  get pages(): Page[] {
    return this.layout.pages
  }

  // ─────────────────────────── 외부 API: 보기 ───────────────────────────

  zoomBy(factor: number) {
    this.cam.zoomAt(this.renderer.cssW / 2, this.renderer.cssH / 2, this.cam.zoom * factor)
    this.onCameraMoved()
  }

  /** infinite: 원점 100% / paged: 폭 맞춤 */
  resetView() {
    if (this.layout.paged) return this.fitWidth()
    this.cam.zoom = 1
    this.cam.x = -this.renderer.cssW / 2
    this.cam.y = -this.renderer.cssH / 2
    this.onCameraMoved()
  }

  fitWidth(keepPage = true) {
    const idx = keepPage ? this.currentPage() : 0
    const b = this.layout.bounds
    const W = this.renderer.cssW
    const zoom = clampZoom(Math.min((W - 32) / Math.max(1, b.w), 2.5))
    this.cam.zoom = zoom
    this.cam.x = b.x - (W / zoom - b.w) / 2
    const p = this.layout.pages[idx]
    const r = p && this.layout.rects.get(p.id)
    this.cam.y = (r ? r.y : 0) - 16 / zoom
    this.onCameraMoved()
  }

  fitAll() {
    let b: { minX: number; minY: number; maxX: number; maxY: number } | null
    if (this.layout.paged) {
      const lb = this.layout.bounds
      b = { minX: lb.x, minY: lb.y, maxX: lb.x + lb.w, maxY: lb.y + lb.h }
    } else b = this.scene.bounds()
    // 전체 보기에는 블록 bounds도 포함한다 (편집 화면 기능 — PDF bounds 계산과 무관)
    const bb = this.blocks.bounds(this.layout)
    if (bb) b = b ? unionBox(b, bb) : bb
    for (const sh of this.layout.sheets) {
      const r = this.layout.rects.get(sh.id)
      if (r) b = unionBox(b, { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h })
    }
    if (!b) return this.resetView()
    const pad = 32
    const w = Math.max(1, b.maxX - b.minX)
    const h = Math.max(1, b.maxY - b.minY)
    const zoom = clampZoom(Math.min((this.renderer.cssW - pad * 2) / w, (this.renderer.cssH - pad * 2) / h))
    this.cam.zoom = zoom
    this.cam.x = (b.minX + b.maxX) / 2 - this.renderer.cssW / 2 / zoom
    this.cam.y = (b.minY + b.maxY) / 2 - this.renderer.cssH / 2 / zoom
    this.onCameraMoved()
  }

  scrollToPage(i: number) {
    const p = this.layout.pages[Math.max(0, Math.min(this.layout.pages.length - 1, i))]
    const r = p && this.layout.rects.get(p.id)
    if (!r) return
    this.momentum = null
    this.cam.y = r.y - 16 / this.cam.zoom
    this.onCameraMoved()
  }

  currentPage() {
    const v = this.renderer.viewBox(this.cam)
    return this.layout.currentIndex(v.minY, v.maxY)
  }

  jumpTo(wx: number, wy: number) {
    this.cam.zoom = 1
    this.cam.x = wx - this.renderer.cssW / 2
    this.cam.y = wy - this.renderer.cssH / 2
    this.onCameraMoved()
  }

  getViewState(): ViewState {
    return { x: this.cam.x, y: this.cam.y, zoom: this.cam.zoom }
  }

  private initialView(v?: ViewState) {
    if (v && Number.isFinite(v.x) && Number.isFinite(v.zoom)) {
      this.cam.x = v.x
      this.cam.y = v.y
      this.cam.zoom = clampZoom(v.zoom)
      this.onCameraMoved()
    } else if (this.layout.paged) this.fitWidth(false)
    else this.resetView()
  }

  // ─────────────────────────── 외부 API: 편집 ───────────────────────────

  undo() {
    if (this.active || this.readOnly) return
    const cmd = this.history.popUndo()
    if (!cmd) return
    this.undoneSinceFlush = true
    this.applyCommand(cmd, true)
  }

  redo() {
    if (this.active || this.readOnly) return
    const cmd = this.history.popRedo()
    if (!cmd) return
    this.undoneSinceFlush = true
    this.applyCommand(cmd, false)
  }

  get canUndo() {
    return this.history.canUndo
  }

  deleteSelection() {
    if (!this.selection.length || this.readOnly) return
    const removed = this.selection.map(toEntry)
    this.clearSelection(false)
    this.exec({ removed, added: [] })
  }

  /** 선택한 획의 색 바꾸기 (형광펜은 투명도 유지) */
  recolorSelection(color: string) {
    if (!this.selection.length || this.readOnly) return
    const removed = this.selection.map(toEntry)
    const added = removed.map((e) => {
      const alpha = e.stroke.tool === 'highlighter' ? e.stroke.color.slice(7, 9) || '66' : color.slice(7, 9) || 'ff'
      return { ...e, stroke: { ...e.stroke, color: color.slice(0, 7) + alpha } }
    })
    this.exec({ removed, added })
    this.setSelection(added.map((e) => this.scene.recs.get(e.stroke.id)!).filter(Boolean))
  }

  /** 선택 영역 복제 (약간 옆으로) */
  duplicateSelection() {
    if (!this.selection.length || this.readOnly) return
    const off = 24 / this.cam.zoom
    const added = this.selection.map((r) => this.movedEntry(r, off, off, ulid()))
    if (this.lassoPoly) this.lassoPoly = shiftPoly(this.lassoPoly, off, off)
    this.exec({ removed: [], added })
    this.setSelection(added.map((e) => this.scene.recs.get(e.stroke.id)!).filter(Boolean))
  }

  clearSelection(redraw = true) {
    if (!this.selection.length && !this.lassoPoly) return
    this.selection = []
    this.selectionBox = null
    this.lassoPoly = null
    this.renderer.hidden = null
    if (redraw) this.committedDirty = true
    this.liveDirty = true
    this.cb.onSelection?.(null)
  }

  // ─────────────────────────── 외부 API: 블록 ───────────────────────────
  // 블록은 Element 청크와 별개(PDF 내보내기 제외)지만 같은 Command 기반 히스토리와 저장 흐름을 쓴다.

  addBlock(b: Block) {
    if (this.readOnly) return
    this.exec({ removed: [], added: [], blocks: [{ before: null, after: b }] })
  }

  /** 메모 입력처럼 값이 연속으로 바뀔 때는 history: false — 저장만 예약하고 히스토리에 넣지 않는다. 편집을 마치면 blur에서 한 번만 exec한다. */
  updateBlock(id: ID, patch: Partial<Block>, opts: { history?: boolean } = {}) {
    if (this.readOnly) return
    const cur = this.blocks.get(id)
    if (!cur) return
    const next = { ...cur, ...patch, updatedAt: Date.now() } as Block
    if (opts.history === false) {
      this.blocks._put(next)
      this.dirtyBlocks.set(next.id, next)
      this.deletedBlocks.delete(next.id)
      this.scheduleSave()
      return
    }
    this.exec({ removed: [], added: [], blocks: [{ before: cur, after: next }] })
  }

  /** 연속 편집(메모 입력 등)을 마칠 때 호출 — 시작 시점 스냅샷과 현재 값으로 히스토리 1건을 만든다 */
  commitBlockEdit(before: Block) {
    if (this.readOnly) return
    const cur = this.blocks.get(before.id)
    if (!cur) return
    if (JSON.stringify(before) === JSON.stringify(cur)) return
    this.exec({ removed: [], added: [], blocks: [{ before, after: cur }] })
  }

  /** 월드 좌표로 옮긴다 — anchorBlock으로 소속 페이지를 다시 정한 뒤 exec */
  moveBlockToWorld(id: ID, wx: number, wy: number, h: number) {
    if (this.readOnly) return
    const cur = this.blocks.get(id)
    if (!cur) return
    const a = anchorBlock(this.layout, wx, wy, cur.w, h)
    if (!a) return
    if (a.pageId === cur.pageId && a.x === cur.x && a.y === cur.y) return
    this.exec({
      removed: [],
      added: [],
      blocks: [{ before: cur, after: { ...cur, pageId: a.pageId, x: a.x, y: a.y, updatedAt: Date.now() } }]
    })
  }

  deleteBlock(id: ID) {
    if (this.readOnly) return
    const cur = this.blocks.get(id)
    if (!cur) return
    this.exec({ removed: [], added: [], blocks: [{ before: cur, after: null }] })
  }

  duplicateBlock(id: ID): ID {
    if (this.readOnly) return ''
    const cur = this.blocks.get(id)
    if (!cur) return ''
    const now = Date.now()
    const copy: Block = {
      ...refreshBlockIds(cur),
      id: ulid(),
      x: cur.x + 24,
      y: cur.y + 24,
      z: this.maxBlockZ() + 1,
      createdAt: now,
      updatedAt: now
    }
    this.exec({ removed: [], added: [], blocks: [{ before: null, after: copy }] })
    return copy.id
  }

  private maxBlockZ() {
    let m = 0
    for (const b of this.blocks.list()) m = Math.max(m, b.z)
    return m
  }

  /** 블록을 맨 앞으로. 이미 맨 앞이면 z를 올리지 않는다(무한 증가 방지). */
  bringBlockToFront(id: ID) {
    if (this.readOnly) return
    const cur = this.blocks.get(id)
    if (!cur) return
    let maxOther = 0
    for (const b of this.blocks.list()) if (b.id !== id) maxOther = Math.max(maxOther, b.z)
    if (cur.z > maxOther) return
    this.updateBlock(id, { z: maxOther + 1 })
  }

  // ─────────────────────────── 외부 API: 보조 용지 ───────────────────────────
  // 보조 용지 = pageOrder 밖의 Page(sheet 필드). 페이지처럼 획을 갖고 같은 저장·동기화 경로를 탄다.
  // 위치는 기준 페이지 원점 기준 상대값이라 페이지가 옮겨 가면 따라간다. 문서형 노트에서만 쓴다.

  get sheets(): Page[] {
    return this.layout.sheets
  }

  sheet(id: ID): Page | undefined {
    return this.layout.sheets.find((s) => s.id === id)
  }

  subscribeSheets = (fn: () => void): (() => void) => {
    this.sheetListeners.add(fn)
    return () => {
      this.sheetListeners.delete(fn)
    }
  }

  /** useSyncExternalStore용 — 용지 목록이나 배치(페이지 이동 포함)가 바뀌면 달라진다 */
  sheetsVersion = () => this.sheetRev

  private bumpSheets() {
    this.sheetRev++
    for (const fn of [...this.sheetListeners]) fn()
  }

  private maxSheetZ() {
    let m = 0
    for (const s of this.layout.sheets) m = Math.max(m, s.sheet!.z)
    return m
  }

  private sheetsOf(pageId: ID): Page[] {
    return this.layout.sheets.filter((s) => s.sheet!.anchorPageId === pageId)
  }

  /** 페이지 왼쪽·오른쪽에 붙은 새 보조 용지. 만든 용지 id (못 만들면 null) */
  addSheet(pageIndex: number, side: 'left' | 'right'): ID | null {
    if (!this.layout.paged || this.readOnly) return null
    const page = this.layout.pages[pageIndex]
    if (!page?.size) return null
    const now = Date.now()
    const size = clampSheetSize(Math.min(SHEET_DEFAULT_W, page.size.w), page.size.h)
    // 같은 쪽에 이미 붙은 용지가 있으면 조금씩 내려 겹쳐도 보이게 한다
    const same = this.sheetsOf(page.id).filter((s) => s.sheet!.snap === side).length
    const sheet: Page = {
      id: ulid(),
      documentId: this.doc.id,
      schemaVersion: SCHEMA_VERSION,
      size,
      background: makeBackground('blank'),
      sheet: { anchorPageId: page.id, x: side === 'left' ? -size.w : page.size.w, y: same * 24, snap: side, title: '', z: this.maxSheetZ() + 1 },
      createdAt: now,
      updatedAt: now,
      version: 0
    }
    this.exec({ removed: [], added: [], sheets: [{ before: null, after: sheet }], label: '보조 용지 추가' })
    return sheet.id
  }

  /**
   * 용지 정보·크기·속지를 바꾼다. history: false는 끄는 동안처럼 값이 연속으로 바뀔 때 —
   * 저장만 예약하고 히스토리에 넣지 않는다. 마치면 commitSheetEdit(시작 값)으로 한 번만 기록한다.
   */
  updateSheet(id: ID, patch: { sheet?: Partial<SheetInfo>; size?: { w: number; h: number }; background?: Background }, opts: { history?: boolean } = {}) {
    if (this.readOnly) return
    const cur = this.sheet(id)
    if (!cur) return
    const next: Page = {
      ...cur,
      ...(patch.size ? { size: clampSheetSize(patch.size.w, patch.size.h) } : {}),
      ...(patch.background ? { background: patch.background } : {}),
      sheet: { ...cur.sheet!, ...patch.sheet },
      updatedAt: Date.now()
    }
    if (opts.history === false) {
      this.applySheetChanges([{ before: cur, after: next }], false)
      this.scheduleSave()
      return
    }
    this.exec({ removed: [], added: [], sheets: [{ before: cur, after: next }], label: '보조 용지' })
  }

  /** 연속 편집(끌기·크기 조절)을 마칠 때 — 시작 값과 지금 값으로 히스토리 1건 */
  commitSheetEdit(before: Page) {
    if (this.readOnly) return
    const cur = this.sheet(before.id)
    if (!cur) return
    if (JSON.stringify({ ...before, updatedAt: 0 }) === JSON.stringify({ ...cur, updatedAt: 0 })) return
    // 화면은 이미 cur 상태다 — 다시 적용하지 않고 기록만 한다
    this.history.push({ removed: [], added: [], sheets: [{ before, after: cur }], label: '보조 용지' })
    this.emitView(true)
  }

  /**
   * 용지 왼쪽 위를 월드 좌표 (wx, wy)에 두면 어디에 붙는가. 용지 가운데에서 가장 가까운 페이지가 기준이 되고,
   * 그 페이지 왼쪽·오른쪽 가장자리 가까이(세로로 겹칠 때)면 붙는다. 붙으면 위쪽 끝도 가까우면 맞춘다.
   */
  sheetPlacement(id: ID, wx: number, wy: number): Pick<SheetInfo, 'anchorPageId' | 'x' | 'y' | 'snap'> | null {
    const cur = this.sheet(id)
    if (!cur?.size) return null
    const { w, h } = cur.size
    const page = this.layout.pageNear(wx + w / 2, wy + h / 2)
    const r = page && this.layout.rects.get(page.id)
    if (!page || !r) return null
    const tol = SHEET_SNAP_PX / this.cam.zoom
    const overlapsV = wy < r.y + r.h && wy + h > r.y
    let snap: SheetInfo['snap'] = null
    if (overlapsV && Math.abs(wx + w - r.x) < tol) snap = 'left'
    else if (overlapsV && Math.abs(wx - (r.x + r.w)) < tol) snap = 'right'
    let y = wy - r.y
    if (snap && Math.abs(y) < tol) y = 0
    const x = snap === 'left' ? -w : snap === 'right' ? r.w : wx - r.x
    return { anchorPageId: page.id, x: q2(x), y: q2(y), snap }
  }

  /** 용지를 월드 좌표로 옮긴다 (sheetPlacement 규칙). 끄는 동안은 history: false */
  moveSheet(id: ID, wx: number, wy: number, opts: { history?: boolean } = {}) {
    const at = this.sheetPlacement(id, wx, wy)
    if (at) this.updateSheet(id, { sheet: at }, opts)
  }

  /** 용지를 지운다 — 그 위 획도 같은 명령으로 지워 Undo하면 함께 돌아온다 */
  deleteSheet(id: ID) {
    if (this.readOnly) return
    const cur = this.sheet(id)
    if (!cur) return
    this.exec({ removed: this.scene.entriesOfPage(id), added: [], sheets: [{ before: cur, after: null }], label: '보조 용지 삭제' })
  }

  /** 용지와 그 위 획을 복제한다. 사본은 떼어서 조금 옆에 둔다. 사본 id */
  duplicateSheet(id: ID): ID | null {
    if (this.readOnly) return null
    const cur = this.sheet(id)
    const r = cur && this.layout.rects.get(id)
    const anchor = cur && this.layout.rects.get(cur.sheet!.anchorPageId)
    if (!cur || !r || !anchor) return null
    const now = Date.now()
    const copy: Page = {
      ...cur,
      id: ulid(),
      sheet: { ...cur.sheet!, snap: null, x: q2(r.x - anchor.x + 24), y: q2(r.y - anchor.y + 24), z: this.maxSheetZ() + 1 },
      createdAt: now,
      updatedAt: now,
      version: 0,
      deletedAt: undefined
    }
    const added = this.scene.entriesOfPage(id).map((e) => ({ ...e, pageId: copy.id, stroke: { ...e.stroke, id: ulid() } }))
    this.exec({ removed: [], added, sheets: [{ before: null, after: copy }], label: '보조 용지 복제' })
    return copy.id
  }

  /** 맨 위로 — 이미 맨 위면 그대로 */
  bringSheetToFront(id: ID) {
    const cur = this.sheet(id)
    if (!cur || cur.sheet!.z >= this.maxSheetZ()) return
    this.updateSheet(id, { sheet: { z: this.maxSheetZ() + 1 } })
  }

  /** 용지 변경을 적용한다 (Command 적용과 history: false 편집이 함께 쓴다) */
  private applySheetChanges(changes: SheetChange[], inverse: boolean) {
    const map = new Map(this.layout.sheets.map((s) => [s.id, s]))
    const moved: ID[] = []
    for (const ch of changes) {
      const next = inverse ? ch.before : ch.after
      const gone = inverse ? ch.after : ch.before
      if (next) {
        map.set(next.id, next)
        this.allPages.set(next.id, next)
        this.dirtyPages.add(next.id)
        this.deletedPages.delete(next.id)
        moved.push(next.id)
      } else if (gone) {
        map.delete(gone.id)
        this.dirtyPages.delete(gone.id)
        this.deletedPages.add(gone.id)
      }
    }
    this.layout.setSheets([...map.values()])
    for (const id of moved) this.scene.relayoutPage(id)
    this.committedDirty = true
    this.bumpSheets()
  }

  // ─────────────────────────── 외부 API: 블록 위 화면 이동·확대 ───────────────────────────
  // 블록 DOM은 #canvas-root 밖에 있어 그 위의 입력이 엔진에 닿지 않는다.
  // BlockLayer가 화면 이동·확대에 쓰는 입력(손가락·휠·가운데 버튼)만 골라 넘긴다. 펜·마우스 왼쪽 버튼은 넘기지 않는다.

  overlayWheel(e: WheelEvent) {
    this.onWheel(e)
  }

  /** phase를 따로 받는다 — 블록 헤더 드래그를 넘겨받을 때는 pointermove 이벤트를 'down'으로 넘긴다 */
  overlayPointer(e: PointerEvent, phase: 'down' | 'move' | 'up' | 'cancel') {
    if (phase === 'down') {
      this.syncRect()
      if (e.pointerType === 'mouse' && e.button === 1) {
        this.momentum = null
        this.startMiddlePan(e)
      } else if (e.pointerType === 'touch') {
        this.momentum = null
        this.touchDown(e, false)
      }
      return
    }
    if (e.pointerType !== 'touch' && this.middlePan?.id !== e.pointerId) return
    if (phase === 'move') this.onPointerMove(e)
    else if (phase === 'up') this.onPointerUp(e)
    else this.onPointerCancel(e)
  }

  /** 카메라가 실제로 바뀐 프레임마다 리스너를 호출한다. React state로 매 프레임 전달하지 말 것. */
  onCamera(fn: (cam: { x: number; y: number; zoom: number }) => void): () => void {
    this.camListeners.add(fn)
    fn({ x: this.cam.x, y: this.cam.y, zoom: this.cam.zoom })
    return () => {
      this.camListeners.delete(fn)
    }
  }

  /** 클라이언트 좌표 → 월드 좌표 (rectLeft/Top 보정 포함) */
  worldOfClient(clientX: number, clientY: number): { x: number; y: number } {
    this.syncRect()
    return {
      x: (clientX - this.rectLeft) / this.cam.zoom + this.cam.x,
      y: (clientY - this.rectTop) / this.cam.zoom + this.cam.y
    }
  }

  private notifyCamera() {
    const c = this.cam
    if (c.x === this.lastCamNotified.x && c.y === this.lastCamNotified.y && c.zoom === this.lastCamNotified.zoom) return
    this.lastCamNotified = { x: c.x, y: c.y, zoom: c.zoom }
    for (const fn of [...this.camListeners]) fn({ x: c.x, y: c.y, zoom: c.zoom })
  }

  // ─────────────────────────── 외부 API: 페이지 ───────────────────────────

  private snapshot(changed: Page[]): PageSnapshot {
    return { order: this.layout.pages.map((p) => p.id), pages: changed.map((p) => ({ ...p })) }
  }

  /** index 뒤에 새 페이지 (index = -1이면 맨 앞) */
  addPage(afterIndex: number, spec?: { size?: { w: number; h: number }; background?: Background }) {
    if (!this.layout.paged || this.readOnly) return
    const ref = this.layout.pages[Math.max(0, afterIndex)] ?? this.layout.pages[0]
    const now = Date.now()
    const size = spec?.size ?? (ref?.size ? { ...ref.size } : { w: 595.28, h: 841.89 })
    const page: Page = {
      id: ulid(),
      documentId: this.doc.id,
      schemaVersion: ref?.schemaVersion ?? 1,
      size: ref?.pdf && !spec?.size ? { w: 595.28, h: 841.89 } : size,
      background: spec?.background ?? (ref && !ref.pdf ? { ...ref.background } : { type: 'blank', color: '#ffffff' }),
      createdAt: now,
      updatedAt: now,
      version: 0
    }
    const before = this.snapshot([])
    const order = [...before.order]
    order.splice(afterIndex + 1, 0, page.id)
    this.exec({ removed: [], added: [], pagesBefore: before, pagesAfter: { order, pages: [page] }, label: '페이지 추가' })
    this.scrollToPage(afterIndex + 1)
  }

  deletePage(index: number) {
    if (!this.layout.paged || this.readOnly || this.layout.pages.length <= 1) return
    const page = this.layout.pages[index]
    if (!page) return
    this.clearSelection()
    // 이 페이지에 붙은 보조 용지와 그 위 획도 함께 지운다 — Undo하면 함께 돌아온다
    const sheets = this.sheetsOf(page.id)
    const removed = [page, ...sheets].flatMap((p) => this.scene.entriesOfPage(p.id))
    const before = this.snapshot([page])
    const order = before.order.filter((id) => id !== page.id)
    // 그 페이지에 소속된 블록(여백 블록 포함)도 같은 명령으로 지운다 — Undo하면 함께 복원된다.
    // 이 페이지를 가리키던 jump 블록은 그대로 둔다. UI가 "삭제된 페이지"로 표시한다.
    const pageBlocks = this.blocks.ofPage(page.id)
    this.exec({
      removed,
      added: [],
      pagesBefore: before,
      pagesAfter: { order, pages: [] },
      blocks: pageBlocks.map((b) => ({ before: b, after: null })),
      sheets: sheets.map((sh) => ({ before: sh, after: null })),
      label: '페이지 삭제'
    })
  }

  duplicatePage(index: number) {
    if (!this.layout.paged || this.readOnly) return
    const src = this.layout.pages[index]
    if (!src) return
    const now = Date.now()
    const page: Page = { ...src, id: ulid(), createdAt: now, updatedAt: now, version: 0, deletedAt: undefined }
    const added = this.scene.entriesOfPage(src.id).map((e) => ({ ...e, pageId: page.id, stroke: { ...e.stroke, id: ulid() } }))
    const zBase = this.maxBlockZ()
    const blockCopies = this.blocks
      .ofPage(src.id)
      .map((b, i) => ({ ...refreshBlockIds(b), id: ulid(), pageId: page.id, z: zBase + 1 + i, createdAt: now, updatedAt: now }) as Block)
    // 보조 용지도 새 페이지에 붙여 복제한다
    let sheetZ = this.maxSheetZ()
    const sheetCopies: Page[] = []
    for (const sh of this.sheetsOf(src.id)) {
      const copy: Page = { ...sh, id: ulid(), sheet: { ...sh.sheet!, anchorPageId: page.id, z: ++sheetZ }, createdAt: now, updatedAt: now, version: 0, deletedAt: undefined }
      sheetCopies.push(copy)
      for (const e of this.scene.entriesOfPage(sh.id)) added.push({ ...e, pageId: copy.id, stroke: { ...e.stroke, id: ulid() } })
    }
    const before = this.snapshot([])
    const order = [...before.order]
    order.splice(index + 1, 0, page.id)
    this.exec({
      removed: [],
      added,
      pagesBefore: before,
      pagesAfter: { order, pages: [page] },
      blocks: blockCopies.map((b) => ({ before: null, after: b })),
      sheets: sheetCopies.map((sh) => ({ before: null, after: sh })),
      label: '페이지 복제'
    })
  }

  movePage(from: number, to: number) {
    if (!this.layout.paged || this.readOnly || from === to) return
    const before = this.snapshot([])
    const order = [...before.order]
    const [id] = order.splice(from, 1)
    order.splice(to, 0, id)
    this.exec({ removed: [], added: [], pagesBefore: before, pagesAfter: { order, pages: [] }, label: '페이지 이동' })
  }

  /** 속지 변경. indices 없으면 모든 페이지(PDF 페이지 제외) */
  setBackground(bg: Background, indices?: number[]) {
    if (this.readOnly) return
    const targets = (indices ? indices.map((i) => this.layout.pages[i]) : this.layout.pages).filter((p) => p && !p.pdf)
    if (!targets.length) return
    const before = this.snapshot(targets)
    const after = this.snapshot(targets.map((p) => ({ ...p, background: bg })))
    this.exec({ removed: [], added: [], pagesBefore: before, pagesAfter: after, label: '속지 변경' })
  }

  /** 페이지 크기/방향 변경 (PDF 페이지 제외) */
  setPageSize(size: { w: number; h: number }, indices?: number[]) {
    if (this.readOnly || !this.layout.paged) return
    const targets = (indices ? indices.map((i) => this.layout.pages[i]) : this.layout.pages).filter((p) => p && !p.pdf)
    if (!targets.length) return
    const before = this.snapshot(targets)
    const after = this.snapshot(targets.map((p) => ({ ...p, size: { ...size } })))
    // 페이지가 작아지면 기존 블록이 허용 범위를 벗어날 수 있다 — 같은 Command에서 상대좌표를 clamp해 함께 Undo되게 한다
    const targetIds = new Set(targets.map((p) => p.id))
    const blockChanges = this.blocks
      .list()
      .filter((b) => targetIds.has(b.pageId))
      .map((b) => {
        const h = this.blocks.measuredHeight(b.id) || 72
        const x = clampBlockRel(b.x, size.w + BLOCK_MAX_OUTSIDE - b.w)
        const y = clampBlockRel(b.y, size.h + BLOCK_MAX_OUTSIDE - h)
        return x === b.x && y === b.y ? null : { before: b, after: { ...b, x, y, updatedAt: Date.now() } as Block }
      })
      .filter((c): c is { before: Block; after: Block } => c !== null)
    this.exec({ removed: [], added: [], pagesBefore: before, pagesAfter: after, blocks: blockChanges, label: '페이지 크기' })
  }

  /** 다른 문서/PDF에서 가져온 페이지를 index 뒤에 삽입 */
  insertPages(afterIndex: number, pages: Page[]) {
    if (!this.layout.paged || this.readOnly || !pages.length) return
    const before = this.snapshot([])
    const order = [...before.order]
    order.splice(afterIndex + 1, 0, ...pages.map((p) => p.id))
    this.exec({ removed: [], added: [], pagesBefore: before, pagesAfter: { order, pages }, label: '페이지 삽입' })
    this.scrollToPage(afterIndex + 1)
  }

  // ─────────────────────────── Command 실행 ───────────────────────────

  private exec(cmd: Command) {
    this.applyCommand(cmd, false)
    this.history.push(cmd)
    this.emitView(true)
  }

  private applySnapshot(s: PageSnapshot) {
    const prevOrder = new Set(this.layout.pages.map((p) => p.id))
    for (const p of s.pages) {
      this.allPages.set(p.id, p)
      this.dirtyPages.add(p.id)
    }
    const next = s.order.map((id) => this.allPages.get(id)!).filter(Boolean)
    const nextSet = new Set(s.order)
    for (const id of prevOrder) {
      if (!nextSet.has(id)) {
        this.deletedPages.add(id)
        this.dirtyPages.delete(id)
      }
    }
    for (const id of s.order) {
      if (!prevOrder.has(id)) {
        this.deletedPages.delete(id)
        this.dirtyPages.add(id)
      }
    }
    this.orderDirty = true
    this.layout.setPages(next)
    this.scene.relayout()
    this.cb.onPagesChanged?.(next)
    this.pagesDirty = true
    this.blocks._notify() // 블록 위치는 페이지 원점 기준 상대값 — UI가 다시 계산하게 한다
    this.bumpSheets() // 보조 용지도 기준 페이지를 따라 옮겨 갔다 (setPages가 다시 배치)
  }

  private applyCommand(cmd: Command, inverse: boolean) {
    const toRemove = inverse ? cmd.added : cmd.removed
    const toAdd = inverse ? cmd.removed : cmd.added
    const snap = inverse ? cmd.pagesBefore : cmd.pagesAfter
    let box: Box | null = null
    const touched = new Set<ID>()
    for (const e of toRemove) {
      const rec = this.scene.remove(e.stroke.id)
      if (rec) {
        box = unionBox(box, rec.item)
        this.markDirty(rec.pageId, rec.key)
        touched.add(rec.pageId)
      }
    }
    if (snap) this.applySnapshot(snap)
    // 보조 용지는 획을 더하기 전에 — 되살린 용지 위 획이 용지 원점을 찾아야 한다
    if (cmd.sheets?.length) this.applySheetChanges(cmd.sheets, inverse)
    for (const e of toAdd) {
      const rec = this.scene.add(e)
      box = unionBox(box, rec.item)
      this.markDirty(e.pageId, e.key)
      touched.add(e.pageId)
    }
    // 블록: inverse면 before, 아니면 after를 적용한다 (Element 청크와는 별개 경로)
    for (const ch of cmd.blocks ?? []) {
      const next = inverse ? ch.before : ch.after
      const gone = inverse ? ch.after : ch.before
      if (next) {
        this.blocks._put(next)
        this.dirtyBlocks.set(next.id, next)
        this.deletedBlocks.delete(next.id)
      } else if (gone) {
        this.blocks._remove(gone.id)
        this.dirtyBlocks.delete(gone.id)
        this.deletedBlocks.add(gone.id)
      }
    }
    if (this.selection.length) this.clearSelection(false)
    // 블록만 바뀐 Command는 DOM 오버레이만 갱신하면 된다 — 획 캔버스를 다시 그리지 않는다.
    const blocksOnly = toRemove.length === 0 && toAdd.length === 0 && !snap && !cmd.sheets?.length
    if (blocksOnly) {
      // 캔버스에 그릴 변경 없음 — 블록은 BlockLayer가 렌더한다
    } else if (snap || cmd.sheets?.length || !box || !this.renderer.inSync(this.cam) || toRemove.length + toAdd.length > 500) {
      this.committedDirty = true
    } else {
      this.renderer.redrawRegion(this.scene, this.cam, box)
    }
    for (const id of touched) this.bumpPage(id)
    this.scheduleSave()
    this.emitView(true)
  }

  private markDirty(pageId: ID, key: string) {
    this.dirtyGroups.add(groupKey(pageId, key))
  }

  private bumpPage(pageId: ID) {
    this.pageRev.set(pageId, (this.pageRev.get(pageId) ?? 0) + 1)
    this.cb.onPageContentChanged?.(pageId)
  }

  // ─────────────────────────── 저장 ───────────────────────────

  private setSaveState(s: SaveState, err?: unknown) {
    if (this.saveState === s && !err) return
    this.saveState = s
    this.cb.onSaveState?.(s, err)
  }

  get hasPendingChanges() {
    return this.dirtyGroups.size > 0 || this.dirtyPages.size > 0 || this.deletedPages.size > 0 || this.orderDirty || this.dirtyBlocks.size > 0 || this.deletedBlocks.size > 0
  }

  private scheduleSave() {
    if (this.readOnly) return
    this.setSaveState('pending')
    clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => void this.flush(), SAVE_DEBOUNCE_MS)
  }

  /** 바뀐 청크/페이지를 IndexedDB에 기록. 진행 중인 저장이 있으면 끝난 뒤 이어서 */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer)
    if (this.saving) {
      await this.saving
      if (!this.hasPendingChanges) return
    }
    // 읽기 전용이어도 이미 쌓인 변경은 기록한다 — 처음부터 읽기 전용인 엔진은 변경이 생기지 않고,
    // freeze()로 막은 엔진은 막기 전의 변경을 마저 써야 한다
    if (!this.hasPendingChanges) {
      if (this.saveState !== 'error') this.setSaveState('saved')
      return
    }
    const groups = [...this.dirtyGroups]
    const pagesUp = [...this.dirtyPages]
    const pagesDel = [...this.deletedPages]
    const blocksUp = [...this.dirtyBlocks.values()]
    const blocksDel = [...this.deletedBlocks]
    const order = this.orderDirty
    this.dirtyGroups.clear()
    this.dirtyPages.clear()
    this.deletedPages.clear()
    this.dirtyBlocks.clear()
    this.deletedBlocks.clear()
    this.orderDirty = false
    const liveIds = new Set([...this.layout.pages, ...this.layout.sheets].map((p) => p.id))
    const batch: SaveBatch = {
      documentId: this.doc.id,
      chunks: groups.map((gk) => {
        const i = gk.indexOf('|')
        const pageId = gk.slice(0, i)
        return { pageId, key: gk.slice(i + 1), elements: liveIds.has(pageId) ? this.scene.groupElements(gk) : [] }
      }),
      pagesUpsert: pagesUp.filter((id) => liveIds.has(id)).map((id) => this.allPages.get(id)!).filter(Boolean),
      pagesDelete: pagesDel,
      blocksUpsert: blocksUp.length ? blocksUp : undefined,
      blocksDelete: blocksDel.length ? blocksDel : undefined,
      doc: order ? { pageOrder: this.layout.pages.map((p) => p.id) } : undefined,
      viaUndo: this.undoneSinceFlush
    }
    if (order) this.doc = { ...this.doc, pageOrder: batch.doc!.pageOrder! }
    this.setSaveState('saving')
    this.saving = (async () => {
      try {
        await this.persist(batch)
        this.undoneSinceFlush = false // 성공한 배치의 힌트는 소모 — 실패하면 재시도에 다시 끼운다
        this.setSaveState(this.hasPendingChanges ? 'pending' : 'saved')
      } catch (e) {
        // 실패하면 다시 대기열에 넣고 재시도
        groups.forEach((g) => this.dirtyGroups.add(g))
        pagesUp.forEach((p) => this.dirtyPages.add(p))
        pagesDel.forEach((p) => this.deletedPages.add(p))
        blocksUp.forEach((b) => this.dirtyBlocks.set(b.id, b))
        blocksDel.forEach((id) => this.deletedBlocks.add(id))
        if (order) this.orderDirty = true
        this.setSaveState('error', e)
        if (!this.destroyed) this.saveTimer = window.setTimeout(() => void this.flush(), 5000)
      } finally {
        this.saving = null
      }
    })()
    await this.saving
    if (this.hasPendingChanges && this.saveState !== 'error') await this.flush()
  }

  // ─────────────────────────── 이벤트 바인딩 ───────────────────────────

  private on(target: EventTarget, type: string, fn: (e: any) => void, opts?: AddEventListenerOptions) {
    target.addEventListener(type, fn, opts)
    this.disposers.push(() => target.removeEventListener(type, fn, opts))
  }

  private bindEvents() {
    const r = this.root
    this.on(r, 'pointerdown', this.onPointerDown)
    this.on(r, 'pointermove', this.onPointerMove)
    this.on(r, 'pointerup', this.onPointerUp)
    this.on(r, 'pointercancel', this.onPointerCancel)
    this.on(r, 'pointerleave', this.onPointerLeave)
    this.on(r, 'pointerenter', () => this.syncRect()) // 펜·마우스 커서(누르기 전)도 제자리에
    this.on(r, 'wheel', this.onWheel, { passive: false })
    const prevent = (e: Event) => e.preventDefault()
    // 휠(가운데) 버튼: 브라우저 자동 스크롤 대신 드래그 팬으로 사용
    this.on(r, 'mousedown', (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    })
    this.on(r, 'auxclick', (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    })
    this.on(r, 'touchstart', prevent, { passive: false })
    this.on(r, 'touchmove', prevent, { passive: false })
    this.on(r, 'contextmenu', prevent)
    this.on(document, 'gesturestart', prevent, { passive: false })
    this.on(document, 'gesturechange', prevent, { passive: false })
    this.on(document, 'gestureend', prevent, { passive: false })
    // 백그라운드 전환/종료 시 디바운스를 기다리지 않고 바로 기록 — iPad는 뒤로 간 탭을 예고 없이 닫는다
    this.on(document, 'visibilitychange', () => {
      if (document.hidden) {
        this.finishActive(this.settings.cancelBehavior === 'commit')
        void this.flush()
      }
    })
    this.on(window, 'pagehide', () => void this.flush())
  }

  private capture(id: number) {
    try {
      this.root.setPointerCapture(id)
    } catch {
      /* noop */
    }
  }

  private local(e: { clientX: number; clientY: number }) {
    return { x: e.clientX - this.rectLeft, y: e.clientY - this.rectTop }
  }

  private recordPointerStats(e: PointerEvent) {
    const s = this.stats
    s.pointerType = e.pointerType
    s.pressure = e.pressure
    s.tiltX = e.tiltX
    s.tiltY = e.tiltY
    s.altitude = (e as PointerEvent & { altitudeAngle?: number }).altitudeAngle ?? null
    s.contactW = e.width
    s.contactH = e.height
  }

  private markEvent(e: PointerEvent) {
    const ts = eventTimeToPerf(e.timeStamp)
    if (ts < this.pendingEventTs) this.pendingEventTs = ts
  }

  private isPenLike(e: PointerEvent) {
    return e.pointerType === 'pen' || e.pointerType === 'mouse'
  }

  // ─────────────────────────── 포인터 ───────────────────────────

  private onPointerDown = (e: PointerEvent) => {
    this.syncRect()
    this.recordPointerStats(e)
    this.momentum = null
    if (this.isPenLike(e)) {
      if (e.pointerType === 'mouse' && e.button !== 0) {
        if (e.button === 1) this.startMiddlePan(e)
        return
      }
      if (this.active && this.active.pointerType !== 'touch') return
      this.cancelTouchInteractions()
      if (this.readOnly) return
      this.capture(e.pointerId)
      this.startStroke(e)
      return
    }
    this.touchDown(e, true)
  }

  /** 손가락이 닿음. fromCanvas가 아니면(블록 위) 획을 시작하지 않고 pointer capture도 하지 않는다 — 블록의 탭·클릭은 그대로 둔다 */
  private touchDown(e: PointerEvent, fromCanvas: boolean) {
    const p = this.local(e)
    const t: TouchInfo = { id: e.pointerId, x: p.x, y: p.y, sx: p.x, sy: p.y, ignored: false }
    const penBusy = !!this.active && this.active.pointerType !== 'touch'
    const inPalmWindow = performance.now() - this.lastPenUp < this.settings.palmWindowMs
    const bigContact = this.settings.palmMaxContact > 0 && Math.max(e.width, e.height) > this.settings.palmMaxContact
    if (penBusy || inPalmWindow || bigContact) {
      t.ignored = true
      this.palmRejected++
      this.touches.set(e.pointerId, t)
      return
    }
    if (fromCanvas) this.capture(e.pointerId)
    this.touches.set(e.pointerId, t)
    if (this.active && this.active.pointerType === 'touch') this.finishActive(false)

    const live = this.liveTouches()
    if (fromCanvas && live.length === 1 && this.settings.fingerDraw && !this.readOnly) {
      this.startStroke(e)
      this.gesture = this.newGesture(live, 1)
      return
    }
    this.gesture = this.newGesture(live, Math.min(2, live.length), this.gesture)
  }

  private collect(a: ActiveStroke, e: PointerEvent) {
    const list = this.settings.coalesced && e.getCoalescedEvents ? e.getCoalescedEvents() : []
    const events = list.length ? list : [e]
    this.coalescedTotal += events.length
    this.coalescedEvents++
    for (const ev of events) this.addPoint(a, ev)
  }

  private onPointerMove = (e: PointerEvent) => {
    if (this.middlePan && this.middlePan.id === e.pointerId) {
      const p = this.local(e)
      this.cam.x = this.middlePan.camX - (p.x - this.middlePan.sx) / this.cam.zoom
      this.cam.y = this.middlePan.camY - (p.y - this.middlePan.sy) / this.cam.zoom
      this.onCameraMoved()
      return
    }
    if (this.isPenLike(e)) {
      const a = this.active
      if (a && a.pointerId === e.pointerId) {
        this.recordPointerStats(e)
        this.markEvent(e)
        this.eventCount++
        this.collect(a, e)
        a.predicted =
          this.settings.prediction && (a.tool === 'pen' || a.tool === 'highlighter') && e.getPredictedEvents
            ? e.getPredictedEvents().slice(0, MAX_PREDICTED).map((ev) => this.toChunkPoint(a, ev))
            : []
        this.stats.predictedCount = a.predicted.length
        this.liveDirty = true
      } else if (!a && !this.readOnly) {
        const p = this.local(e)
        this.setCursor(p.x, p.y)
      }
      return
    }
    const t = this.touches.get(e.pointerId)
    if (!t) return
    const p = this.local(e)
    t.x = p.x
    t.y = p.y
    if (t.ignored) return
    const a = this.active
    if (a && a.pointerId === e.pointerId) {
      this.markEvent(e)
      this.eventCount++
      this.collect(a, e)
      a.predicted = []
      this.liveDirty = true
      return
    }
    this.updateGesture()
  }

  private onPointerUp = (e: PointerEvent) => {
    if (this.middlePan && this.middlePan.id === e.pointerId) {
      this.endMiddlePan()
      return
    }
    if (this.isPenLike(e)) {
      if (this.active && this.active.pointerId === e.pointerId) {
        this.finishActive(true)
        this.lastPenUp = performance.now()
      }
      return
    }
    this.endTouch(e.pointerId, true)
  }

  private onPointerCancel = (e: PointerEvent) => {
    if (this.middlePan && this.middlePan.id === e.pointerId) {
      this.endMiddlePan()
      return
    }
    if (this.active && this.active.pointerId === e.pointerId) {
      this.finishActive(this.settings.cancelBehavior === 'commit')
      if (this.isPenLike(e)) this.lastPenUp = performance.now()
    }
    if (!this.isPenLike(e)) this.endTouch(e.pointerId, false)
  }

  private onPointerLeave = (e: PointerEvent) => {
    if (this.isPenLike(e) && !this.active && this.cursor) {
      this.cursor = null
      this.liveDirty = true
    }
  }

  /** 휠(가운데) 버튼을 누른 채 드래그하면 화면을 1:1로 끌어 이동 */
  private startMiddlePan(e: PointerEvent) {
    this.momentum = null
    this.cancelTouchInteractions()
    const p = this.local(e)
    this.middlePan = { id: e.pointerId, sx: p.x, sy: p.y, camX: this.cam.x, camY: this.cam.y }
    this.capture(e.pointerId)
    if (this.cursor) {
      this.cursor = null
      this.liveDirty = true
    }
    this.root.style.cursor = 'grabbing'
  }

  private endMiddlePan() {
    this.middlePan = null
    this.root.style.cursor = ''
  }

  private onWheel = (e: WheelEvent) => {
    this.syncRect()
    e.preventDefault()
    this.momentum = null
    const p = this.local(e)
    if (e.ctrlKey || e.metaKey) {
      // deltaMode: 0 = 픽셀, 1 = 줄, 2 = 페이지 — 브라우저마다 단위가 달라 먼저 정규화한다.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.renderer.cssH : 1
      const factor = Math.exp(-e.deltaY * unit * WHEEL_ZOOM_SENSITIVITY)
      this.cam.zoomAt(p.x, p.y, this.cam.zoom * factor)
    } else {
      this.cam.x += e.deltaX / this.cam.zoom
      this.cam.y += e.deltaY / this.cam.zoom
    }
    this.onCameraMoved()
  }

  // ─────────────────────────── 획 ───────────────────────────

  private startStroke(e: PointerEvent) {
    const p = this.local(e)
    const w = this.cam.screenToWorld(p.x, p.y)
    const tool = this.tool
    const target = this.layout.targetAt(w.x, w.y)
    if (!target) return
    const hl = tool === 'highlighter'
    const st = hl ? this.style.highlighter : this.style.pen
    const pressure = resolvePressure(this.settings, e.pointerType)
    const a: ActiveStroke = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      tool,
      pageId: target.pageId,
      key: target.key,
      ox: target.ox,
      oy: target.oy,
      points: [],
      raw: [],
      predicted: [],
      lastT: e.timeStamp,
      width: st.width,
      color: st.color,
      opts: strokeOptsFor(pressure, this.settings, hl ? 'highlighter' : 'pen'),
      pressure,
      smoothP: -1,
      removed: new Map(),
      added: new Map(),
      lasso: [],
      moveFrom: null,
      moveD: { x: 0, y: 0 }
    }
    if (tool === 'lasso') {
      const sb = this.selectionBox
      const pad = 12 / this.cam.zoom
      // 획을 고른 영역 안을 누르면 옮기기, 밖(또는 획 없이 영역만 고른 상태)이면 새 올가미
      if (sb && this.selection.length && w.x >= sb.minX - pad && w.x <= sb.maxX + pad && w.y >= sb.minY - pad && w.y <= sb.maxY + pad) {
        a.moveFrom = w
      } else this.clearSelection()
    }
    this.active = a
    this.cursor = null
    this.markEvent(e)
    this.addPoint(a, e)
    this.liveDirty = true
  }

  /**
   * 필압 원시값에 필압 곡선(감마)·최소 필압만 적용해 매핑한다. 상태를 바꾸지 않는다.
   * 반환 -1 = 이 이벤트가 필압 0을 보냄(일부 펜) → 호출부가 직전 값을 이어 쓴다.
   */
  private mappedPressure(ev: PointerEvent, a: ActiveStroke): number {
    if (a.pressure !== 'pressure') return 0.5
    const raw = ev.pressure
    if (!(raw > 0)) return -1
    let p = Math.min(1, raw)
    const g = this.settings.pressureGamma
    if (g !== 1) p = Math.pow(p, g)
    return Math.max(this.settings.minPressure, p)
  }

  private toChunkPoint(a: ActiveStroke, ev: PointerEvent): number[] {
    const p = this.local(ev)
    const w = this.cam.screenToWorld(p.x, p.y)
    const m = this.mappedPressure(ev, a)
    const pr = m < 0 ? (a.smoothP >= 0 ? a.smoothP : 0.5) : m
    return [w.x - a.ox, w.y - a.oy, a.pressure === 'pressure' ? pr : 0.5]
  }

  private addPoint(a: ActiveStroke, ev: PointerEvent) {
    this.pointCount++
    const p = this.local(ev)
    const w = this.cam.screenToWorld(p.x, p.y)
    if (a.tool === 'eraser') {
      this.eraseAt(a, w.x, w.y)
      return
    }
    if (a.tool === 'lasso') {
      if (a.moveFrom) {
        a.moveD = { x: w.x - a.moveFrom.x, y: w.y - a.moveFrom.y }
        this.liveDirty = true
      } else if (this.settings.lassoShape === 'rect') {
        // 사각 올가미: 누른 곳과 지금 점을 잇는 네모 (다각형 네 꼭짓점)
        const l = a.lasso
        const x0 = l.length ? l[0] : w.x
        const y0 = l.length ? l[1] : w.y
        l.length = 0
        l.push(x0, y0, w.x, y0, w.x, w.y, x0, w.y)
      } else {
        const l = a.lasso
        const n = l.length
        if (n < 2 || Math.hypot(w.x - l[n - 2], w.y - l[n - 1]) * this.cam.zoom > 3) l.push(w.x, w.y)
      }
      return
    }
    if (a.pointerType === 'pen') a.raw.push(ev.pressure)
    // 필압: 곡선·최소값 적용 → 지수 평활(직전 값과 섞어 굵기가 계단처럼 변하지 않게)
    const m = this.mappedPressure(ev, a)
    let pr: number
    if (m < 0) {
      // 이 이벤트는 필압을 보내지 않았다 → 직전 값 유지 (평활 상태는 건드리지 않는다)
      pr = a.smoothP >= 0 ? a.smoothP : a.points.length >= 4 ? a.points[a.points.length - 2] : 0.5
    } else {
      pr = a.smoothP < 0 ? m : smoothPressure(a.smoothP, m, this.settings.pressureSmoothing)
      a.smoothP = pr
    }
    const qx = q2(w.x - a.ox)
    const qy = q2(w.y - a.oy)
    const n = a.points.length
    if (n >= 4) {
      // 화면에서 sub-pixel만큼 움직인 점은 떨림으로 보고 점을 만들지 않는다.
      // 선이 매끄러워지고 점 수가 줄어 프레임 비용(입력 지연)도 함께 줄어든다.
      const dx = qx - a.points[n - 4]
      const dy = qy - a.points[n - 3]
      const minD = minPointDist(this.cam.zoom)
      if (dx * dx + dy * dy < minD * minD) {
        if (a.pressure === 'pressure') a.points[n - 2] = q2(Math.max(a.points[n - 2], pr))
        return
      }
    }
    const dt = Math.max(0, Math.round(ev.timeStamp - a.lastT))
    a.lastT = ev.timeStamp
    a.points.push(qx, qy, q2(pr), dt)
  }

  private eraseAt(a: ActiveStroke, wx: number, wy: number) {
    const r = this.style.eraserSize / 2 / this.cam.zoom
    let box: Box | null = null
    // 이 점에서 보이는 획만 — 불투명 용지에 가린 아래 획은 지우지 않고(투명 용지는 비쳐 보이는 획까지),
    // 용지 밖에서는 용지 획을 건드리지 않는다(용지 획은 용지 안으로 잘려 그 밖 부분은 보이지 않는다)
    const surf = this.layout.surfacesAt(wx, wy)
    for (const rec of this.scene.query(wx - r, wy - r, wx + r, wy + r)) {
      if (!this.layout.visibleIn(surf, rec.pageId)) continue
      const s = rec.stroke
      // 지우개는 획 단위만 — 획을 잘라 새 ID 조각을 만들면 기기 간 머지에서 원래 획과 조각이 함께 남는다
      if (!hitStroke(s.points, wx - rec.ox, wy - rec.oy, r + s.width / 2)) continue
      this.eraseRec(a, rec)
      box = unionBox(box, rec.item)
      this.markDirty(rec.pageId, rec.key)
    }
    if (box) {
      if (this.renderer.inSync(this.cam)) this.renderer.redrawRegion(this.scene, this.cam, box)
      else this.committedDirty = true
    }
    this.setCursor((wx - this.cam.x) * this.cam.zoom, (wy - this.cam.y) * this.cam.zoom, true)
  }

  private eraseRec(a: ActiveStroke, rec: StrokeRec) {
    this.scene.remove(rec.stroke.id)
    // 이번 제스처에서 만든 조각을 다시 지우면 기록에서만 뺀다
    if (a.added.has(rec.stroke.id)) a.added.delete(rec.stroke.id)
    else a.removed.set(rec.stroke.id, toEntry(rec))
  }

  private finishActive(commit: boolean) {
    const a = this.active
    if (!a) return
    this.active = null
    this.liveDirty = true
    if (a.tool === 'eraser') {
      this.cursor = null
      if (a.removed.size || a.added.size) {
        const cmd: Command = { removed: [...a.removed.values()], added: [...a.added.values()] }
        this.history.push(cmd)
        const pages = new Set([...cmd.removed, ...cmd.added].map((e) => e.pageId))
        pages.forEach((p) => this.bumpPage(p))
        this.scheduleSave()
        this.emitView(true)
      }
      return
    }
    if (a.tool === 'lasso') return this.finishLasso(a, commit)
    if (a.pointerType === 'pen') {
      const changed = this.detector.observe(a.raw)
      if (changed) this.cb.onPressureCapability?.(changed)
    }
    this.stats.pressureSource = PRESSURE_LABEL[a.pressure]
    if (!commit || a.points.length === 0) return
    const hl = a.tool === 'highlighter'
    const stroke: Stroke = {
      id: ulid(),
      type: 'stroke',
      tool: hl ? 'highlighter' : 'pen',
      layer: hl ? 'under' : 'main',
      z: this.scene.nextZ(),
      createdAt: Date.now(),
      color: a.color,
      width: a.width,
      points: a.points,
      bbox: pointsBBox(a.points, a.width),
      opts: a.opts
    }
    const entry: Entry = { stroke, pageId: a.pageId, key: a.key }
    const rec = this.scene.add(entry)
    this.history.push({ removed: [], added: [entry] })
    this.markDirty(a.pageId, a.key)
    this.bumpPage(a.pageId)
    if (this.renderer.inSync(this.cam)) {
      // 보조 용지와 겹치면 쌓임 순서(페이지 획 → 용지 → 용지 획)를 지키려고 영역을 다시 그린다
      if (stroke.layer === 'under' || this.layout.sheetOverlaps(rec.item)) this.renderer.redrawRegion(this.scene, this.cam, rec.item)
      else this.renderer.drawIncremental(rec, this.cam)
    } else this.committedDirty = true
    this.scheduleSave()
    this.emitView(true)
  }

  // ─────────────────────────── 올가미 ───────────────────────────

  private finishLasso(a: ActiveStroke, commit: boolean) {
    if (a.moveFrom) {
      const { x: dx, y: dy } = a.moveD
      if (!commit || (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01)) {
        this.liveDirty = true
        return
      }
      const removed = this.selection.map(toEntry)
      const added = this.selection.map((r) => this.movedEntry(r, dx, dy, r.stroke.id))
      if (this.lassoPoly) this.lassoPoly = shiftPoly(this.lassoPoly, dx, dy) // 영역도 함께 옮긴다
      this.exec({ removed, added })
      this.setSelection(added.map((e) => this.scene.recs.get(e.stroke.id)!).filter(Boolean))
      return
    }
    const poly = a.lasso
    if (!commit || poly.length < 6) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let i = 0; i < poly.length; i += 2) {
      minX = Math.min(minX, poly[i]); maxX = Math.max(maxX, poly[i])
      minY = Math.min(minY, poly[i + 1]); maxY = Math.max(maxY, poly[i + 1])
    }
    // 보조 용지 위에서 시작한 올가미는 그 자리에서 보이는 획만 고른다 (불투명 용지에 가린 아래 획은 빼고)
    const surf = this.layout.surfacesAt(poly[0], poly[1])
    const onSheet = surf.sheets.size > 0
    const sel = this.scene
      .query(minX, minY, maxX, maxY)
      .filter((r) => (!onSheet || this.layout.visibleIn(surf, r.pageId)) && strokeInPolygon(r.stroke.points, r.ox, r.oy, poly))
    // 너무 작은 영역(살짝 누른 것)은 획이 없으면 고르지 않는다
    const big = (maxX - minX) * this.cam.zoom > 8 && (maxY - minY) * this.cam.zoom > 8
    this.lassoPoly = sel.length || big ? poly.slice() : null
    this.setSelection(sel)
  }

  /** 획을 월드 좌표로 (dx, dy) 옮긴 새 Entry. paged에서는 시작점이 들어간 페이지로 옮겨 간다 */
  private movedEntry(rec: StrokeRec, dx: number, dy: number, id: ID): Entry {
    const s = rec.stroke
    const sx = s.points[0] + rec.ox + dx
    const sy = s.points[1] + rec.oy + dy
    const t = this.layout.targetAt(sx, sy) ?? { pageId: rec.pageId, key: rec.key, ox: rec.ox, oy: rec.oy }
    const offX = rec.ox + dx - t.ox
    const offY = rec.oy + dy - t.oy
    const pts = s.points.slice()
    for (let i = 0; i < pts.length; i += 4) {
      pts[i] = q2(pts[i] + offX)
      pts[i + 1] = q2(pts[i + 1] + offY)
    }
    return { pageId: t.pageId, key: t.key, stroke: { ...s, id, points: pts, bbox: pointsBBox(pts, s.width) } }
  }

  private setSelection(recs: StrokeRec[]) {
    this.selection = recs
    if (!recs.length && !this.lassoPoly) {
      this.clearSelection()
      return
    }
    // 고른 영역 = 올가미 영역 + 고른 획 (획이 올가미 밖으로 삐져나와도 잡을 수 있게)
    let box: Box | null = this.lassoPoly ? polyBox(this.lassoPoly) : null
    for (const r of recs) box = unionBox(box, r.item)
    this.selectionBox = box
    this.renderer.hidden = recs.length ? new Set(recs.map((r) => r.stroke.id)) : null
    this.committedDirty = true
    this.liveDirty = true
    this.emitSelection()
  }

  private emitSelection() {
    const b = this.selectionBox
    if (!b || !this.cb.onSelection) return
    const d = this.active?.moveFrom ? this.active.moveD : { x: 0, y: 0 }
    const p0 = this.cam.worldToScreen(b.minX + d.x, b.minY + d.y)
    const p1 = this.cam.worldToScreen(b.maxX + d.x, b.maxY + d.y)
    const poly: number[] = []
    const src = this.lassoPoly ?? boxPoly(b)
    for (let i = 0; i < src.length; i += 2) {
      const s = this.cam.worldToScreen(src[i] + d.x, src[i + 1] + d.y)
      poly.push(s.x, s.y)
    }
    this.cb.onSelection({
      count: this.selection.length,
      rect: { x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y },
      poly,
      moving: !!this.active?.moveFrom
    })
  }

  private setCursor(sx: number, sy: number, force = false) {
    if ((this.active && !force) || this.tool === 'lasso') return
    const eraser = this.tool === 'eraser'
    const st = this.tool === 'highlighter' ? this.style.highlighter : this.style.pen
    this.cursor = {
      sx,
      sy,
      radius: eraser ? this.style.eraserSize / 2 : (st.width * this.cam.zoom) / 2,
      kind: eraser ? 'eraser' : 'pen',
      color: st.color
    }
    this.liveDirty = true
  }

  // ─────────────────────────── 터치 제스처 ───────────────────────────

  private liveTouches() {
    return [...this.touches.values()].filter((t) => !t.ignored)
  }

  private newGesture(live: TouchInfo[], count: number, prev?: Gesture | null): Gesture {
    const pts = live.slice(0, Math.max(1, count))
    return {
      startCam: this.cam.clone(),
      startMid: midpoint(pts),
      startDist: count >= 2 ? distance(pts[0], pts[1]) : 0,
      count,
      maxTouches: Math.max(prev?.maxTouches ?? 0, live.length),
      t0: prev?.t0 ?? performance.now(),
      moved: prev?.moved ?? false,
      panning: false,
      samples: []
    }
  }

  private updateGesture() {
    const g = this.gesture
    if (!g) return
    const live = this.liveTouches()
    if (!live.length) return
    for (const t of live) if (Math.hypot(t.x - t.sx, t.y - t.sy) > TAP_SLOP_PX) g.moved = true
    if (live.length >= 3 || g.count === 0) return
    if (g.count === 1) {
      if (this.settings.fingerDraw) return
      const t = live[0]
      if (!g.panning) {
        if (Math.hypot(t.x - g.startMid.x, t.y - g.startMid.y) < TAP_SLOP_PX) return
        g.panning = true
      }
      this.cam.x = g.startCam.x - (t.x - g.startMid.x) / this.cam.zoom
      this.cam.y = g.startCam.y - (t.y - g.startMid.y) / this.cam.zoom
      const now = performance.now()
      g.samples.push({ t: now, x: t.x, y: t.y })
      while (g.samples.length > 2 && now - g.samples[0].t > 100) g.samples.shift()
      this.onCameraMoved()
      return
    }
    const [a, b] = live
    const mid = midpoint([a, b])
    const d = distance(a, b)
    const zoom = clampZoom(g.startCam.zoom * (g.startDist > 0 ? d / g.startDist : 1))
    const w = g.startCam.screenToWorld(g.startMid.x, g.startMid.y)
    this.cam.zoom = zoom
    this.cam.x = w.x - mid.x / zoom
    this.cam.y = w.y - mid.y / zoom
    this.onCameraMoved()
  }

  private endTouch(id: number, normal: boolean) {
    const t = this.touches.get(id)
    if (!t) return
    this.touches.delete(id)
    if (this.active && this.active.pointerId === id) this.finishActive(normal || this.settings.cancelBehavior === 'commit')
    if (t.ignored) {
      if (this.touches.size === 0) this.gesture = null
      return
    }
    const g = this.gesture
    const live = this.liveTouches()
    if (!live.length) {
      if (g && normal && !g.moved && performance.now() - g.t0 < TAP_MAX_MS) {
        if (g.maxTouches === 2) this.undo()
        else if (g.maxTouches === 3) this.redo()
      }
      // 한 손가락 팬 관성
      if (g && g.count === 1 && g.panning && this.settings.momentum && g.samples.length >= 2) {
        const s0 = g.samples[0]
        const s1 = g.samples[g.samples.length - 1]
        const dt = s1.t - s0.t
        if (dt > 0 && performance.now() - s1.t < 60) {
          const vx = (s1.x - s0.x) / dt
          const vy = (s1.y - s0.y) / dt
          if (Math.hypot(vx, vy) > 0.3) this.momentum = { vx, vy, t: performance.now() }
        }
      }
      this.gesture = null
      return
    }
    if (g) {
      const next = this.newGesture(live, Math.min(2, live.length), g)
      next.panning = live.length === 1 && g.moved
      if (live.length === 1 && this.settings.fingerDraw) next.count = 0
      this.gesture = next
    }
  }

  private cancelTouchInteractions() {
    if (this.active && this.active.pointerType === 'touch') this.finishActive(false)
    const g = this.gesture
    if (g && g.count === 1 && g.panning) {
      this.cam.copy(g.startCam)
      this.onCameraMoved()
    }
    for (const t of this.touches.values()) {
      if (!t.ignored) this.palmRejected++
      t.ignored = true
    }
    this.gesture = null
  }

  // ─────────────────────────── 카메라 / 렌더 루프 ───────────────────────────

  private onCameraMoved() {
    if (!this.layout.paged) {
      const bg = this.layout.pages[0]?.background ?? { type: 'dot', spacing: 32, color: '' }
      this.renderer.drawInfiniteBackground(this.cam, bg)
    }
    this.committedDirty = true
    this.pagesDirty = true
    this.liveDirty = true
    this.notifyCamera()
  }

  /**
   * 캔버스의 화면 위치를 다시 읽는다. 노트를 여는 애니메이션처럼 크기는 그대로인 채 자리만 옮겨 가면
   * ResizeObserver가 알려 주지 않아, 처음 읽은 값(애니메이션 도중)이 남아 펜 입력이 몇 px 어긋났다.
   * 입력이 시작될 때마다 부른다 (pointerdown 빈도라 레이아웃 읽기 비용은 무시할 만하다).
   */
  private syncRect() {
    const rect = this.root.getBoundingClientRect()
    this.rectLeft = rect.left
    this.rectTop = rect.top
  }

  private handleResize(force = false) {
    this.syncRect()
    const w = this.root.clientWidth
    const h = this.root.clientHeight
    const r = this.renderer
    if (!force && w === r.cssW && h === r.cssH) return
    if (r.cssW > 1 && r.cssH > 1) {
      const c = this.cam.screenToWorld(r.cssW / 2, r.cssH / 2)
      this.cam.x = c.x - w / 2 / this.cam.zoom
      this.cam.y = c.y - h / 2 / this.cam.zoom
    }
    r.resize(w, h, window.devicePixelRatio || 1, this.settings.resolution)
    r.renderedCam.zoom = NaN
    this.onCameraMoved()
  }

  private frame = (now: number) => {
    this.raf = 0 // 이번 프레임에서 할 일을 다 한 뒤 needsFrame()으로 다음 프레임을 정한다
    this.frameCount++
    const r = this.renderer
    const paged = this.layout.paged

    if (this.momentum) {
      const m = this.momentum
      const dt = Math.min(32, now - m.t)
      m.t = now
      this.cam.x -= (m.vx * dt) / this.cam.zoom
      this.cam.y -= (m.vy * dt) / this.cam.zoom
      const decay = Math.pow(0.95, dt / 16)
      m.vx *= decay
      m.vy *= decay
      if (Math.hypot(m.vx, m.vy) < 0.02) this.momentum = null
      this.onCameraMoved()
    }

    if (this.committedDirty) {
      this.committedDirty = false
      const moving = (this.gesture !== null && this.touches.size > 0) || this.momentum !== null
      const mode = this.settings.gestureRender
      const cheap = r.lastFullMs < AUTO_REDRAW_BUDGET_MS
      const canTransform = Number.isFinite(r.renderedCam.zoom)
      if (moving && canTransform && (mode === 'transform' || (mode === 'auto' && !cheap))) {
        r.applyTransform(this.cam, paged)
        this.stats.renderPath = 'transform'
        clearTimeout(this.settleTimer)
        this.settleTimer = window.setTimeout(() => {
          this.committedDirty = true
          this.pagesDirty = true
          this.settleTimer = 0
        }, GESTURE_SETTLE_MS)
        this.pagesDirty = false
      } else if (!moving && this.settleTimer) {
        r.applyTransform(this.cam, paged)
        this.pagesDirty = false
      } else {
        if (paged) {
          this.pagesDirty = false
          r.drawPages(this.cam, this.layout, this.pdf)
        }
        r.fullRedraw(this.scene, this.cam)
        this.stats.committedMs = r.lastFullMs
        this.stats.renderPath = moving ? 'redraw' : 'idle'
      }
      if (this.selection.length || this.lassoPoly) this.emitSelection()
      this.emitView()
    }

    if (this.pagesDirty && paged && r.inSync(this.cam)) {
      this.pagesDirty = false
      r.drawPages(this.cam, this.layout, this.pdf)
    }

    if (this.liveDirty) {
      this.liveDirty = false
      const t0 = performance.now()
      const a = this.active
      const live: LiveDraw | null =
        a && (a.tool === 'pen' || a.tool === 'highlighter')
          ? { ox: a.ox, oy: a.oy, points: a.points, predicted: a.predicted, width: a.width, color: a.color, opts: a.opts, clip: this.sheetClip(a.pageId) }
          : null
      let overlay: Overlay | null = null
      if (a && a.tool === 'lasso' && !a.moveFrom) overlay = { lasso: a.lasso }
      if (this.selection.length) {
        const d = a?.moveFrom ? a.moveD : { x: 0, y: 0 }
        overlay = { ...(overlay ?? {}), selection: { recs: this.selection, dx: d.x, dy: d.y, scale: 1, cx: 0, cy: 0 } }
        if (a?.moveFrom) this.emitSelection()
      }
      r.drawLive(this.cam, live, this.cursor, overlay)
      const t1 = performance.now()
      this.stats.liveMs = t1 - t0
      if (this.pendingEventTs !== Infinity) {
        const lat = t1 - this.pendingEventTs
        if (lat >= 0 && lat < 1000) {
          this.latencies.push(lat)
          if (this.latencies.length > LAT_SAMPLES) this.latencies.shift()
        }
        this.pendingEventTs = Infinity
      }
    }

    if (now - this.lastStatsAt > 2000) {
      // 쉬다가 깨어났다 — 쉰 시간까지 나누면 fps·이벤트 빈도가 엉터리로 낮게 나오므로 측정을 새로 시작한다
      this.lastStatsAt = now
      this.frameCount = this.eventCount = this.pointCount = this.coalescedTotal = this.coalescedEvents = 0
    } else if (now - this.lastStatsAt >= 500) this.flushStats(now)

    if (this.needsFrame()) this.wake()
  }

  /** 보조 용지 위 획은 용지 안으로 자른다 (확정 레이어와 같게) */
  private sheetClip(pageId: ID): Box | undefined {
    if (!this.layout.isSheet(pageId)) return undefined
    const r = this.layout.rects.get(pageId)
    return r ? { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h } : undefined
  }

  private flushStats(now: number) {
    const dt = (now - this.lastStatsAt) / 1000
    this.lastStatsAt = now
    const s = this.stats
    s.fps = Math.round(this.frameCount / dt)
    s.eventHz = Math.round(this.eventCount / dt)
    s.pointHz = Math.round(this.pointCount / dt)
    if (this.coalescedEvents) s.coalescedPerEvent = +(this.coalescedTotal / this.coalescedEvents).toFixed(1)
    this.frameCount = this.eventCount = this.pointCount = this.coalescedTotal = this.coalescedEvents = 0
    if (this.latencies.length) {
      const sorted = [...this.latencies].sort((a, b) => a - b)
      s.latencyAvg = +(sorted.reduce((x, y) => x + y, 0) / sorted.length).toFixed(1)
      s.latencyP95 = +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))].toFixed(1)
    }
    s.strokes = this.scene.size
    s.visible = this.renderer.visibleCount
    s.zoom = this.cam.zoom
    s.dpr = this.renderer.dpr
    s.canvasPx = this.renderer.canvasPx
    s.palmRejected = this.palmRejected
    s.pdfCache = this.pdf.stats()
    this.cb.onStats?.({ ...s })
  }

  private emitView(force = false) {
    const info: ViewInfo = {
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      zoom: this.cam.zoom,
      currentPage: this.currentPage(),
      pageCount: this.layout.pages.length
    }
    const key = `${info.canUndo}${info.canRedo}${info.zoom.toFixed(3)}${info.currentPage}/${info.pageCount}`
    if (!force && key === this.lastViewKey) return
    this.lastViewKey = key
    this.cb.onView?.(info)
  }

  resetStats() {
    this.latencies = []
    this.palmRejected = 0
    this.stats.latencyAvg = this.stats.latencyP95 = 0
  }

  // ─────────────────────────── 썸네일 ───────────────────────────

  /** 페이지 썸네일 (속지/PDF 저해상도 + 획). 사이드바와 문서 목록에서 쓴다 */
  async renderPageThumb(pageId: ID, width: number): Promise<HTMLCanvasElement | null> {
    const page = this.allPages.get(pageId)
    if (!page) return null
    let w: number, h: number, ox: number, oy: number
    let recs: StrokeRec[]
    if (page.size) {
      const r = this.layout.rects.get(pageId)
      if (!r) return null
      w = page.size.w
      h = page.size.h
      ox = r.x
      oy = r.y
      recs = this.scene.recsOfPage(pageId)
    } else {
      const b = this.scene.bounds() ?? { minX: -400, minY: -300, maxX: 400, maxY: 300 }
      const pad = 40
      ox = b.minX - pad
      oy = b.minY - pad
      w = b.maxX - b.minX + pad * 2
      h = b.maxY - b.minY + pad * 2
      // 썸네일 비율 4:3 이하로
      if (h > w * 1.4) h = w * 1.4
      recs = this.scene.query(ox, oy, ox + w, oy + h)
    }
    const scale = width / w
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(w * scale))
    c.height = Math.max(1, Math.round(h * scale))
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    // 흰 종이만 저장하지 않는다 — 그린 게 없으면(원본 미확보 PDF + 필기 없음, 빈 첫 페이지)
    // null을 돌려준다(io/docThumb.renderPageBlob와 같은 규칙). 흰 사진 카드 방지.
    let drew = false
    if (page.pdf) {
      const bmp = await this.pdfThumb(page, scale)
      if (bmp) {
        ctx.drawImage(bmp, 0, 0, w, h)
        drew = true
      }
    } else if (page.size) {
      drawPattern(ctx, page.background, w, h, scale * 2)
      if (page.background.type !== 'blank') drew = true
    }
    for (const pass of ['under', 'main'] as const) {
      for (const rec of recs) {
        if (rec.stroke.layer !== pass) continue
        ctx.setTransform(scale, 0, 0, scale, (rec.ox - ox) * scale, (rec.oy - oy) * scale)
        ctx.fillStyle = rec.stroke.color
        ctx.fill(getPath(rec))
        drew = true
      }
    }
    if (!drew) return null
    return c
  }

  /**
   * 이미지로 보내기(복사·공유) — 화면 줌과 관계없이 읽기 좋은 해상도로 다시 그린 PNG (흰 바탕).
   *  - { page }: 그 페이지 전체 (무한 캔버스면 지금 보이는 화면)
   *  - 'selection': 올가미 영역을 그 모양대로 자른다 — 고른 획 기준이 아니다. 걸친 획은 경계에서 잘린다
   * background면 종이·속지·PDF까지, 아니면 필기(형광펜 포함)만. 블록(메모·할 일 등)은 PDF 내보내기처럼 담지 않는다.
   * PDF 원본이 이 기기에 없으면 화면에 그릴 때처럼 받아 온다.
   */
  async exportImage(target: { page: number } | 'selection', opts: { background?: boolean; longSide?: number } = {}): Promise<Blob | null> {
    const longSide = opts.longSide ?? 2000
    const background = opts.background ?? true
    let box: Box | null
    let clip: number[] | null = null
    if (target === 'selection') {
      clip = this.lassoPoly ?? (this.selectionBox ? boxPoly(this.selectionBox) : null)
      const b = clip && polyBox(clip)
      const pad = 8
      box = b ? { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad } : null
    } else if (this.layout.paged) {
      const p = this.layout.pages[target.page]
      const r = p && this.layout.rects.get(p.id)
      box = r ? { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h } : null
    } else box = this.renderer.viewBox(this.cam)
    if (!box) return null
    const w = box.maxX - box.minX
    const h = box.maxY - box.minY
    if (w <= 0 || h <= 0) return null
    // 긴 변 longSide px, 작은 영역도 1pt에 4px까지만 (흐릿하게 키우지 않는다), 캔버스 한도 안에서
    let k = Math.min(longSide / Math.max(w, h), 4)
    if (w * h * k * k > 16_000_000) k = Math.sqrt(16_000_000 / (w * h))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(w * k))
    c.height = Math.max(1, Math.round(h * k))
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, c.width, c.height)
    if (clip) {
      // 올가미 모양으로 자른다 — 밖은 흰 바탕. 클립은 그린 때의 변환으로 기기 픽셀에 고정되므로 아래 setTransform과 무관하다
      ctx.setTransform(k, 0, 0, k, -box.minX * k, -box.minY * k)
      ctx.beginPath()
      for (let i = 0; i < clip.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, clip[i], clip[i + 1])
      ctx.closePath()
      ctx.clip()
    }
    if (this.layout.paged && background) {
      for (const p of this.layout.visiblePages(box.minY, box.maxY, box.minX, box.maxX)) {
        const r = this.layout.rects.get(p.id)
        if (!r) continue
        ctx.save()
        ctx.setTransform(k, 0, 0, k, (r.x - box.minX) * k, (r.y - box.minY) * k)
        ctx.beginPath()
        ctx.rect(0, 0, r.w, r.h)
        ctx.clip()
        ctx.fillStyle = p.background.type === 'blank' ? p.background.color : '#ffffff'
        ctx.fillRect(0, 0, r.w, r.h)
        if (p.pdf) {
          const bmp = await this.pdf.getExact(p.pdf, r.w, r.h, k)
          if (bmp) {
            ctx.imageSmoothingQuality = 'high'
            ctx.drawImage(bmp, 0, 0, r.w, r.h)
          }
        } else drawPattern(ctx, p.background, r.w, r.h, k)
        ctx.restore()
      }
    }
    const recs = this.scene.query(box.minX, box.minY, box.maxX, box.maxY)
    for (const pass of ['under', 'main'] as const) {
      for (const rec of recs) {
        if (rec.stroke.layer !== pass) continue
        ctx.setTransform(k, 0, 0, k, (rec.ox - box.minX) * k, (rec.oy - box.minY) * k)
        ctx.fillStyle = rec.stroke.color
        ctx.fill(getPath(rec))
      }
    }
    return new Promise((res) => c.toBlob((b) => res(b), 'image/png'))
  }

  private async pdfThumb(page: Page, scale: number): Promise<CanvasImageSource | null> {
    if (!page.pdf || !page.size) return null
    // 캐시에 있으면 그대로, 없으면 렌더링될 때까지 잠깐 기다린다
    for (let i = 0; i < 40; i++) {
      const bmp = this.pdf.get(page.pdf, page.size.w, page.size.h, Math.max(0.25, scale), false)
      if (bmp) return bmp
      if (this.pdf.isFailed(page.pdf)) return null
      await new Promise((r) => setTimeout(r, 100))
    }
    return null
  }

  async renderDocThumb(): Promise<Blob | null> {
    const first = this.layout.pages[0]
    if (!first) return null
    const c = await this.renderPageThumb(first.id, 320)
    if (!c) return null
    return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.8))
  }

  // ─────────────────────────── 테스트 도구 ───────────────────────────

  stressTest(count: number, areaSize = 20000) {
    const c = this.cam.screenToWorld(this.renderer.cssW / 2, this.renderer.cssH / 2)
    const colors = ['#1f2937ff', '#2563ebff', '#dc2626ff', '#059669ff', '#7c3aedff']
    const list: Entry[] = []
    const opts = strokeOptsFor('pressure', this.settings, 'pen')
    const area = this.layout.paged ? Math.min(areaSize, 500) : areaSize
    for (let i = 0; i < count; i++) {
      let x = c.x + (Math.random() - 0.5) * area
      let y = c.y + (Math.random() - 0.5) * area
      const t = this.layout.targetAt(x, y)
      if (!t) continue
      const n = 12 + Math.floor(Math.random() * 30)
      const pts: number[] = []
      let ang = Math.random() * Math.PI * 2
      for (let j = 0; j < n; j++) {
        pts.push(q2(x - t.ox), q2(y - t.oy), q2(0.3 + Math.random() * 0.5), 8)
        ang += (Math.random() - 0.5) * 1.2
        x += Math.cos(ang) * 6
        y += Math.sin(ang) * 6
      }
      const width = 2 + Math.random() * 3
      list.push({
        pageId: t.pageId,
        key: t.key,
        stroke: {
          id: ulid(), type: 'stroke', tool: 'pen', layer: 'main', z: this.scene.nextZ(),
          createdAt: Date.now(), color: colors[i % colors.length], width, points: pts,
          bbox: pointsBBox(pts, width), opts
        }
      })
    }
    const t0 = performance.now()
    this.exec({ removed: [], added: list })
    return performance.now() - t0
  }

  clearAll() {
    const removed = [...this.scene.recs.values()].map(toEntry)
    if (removed.length) this.exec({ removed, added: [] })
  }
}

// ─────────────────────────── helpers ───────────────────────────

function toEntry(r: StrokeRec): Entry {
  return { stroke: r.stroke, pageId: r.pageId, key: r.key }
}

function midpoint(ts: { x: number; y: number }[]) {
  let x = 0, y = 0
  for (const t of ts) {
    x += t.x
    y += t.y
  }
  return { x: x / ts.length, y: y / ts.length }
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function unionBox(a: Box | null, b: Box): Box {
  if (!a) return { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY }
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY)
  }
}

function eventTimeToPerf(ts: number) {
  const now = performance.now()
  if (ts > now + 60_000) return now - (Date.now() - ts)
  return ts
}

export { PAGE_GAP }

/** 다각형(평탄 [x, y, …])을 (dx, dy)만큼 옮긴 새 배열 */
function shiftPoly(p: number[], dx: number, dy: number): number[] {
  return p.map((v, i) => (i % 2 ? v + dy : v + dx))
}
/** 다각형의 경계 상자 */
function polyBox(p: number[]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < p.length; i += 2) {
    minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i])
    minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1])
  }
  return { minX, minY, maxX, maxY }
}
const boxPoly = (b: Box) => [b.minX, b.minY, b.maxX, b.minY, b.maxX, b.maxY, b.minX, b.maxY]
