import { useEffect, useState } from 'react'
import { login, logout } from '../sync/token'
import { onSyncProgress, onSyncStatus, planPush, pullNow, pushNow, type PushPlan, type SyncStatus } from '../sync/sync'
import { downloadAllMissing, listMissingAssets, onAssetProgress } from '../sync/assets'
import { db } from '../storage/db'
import { formatDate, formatBytes } from '../shared/util'
import { Icon } from './Icon'

const STATUS_LABEL: Record<SyncStatus, string> = {
  idle: '동기화됨',
  syncing: '작업 중…',
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

const CHANGE_LABEL = { add: '추가', modify: '수정', delete: '삭제' } as const

function fmtBytes(n: number) {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`
}
void fmtBytes

export function SyncSection() {
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [lastPush, setLastPush] = useState<number | null>(null)
  const [lastPull, setLastPull] = useState<number | null>(null)
  const [pending, setPending] = useState(0)
  const [missing, setMissing] = useState<{ n: number; bytes: number }>({ n: 0, bytes: 0 })
  const [progress, setProgress] = useState<string | null>(null)
  const [fetching, setFetching] = useState<{ loaded: number; total: number | null } | null>(null)
  const [pullingAssets, setPullingAssets] = useState<{ done: number; total: number } | null>(null)
  const [preview, setPreview] = useState<PushPlan | null>(null)
  const [nameInput, setNameInput] = useState('')

  useEffect(() => {
    const un = onSyncStatus(setStatus)
    return () => {
      un()
    }
  }, [])

  useEffect(() => {
    const un = onSyncProgress((t) => setProgress(t))
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
      const [lp, ll, n, assets] = await Promise.all([
        db.syncState.get('lastPushAt'),
        db.syncState.get('lastPullAt'),
        db.outbox.count(),
        db.assets.toArray()
      ])
      if (!alive) return
      setLastPush((lp?.value as number) ?? null)
      setLastPull((ll?.value as number) ?? null)
      setPending(n)
      const miss = assets.filter((a) => !a.blob)
      setMissing({ n: miss.length, bytes: miss.reduce((s, a) => s + a.size, 0) })
    }
    void load()
    const t = setInterval(load, 4000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [status, progress, preview, pullingAssets])

  const signedOut = status === 'auth-required' || status === 'disabled'

  const doPull = async () => {
    const r = await pullNow()
    if (r) {
      const bits = [r.docs ? `문서 ${r.docs}개` : '', r.folders ? '폴더' : ''].filter(Boolean)
      if (bits.length) {
        toast(`받았습니다: ${bits.join(', ')}.`)
        if (r.conflicts) toast(`다른 기기와 충돌한 문서 ${r.conflicts}개를 머지했습니다. "올리기"로 허브에 반영하세요.`, 'info')
      } else {
        toast('이미 최신 상태입니다.')
      }
    }
  }

  const openPushPreview = async () => {
    try {
      const plan = await planPush()
      if (!plan.docs.length && !plan.folders && !plan.assets.count && !plan.remoteAhead) {
        toast('올릴 변경이 없습니다. 이미 최신 상태입니다.')
        return
      }
      setPreview(plan)
    } catch (e) {
      toast(e instanceof Error ? e.message : '상태를 확인하지 못했습니다.', 'error')
    }
  }

  const doPush = async () => {
    setPreview(null)
    await pushNow()
  }

  const pullAllAssets = async () => {
    const rows = await listMissingAssets()
    if (!rows.length) return
    setPullingAssets({ done: 0, total: rows.length })
    try {
      await downloadAllMissing((done, t) => setPullingAssets({ done, total: t }))
      setPullingAssets(null)
    } finally {
      setPullingAssets(null)
    }
  }

  const saveName = async () => {
    const { setDeviceName, getDeviceName } = await import('../sync/token')
    if (!nameInput.trim()) return
    await setDeviceName(nameInput)
    setNameInput('')
    toast(`기기 이름을 "${await getDeviceName()}"(으)로 바꿨습니다.`)
  }

  if (signedOut) {
    return (
      <section className="panel-section" id="sync-settings">
        <h3>동기화 · Google Drive</h3>
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
            서버에 OAuth 설정이 없습니다(Cloudflare의 GOOGLE_CLIENT_ID 등 환경 변수). 로컬 저장은 계속 동작합니다.
          </p>
        )}
      </section>
    )
  }

  const working = status === 'syncing'

  return (
    <section className="panel-section" id="sync-settings">
      <h3>동기화 · Google Drive</h3>
      <div className="setting-row">
        <span className="setting-label">
          상태
          <small>
            {lastPush ? `마지막 올리기 ${formatDate(lastPush)}` : '아직 올리기 전'}
            {lastPull ? ` · 마지막 받기 ${formatDate(lastPull)}` : ''}
          </small>
        </span>
        <span className="setting-control">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[status], flexShrink: 0 }} />
            {STATUS_LABEL[status]}
            {pending > 0 && !working ? ` · 올리지 않은 변경 ${pending}건` : ''}
          </span>
        </span>
      </div>
      <div className="setting-row">
        <span className="setting-label">
          이 기기 이름
          <small>커밋 메시지와 버전 기록에 표시됩니다</small>
        </span>
        <span className="setting-control">
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input
              className="text-input"
              style={{ minWidth: 120 }}
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="기기 이름"
              aria-label="기기 이름"
            />
            <button className="text-btn" onClick={() => void saveName()} disabled={!nameInput.trim()}>
              저장
            </button>
          </span>
        </span>
      </div>

      {progress && <p className="hint">{progress}</p>}
      {fetching && (
        <p className="hint">
          원본 받는 중… {formatBytes(fetching.loaded)}
          {fetching.total ? ` / ${formatBytes(fetching.total)}` : ''}
        </p>
      )}
      {pullingAssets && (
        <p className="hint">
          원본 모두 받는 중… {pullingAssets.done} / {pullingAssets.total}
        </p>
      )}

      <div className="btn-row">
        <button className="text-btn" onClick={() => void doPull()} disabled={working}>
          <Icon name="download" size={16} /> 받기
        </button>
        <button className="text-btn" onClick={() => void openPushPreview()} disabled={working}>
          <Icon name="upload" size={16} /> 올리기
        </button>
        <button className="text-btn" onClick={() => void pullAllAssets()} disabled={!missing.n || !!pullingAssets || working}>
          원본 모두 받기
        </button>
        <button className="text-btn" onClick={() => void logout().then(() => void pushNow())}>
          로그아웃
        </button>
      </div>

      {missing.n > 0 && (
        <p className="hint">
          이 기기에 없는 원본 {missing.n}개 · {formatBytes(missing.bytes)} — 문서를 열 때 자동으로 받아옵니다.
        </p>
      )}

      <p className="hint">
        <b>받기</b>는 다른 기기가 올린 변경을 가져오고, <b>올리기</b>는 이 기기의 변경을 한 커밋으로 올립니다 — 커밋에 뭐가 들어갈지는 올리기 전에 미리 보여줍니다. 다른 기기가
        먼저 올렸으면 올리기가 먼저 받아서 머지합니다. 같은 문서를 두 기기에서 고쳤으면 페이지·청크 단위로 합치고, 겹친 부분은 원격을 우선합니다 — 이 기기의 편집은 버전 기록에
        남아 되돌리기로 복구할 수 있습니다. 기기 데이터가 지워지면 받기 한 번으로 복구됩니다.
      </p>

      {preview && <PushPreview plan={preview} busy={working} onConfirm={() => void doPush()} onClose={() => setPreview(null)} />}
    </section>
  )
}

function PushPreview({ plan, busy, onConfirm, onClose }: { plan: PushPlan; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  const adds = plan.docs.filter((d) => d.change === 'add')
  const mods = plan.docs.filter((d) => d.change === 'modify')
  const dels = plan.docs.filter((d) => d.change === 'delete')
  const n = plan.docs.length + (plan.folders ? 1 : 0) + plan.assets.count
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="커밋 미리보기">
        <h2 className="modal-title">커밋 미리보기</h2>
        <p className="hint">
          허브에 올라갈 변경 {n}건{plan.remoteAhead ? ' · 다른 기기의 변경이 있어 먼저 받아 머지합니다' : ''}
          {!plan.connected ? ' · 오프라인 — 허브 상태와 비교하지 않았습니다' : ''}
        </p>
        {plan.conflicts.length > 0 && (
          <p className="hint warn">
            다른 기기도 고친 문서 {plan.conflicts.length}개 — 페이지·청크 단위로 합치고 겹친 부분은 원격을 우선합니다. 이 기기의 편집은 버전 기록에 남겨 언제든 복구할 수
            있습니다.
          </p>
        )}
        {(adds.length > 0 || mods.length > 0 || dels.length > 0) && (
          <div className="push-list">
            {[...adds, ...mods, ...dels].map((d) => (
              <div key={d.docId} className="push-row">
                <span className={'push-badge ' + d.change}>{CHANGE_LABEL[d.change]}</span>
                <span className="push-name">{d.title}</span>
              </div>
            ))}
          </div>
        )}
        {plan.folders && (
          <div className="push-row">
            <span className="push-badge modify">수정</span>
            <span className="push-name">폴더 트리</span>
          </div>
        )}
        {plan.assets.count > 0 && (
          <div className="push-row">
            <span className="push-badge add">추가</span>
            <span className="push-name">
              원본(PDF·이미지) {plan.assets.count}개 · {formatBytes(plan.assets.bytes)}
            </span>
          </div>
        )}
        <div className="modal-actions">
          <button className="text-btn" onClick={onClose}>
            취소
          </button>
          <button className="primary-btn" onClick={onConfirm} disabled={busy}>
            <Icon name="upload" size={18} /> {n ? `${n}건 올리기` : '머지하고 올리기'}
          </button>
        </div>
      </div>
    </div>
  )
}

function toast(text: string, kind: 'info' | 'success' | 'error' = 'success') {
  void import('../app/store').then(({ useUI }) => useUI.getState().toast(text, kind))
}
