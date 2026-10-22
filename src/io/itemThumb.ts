// 앱·기타 파일 카드 미리보기(썸네일). 노트 미리보기와 같이 로컬 전용 — Drive로 동기화하지 않는다.
//
// - 파일: 이 기기에 원본이 있을 때 이미지 · PDF 첫 쪽 · 텍스트 앞부분을 그린다.
//   미리보기를 만들려고 원본을 내려받지는 않는다(지연 로딩 원칙) — 한 번 열어 원본이 생기면 그때 만든다.
// - 앱: 앱이 sandbox iframe 안에서 스스로 화면을 찍어 보낸다(AppRunner · bridge). 밖에서는 화면을 읽을 수 없다.
// 만들 수 없으면(원본 없음, 시트 등 그릴 수 없는 형식, 한 번도 실행하지 않은 앱) 카드는 아이콘을 보인다.
import { db, type FileRow } from '../storage/db'
import { extOf, type HtmlApp, type ID } from '../shared/model'
import { closePdf, openPdf } from '../engine/pdf/pdfjs'
import { emitThumbsChanged } from './docThumb'

/** 카드 비율(1 : 1.30 — .doc-grid .doc-thumb)로 자른 320px JPEG */
const THUMB_W = 320
const THUMB_H = Math.round(THUMB_W * 1.3)

export const appThumbKey = (id: ID) => 'app:' + id
export const fileThumbKey = (id: ID) => 'file:' + id

export async function getItemThumbRows(): Promise<Map<string, { blob: Blob; updatedAt: number }>> {
  const rows = await db.itemThumbs.toArray()
  return new Map(rows.map((r) => [r.key, { blob: r.blob, updatedAt: r.updatedAt }]))
}

export async function putItemThumb(key: string, blob: Blob) {
  await db.itemThumbs.put({ key, blob, updatedAt: Date.now() })
}

type Src = ImageBitmap | HTMLImageElement | HTMLCanvasElement

/**
 * 카드에 맞춰 남기는 곳
 * - 'top' · 'center': 카드 비율로 자른다 — 넓으면 가로 가운데, 길면 위(top) · 가운데(center)
 * - 'screen'(앱 화면): 폭은 다 살린다 — 가로로 긴 화면은 위에 붙이고 아래는 화면 바닥색으로 잇는다
 */
type Fit = 'top' | 'center' | 'screen'

/** 그림을 카드 비율(THUMB_W × THUMB_H) JPEG로 만든다. 투명한 곳은 흰 종이 */
function cropToCard(src: Src, sw: number, sh: number, fit: Fit): Promise<Blob | null> {
  if (!sw || !sh) return Promise.resolve(null)
  const c = document.createElement('canvas')
  c.width = THUMB_W
  c.height = THUMB_H
  const ctx = c.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, THUMB_W, THUMB_H)
  ctx.imageSmoothingQuality = 'high'
  const ratio = THUMB_H / THUMB_W
  if (fit === 'screen' && sh < sw * ratio) {
    const dh = Math.max(1, Math.round((sh * THUMB_W) / sw))
    ctx.drawImage(src, 0, 0, sw, sh, 0, 0, THUMB_W, dh)
    const [r, g, b] = ctx.getImageData(1, dh - 1, 1, 1).data // 화면 바닥 왼쪽 점의 색으로 아래를 채운다
    ctx.fillStyle = `rgb(${r},${g},${b})`
    ctx.fillRect(0, dh, THUMB_W, THUMB_H - dh)
  } else {
    let cw = sw
    let ch = sw * ratio
    if (ch > sh) {
      ch = sh
      cw = sh / ratio
    }
    const cy = fit === 'center' ? (sh - ch) / 2 : 0
    ctx.drawImage(src, (sw - cw) / 2, cy, cw, ch, 0, 0, THUMB_W, THUMB_H)
  }
  return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.8))
}

/** 이미지 Blob을 그린다 — createImageBitmap이 못 읽는 형식(SVG 등)은 <img>로 (스크립트는 돌지 않는다) */
async function decode(blob: Blob): Promise<{ src: Src; w: number; h: number; close: () => void }> {
  try {
    const bmp = await createImageBitmap(blob)
    return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() }
  } catch {
    const url = URL.createObjectURL(blob)
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      return { src: img, w: img.naturalWidth, h: img.naturalHeight, close: () => {} }
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}

/** 이미지 Blob → 카드 미리보기. 읽을 수 없으면 null */
export async function imageToThumb(blob: Blob, fit: Fit): Promise<Blob | null> {
  const d = await decode(blob).catch(() => null)
  if (!d) return null
  try {
    return await cropToCard(d.src, d.w, d.h, fit)
  } finally {
    d.close()
  }
}

async function pdfToThumb(blob: Blob): Promise<Blob | null> {
  const pdf = await openPdf(await blob.arrayBuffer()).catch(() => null) // 암호·손상 PDF는 아이콘으로
  if (!pdf) return null
  try {
    const p = await pdf.getPage(1)
    const base = p.getViewport({ scale: 1, rotation: p.rotate })
    const vp = p.getViewport({ scale: THUMB_W / base.width, rotation: p.rotate })
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(vp.width))
    c.height = Math.max(1, Math.round(vp.height))
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, c.width, c.height)
    await p.render({ canvas: null, canvasContext: ctx, viewport: vp }).promise
    return await cropToCard(c, c.width, c.height, 'top')
  } finally {
    await closePdf(pdf)
  }
}

/** 텍스트 앞부분을 흰 종이에 고정폭 글꼴로 — 줄이 넘치면 글자 단위로 접는다 */
function textToThumb(text: string): Promise<Blob | null> {
  const pad = 16
  const lh = 17
  const c = document.createElement('canvas')
  c.width = THUMB_W
  c.height = THUMB_H
  const ctx = c.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, THUMB_W, THUMB_H)
  ctx.fillStyle = '#2b2a26'
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  ctx.textBaseline = 'top'
  const maxW = THUMB_W - pad * 2
  const maxLines = Math.floor((THUMB_H - pad * 2) / lh)
  const lines: string[] = []
  for (const raw of text.slice(0, 4000).replace(/\t/g, '  ').split(/\r?\n/)) {
    let cur = ''
    for (const ch of raw) {
      if (ctx.measureText(cur + ch).width > maxW) {
        lines.push(cur)
        cur = ch
      } else cur += ch
    }
    lines.push(cur)
    if (lines.length >= maxLines) break
  }
  if (!lines.some((l) => l.trim())) return Promise.resolve(null) // 빈 파일은 아이콘으로
  lines.slice(0, maxLines).forEach((l, i) => ctx.fillText(l, pad, pad + i * lh))
  return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.8))
}

/** 파일 미리보기를 그린다. 원본이 이 기기에 없거나 그릴 수 없는 형식이면 null */
export async function renderFileThumb(f: FileRow): Promise<Blob | null> {
  if (f.kind === 'text') return f.text !== undefined ? textToThumb(f.text) : null
  if (!f.blob) return null
  if (f.kind === 'image') return imageToThumb(f.blob, 'center')
  if (extOf(f.name) === 'pdf' || f.mime === 'application/pdf') return pdfToThumb(f.blob)
  return null
}

const hasOriginal = (f: FileRow) => f.text !== undefined || !!f.blob
/** 이번 실행에서 그려 보고 못 그린 파일(id:수정 시각) — 목록을 다시 읽을 때마다 되풀이하지 않는다 */
const failed = new Set<string>()
let running: Promise<void> = Promise.resolve()

/**
 * 라이브러리가 목록을 읽을 때 부른다.
 * - 원본이 이 기기에 있는데 미리보기가 없는 파일만 그린다 (하나씩, 실패는 삼킨다 — 미리보기는 선택 사항)
 * - 사라진 앱·파일의 미리보기는 지운다
 * 겹쳐 불리면 앞의 일이 끝난 뒤 이어서 한다.
 */
export function syncItemThumbs(apps: HtmlApp[], files: FileRow[]): Promise<void> {
  running = running.then(async () => {
    const keys = new Set<string>(await db.itemThumbs.toCollection().primaryKeys())
    const live = new Set([...apps.map((a) => appThumbKey(a.id)), ...files.map((f) => fileThumbKey(f.id))])
    const gone = [...keys].filter((k) => !live.has(k))
    if (gone.length) await db.itemThumbs.bulkDelete(gone)
    let made = 0
    for (const f of files) {
      const key = fileThumbKey(f.id)
      const tried = f.id + ':' + f.updatedAt
      if (keys.has(key) || !hasOriginal(f) || failed.has(tried)) continue
      try {
        const blob = await renderFileThumb(f)
        if (blob) {
          await putItemThumb(key, blob)
          made++
        } else failed.add(tried)
      } catch {
        failed.add(tried)
      }
    }
    if (made || gone.length) emitThumbsChanged()
  }).catch(() => {}) // 미리보기는 선택 사항 — 다음 호출이 막히지 않게
  return running
}
