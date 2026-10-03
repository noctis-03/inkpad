import { BlockStore, anchorBlock } from './blocks'
import { Camera, clampZoom } from './camera'
import { AUTO_REDRAW_BUDGET_MS, GESTURE_SETTLE_MS, TAP_MAX_MS, TAP_SLOP_PX, WHEEL_ZOOM_SENSITIVITY } from './constants'
import { hitStroke, pointsBBox, q2, splitStroke, strokeInPolygon } from './geometry'
import { History, type Command, type PageSnapshot } from './history'
import { Layout, PAGE_GAP } from './layout'
import { PdfCache } from './pdf/pdfCache'
import { PressureDetector, PRESSURE_LABEL, resolvePressure, strokeOptsFor, type ResolvedPressure } from './pressure'
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
  private momentum: { vx: number; vy: number; t: number } | null = null
  /** 가운데(휠) 버튼 드래그 팬 상태 */
  private middlePan: { id: number; sx: number; sy: number; camX: number; camY: number } | null = null

  // 선택
  private selection: StrokeRec[] = []
  private selectionBox: Box | null = null

  // 렌더
  private raf = 0
  private liveDirty = true
  private committedDirty = true
  private pagesDirty = true
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
  private saveTimer = 0
  private saving: Promise<void> | null = null
  private saveState: SaveState = 'saved'

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
    this.raf = requestAnimationFrame(this.frame)
    this.emitView(true)
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
  }

  setTool(t: Tool) {
    if (t !== 'lasso' && this.selection.length) this.clearSelection()
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
    if (cmd) this.applyCommand(cmd, true)
  }

  redo() {
    if (this.active || this.readOnly) return
    const cmd = this.history.popRedo()
    if (cmd) this.applyCommand(cmd, false)
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
    this.exec({ removed: [], added })
    this.setSelection(added.map((e) => this.scene.recs.get(e.stroke.id)!).filter(Boolean))
  }

  clearSelection(redraw = true) {
    if (!this.selection.length) return
    this.selection = []
    this.selectionBox = null
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
      ...cur,
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
    const removed = this.scene.entriesOfPage(page.id)
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
    const blockCopies = this.blocks
      .ofPage(src.id)
      .map((b) => ({ ...b, id: ulid(), pageId: page.id, createdAt: now, updatedAt: now }) as Block)
    const before = this.snapshot([])
    const order = [...before.order]
    order.splice(index + 1, 0, page.id)
    this.exec({
      removed: [],
      added,
      pagesBefore: before,
      pagesAfter: { order, pages: [page] },
      blocks: blockCopies.map((b) => ({ before: null, after: b })),
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
    this.exec({ removed: [], added: [], pagesBefore: before, pagesAfter: after, label: '페이지 크기' })
  }

  /** 다른 문서/PDF에서 가져온 페이지를 index 뒤에 삽입 (FR-IO-01) */
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
    const blocksOnly = toRemove.length === 0 && toAdd.length === 0 && !snap
    if (blocksOnly) {
      // 캔버스에 그릴 변경 없음 — 블록은 BlockLayer가 렌더한다
    } else if (snap || !box || !this.renderer.inSync(this.cam) || toRemove.length + toAdd.length > 500) {
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
    if (!this.hasPendingChanges || this.readOnly) {
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
    const liveIds = new Set(this.layout.pages.map((p) => p.id))
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
      doc: order ? { pageOrder: this.layout.pages.map((p) => p.id) } : undefined
    }
    if (order) this.doc = { ...this.doc, pageOrder: batch.doc!.pageOrder! }
    this.setSaveState('saving')
    this.saving = (async () => {
      try {
        await this.persist(batch)
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
    // 백그라운드 전환/종료 시 디바운스를 기다리지 않고 바로 기록 (설계 8장 4)
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
    this.capture(e.pointerId)
    this.touches.set(e.pointerId, t)
    if (this.active && this.active.pointerType === 'touch') this.finishActive(false)

    const live = this.liveTouches()
    if (live.length === 1 && this.settings.fingerDraw && !this.readOnly) {
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
            ? e.getPredictedEvents().map((ev) => this.toChunkPoint(a, ev))
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
      removed: new Map(),
      added: new Map(),
      lasso: [],
      moveFrom: null,
      moveD: { x: 0, y: 0 }
    }
    if (tool === 'lasso') {
      const sb = this.selectionBox
      const pad = 12 / this.cam.zoom
      if (sb && w.x >= sb.minX - pad && w.x <= sb.maxX + pad && w.y >= sb.minY - pad && w.y <= sb.maxY + pad) {
        a.moveFrom = w
      } else if (this.selection.length) {
        this.clearSelection()
      }
    }
    this.active = a
    this.cursor = null
    this.markEvent(e)
    this.addPoint(a, e)
    this.liveDirty = true
  }

  private pressureOf(ev: PointerEvent, a: ActiveStroke, record = true) {
    if (record && a.pointerType === 'pen') a.raw.push(ev.pressure)
    if (a.pressure !== 'pressure') return 0.5
    let p = ev.pressure
    if (!(p > 0)) {
      // 일부 이벤트는 0을 보낸다 → 직전 값 유지
      const n = a.points.length
      return n >= 4 ? a.points[n - 2] : 0.5
    }
    p = Math.min(1, p)
    const g = this.settings.pressureGamma
    if (g !== 1) p = Math.pow(p, g)
    return Math.max(this.settings.minPressure, p)
  }

  private toChunkPoint(a: ActiveStroke, ev: PointerEvent): number[] {
    const p = this.local(ev)
    const w = this.cam.screenToWorld(p.x, p.y)
    return [w.x - a.ox, w.y - a.oy, a.pressure === 'pressure' ? this.pressureOf(ev, a, false) : 0.5]
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
      } else {
        const l = a.lasso
        const n = l.length
        if (n < 2 || Math.hypot(w.x - l[n - 2], w.y - l[n - 1]) * this.cam.zoom > 3) l.push(w.x, w.y)
      }
      return
    }
    const pr = this.pressureOf(ev, a)
    const qx = q2(w.x - a.ox), qy = q2(w.y - a.oy)
    const n = a.points.length
    if (n >= 4 && a.points[n - 4] === qx && a.points[n - 3] === qy) {
      a.points[n - 2] = q2(Math.max(a.points[n - 2], pr))
      return
    }
    const dt = Math.max(0, Math.round(ev.timeStamp - a.lastT))
    a.lastT = ev.timeStamp
    a.points.push(qx, qy, q2(pr), dt)
  }

  private eraseAt(a: ActiveStroke, wx: number, wy: number) {
    const r = this.style.eraserSize / 2 / this.cam.zoom
    const partial = this.settings.eraserMode === 'partial'
    let box: Box | null = null
    for (const rec of this.scene.query(wx - r, wy - r, wx + r, wy + r)) {
      const s = rec.stroke
      const lx = wx - rec.ox, ly = wy - rec.oy
      if (partial) {
        const pieces = splitStroke(s.points, lx, ly, r + s.width * 0.35)
        if (!pieces) continue
        this.eraseRec(a, rec)
        for (const pts of pieces) {
          const piece: Entry = {
            pageId: rec.pageId,
            key: rec.key,
            stroke: { ...s, id: ulid(), points: pts, bbox: pointsBBox(pts, s.width) }
          }
          this.scene.add(piece)
          a.added.set(piece.stroke.id, piece)
        }
      } else {
        if (!hitStroke(s.points, lx, ly, r + s.width / 2)) continue
        this.eraseRec(a, rec)
      }
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
      if (stroke.layer === 'under') this.renderer.redrawRegion(this.scene, this.cam, rec.item)
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
    const sel = this.scene.query(minX, minY, maxX, maxY).filter((r) => strokeInPolygon(r.stroke.points, r.ox, r.oy, poly))
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
    if (!recs.length) {
      this.clearSelection()
      return
    }
    let box: Box | null = null
    for (const r of recs) box = unionBox(box, r.item)
    this.selectionBox = box
    this.renderer.hidden = new Set(recs.map((r) => r.stroke.id))
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
    this.cb.onSelection({
      count: this.selection.length,
      rect: { x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y },
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

  private handleResize(force = false) {
    const rect = this.root.getBoundingClientRect()
    this.rectLeft = rect.left
    this.rectTop = rect.top
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
    this.raf = requestAnimationFrame(this.frame)
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
      if (this.selection.length) this.emitSelection()
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
          ? { ox: a.ox, oy: a.oy, points: a.points, predicted: a.predicted, width: a.width, color: a.color, opts: a.opts }
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

    if (now - this.lastStatsAt >= 500) this.flushStats(now)
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
    if (page.pdf) {
      const bmp = await this.pdfThumb(page, scale)
      if (bmp) ctx.drawImage(bmp, 0, 0, w, h)
    } else if (page.size) drawPattern(ctx, page.background, w, h, scale * 2)
    for (const pass of ['under', 'main'] as const) {
      for (const rec of recs) {
        if (rec.stroke.layer !== pass) continue
        ctx.setTransform(scale, 0, 0, scale, (rec.ox - ox) * scale, (rec.oy - oy) * scale)
        ctx.fillStyle = rec.stroke.color
        ctx.fill(getPath(rec))
      }
    }
    return c
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
