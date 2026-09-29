import { useEffect, useState } from 'react'
import { login, logout } from '../sync/token'
import { onSyncStatus, syncNow, type SyncStatus } from '../sync/sync'
import { downloadAllMissing, onAssetProgress } from '../sync/assets'
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

function fmtBytes(n: number) {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`
}

export function SyncSection() {
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [last, setLast] = useState<number | null>(null)
  const [pending, setPending] = useState(0)
  const [missing, setMissing] = useState(0)
  const [missingBytes, setMissingBytes] = useState(0)
  const [fetching, setFetching] = useState<{ loaded: number; total: number | null } | null>(null)
  const [pullingAssets, setPullingAssets] = useState<{ done: number; total: number } | null>(null)

  useEffect(() => {
    const un = onSyncStatus(setStatus)
    return () => {
      un()
    }
  }, [])

  // 원본 지연 로딩 진행률
  useEffect(() => {
    const off = onAssetProgress((e) => setFetching(e.done ? null : { loaded: e.loaded, total: e.total }))
    return () => {
      off()
      setFetching(null)
    }
  }, [])

  useEffect(() => {
    let alive = true
    const load = async () => {
      const [v, n, absent] = await Promise.all([
        db.syncState.get('lastSyncAt'),
        db.outbox.count(),
        db.assets.toArray()
      ])
      if (!alive) return
      setLast((v?.value as number) ?? null)
      setPending(n)
      const miss = absent.filter((a) => !a.blob)
      setMissing(miss.length)
      setMissingBytes(miss.reduce((s, a) => s + a.size, 0))
    }
    void load()
    const t = setInterval(load, 4000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [status, fetching, pullingAssets])

  const signedOut = status === 'auth-required' || status === 'disabled'

  const pullAllAssets = async () => {
    const total = missing
    setPullingAssets({ done: 0, total })
    try {
      const { ok, failed } = await downloadAllMissing((done, t) => setPullingAssets({ done, total: t }))
      if (failed) console.warn('[sync] 원본 일부를 받지 못했습니다:', failed)
      void ok
    } finally {
      setPullingAssets(null)
    }
  }

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

          <div className="setting-row">
            <span className="setting-label">
              이 기기에 없는 원본
              <small>PDF · 이미지 원본은 문서를 열 때 받아옵니다</small>
            </span>
            <span className="setting-control">
              {missing === 0 ? (
                <span style={{ whiteSpace: 'nowrap' }}>모두 받음</span>
              ) : (
                <span style={{ whiteSpace: 'nowrap' }}>
                  {missing}개 · {fmtBytes(missingBytes)}
                </span>
              )}
            </span>
          </div>

          {fetching && (
            <p className="hint">
              원본 받는 중… {fmtBytes(fetching.loaded)}
              {fetching.total ? ` / ${fmtBytes(fetching.total)}` : ''}
            </p>
          )}
          {pullingAssets && (
            <p className="hint">
              원본 모두 받는 중… {pullingAssets.done} / {pullingAssets.total}
            </p>
          )}

          <div className="btn-row">
            <button className="text-btn" onClick={() => void syncNow()} disabled={status === 'syncing'}>
              {status === 'syncing' ? '동기화 중…' : '동기화'}
            </button>
            <button className="text-btn" onClick={() => void pullAllAssets()} disabled={!missing || !!pullingAssets}>
              원본 모두 받기
            </button>
            <button className="text-btn" onClick={() => void logout().then(() => void syncNow())}>
              로그아웃
            </button>
          </div>

          <p className="hint">
            <b>동기화</b>는 위 버튼을 눌렀을 때만 실행됩니다. 이 기기에만 있던 변경을 모두 올리고, 다른 기기의 변경을 받아옵니다. 원본 바이트(PDF·이미지)는 여기서 받지 않고,
            그 원본을 쓰는 문서를 처음 열 때 그때 받아옵니다 — 폰에서는 목록이 즉시 뜨고 열어 본 문서만 용량을 차지합니다. 두 기기에서 같은 문서를 수정하면 충돌 사본으로 양쪽 내용을 모두 남깁니다.
          </p>
        </>
      )}
    </section>
  )
}
