import { getAsset } from '../../storage/repo'
import { closePdf, openPdf, PdfPasswordError, type PDFDocumentProxy, type PDFPageProxy } from './pdfjs'
import type { ID, PdfRef } from '../../shared/model'

interface Bitmap {
  key: string
  canvas: HTMLCanvasElement
  pixels: number
  lastUsed: number
}

const MAX_BITMAP_PIXELS = 48_000_000 // 비트맵 캐시 총량 (약 190MB RGBA). NFR-04

/**
 * PDF 페이지 비트맵 캐시.
 *  - 줌 단계(2의 거듭제곱)별 해상도로 렌더링하고, 총 픽셀 수 기준 LRU로 해제한다.
 *  - 렌더링은 한 번에 하나씩 (화면에 보이는 페이지 우선), 결과가 나오면 onReady 호출.
 */
export class PdfCache {
  private docs = new Map<ID, Promise<PDFDocumentProxy>>()
  private pages = new Map<string, Promise<PDFPageProxy>>()
  private bitmaps = new Map<string, Bitmap>()
  private pixels = 0
  private queue: { key: string; ref: PdfRef; scale: number; w: number; h: number }[] = []
  private queued = new Set<string>()
  private running = false
  private failed = new Set<string>()
  onReady: () => void = () => {}
  passwordProvider: ((assetId: ID, incorrect: boolean) => Promise<string | null>) | null = null
  /** 원본이 이 기기에 없을 때 받아오는 훅 (지연 로딩 A안 ②). 실패하면 예외를 던진다 */
  assetProvider: ((assetId: ID) => Promise<Blob>) | null = null
  /** 원본 확보 실패 시 사용자에게 알릴 메시지 전달 */
  onAssetError: ((assetId: ID, message: string) => void) | null = null

  doc(assetId: ID): Promise<PDFDocumentProxy> {
    let p = this.docs.get(assetId)
    if (!p) {
      p = (async () => {
        let row = await getAsset(assetId)
        if (!row) throw new Error('이 PDF의 원본 정보가 없습니다.')
        if (!row.blob && this.assetProvider) {
          // 지연 로딩: 이 기기에 원본이 없으면 지금 받아온다 (동기화 "받기"는 메타데이터만 받음)
          try {
            row = { ...row, blob: await this.assetProvider(assetId) }
          } catch (e) {
            const msg = e instanceof Error ? e.message : 'PDF 원본을 받지 못했습니다.'
            this.onAssetError?.(assetId, msg)
            throw new Error(msg)
          }
        }
        if (!row.blob) throw new Error('PDF 원본이 이 기기에 없습니다.')
        const buf = await row.blob.arrayBuffer()
        let password: string | undefined
        for (;;) {
          try {
            return await openPdf(buf, password)
          } catch (e) {
            if (!(e instanceof PdfPasswordError) || !this.passwordProvider) throw e
            const pw = await this.passwordProvider(assetId, !!password)
            if (pw == null) throw e
            password = pw
          }
        }
      })()
      p.catch(() => this.docs.delete(assetId))
      this.docs.set(assetId, p)
    }
    return p
  }

  private page(ref: PdfRef): Promise<PDFPageProxy> {
    const k = `${ref.assetId}:${ref.pageIndex}`
    let p = this.pages.get(k)
    if (!p) {
      p = this.doc(ref.assetId).then((d) => d.getPage(ref.pageIndex + 1))
      p.catch(() => this.pages.delete(k))
      this.pages.set(k, p)
    }
    return p
  }

  /** 줌에 맞는 해상도 단계 (1pt → 화면 px). 2의 거듭제곱으로 끊어서 캐시 적중률을 높인다 */
  static levelFor(pxPerPt: number) {
    const l = Math.pow(2, Math.ceil(Math.log2(Math.max(0.25, pxPerPt))))
    return Math.min(l, 8)
  }

  /**
   * 그릴 비트맵을 돌려준다. 원하는 해상도가 없으면 가장 가까운 해상도를 대신 주고 렌더링을 예약한다.
   * w, h: 페이지 크기(pt)
   */
  get(ref: PdfRef, w: number, h: number, pxPerPt: number, priority: boolean): HTMLCanvasElement | null {
    const want = PdfCache.levelFor(pxPerPt)
    // 캔버스 한 장이 너무 커지지 않게 (Safari 캔버스 한도)
    let level = want
    while (level > 0.25 && w * h * level * level > 16_000_000) level /= 2
    const key = `${ref.assetId}:${ref.pageIndex}:${ref.rotation}:${level}`
    const hit = this.bitmaps.get(key)
    if (hit) {
      hit.lastUsed = performance.now()
      return hit.canvas
    }
    if (!this.failed.has(key)) this.enqueue(key, ref, level, w, h, priority)
    // 대체: 같은 페이지의 다른 해상도 중 가장 큰 것
    let best: Bitmap | null = null
    const prefix = `${ref.assetId}:${ref.pageIndex}:${ref.rotation}:`
    for (const b of this.bitmaps.values()) {
      if (b.key.startsWith(prefix) && (!best || b.pixels > best.pixels)) best = b
    }
    if (best) best.lastUsed = performance.now()
    return best?.canvas ?? null
  }

  isFailed(ref: PdfRef) {
    for (const k of this.failed) if (k.startsWith(`${ref.assetId}:${ref.pageIndex}:`)) return true
    return false
  }

  private enqueue(key: string, ref: PdfRef, scale: number, w: number, h: number, priority: boolean) {
    if (this.queued.has(key)) {
      if (priority) {
        const i = this.queue.findIndex((q) => q.key === key)
        if (i > 0) this.queue.unshift(...this.queue.splice(i, 1))
      }
      return
    }
    this.queued.add(key)
    const job = { key, ref, scale, w, h }
    if (priority) this.queue.unshift(job)
    else this.queue.push(job)
    // 대기열이 너무 길면 오래된 비우선 작업을 버린다 (빠르게 스크롤할 때)
    while (this.queue.length > 24) this.queued.delete(this.queue.pop()!.key)
    void this.pump()
  }

  /** 화면에서 벗어난 페이지의 대기 작업 취소 */
  retain(visibleKeys: Set<string>) {
    this.queue = this.queue.filter((q) => {
      const keep = visibleKeys.has(`${q.ref.assetId}:${q.ref.pageIndex}`)
      if (!keep) this.queued.delete(q.key)
      return keep
    })
  }

  private async pump() {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!
        try {
          await this.render(job)
        } catch (e) {
          console.warn('PDF 렌더링 실패', job.key, e)
          this.failed.add(job.key)
        }
        this.queued.delete(job.key)
        this.onReady()
      }
    } finally {
      this.running = false
    }
  }

  private async render(job: { key: string; ref: PdfRef; scale: number; w: number; h: number }) {
    const page = await this.page(job.ref)
    const vp = page.getViewport({ scale: job.scale, rotation: (page.rotate + job.ref.rotation) % 360 })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(vp.width))
    canvas.height = Math.max(1, Math.round(vp.height))
    const ctx = canvas.getContext('2d', { alpha: false })!
    await page.render({ canvas: null, canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise
    const pixels = canvas.width * canvas.height
    this.bitmaps.set(job.key, { key: job.key, canvas, pixels, lastUsed: performance.now() })
    this.pixels += pixels
    this.evict()
  }

  private evict() {
    if (this.pixels <= MAX_BITMAP_PIXELS) return
    const list = [...this.bitmaps.values()].sort((a, b) => a.lastUsed - b.lastUsed)
    for (const b of list) {
      if (this.pixels <= MAX_BITMAP_PIXELS * 0.75) break
      this.bitmaps.delete(b.key)
      this.pixels -= b.pixels
      b.canvas.width = b.canvas.height = 0 // Safari: 메모리 즉시 해제
    }
  }

  /** 메모리 압박 시 (16.2) */
  trim() {
    for (const b of this.bitmaps.values()) b.canvas.width = b.canvas.height = 0
    this.bitmaps.clear()
    this.pixels = 0
  }

  stats() {
    return `${this.bitmaps.size}장 ${(this.pixels / 1e6).toFixed(1)}MP`
  }

  async destroy() {
    this.trim()
    this.queue = []
    for (const p of this.docs.values()) p.then((d) => closePdf(d)).catch(() => {})
    this.docs.clear()
    this.pages.clear()
  }
}
