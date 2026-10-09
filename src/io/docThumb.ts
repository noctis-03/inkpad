// 노트 카드 미리보기(썸네일)를 이 기기에서 다시 만든다.
//
// 미리보기는 Drive로 동기화하지 않는다(로컬 전용). 대신 동기화로 들어온 "내용"(페이지·획·배경)과
// 이 기기에 확보된 원본(PDF)으로 첫 페이지를 그려 미리보기를 복구한다.
// 이렇게 하면 다른 기기에서 받은 노트도, 원본만 확보되면 카드 미리보기가 뜬다.
import { db, type ThumbRow } from '../storage/db'
import { loadDocument, putThumbnail } from '../storage/repo'
import { drawPattern } from '../engine/background'
import { getPath } from '../engine/scene'
import { closePdf, openPdf } from '../engine/pdf/pdfjs'
import { useUI } from '../app/store'
import type { ID, Page, Stroke } from '../shared/model'

const THUMB_W = 320

/** 미리보기가 새로 만들어졌을 때 라이브러리 카드가 즉시 다시 읽도록 알린다 */
export const THUMBS_EVENT = 'inkpad-thumbs-changed'
const thumbsChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('inkpad-thumbs') : null
if (thumbsChannel) thumbsChannel.onmessage = () => window.dispatchEvent(new Event(THUMBS_EVENT))
export function emitThumbsChanged() {
  window.dispatchEvent(new Event(THUMBS_EVENT))
  thumbsChannel?.postMessage(Date.now())
}


/** 획을 아래 레이어(형광펜) → 위 레이어(펜) 순, 같은 레이어는 z 순으로. */
const byLayerZ = (a: Stroke, b: Stroke) => (a.layer === b.layer ? a.z - b.z : a.layer === 'under' ? -1 : 1)

/**
 * 페이지 1장을 320px JPEG로 그린다.
 * PDF 원본이 이 기기에 있고 그릴 수 있으면 PDF 위에 필기를 얹고,
 * 없으면 배경(속지) 위에 필기만 그린다.
 * 아무것도 그릴 게 없으면(빈 배경 + 필기 없음, 혹은 PDF 원본 미확보 + 필기 없음) null.
 */
async function renderPageBlob(page: Page, strokes: Stroke[]): Promise<Blob | null> {
  if (!page.size) return null // 무한 캔버스는 이 경로에서 제외 (엔진 렌더가 담당)
  const { w, h } = page.size
  const scale = THUMB_W / w
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.setTransform(scale, 0, 0, scale, 0, 0)

  let drew = false
  if (page.pdf) {
    // 원본 지연 로딩 원칙: 여기서 새로 받아오지 않는다. 이미 이 기기에 있으면 그린다.
    const asset = await db.assets.get(page.pdf.assetId)
    if (asset?.blob) {
      const pdf = await openPdf(await asset.blob.arrayBuffer()).catch(() => null)
      if (pdf) {
        try {
          const p = await pdf.getPage(1)
          const base = p.getViewport({ scale: 1, rotation: p.rotate })
          const vp = p.getViewport({ scale: w / base.width, rotation: p.rotate })
          const c = document.createElement('canvas')
          c.width = Math.max(1, Math.round(vp.width))
          c.height = Math.max(1, Math.round(vp.height))
          await p.render({ canvas: null, canvasContext: c.getContext('2d')!, viewport: vp }).promise
          ctx.drawImage(c, 0, 0, w, h)
          drew = true
        } catch {
          /* 원본을 그리지 못하면 필기만 */
        } finally {
          await closePdf(pdf)
        }
      }
    }
  } else {
    drawPattern(ctx, page.background, w, h, scale * 2)
    if (page.background.type !== 'blank') drew = true
  }

  if (strokes.length) {
    for (const s of [...strokes].sort(byLayerZ)) {
      ctx.fillStyle = s.color
      ctx.fill(getPath({ stroke: s }))
    }
    drew = true
  }
  if (!drew) return null // 빈 미리보기를 저장하지 않는다 (원본 미확보 PDF가 흰 카드가 되는 것 방지)

  return await new Promise((res) => canvas.toBlob((b) => res(b), 'image/jpeg', 0.8))
}

/** 문서 첫 페이지로 미리보기를 다시 만든다. 문서가 없거나 그릴 게 없으면 false. */
export async function regenerateThumbnail(docId: ID): Promise<boolean> {
  const { pages, chunks } = await loadDocument(docId)
  const first = pages[0]
  if (!first) return false
  const strokes = chunks
    .filter((c) => c.pageId === first.id)
    .flatMap((c) => c.elements)
    .filter((e): e is Stroke => e.type === 'stroke')
  const blob = await renderPageBlob(first, strokes)
  if (!blob) return false
  await putThumbnail(docId, blob)
  return true
}

/** 이 문서에 미리보기가 이미 저장돼 있는지 */
export async function hasThumbnail(docId: ID): Promise<boolean> {
  return !!(await db.thumbnails.get(docId))
}

/** 미리보기가 없는 문서 id만 고른다. docIds를 주면 그중에서만, 없으면 전체(휴지통 제외). */
async function collectMissingThumbnails(docIds?: ID[]): Promise<ID[]> {
  const have = new Set<ID>(await db.thumbnails.toCollection().primaryKeys())
  let ids = docIds
  if (!ids) {
    const docs = await db.documents.toArray()
    ids = docs.filter((d) => !d.deletedAt).map((d) => d.id)
  }
  return ids.filter((id) => !have.has(id))
}

/**
 * 아직 미리보기가 없는 문서들만 골라 다시 만든다 (알림 없음).
 * 실패는 삼킨다 — 미리보기는 선택 사항이다.
 */
export async function refreshMissingThumbnails(docIds?: ID[]): Promise<void> {
  let made = 0
  for (const id of await collectMissingThumbnails(docIds)) {
    try {
      if (await regenerateThumbnail(id)) made++
    } catch {
      /* 미리보기는 선택 사항 */
    }
  }
  if (made) emitThumbsChanged()
}

/**
 * refreshMissingThumbnails와 같지만 진행/완료 토스트를 띄운다.
 * 만들 게 없으면 토스트를 띄우지 않는다. 만들어진 개수를 돌려준다.
 */
export async function refreshMissingThumbnailsWithToast(docIds?: ID[]): Promise<number> {
  const missing = await collectMissingThumbnails(docIds)
  if (!missing.length) return 0
  const sticky = useUI.getState().toast(`미리보기를 만드는 중… (${missing.length}개)`, 'info', undefined, { sticky: true })
  let made = 0
  for (const id of missing) {
    try {
      if (await regenerateThumbnail(id)) made++
    } catch {
      /* 미리보기는 선택 사항 */
    }
  }
  useUI.getState().dismissToast(sticky)
  if (made) {
    useUI.getState().toast(`미리보기 ${made}개를 만들었습니다.`, 'success')
    emitThumbsChanged() // 라이브러리 카드가 새로고침 없이 즉시 갱신된다
  }
  return made
}

export type { ThumbRow }
