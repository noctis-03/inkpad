// PDF 내보내기에 심을 한글 폰트.
//
// pdf-lib의 기본 폰트(Helvetica 등)는 WinAnsi 인코딩이라 한글이 통째로 사라진다.
// 그래서 나눔스퀘어(TTF, OFL 라이선스)를 앱에 함께 담고, 내보낼 때 문서에 통째로 심는다.
// (pdf-lib/fontkit의 subset: true는 CJK 글자를 대량 누락시키므로 쓰지 않는다 — exportWorker.ts 주석 참고)
//
// public/fonts 에 두어 서비스 워커 프리캐시에 포함되게 한다 → 오프라인에서도 내보내기 가능.
const FONT_URL = `${import.meta.env.BASE_URL}fonts/NanumSquareR.ttf`

let cached: Promise<ArrayBuffer> | null = null

export function loadExportFont(): Promise<ArrayBuffer> {
  if (!cached) {
    cached = fetch(FONT_URL).then((r) => {
      if (!r.ok) throw new Error(`내보내기용 글꼴을 불러오지 못했습니다 (${r.status})`)
      return r.arrayBuffer()
    })
    cached.catch(() => {
      cached = null // 실패는 캐시하지 않는다 — 다음 시도에서 다시 받는다
    })
  }
  return cached
}

/** 폰트를 못 받아도 내보내기는 계속한다 — 텍스트만 빠지고 경고를 띄운다 */
export async function tryLoadExportFont(): Promise<ArrayBuffer | undefined> {
  try {
    return await loadExportFont()
  } catch {
    return undefined
  }
}
