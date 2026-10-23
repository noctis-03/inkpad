// 앱·파일 화면 머리의 칸 버튼 — 가운데 칸이면 뒤로 · 오른쪽 칸에 띄우기, 오른쪽 칸이면 칸 닫기 · 가운데로.
import { useUI, type SplitRoute } from '../../app/store'
import { Icon } from '../Icon'
import { useSplitAllowed } from '../TabBar'

/** 이 화면이 놓인 자리 — 가운데(지금 탭) · 오른쪽 칸(듀얼) · 숨김(켜 둔 채 다른 탭을 보는 중) */
export type PaneSlot = 'main' | 'side' | 'hidden'

/** 머리 왼쪽: 뒤로(가운데) 또는 칸 닫기(오른쪽) */
export function RunnerBack({ pane }: { pane: PaneSlot }) {
  const navigate = useUI((s) => s.navigate)
  const closeSplit = useUI((s) => s.closeSplit)
  if (pane === 'side')
    return (
      <button className="tb-btn" onClick={closeSplit} aria-label="오른쪽 칸 닫기" title="오른쪽 칸 닫기 (탭은 남는다)">
        <Icon name="close" />
      </button>
    )
  return (
    <button className="tb-btn" onClick={() => navigate(useUI.getState().returnRoute ?? useUI.getState().home)} aria-label="뒤로">
      <Icon name="back" />
    </button>
  )
}

/** 머리 오른쪽: 오른쪽 칸에 띄우기(가운데, 넓은 화면만) 또는 가운데로(오른쪽) */
export function RunnerSplit({ pane, route }: { pane: PaneSlot; route: SplitRoute }) {
  const navigate = useUI((s) => s.navigate)
  const openSplit = useUI((s) => s.openSplit)
  const allowed = useSplitAllowed()
  if (pane === 'side')
    return (
      <button className="tb-btn" onClick={() => navigate(route)} aria-label="가운데로" title="가운데 칸으로 크게">
        <Icon name="maximize" />
      </button>
    )
  if (!allowed) return null
  return (
    <button className="tb-btn" onClick={() => openSplit(route)} aria-label="오른쪽 칸에 띄우기" title="오른쪽 칸에 띄우기 — 가운데에서 노트를 함께 본다">
      <Icon name="sidebar" />
    </button>
  )
}
