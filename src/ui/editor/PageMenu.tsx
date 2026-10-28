// 페이지 메뉴 — 페이지 사이드바 썸네일의 ⋯와 캔버스의 페이지 칩(PageChipLayer)이 함께 쓴다.
// 페이지 더하기·복제·보조 용지·순서·삭제와, 이 페이지를 이미지로·AI로 보내기
import type { Engine } from '../../engine/engine'
import { useUI } from '../../app/store'
import { confirmDialog } from '../../app/dialogs'
import { Menu, MenuItem } from '../Menu'

export function PageMenu({ engine, index: i, x, y, readOnly, onClose }: { engine: Engine; index: number; x: number; y: number; readOnly?: boolean; onClose: () => void }) {
  const count = engine.pages.length
  const act = (fn: () => void) => () => {
    onClose()
    fn()
  }
  const del = async () => {
    if (count <= 1) return useUI.getState().toast('마지막 페이지는 삭제할 수 없습니다.')
    const ok = await confirmDialog(`${i + 1}페이지 삭제`, { message: '실행 취소로 되돌릴 수 있습니다.', ok: '삭제', danger: true })
    if (ok) engine.deletePage(i)
  }
  return (
    <Menu x={x} y={y} onClose={onClose}>
      <div className="menu-label">{i + 1}페이지</div>
      <MenuItem icon="share" label="이미지로 보내기" onClick={act(() => useUI.setState({ sendImage: { page: i } }))} />
      <MenuItem icon="sparkle" label="AI로 보내기" onClick={act(() => useUI.setState({ aiSend: { page: i } }))} />
      {!readOnly && (
        <>
          <div className="menu-sep" />
          <MenuItem icon="plus" label="앞에 새 페이지" onClick={act(() => engine.addPage(i - 1))} />
          <MenuItem icon="plus" label="뒤에 새 페이지" onClick={act(() => engine.addPage(i))} />
          <MenuItem icon="copy" label="복제" onClick={act(() => engine.duplicatePage(i))} />
          <MenuItem icon="page" label="왼쪽에 보조 용지" onClick={act(() => engine.addSheet(i, 'left'))} />
          <MenuItem icon="page" label="오른쪽에 보조 용지" onClick={act(() => engine.addSheet(i, 'right'))} />
          {i > 0 && <MenuItem icon="arrowUp" label="위로" onClick={act(() => engine.movePage(i, i - 1))} />}
          {i < count - 1 && <MenuItem icon="arrowDown" label="아래로" onClick={act(() => engine.movePage(i, i + 1))} />}
          <MenuItem icon="trash" label="삭제" danger onClick={act(() => void del())} />
        </>
      )}
    </Menu>
  )
}
