// 편집 화면 툴바의 노트 동기화 칩 — 이 노트의 상태(최신·올리기 필요·새 버전·갈라짐·머지 대기·클라우드 없음)를
// 라이브러리 카드와 같은 점으로 보여 주고, 누르면 이 노트만 올리기·이 기기 변경사항 확인(받기)·변경 버리기·머지를 고른다.
// 버전 기록·동기화 패널은 툴바 오른쪽 메뉴에 있어 여기서는 뺀다.
// 상태는 이 기기 DB와 마지막으로 본 판정만 읽는다(네트워크 없음). 네트워크는 메뉴를 눌렀을 때만 쓴다.
import { useCallback, useEffect, useState, type MouseEvent } from 'react'
import { useUI } from '../../app/store'
import type { ID } from '../../shared/model'
import { getSync } from '../../sync/folders'
import {
  CLOUD_STATES_EVENT,
  REMOTE_EVENT,
  cachedMergeQueue,
  listMergeQueue,
  noteCardState,
  onSyncStatus,
  pullOneNote,
  pushOneNote,
  type CardSyncState
} from '../../sync/sync'
import { MERGE_DONE_EVENT, openMergeView } from '../merge/MergeView'
import { openChanges } from '../ChangesView'
import { Menu, MenuItem } from '../Menu'

type ChipState = CardSyncState | 'queued'

const LABEL: Record<ChipState, string> = {
  same: '동기화됨',
  pending: '올리기 필요',
  'remote-new': '새 버전',
  diverged: '갈라짐',
  queued: '머지 대기',
  new: '클라우드 없음'
}
/** 같은 색 점 — 머지 대기는 갈라짐과 같은 색 */
const DOT: Record<ChipState, CardSyncState> = { same: 'same', pending: 'pending', 'remote-new': 'remote-new', diverged: 'diverged', queued: 'diverged', new: 'new' }

export function NoteSyncChip({ docId, title }: { docId: ID; title: string }) {
  const saveState = useUI((s) => s.saveState)
  const toast = useUI((s) => s.toast)
  const [state, setState] = useState<ChipState | null>(null)
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const refresh = useCallback(async () => {
    if (!(await getSync('rootFolderId'))) return setState(null) // 동기화를 설정하지 않았으면 칩을 내지 않는다
    const s = await noteCardState(docId)
    if (!s) return setState(null)
    const queued = (await cachedMergeQueue()).some((q) => q.docId === docId)
    setState(s === 'same' && queued ? 'queued' : s)
  }, [docId])

  // 저장이 끝날 때마다(올리기 필요가 생긴다), 동기화·머지·받기가 끝날 때마다 다시 본다
  useEffect(() => {
    if (saveState === 'saved') void refresh()
  }, [saveState, refresh])
  useEffect(() => {
    const on = () => void refresh()
    window.addEventListener(CLOUD_STATES_EVENT, on)
    window.addEventListener(REMOTE_EVENT, on)
    window.addEventListener(MERGE_DONE_EVENT, on)
    const un = onSyncStatus((s) => s === 'idle' && on())
    return () => {
      window.removeEventListener(CLOUD_STATES_EVENT, on)
      window.removeEventListener(REMOTE_EVENT, on)
      window.removeEventListener(MERGE_DONE_EVENT, on)
      un()
    }
  }, [refresh])

  if (!state) return null

  const act = async (fn: () => Promise<void>) => {
    setMenu(null)
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast(e instanceof Error ? e.message : '하지 못했습니다.', 'error')
    } finally {
      setBusy(false)
      void refresh()
    }
  }
  const push = () =>
    act(async () => {
      const r = await pushOneNote(docId)
      if (r === 'diverged') toast('다른 기기에서도 바뀌어 이 기기 브랜치에만 올렸습니다(갈라짐). 머지해 주세요.', 'info', { label: '머지', run: () => void openMerge() })
      else toast(r === 'skipped' ? '바뀐 내용이 없어 올리지 않았습니다.' : '이 노트를 올렸습니다.', r === 'skipped' ? 'info' : 'success')
    })
  // 이 기기 변경사항 확인 = 받기(클라우드로 맞추기). 이 기기에서 바꾼 것이 있으면 바로 덮지 않고 비교 화면에서 고른다.
  // 바꾼 것이 없으면 클라우드의 새 버전을 그대로 받는다
  const pull = () =>
    act(async () => {
      const r = await pullOneNote(docId)
      if (r === 'pending' || r === 'diverged') return openChanges({ docId, title, actions: ['align', 'push'] })
      const msg: Record<'applied' | 'same' | 'notfound', [string, 'info' | 'success' | 'error']> = {
        applied: ['이 기기에서 바꾼 것이 없어 클라우드의 새 버전을 받았습니다.', 'success'],
        same: ['이 기기에서 바꾼 것이 없고, 클라우드와 같습니다.', 'info'],
        notfound: ['클라우드에 이 노트가 없습니다. 먼저 올려 주세요.', 'info']
      }
      toast(...msg[r])
    })
  const openMerge = async () => {
    const q = (await listMergeQueue()).filter((e) => e.docId === docId)
    const target = q.find((e) => e.mine) ?? q[0]
    if (target) openMergeView(target)
    else toast('이 노트는 머지할 것이 없습니다.', 'info')
  }

  const open = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setMenu((m) => (m ? null : { x: r.right, y: r.bottom }))
  }
  return (
    <>
      <button className="note-sync" onClick={open} disabled={busy} aria-haspopup="menu" aria-expanded={!!menu} aria-label={`이 노트 동기화: ${LABEL[state]}`}>
        {busy ? (
          <span className="spinner sm" />
        ) : (
          <span className={'doc-state s-' + DOT[state]}>
            <i className="doc-state-dot" aria-hidden="true" />
            {LABEL[state]}
          </span>
        )}
      </button>
      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuItem icon="upload" label="이 노트 올리기" onClick={() => void push()} />
          <MenuItem icon="download" label="이 기기 변경사항 확인" onClick={() => void pull()} />
          {(state === 'pending' || state === 'diverged') && (
            <MenuItem icon="undo" label="변경 버리기…" onClick={() => (setMenu(null), openChanges({ docId, title, actions: ['discard'] }))} />
          )}
          {(state === 'diverged' || state === 'queued') && <MenuItem icon="swap" label="머지 열기" onClick={() => act(openMerge)} />}
        </Menu>
      )}
    </>
  )
}
