import { getAsset } from '../storage/repo'
import { AssetDownloadCancelledError } from '../sync/assets'
import type { ID } from '../shared/model'

/** 넣을 때 긴 변을 이 크기(px)까지 줄인다 — 아이패드 카메라 사진(4032px)은 원본·동기화·메모리 모두 무겁다 */
export const IMAGE_MAX_SIDE = 2048

interface Slot {
  bmp: ImageBitmap | null
  failed: boolean
}

/**
 * 사진 비트맵 캐시 (원본 에셋 → ImageBitmap).
 *  - 처음 그릴 때 이 기기의 원본을 풀고, 없으면 PDF처럼 받아 온다(assetProvider) — 다 되면 onReady
 *  - 노트를 닫으면(엔진 정리) 모두 놓는다
 */
export class ImageCache {
  private slots = new Map<ID, Slot>()
  private loading = new Map<ID, Promise<ImageBitmap | null>>()
  onReady: () => void = () => {}
  /** 원본이 이 기기에 없을 때 받아오는 훅 (PdfCache와 같은 것을 쓴다) */
  assetProvider: (() => ((assetId: ID) => Promise<Blob>) | null) | null = null
  onAssetError: ((assetId: ID, message: string) => void) | null = null

  /** 지금 그릴 수 있으면 비트맵, 아니면 null (불러오기를 시작한다) */
  get(assetId: ID): ImageBitmap | null {
    const s = this.slots.get(assetId)
    if (s) return s.bmp
    void this.load(assetId)
    return null
  }

  isFailed(assetId: ID) {
    return !!this.slots.get(assetId)?.failed
  }

  /** 다 불러올 때까지 기다린다 (썸네일·이미지로 보내기) */
  async ready(assetId: ID): Promise<ImageBitmap | null> {
    const s = this.slots.get(assetId)
    if (s) return s.bmp
    return this.load(assetId)
  }

  /** 방금 넣은 사진 — 이미 디코딩한 비트맵을 그대로 쓴다 */
  put(assetId: ID, bmp: ImageBitmap) {
    this.slots.get(assetId)?.bmp?.close()
    this.slots.set(assetId, { bmp, failed: false })
  }

  private load(assetId: ID): Promise<ImageBitmap | null> {
    let p = this.loading.get(assetId)
    if (p) return p
    p = (async () => {
      try {
        const row = await getAsset(assetId)
        if (!row) throw new Error('이 사진의 원본 정보가 없습니다.')
        let blob = row.blob
        const provider = this.assetProvider?.()
        if (!blob && provider) {
          try {
            blob = await provider(assetId)
          } catch (e) {
            const msg = e instanceof Error ? e.message : '사진 원본을 받지 못했습니다.'
            if (!(e instanceof AssetDownloadCancelledError)) this.onAssetError?.(assetId, msg)
            throw e
          }
        }
        if (!blob) throw new Error('사진 원본이 이 기기에 없습니다.')
        const bmp = await createImageBitmap(blob)
        this.slots.set(assetId, { bmp, failed: false })
        return bmp
      } catch (e) {
        console.warn('[images] 사진을 불러오지 못했습니다.', assetId, e)
        this.slots.set(assetId, { bmp: null, failed: true })
        return null
      } finally {
        this.loading.delete(assetId)
        this.onReady()
      }
    })()
    this.loading.set(assetId, p)
    return p
  }

  clear() {
    for (const s of this.slots.values()) s.bmp?.close()
    this.slots.clear()
  }
}

/**
 * 고른 사진 파일을 노트에 넣을 형태로 — 긴 변 IMAGE_MAX_SIDE 이하, PNG·JPEG만.
 * 이미 작은 PNG(스크린샷 등)는 원본 그대로. 나머지는 다시 그려 저장한다 — JPEG의 EXIF 회전을 픽셀에 굽고
 * (PDF 내보내기는 EXIF를 보지 않는다) 위치 정보 같은 메타데이터도 함께 떨어진다.
 * 투명할 수 있는 형식(PNG·WebP·GIF)은 PNG로, 나머지는 JPEG로
 */
export async function prepareImage(file: Blob): Promise<{ blob: Blob; mime: string; bmp: ImageBitmap; w: number; h: number }> {
  const src = await createImageBitmap(file)
  const long = Math.max(src.width, src.height)
  const keep = file.type === 'image/png' && long <= IMAGE_MAX_SIDE
  if (keep) return { blob: file, mime: file.type, bmp: src, w: src.width, h: src.height }
  const k = Math.min(1, IMAGE_MAX_SIDE / long)
  const w = Math.max(1, Math.round(src.width * k))
  const h = Math.max(1, Math.round(src.height * k))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, w, h)
  src.close()
  const mime = /png|webp|gif/.test(file.type) ? 'image/png' : 'image/jpeg'
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, mime, 0.9))
  if (!blob) throw new Error('사진을 변환하지 못했습니다.')
  const bmp = await createImageBitmap(c)
  c.width = c.height = 0
  return { blob, mime, bmp, w, h }
}
