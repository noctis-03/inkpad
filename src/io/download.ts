import { safeFileName } from '../shared/util'

/**
 * 파일 저장. iPadOS Safari는 Web Share(파일)를 지원하므로 먼저 공유 시트를 시도하고
 * ("파일에 저장" 선택 가능), 안 되면 다운로드 링크로 대체한다.
 */
export async function saveFile(blob: Blob, name: string, preferShare = true) {
  const fileName = safeFileName(name)
  const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' })
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
  if (preferShare && nav.share && nav.canShare?.({ files: [file] }) && /iPad|iPhone|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document) {
    try {
      await nav.share({ files: [file], title: fileName })
      return
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.style.display = 'none'
    document.body.appendChild(input)
    input.onchange = () => {
      resolve(input.files ? [...input.files] : [])
      input.remove()
    }
    // 취소 감지 (지원 브라우저)
    input.addEventListener('cancel', () => {
      resolve([])
      input.remove()
    })
    input.click()
  })
}
