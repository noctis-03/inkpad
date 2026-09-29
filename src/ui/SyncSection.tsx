import { useCallback, useEffect, useState } from 'react'
import { login, logout } from '../sync/token'
import { downloadCloudNote, deleteCloudNote, listCloudNotes, onSyncStatus, planPush, pullNow, pushNow, syncNow, type CloudNoteInfo, type PushPlan, type SyncStatus } from '../sync/sync'
import { onAssetProgress } from '../sync/assets'
import { db } from '../storage/db'
import { formatDate } from '../shared/util'
import { confirmDialog } from '../app/dialogs'
import { Icon } from './Icon'

const STATUS_LABEL: Record<SyncStatus, string> = {
  idle: '동기화됨',
  syncing: '작업 중…',
  offline: '오프라인',
  'auth-required': '로그인 필요',
  error: '오류',
  disabled: '서버 미설정'
}

/** 이 기기 이름 정하기 — 클라우드 목록에 표시된다 */
function DeviceNameRow() {
  const [name, setName] = useState('')
  const [saved, setSaved] = useState('')
  useEffect(() => {
    void import('../sync/token').then(({ getDeviceName }) => void getDeviceName().then(setSaved))
  }, [])
  const save = async () => {
    const { setDeviceName } = await import('../sync/token')
    await setDeviceName(name)
    setSaved(name.trim())
    setName('')
    toast(`기기 이름을 "${saved}"(으)로 정했습니다. 다음 올리기부터 적용됩니다.`)
  }
  return (
    <div className="setting-row">
      <span className="setting-label">
        이 기기 이름
        <small>클라우드 목록에 표시됩니다</small>
      </span>
      <span className="setting-control">
        <span className="device-name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={saved || '기기 이름'}
            aria-label="기기 이름"
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && void save()}
          />
          <button className="text-btn small" disabled={!name.trim()} onClick={() => void save()}>
            저장
          </button>
        </span>
      </span>
    </div>
  )
}

function toast(text: string, kind: 'info' | 'success' | 'error' = 'success') {
  void import('../app/store').then(({ useUI }) => useUI.getState().toast(text, kind))
}

export function SyncSection() {
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [last, setLast] = useState<number | null>(null)
  const [cloud, setCloud] = useState<CloudNoteInfo[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState<{ loaded: number; total: number | null } | null>(null)
  const [preview, setPreview] = useState<PushPlan | null>(null)

  useEffect(() => {
    const un = onSyncStatus(setStatus)
    return () => {
      un()
    }
  }, [])

  // 원본(PDF·이미지) 받는 중 표시
  useEffect(() => {
    const off = onAssetProgress((e) => setFetching(e.done ? null : { loaded: e.loaded, total: e.total }))
    return () => {
      off()
      setFetching(null)
    }
  }, [])

  const loadCloud = useCallback(async () => {
    setLoading(true)
    try {
      setCloud(await listCloudNotes())
    } catch (e) {
      toast(e instanceof Error ? e.message : '클라우드 목록을 가져오지 못했습니다.', 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void db.syncState.get('lastPushAt').then((v) => setLast((v?.value as number) ?? null))
    if (status !== 'auth-required' && status !== 'disabled') void loadCloud()
  }, [status, loadCloud])

  const doPull = async () => {
    const r = await pullNow()
    if (r) {
      const bits = [r.docs ? `노트 ${r.docs}개` : '', r.folders ? '폴더' : ''].filter(Boolean)
      toast(bits.length ? `받았습니다: ${bits.join(', ')}.` : '이미 최신 상태입니다.', bits.length ? 'success' : 'info')
      void loadCloud()
    }
  }

  const doPush = async () => {
    try {
      const plan = await planPush()
      if (!plan.docs.length && !plan.folders && !plan.assets.count) {
        toast('올릴 변경이 없습니다. 이미 최신 상태입니다.', 'info')
        return
      }
      setPreview(plan)
    } catch (e) {
      toast(e instanceof Error ? e.message : '상태를 확인하지 못했습니다.', 'error')
    }
  }

  const confirmPush = async () => {
    setPreview(null)
    await pushNow()
    void loadCloud()
  }

  const downloadOne = async (info: CloudNoteInfo) => {
    setLoading(true)
    try {
      const r = await downloadCloudNote(info)
      if (r === 'applied') toast(`"${info.title}"을(를) 받았습니다.`)
      else if (r === 'skipped') toast('이 기기에서 수정 중인 노트라 받지 못했습니다. 먼저 "올리기"를 눌러 주세요.', 'info')
      else toast('클라우드에서 그 노트를 찾지 못했습니다.', 'error')
      await loadCloud()
    } catch (e) {
      toast(e instanceof Error ? e.message : '받기 실패', 'error')
      setLoading(false)
    }
  }

  const deleteOne = async (info: CloudNoteInfo) => {
    if (
      !(await confirmDialog('클라우드에서 삭제', {
        message: `"${info.title}"을(를) 클라우드에서 지웁니다. 각 기기에 저장된 사본은 그대로 남습니다.`,
        ok: '삭제',
        danger: true
      }))
    )
      return
    setLoading(true)
    try {
      await deleteCloudNote(info)
      toast('클라우드에서 지웠습니다.')
      await loadCloud()
    } catch (e) {
      toast(e instanceof Error ? e.message : '삭제 실패', 'error')
      setLoading(false)
    }
  }

  if (status === 'auth-required' || status === 'disabled') {
    return (
      <section className="panel-section" id="sync-settings">
        <h3>동기화 · Google Drive</h3>
        {status === 'auth-required' ? (
          <div className="btn-row">
            <button className="primary-btn" onClick={() => login()}>
              <Icon name="upload" size={18} /> Google로 로그인
            </button>
          </div>
        ) : (
          <p className="hint warn">서버에 OAuth 설정이 없습니다. 로컬 저장은 계속 동작합니다.</p>
        )}
      </section>
    )
  }

  return (
    <section className="panel-section" id="sync-settings">
      <h3>동기화 · Google Drive</h3>
      <div className="setting-row">
        <span className="setting-label">
          상태
          <small>{last ? `마지막 동기화 ${formatDate(last)}` : '아직 동기화 전'}</small>
        </span>
        <span className="setting-control">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: status === 'idle' ? '#16a34a' : status === 'syncing' ? '#2563eb' : '#dc2626', flexShrink: 0 }} />
            {STATUS_LABEL[status]}
          </span>
          <button className="text-btn small" onClick={() => void logout().then(() => void syncNow())}>
            로그아웃
          </button>
        </span>
      </div>

      {fetching && (
        <p className="hint">
          원본 받는 중… {Math.round(fetching.loaded / 1024)}KB{fetching.total ? ` / ${Math.round(fetching.total / 1024)}KB` : ''}
        </p>
      )}

      <div className="btn-row">
        <button className="text-btn" onClick={() => void doPull()} disabled={status === 'syncing'}>
          <Icon name="download" size={16} /> 받기
        </button>
        <button className="text-btn" onClick={() => void doPush()} disabled={status === 'syncing'}>
          <Icon name="upload" size={16} /> 올리기
        </button>
      </div>

      <DeviceNameRow />

      <div className="setting-row" style={{ marginTop: 10 }}>
        <span className="setting-label">
          클라우드 노트
          <small>Drive에 저장된 노트 — 눌러서 이 기기로 받습니다</small>
        </span>
        <span className="setting-control">
          <button className="text-btn small" onClick={() => void loadCloud()} disabled={loading || status === 'syncing'}>
            새로 고침
          </button>
        </span>
      </div>

      {cloud && cloud.length === 0 && <p className="hint">클라우드에 노트가 없습니다. 노트를 만든 뒤 "올리기"를 눌러 주세요.</p>}
      {cloud && cloud.length > 0 && (
        <div className="cloud-list">
          {cloud.map((c) => (
            <div key={c.docId} className="cloud-row">
              <span className="cloud-title">{c.title}</span>
              {c.state === 'remote-new' && <span className="dot-new" aria-label="새 노트" />}
              {c.state === 'deleted-local' && <span className="dot-del" aria-label="이 기기에서 지운 노트" />}
              <span className="cloud-meta">
                {c.device ? `${c.device} · ` : ''}
                {formatDate(c.updatedAt)}
              </span>
              <button className="text-btn small" disabled={loading || status === 'syncing'} onClick={() => void downloadOne(c)}>
                받기
              </button>
              <button className="icon-mini danger" aria-label="클라우드에서 삭제" disabled={loading || status === 'syncing'} onClick={() => void deleteOne(c)}>
                <Icon name="trash" size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
      {preview && <PushPreview plan={preview} busy={status === 'syncing'} onConfirm={() => void confirmPush()} onClose={() => setPreview(null)} />}
    </section>
  )
}

/** 올리기 미리보기 — 이번 올리기에 클라우드로 올라갈 변경 목록 */
function PushPreview({ plan, busy, onConfirm, onClose }: { plan: PushPlan; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  const adds = plan.docs.filter((d) => d.change === 'add')
  const mods = plan.docs.filter((d) => d.change === 'modify')
  const dels = plan.docs.filter((d) => d.change === 'delete')
  const label = { add: '추가', modify: '수정', delete: '삭제' } as const
  const n = plan.docs.length + (plan.folders ? 1 : 0) + plan.assets.count
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="올리기 미리보기">
        <h2 className="modal-title">올리기 미리보기</h2>
        <p className="hint">클라우드에 올라갈 변경 {n}건 — 올린 뒤 다른 기기의 변경도 받아옵니다.</p>
        {(adds.length > 0 || mods.length > 0 || dels.length > 0) && (
          <div className="push-list">
            {[...adds, ...mods, ...dels].map((d) => (
              <div key={d.docId} className="push-row">
                <span className={'push-badge ' + d.change}>{label[d.change]}</span>
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
              원본(PDF·이미지) {plan.assets.count}개 · {Math.round(plan.assets.bytes / 1024)}KB
            </span>
          </div>
        )}
        <div className="modal-actions">
          <button className="text-btn" onClick={onClose}>
            취소
          </button>
          <button className="primary-btn" onClick={onConfirm} disabled={busy}>
            <Icon name="upload" size={18} /> {n ? `${n}건 올리기` : '올리기'}
          </button>
        </div>
      </div>
    </div>
  )
}
