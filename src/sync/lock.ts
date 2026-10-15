// 동기화 잠금 — 노트 파일(main·브랜치)을 읽고 쓰는 일은 탭이 여러 개여도 한 번에 하나만 한다.
// 일괄 받기·올리기는 이미 누가 하고 있으면 건너뛰고(ifAvailable), 노트 하나 올리기·받기·맞추기·고정 해제처럼
// 사용자가 행에서 누른 동작은 앞의 작업이 끝나기를 기다렸다가 한다.
export const SYNC_LOCK = 'inkpad-sync'

/** 잠금을 기다렸다가 fn을 실행한다. 안에서 다시 부르면 멈추므로(같은 잠금) 바깥에서 한 번만 감싼다 */
export function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  return navigator.locks.request(SYNC_LOCK, fn) as Promise<T>
}
