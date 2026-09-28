import { useEffect, useState } from 'react'
import { login, logout } from '../sync/token'
import { onSyncStatus, syncNow, type SyncStatus } from '../sync/sync'
import { db } from '../storage/db'
import { formatDate } from '../shared/util'
import { Icon } from './Icon'

const STATUS_LABEL: Record<SyncStatus, string> = {
  idle: '동기화됨',
  syncing: '동기화 중…',
  offline: '오프라인 — 기기에 저장됨',
  'auth-required': '로그인 필요',
  error: '동기화 오류',
  disabled: '서버 미설정'
}

const STATUS_COLOR: Record<SyncStatus, string> = {
  idle: '#16a34a',
  syncing: '#2563eb',
  offline: '#9ca3af',
  'auth-required': '#d97706',
  error: '#dc2626',
  disabled: '#9ca3af'
}

export function SyncSection() {
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [last, setLast] = useState<number | null>(null)
  const [pending, setPending] = useState(0)

  useEffect(() => {
    const un = onSyncStatus(setStatus)
    return () => {
      un()
    }
  }, [])

  useEffect(() => {
    let alive = true
    const load = async () => {
      const [v, n] = await Promise.all([db.syncState.get('lastSyncAt'), db.outbox.count()])
      if (!alive) return
      setLast((v?.value as number) ?? null)
      setPending(n)
    }
    void load()
    const t = setInterval(load, 4000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [status])

  const signedOut = status === 'auth-required' || status === 'disabled'

  return (
    <section className="panel-section" id="sync-settings">
      <h3>동기화 · Google Drive</h3>
      {signedOut ? (
        <>
          <p className="hint">
            노트를 Google Drive의 앱 전용 폴더에 저장해 기기 사이에서 동기화합니다. 데이터는 이 기기에도 그대로 남아 오프라인에서도 쓸 수 있습니다.
          </p>
          {status === 'auth-required' ? (
            <div className="btn-row">
              <button className="primary-btn" onClick={() => login()}>
                <Icon name="upload" size={18} /> Google로 로그인
              </button>
            </div>
          ) : (
            <p className="hint warn">
              서버에 OAuth 설정이 없습니다(Cloudflare Pages의 GOOGLE_CLIENT_ID 등 환경 변수). 로컬 저장은 계속 동작합니다.
            </p>
          )}
        </>
      ) : (
        <>
          <div className="setting-row">
            <span className="setting-label">
              상태
              <small>{last ? `마지막 동기화 ${formatDate(last)}` : '아직 동기화 전'}</small>
            </span>
            <span className="setting-control">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[status], flexShrink: 0 }} />
                {STATUS_LABEL[status]}
                {pending > 0 && status !== 'syncing' ? ` · 대기 ${pending}건` : ''}
              </span>
            </span>
          </div>
          <div className="btn-row">
            <button className="text-btn" onClick={() => void syncNow()} disabled={status === 'syncing'}>
              지금 동기화
            </button>
            <button className="text-btn" onClick={() => void logout().then(() => void syncNow())}>
              로그아웃
            </button>
          </div>
          <p className="hint">
            동기화는 위 <b>지금 동기화</b>를 눌렀을 때만 실행됩니다. 평소의 수정·삭제는 이 기기에만 저장되고, 버튼을 누르면 대기 중인 변경이 모두 업로드되며 다른 기기의 변경도 받아옵니다. 두 기기에서 같은 문서를 수정하면 충돌 사본으로 양쪽 내용을 모두 남깁니다.
          </p>
        </>
      )}
    </section>
  )
}
