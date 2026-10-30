// 탭 바 오른쪽 상태 칸(StatusDock)의 쪽들 — 칸에서는 한 줄(Compact), 펼친 창에서는 자세히(Detail).
// 쪽을 더하려면 DockPage를 하나 만들어 DOCK_PAGES에 넣는다. 칸에서 좌우로 넘기고, 펼친 창 위 탭으로 고른다.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { clearFinishedActivities, getActivities, onActivities, type Activity, type ActivityKind } from '../../shared/activity'
import { clearNotices, getNotices, onNotices, unreadNotices, type Notice } from '../../shared/notices'
import { formatBytes, formatDate } from '../../shared/util'
import { db } from '../../storage/db'
import { storageStats } from '../../storage/repo'
import { CLOUD_STATES_EVENT, onSyncStatus, unsyncedNoteIds, type SyncStatus } from '../../sync/sync'
import { Icon } from '../Icon'

export interface DockPage {
  id: string
  label: string
  Compact: () => ReactNode
  Detail: () => ReactNode
}

// ───────── 공용 ─────────

export const useActivities = () => useSyncExternalStore(onActivities, getActivities)
export const useNotices = () => useSyncExternalStore(onNotices, getNotices)

/** 이만큼 지난 시각을 다시 그린다 — "3분 전" 같은 글자가 멈추지 않게 */
function useNow(ms: number) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(t)
  }, [ms])
  return now
}

export function ago(ts: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 10) return '방금'
  if (s < 60) return `${s}초 전`
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`
  return formatDate(ts)
}

const KIND_ICON: Record<ActivityKind, string> = { upload: 'upload', download: 'download', import: 'download', export: 'share', work: 'gear' }
const KIND_LABEL: Record<ActivityKind, string> = { upload: '올리기', download: '받기', import: '가져오기', export: '내보내기', work: '작업' }

/** 진행 막대 — 진행률을 모르면 흐르는 줄 */
function Bar({ value, tone }: { value?: number; tone?: 'ok' | 'bad' }) {
  return (
    <span className={'dock-bar' + (value === undefined ? ' is-flowing' : '') + (tone ? ' is-' + tone : '')}>
      <i style={value === undefined ? undefined : { width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
    </span>
  )
}

// ───────── 전송 ─────────

/** 끝난 일을 칸에 잠깐 보여 주는 시간 */
const FLASH_MS = 4000

function TransfersCompact() {
  const list = useActivities()
  const now = useNow(1000)
  const running = list.filter((a) => a.state === 'running')
  const cur = running[running.length - 1]
  if (cur) {
    return (
      <div className="dock-line">
        <span className="dock-ic is-running">
          <Icon name={KIND_ICON[cur.kind]} size={14} />
        </span>
        <span className="dock-text">{cur.title}</span>
        <span className="dock-meta">{running.length > 1 ? `+${running.length - 1}` : cur.progress !== undefined ? `${Math.round(cur.progress * 100)}%` : ''}</span>
        <Bar value={running.length > 1 ? running.reduce((s, a) => s + (a.progress ?? 0), 0) / running.length : cur.progress} />
      </div>
    )
  }
  const last = list[list.length - 1]
  if (last && last.endedAt && now - last.endedAt < FLASH_MS) {
    const bad = last.state === 'error'
    return (
      <div className={'dock-line' + (bad ? ' is-bad' : ' is-ok')}>
        <span className="dock-ic">
          <Icon name={bad ? 'xCircle' : 'checkCircle'} size={14} />
        </span>
        <span className="dock-text">{last.title}</span>
        <span className="dock-meta">{bad ? '실패' : '완료'}</span>
      </div>
    )
  }
  const done = list.length
  return (
    <div className="dock-line is-idle">
      <span className="dock-ic">
        <Icon name="swap" size={14} />
      </span>
      <span className="dock-text">{done ? `최근 전송 ${done}건` : '전송 없음'}</span>
    </div>
  )
}

function ActivityRow({ a, now }: { a: Activity; now: number }) {
  const running = a.state === 'running'
  const bad = a.state === 'error'
  return (
    <li className={'dock-row' + (bad ? ' is-bad' : '') + (running ? ' is-running' : '')}>
      <span className="dock-row-ic">
        <Icon name={running ? KIND_ICON[a.kind] : bad ? 'xCircle' : 'checkCircle'} size={16} />
      </span>
      <div className="dock-row-main">
        <div className="dock-row-top">
          <span className="dock-row-title">{a.title}</span>
          <span className="dock-row-when">{running ? (a.progress !== undefined ? `${Math.round(a.progress * 100)}%` : '') : ago(a.endedAt ?? a.startedAt, now)}</span>
        </div>
        <div className="dock-row-sub">
          <span className="dock-row-kind">{KIND_LABEL[a.kind]}</span>
          {a.detail && <span className="dock-row-detail">{a.detail}</span>}
        </div>
        {running && <Bar value={a.progress} />}
      </div>
    </li>
  )
}

function TransfersDetail() {
  const list = useActivities()
  const now = useNow(15000)
  const running = list.filter((a) => a.state === 'running').reverse()
  const finished = list.filter((a) => a.state !== 'running').reverse()
  if (!list.length) {
    return (
      <div className="dock-empty">
        <Icon name="swap" size={28} />
        <p>주고받는 일이 없습니다</p>
        <small>올리기·받기, 원본 받기, 가져오기·내보내기가 여기에 보입니다.</small>
      </div>
    )
  }
  return (
    <div className="dock-detail">
      {running.length > 0 && (
        <section>
          <h3 className="dock-h">진행 중 {running.length}</h3>
          <ul className="dock-rows">
            {running.map((a) => (
              <ActivityRow key={a.id} a={a} now={now} />
            ))}
          </ul>
        </section>
      )}
      {finished.length > 0 && (
        <section>
          <h3 className="dock-h">
            최근
            <button className="dock-h-btn" onClick={clearFinishedActivities}>
              기록 지우기
            </button>
          </h3>
          <ul className="dock-rows">
            {finished.map((a) => (
              <ActivityRow key={a.id} a={a} now={now} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

// ───────── 알림 ─────────
// 토스트가 이 쪽에서 나온다 — 알림이 오면 칸이 이 쪽으로 넘어오고, 토스트는 칸 바로 아래로 내려온다(app/App Toasts).
// 토스트가 사라진 뒤에도 칸에는 마지막 알림이 남고, 펼치면 지난 알림을 모두 본다.

const NOTICE_ICON: Record<Notice['kind'], string> = { info: 'bell', success: 'checkCircle', error: 'xCircle' }

function NoticesCompact() {
  const list = useNotices()
  const last = list[list.length - 1]
  const unread = unreadNotices()
  if (!last) {
    return (
      <div className="dock-line is-idle">
        <span className="dock-ic">
          <Icon name="bell" size={14} />
        </span>
        <span className="dock-text">알림 없음</span>
      </div>
    )
  }
  return (
    <div className={'dock-line' + (last.kind === 'error' ? ' is-bad' : last.kind === 'success' ? ' is-ok' : '')}>
      <span className="dock-ic">
        <Icon name={NOTICE_ICON[last.kind]} size={14} />
      </span>
      <span className="dock-text">{last.text}</span>
      <span className="dock-meta">{unread ? `새 ${unread}` : '알림'}</span>
    </div>
  )
}

function NoticesDetail() {
  const list = useNotices()
  const now = useNow(15000)
  if (!list.length) {
    return (
      <div className="dock-empty">
        <Icon name="bell" size={28} />
        <p>알림이 없습니다</p>
        <small>저장·올리기·되돌리기 같은 알림이 여기에 남습니다. 새로고침하면 비워집니다.</small>
      </div>
    )
  }
  return (
    <div className="dock-detail">
      <section>
        <h3 className="dock-h">
          최근 알림 {list.length}
          <button className="dock-h-btn" onClick={clearNotices}>
            모두 지우기
          </button>
        </h3>
        <ul className="dock-rows">
          {list
            .slice()
            .reverse()
            .map((n) => (
              <li key={n.id} className={'dock-row' + (n.kind === 'error' ? ' is-bad' : '')}>
                <span className="dock-row-ic">
                  <Icon name={NOTICE_ICON[n.kind]} size={16} />
                </span>
                <div className="dock-row-main">
                  <div className="dock-row-top">
                    <span className="dock-row-title is-wrap">{n.text}</span>
                    <span className="dock-row-when">{ago(n.at, now)}</span>
                  </div>
                </div>
              </li>
            ))}
        </ul>
      </section>
    </div>
  )
}

// ───────── 동기화 ─────────

const SYNC_TEXT: Record<SyncStatus, string> = {
  idle: '대기 중',
  syncing: '동기화 중…',
  offline: '오프라인',
  'auth-required': '로그인 필요',
  error: '동기화 오류',
  disabled: '클라우드 연결 안 됨'
}

interface SyncInfo {
  status: SyncStatus
  pending: number | null
  lastPush: number | null
  lastPull: number | null
}

function useSyncInfo(): SyncInfo {
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [rest, setRest] = useState<Omit<SyncInfo, 'status'>>({ pending: null, lastPush: null, lastPull: null })
  useEffect(() => onSyncStatus(setStatus), [])
  useEffect(() => {
    let alive = true
    const load = async () => {
      const [ids, push, pull] = await Promise.all([unsyncedNoteIds().catch(() => null), db.syncState.get('lastPushAt'), db.syncState.get('lastPullAt')])
      if (alive) setRest({ pending: ids ? ids.length : null, lastPush: (push?.value as number) ?? null, lastPull: (pull?.value as number) ?? null })
    }
    void load()
    window.addEventListener(CLOUD_STATES_EVENT, load)
    return () => {
      alive = false
      window.removeEventListener(CLOUD_STATES_EVENT, load)
    }
  }, [status])
  return { status, ...rest }
}

const syncIcon = (s: SyncStatus) => (s === 'offline' ? 'wifiOff' : s === 'error' || s === 'auth-required' ? 'alert' : 'cloud')

function SyncCompact() {
  const { status, pending, lastPush } = useSyncInfo()
  const now = useNow(30000)
  const quiet = status === 'idle'
  const text = !quiet ? SYNC_TEXT[status] : pending ? `올릴 노트 ${pending}개` : lastPush ? `올림 · ${ago(lastPush, now)}` : '모두 올림'
  return (
    <div className={'dock-line' + (status === 'error' || status === 'auth-required' ? ' is-bad' : quiet && !pending ? ' is-idle' : '')}>
      <span className={'dock-ic' + (status === 'syncing' ? ' is-running' : '')}>
        <Icon name={syncIcon(status)} size={14} />
      </span>
      <span className="dock-text">{text}</span>
      <span className="dock-meta">동기화</span>
    </div>
  )
}

function SyncDetail() {
  const { status, pending, lastPush, lastPull } = useSyncInfo()
  const now = useNow(15000)
  return (
    <div className="dock-detail">
      <div className={'dock-hero' + (status === 'error' || status === 'auth-required' ? ' is-bad' : '')}>
        <Icon name={syncIcon(status)} size={22} />
        <div>
          <strong>{SYNC_TEXT[status]}</strong>
          <small>{pending === null ? '' : pending ? `이 기기에서 바뀐 노트 ${pending}개가 올리기를 기다립니다` : '이 기기의 노트가 모두 올라가 있습니다'}</small>
        </div>
      </div>
      <dl className="dock-facts">
        <dt>마지막 올리기</dt>
        <dd>{lastPush ? ago(lastPush, now) : '없음'}</dd>
        <dt>마지막 받기</dt>
        <dd>{lastPull ? ago(lastPull, now) : '없음'}</dd>
      </dl>
      <p className="dock-note">올리기·받기는 라이브러리의 동기화 창에서 합니다. 진행은 전송 쪽에 보입니다.</p>
    </div>
  )
}

// ───────── 저장 공간 ─────────

type Stats = Awaited<ReturnType<typeof storageStats>>

function useStorage(detail: boolean) {
  const [est, setEst] = useState<{ usage: number; quota: number } | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const list = useActivities()
  const busy = list.some((a) => a.state === 'running')
  useEffect(() => {
    let alive = true
    // 칸에서는 브라우저 추정치만, 펼친 창에서는 노트·원본 개수까지 (DB를 훑으므로 열었을 때만)
    if (detail) void storageStats().then((s) => alive && (setStats(s), setEst({ usage: s.usage, quota: s.quota })))
    else void navigator.storage?.estimate?.().then((e) => alive && setEst({ usage: e.usage ?? 0, quota: e.quota ?? 0 }))
    return () => {
      alive = false
    }
  }, [detail, busy, list.length])
  return { est, stats }
}

function StorageCompact() {
  const { est } = useStorage(false)
  const ratio = est?.quota ? est.usage / est.quota : undefined
  return (
    <div className={'dock-line' + (ratio !== undefined && ratio > 0.8 ? ' is-bad' : ' is-idle')}>
      <span className="dock-ic">
        <Icon name="save" size={14} />
      </span>
      <span className="dock-text">{est ? `${formatBytes(est.usage)} 사용` : '저장 공간'}</span>
      <span className="dock-meta">{ratio !== undefined ? `${Math.max(1, Math.round(ratio * 100))}%` : ''}</span>
      {ratio !== undefined && <Bar value={ratio} />}
    </div>
  )
}

function StorageDetail() {
  const { est, stats } = useStorage(true)
  const ratio = est?.quota ? est.usage / est.quota : 0
  return (
    <div className="dock-detail">
      <div className="dock-hero">
        <Icon name="save" size={22} />
        <div>
          <strong>{est ? `${formatBytes(est.usage)} 사용` : '확인 중…'}</strong>
          <small>{est?.quota ? `브라우저가 허락한 ${formatBytes(est.quota)} 중 ${Math.max(1, Math.round(ratio * 100))}%` : ''}</small>
        </div>
      </div>
      {est?.quota ? <Bar value={ratio} tone={ratio > 0.8 ? 'bad' : undefined} /> : null}
      {stats && (
        <dl className="dock-facts">
          <dt>노트</dt>
          <dd>{stats.docs}개 · {stats.pages}쪽</dd>
          <dt>원본(PDF·이미지)</dt>
          <dd>
            {stats.assets}개 · {formatBytes(stats.assetBytes)}
          </dd>
          <dt>미리보기</dt>
          <dd>
            {stats.thumbs}개 · {formatBytes(stats.thumbBytes)}
          </dd>
          <dt>올리기 대기</dt>
          <dd>{stats.pending}건</dd>
          <dt>저장소 보존</dt>
          <dd>{stats.persisted ? '허용됨' : '허용 안 됨'}</dd>
        </dl>
      )}
    </div>
  )
}

export const DOCK_PAGES: DockPage[] = [
  { id: 'transfers', label: '전송', Compact: TransfersCompact, Detail: TransfersDetail },
  { id: 'notices', label: '알림', Compact: NoticesCompact, Detail: NoticesDetail },
  { id: 'sync', label: '동기화', Compact: SyncCompact, Detail: SyncDetail },
  { id: 'storage', label: '저장 공간', Compact: StorageCompact, Detail: StorageDetail }
]
