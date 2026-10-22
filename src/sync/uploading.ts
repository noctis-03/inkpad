// 지금 클라우드로 올리는 중인 앱·파일 id — 라이브러리 카드 제목 옆 로딩 표시용 (메모리에만, 새로고침하면 비어 있다).
// 앱·파일은 추가·수정하자마자 올리므로 '올리기' 꼬리표 대신 올라가는 동안만 돈다.
import type { ID } from '../shared/model'

export const UPLOADING_EVENT = 'inkpad-uploading-changed'
const counts = new Map<ID, number>()
const emit = () => window.dispatchEvent(new Event(UPLOADING_EVENT))

export const isUploading = (id: ID) => counts.has(id)

/** p가 끝날 때까지 id를 '올리는 중'으로 둔다 (같은 id가 겹쳐 올라가도 마지막이 끝나야 풀린다) */
export function trackUpload<T>(id: ID, p: Promise<T>): Promise<T> {
  counts.set(id, (counts.get(id) ?? 0) + 1)
  emit()
  return p.finally(() => {
    const n = (counts.get(id) ?? 1) - 1
    if (n > 0) counts.set(id, n)
    else counts.delete(id)
    emit()
  })
}
