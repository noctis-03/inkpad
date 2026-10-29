import { closePdf, openPdf, PdfPasswordError, type PDFDocumentProxy } from '../engine/pdf/pdfjs'
import { MAX_IMPORT_BYTES, a4FitFactor, farFromA4, makeBackground, type Page } from '../shared/model'
import { createDocument, makePage, putAsset, putThumbnail, type NewPageSpec } from '../storage/repo'
import { rememberPassword } from './passwords'

export type PasswordPrompt = (incorrect: boolean) => Promise<string | null>

export class ImportError extends Error {}

export interface PdfInfo {
  pdf: PDFDocumentProxy
  assetId: string
  pages: { w: number; h: number; index: number }[]
  failedPages: number[]
  name: string
}

/** 파일 → 에셋 저장 + 페이지 크기 목록. 페이지 비트맵은 만들지 않는다(보일 때 pdf.js가 그린다) */
export async function readPdf(file: File | Blob, name: string, askPassword: PasswordPrompt, onProgress?: (p: number) => void): Promise<PdfInfo> {
  if (file.size > MAX_IMPORT_BYTES) throw new ImportError(`파일이 너무 큽니다 (${Math.round(file.size / 1048576)}MB). 최대 200MB까지 가져올 수 있습니다.`)
  const buf = await file.arrayBuffer()
  const head = new TextDecoder().decode(new Uint8Array(buf.slice(0, 1024)))
  if (!head.includes('%PDF')) throw new ImportError('PDF 파일이 아닙니다.')

  let pdf: PDFDocumentProxy | null = null
  let password: string | undefined
  for (;;) {
    try {
      pdf = await openPdf(buf, password)
      break
    } catch (e) {
      if (e instanceof PdfPasswordError) {
        const pw = await askPassword(!!password)
        if (pw == null) throw new ImportError('가져오기를 취소했습니다.')
        password = pw
        continue
      }
      throw new ImportError('PDF를 읽을 수 없습니다. 파일이 손상되었을 수 있습니다.')
    }
  }
  const asset = await putAsset(new Blob([buf], { type: 'application/pdf' }), { kind: 'pdf', mime: 'application/pdf', name })
  if (password) rememberPassword(asset.id, password)

  const pages: PdfInfo['pages'] = []
  const failedPages: number[] = []
  const n = pdf.numPages
  for (let i = 0; i < n; i++) {
    try {
      const p = await pdf.getPage(i + 1)
      // 페이지 자체 회전(/Rotate)을 반영한 표시 크기 (pt)
      const vp = p.getViewport({ scale: 1, rotation: p.rotate })
      pages.push({ w: round2(vp.width), h: round2(vp.height), index: i })
    } catch {
      failedPages.push(i)
    }
    if (onProgress && (i % 10 === 0 || i === n - 1)) onProgress((i + 1) / n)
  }
  return { pdf, assetId: asset.id, pages, failedPages, name }
}

/** A4 폭에서 많이 벗어난 페이지가 있는가 — 가져올 때 A4 폭에 맞출지 물어보는 기준 */
export const pdfNeedsFit = (info: PdfInfo) => info.pages.some((p) => farFromA4(p))

/** fitA4: 페이지를 A4 폭(가로 페이지는 A4 가로 폭)에 맞춘다 — 크기와 내용 배율만 정하고 PDF 원본 크기는 그대로 남는다 */
export function pdfPageSpecs(info: PdfInfo, fitA4 = false): NewPageSpec[] {
  return info.pages.map((p) => {
    const f = fitA4 ? a4FitFactor(p) : 1
    const fit = Math.abs(f - 1) >= 1e-3
    return {
      size: fit ? { w: p.w * f, h: p.h * f } : { w: p.w, h: p.h },
      ...(fit ? { scale: f } : {}),
      background: makeBackground('blank'),
      pdf: { assetId: info.assetId, pageIndex: p.index, rotation: 0 }
    }
  })
}

/** 기존 문서에 넣을 Page 객체들 */
export function pdfPagesFor(documentId: string, info: PdfInfo, fitA4 = false): Page[] {
  return pdfPageSpecs(info, fitA4).map((s) => makePage(documentId, s))
}

export async function createDocumentFromPdf(info: PdfInfo, folderId: string | null, fitA4 = false) {
  const title = info.name.replace(/\.pdf$/i, '') || 'PDF'
  const doc = await createDocument({ title, mode: 'paged', folderId, pages: pdfPageSpecs(info, fitA4) })
  // 목록용 썸네일: 첫 페이지 저해상도
  try {
    const p = await info.pdf.getPage((info.pages[0]?.index ?? 0) + 1)
    const vp0 = p.getViewport({ scale: 1, rotation: p.rotate })
    const vp = p.getViewport({ scale: 320 / vp0.width, rotation: p.rotate })
    const c = document.createElement('canvas')
    c.width = Math.round(vp.width)
    c.height = Math.round(vp.height)
    await p.render({ canvas: null, canvasContext: c.getContext('2d')!, viewport: vp }).promise
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.8))
    if (blob) await putThumbnail(doc.id, blob)
  } catch {
    /* 썸네일은 선택 사항 */
  }
  await closePdf(info.pdf)
  return doc
}

const round2 = (v: number) => Math.round(v * 100) / 100
