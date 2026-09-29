// pdf.js 로더. Safari 구버전 호환을 위해 legacy 빌드(core-js 폴리필 포함)를 쓰고, 파싱/렌더링 준비는 Web Worker에서 한다.
import type * as PdfJs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

let libPromise: Promise<typeof PdfJs> | null = null

export function loadPdfJs(): Promise<typeof PdfJs> {
  if (!libPromise) {
    libPromise = import('pdfjs-dist/legacy/build/pdf.min.mjs').then((m) => {
      const lib = m as unknown as typeof PdfJs
      lib.GlobalWorkerOptions.workerSrc = workerUrl
      return lib
    })
  }
  return libPromise
}

export type PDFDocumentProxy = PdfJs.PDFDocumentProxy
export type PDFPageProxy = PdfJs.PDFPageProxy

export class PdfPasswordError extends Error {
  constructor(public incorrect: boolean) {
    super(incorrect ? '비밀번호가 틀렸습니다.' : '암호가 걸린 PDF입니다.')
  }
}

const BASE = import.meta.env.BASE_URL

/** PDF 열기. 암호가 필요하면 PdfPasswordError. 비밀번호는 저장하지 않는다 (16.3) */
export async function openPdf(data: ArrayBuffer | Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  const lib = await loadPdfJs()
  // pdf.js가 버퍼를 워커로 넘기면서 비워버리므로 복사본을 준다
  const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0))
  const task = lib.getDocument({
    data: bytes,
    password,
    cMapUrl: `${BASE}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${BASE}pdfjs/standard_fonts/`,
    wasmUrl: `${BASE}pdfjs/wasm/`,
    iccUrl: `${BASE}pdfjs/iccs/`,
    stopAtErrors: false
  })
  try {
    return await task.promise
  } catch (e) {
    const err = e as { name?: string; code?: number }
    if (err?.name === 'PasswordException') throw new PdfPasswordError(err.code === 2)
    throw e
  }
}

/** pdf.js 6: 문서 해제는 loadingTask를 통해 */
export function closePdf(pdf: PDFDocumentProxy | null | undefined) {
  if (!pdf) return Promise.resolve()
  return pdf.loadingTask.destroy().catch(() => {})
}
