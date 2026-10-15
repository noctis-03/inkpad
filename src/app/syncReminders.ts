// 수동 동기화 편의 — 네트워크를 저절로 쓰지 않는 원칙을 지키면서 '올릴 것·받을 것·머지할 것'을 놓치지 않게 한다.
//
//  - 앱 아이콘 배지: 올리지 않은 노트 + 머지 대기 수 (Badging API, 지원하는 곳만 — 설치한 PWA 등). 네트워크 없음
//  - 노트를 닫을 때 알림: 그 노트에 올리지 않은 변경이 있으면 '정리' 버튼이 달린 알림 → 비교 화면에서 올리기·변경 버리기
//  - 앱을 열 때 클라우드 확인: 설정에서 켰을 때만(기본 끔). 노트 목록·브랜치 목록 메타만 읽는다(본문은 받지 않는다) —
//    노트 100개에 약 35KB, 300개에 약 100KB(gzip 전송 기준). 30분 안에 다시 열면 확인하지 않는다.
import { useUI } from './store'
import { CLOUD_STATES_EVENT, listCloudNotes, listMergeQueue, notifySyncChanged, syncSummary } from '../sync/sync'
import { getSync, putSync } from '../sync/folders'
import { pendingSeqsFor } from '../sync/unchanged'
import type { ID } from '../shared/model'

/** 앱을 열 때 확인의 최소 간격 */
export const CLOUD_CHECK_INTERVAL_MS = 30 * 60_000

export interface CloudCheckRecord {
  at: number
  notes: number
  merge: number
  /** 브라우저가 알려 준 실제 전송 바이트(압축 후). 알 수 없으면 없다 */
  bytes?: number
}

const settings = () => useUI.getState().settings
const toast = (text: string, kind: 'info' | 'success' | 'error' = 'success', action?: { label: string; run: () => void }) => useUI.getState().toast(text, kind, action)

/** 동기화를 한 번이라도 설정했나 — 아니면 알림·확인을 하지 않는다 */
const syncConfigured = async () => !!(await getSync('rootFolderId'))

// ───────── 앱 아이콘 배지 ─────────

type BadgeNav = Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }

export async function refreshAppBadge(): Promise<void> {
  const nav = navigator as BadgeNav
  if (!nav.setAppBadge) return
  try {
    if (!settings().appBadge || !(await syncConfigured())) return void (await nav.clearAppBadge?.())
    const s = await syncSummary()
    const n = s.pending.length + s.merge
    if (n > 0) await nav.setAppBadge(n)
    else await nav.clearAppBadge?.()
  } catch {
    /* 배지를 지원하지 않거나 권한이 없다 — 덤이므로 조용히 넘어간다 */
  }
}

// ───────── 노트를 닫을 때 ─────────

/** 편집 화면을 나간 뒤 — 그 노트에 올리지 않은 변경이 있으면 알린다(편집 화면이 마지막 변경을 기록할 시간을 둔다) */
export function remindOnLeave(docId: ID, title: string): void {
  if (!settings().leaveReminder) return
  window.setTimeout(async () => {
    try {
      if (!(await syncConfigured()) || !(await pendingSeqsFor(docId)).length) return
      // '정리'는 비교 화면 — 지금 쓴 것을 보고 올리거나(진짜 필기) 버린다(써 보며 공부한 것)
      toast(`“${title || '제목 없음'}”에 올리지 않은 변경이 있습니다.`, 'info', {
        label: '정리',
        run: () => void import('../ui/ChangesView').then(({ openChanges }) => openChanges({ docId, title, actions: ['push', 'discard'] }))
      })
    } catch {
      /* 알림은 덤 */
    }
  }, 800)
}

// ───────── 앱을 열 때 클라우드 확인 (켰을 때만) ─────────

let checking = false

/** 지금까지 googleapis로 받은 바이트 — 브라우저가 알려 주는 경우만(교차 출처 타이밍 허용이 없으면 0) */
function driveBytesSince(t0: number): number {
  let n = 0
  for (const e of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
    if (e.startTime < t0 || !e.name.includes('googleapis.com')) continue
    n += e.transferSize || e.encodedBodySize || 0
  }
  return n
}

/**
 * 설정에서 켰고, 동기화를 설정했고, 온라인이고, 마지막 확인에서 30분이 지났으면 클라우드 목록을 한 번 본다.
 * 받지는 않는다 — 라이브러리 점·배지·편집 화면 칩이 '받을 것·갈라짐·머지 대기'를 보여 줄 수 있게 판정만 새로 한다.
 */
export async function maybeCheckCloud(): Promise<CloudCheckRecord | null> {
  if (checking || !settings().cloudCheckOnOpen || !navigator.onLine) return null
  if (!(await syncConfigured())) return null
  const last = await getSync<CloudCheckRecord>('cloudCheck')
  if (last && Date.now() - last.at < CLOUD_CHECK_INTERVAL_MS) return null
  checking = true
  const t0 = performance.now()
  try {
    const notes = await listCloudNotes() // 판정 캐시(라이브러리 점)를 함께 갱신한다
    const queue = await listMergeQueue() // 머지 대기 캐시(배지)를 함께 갱신한다
    const bytes = driveBytesSince(t0)
    const rec: CloudCheckRecord = { at: Date.now(), notes: notes.length, merge: queue.length, ...(bytes > 0 ? { bytes } : {}) }
    await putSync('cloudCheck', rec)
    notifySyncChanged()
    return rec
  } catch (e) {
    console.warn('[sync] 앱 열 때 확인을 하지 못했습니다 — 다음에 다시:', e)
    return null
  } finally {
    checking = false
  }
}

/** App이 한 번 부른다 — 배지 갱신과 (켰다면) 열 때·돌아올 때 확인 */
export function installSyncReminders(): () => void {
  void refreshAppBadge()
  void maybeCheckCloud()
  const onChanged = () => void refreshAppBadge()
  const onVisible = () => {
    if (document.visibilityState === 'visible') void maybeCheckCloud()
    else void refreshAppBadge() // 백그라운드로 갈 때 — 기기를 바꾸기 전에 아이콘에 남는다
  }
  window.addEventListener(CLOUD_STATES_EVENT, onChanged)
  document.addEventListener('visibilitychange', onVisible)
  const unsub = useUI.subscribe((s, prev) => {
    if (s.settings.appBadge !== prev.settings.appBadge) void refreshAppBadge()
    if (s.settings.cloudCheckOnOpen && !prev.settings.cloudCheckOnOpen) void maybeCheckCloud() // 켜는 순간 한 번
  })
  return () => {
    window.removeEventListener(CLOUD_STATES_EVENT, onChanged)
    document.removeEventListener('visibilitychange', onVisible)
    unsub()
  }
}
