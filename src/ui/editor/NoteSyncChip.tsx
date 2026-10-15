// 편집 화면 툴바의 노트 동기화 칩 — 이 노트의 상태(최신·올리기 필요·새 버전·갈라짐·머지 대기·클라우드 없음)를
// 라이브러리 카드와 같은 점으로 보여 주고, 누르면 이 노트만 올리기·받기·머지·버전 기록을 고른다.
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

export function NoteSyncChip({ docId }: { docId: ID }) {
  const saveState = useUI((s) => s.saveState)
  const setPanel = useUI((s) => s.setPanel)
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
  const pull = () =>
    act(async () => {
      const r = await pullOneNote(docId)
      const msg: Record<typeof r, [string, 'info' | 'success' | 'error']> = {
        applied: ['클라우드의 새 버전을 받았습니다.', 'success'],
        same: ['이미 최신입니다.', 'info'],
        pending: ['이 기기에 올리지 않은 변경이 있어 받지 않았습니다. 먼저 올려 주세요.', 'info'],
        diverged: ['이 기기와 다른 기기가 각각 고쳐 갈라졌습니다. 덮지 않고 머지 관리에서 합칩니다.', 'info'],
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
          <MenuItem icon="download" label="이 노트 받기" onClick={() => void pull()} />
          {(state === 'diverged' || state === 'queued') && <MenuItem icon="swap" label="머지 열기" onClick={() => act(openMerge)} />}
          <MenuItem icon="restore" label="버전 기록" onClick={() => (setMenu(null), setPanel('history'))} />
          <MenuItem icon="cloud" label="동기화 패널" onClick={() => (setMenu(null), setPanel('sync'))} />
        </Menu>
      )}
    </>
  )
}
