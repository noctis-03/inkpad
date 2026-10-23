// 들어온 파일을 어디에 넣을지 — 라이브러리의 "파일 추가"·끌어 놓기와 HTML 앱의 "Inkpad에 저장"이 함께 쓴다.
// PDF는 노트로, HTML은 앱으로, Inkpad 파일(.inkpad, 안에 manifest가 있는 .zip)은 가져오기, 나머지는 기타 파일로
import { isInkpadZip } from './inkpadFormat'

export type FileRoute = 'pdf' | 'html' | 'inkpad' | 'file'

export async function fileRoute(f: File): Promise<FileRoute> {
  if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') return 'pdf'
  if (/\.html?$/i.test(f.name) || f.type === 'text/html') return 'html'
  if (/\.inkpad$/i.test(f.name)) return 'inkpad'
  // .zip은 안을 들여다봐 Inkpad 파일일 때만 가져오고, 일반 zip은 기타 파일로
  if (/\.zip$/i.test(f.name) && (await isInkpadZip(f))) return 'inkpad'
  return 'file'
}

export async function routeFiles(list: File[]): Promise<Record<FileRoute, File[]>> {
  const out: Record<FileRoute, File[]> = { pdf: [], html: [], inkpad: [], file: [] }
  for (const f of list) out[await fileRoute(f)].push(f)
  return out
}
