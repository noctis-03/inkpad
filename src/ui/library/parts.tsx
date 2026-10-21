// 라이브러리 화면의 작은 조각들 — Library.tsx 본체에서 상태를 거의 갖지 않는 부분만 떼어 냈다.
// (섹션 제목 모핑, 동기화 상태 라벨, 사이드바 폴더 트리, 카테고리 지정 모달, 미리보기 일괄 새로고침 버튼)
import { useEffect, useRef, useState } from 'react'
import { useUI } from '../../app/store'
import { SPRING, dur } from '../motion/motion'
import { Icon } from '../Icon'
import { refreshAllThumbnailsWithToast } from '../../io/docThumb'
import type { DocumentMeta, Folder, HtmlApp, ID } from '../../shared/model'
import { MAX_CATEGORY_CHARS, normalizeCategory } from '../../shared/model'
import type { CardSyncState } from '../../sync/sync'
import type { FileRow } from '../../storage/db'
import type { Mark } from '../../storage/repo'

/**
 * 카드 캡션의 동기화 상태 라벨.
 * 8px 색 점은 색만으로 뜻을 전달해 색각 이상 사용자에게 닿지 않는다 — 말로 바꾼다.
 * 클라우드 없음 / 올리기 대기 / 최신 / 클라우드에 새 버전 / 갈라짐(이 기기와 클라우드가 각각 바뀜 — 머지가 필요).
 */
const SYNC_LABEL: Record<CardSyncState, string> = {
  new: '클라우드 없음',
  pending: '올리기 필요',
  same: '동기화됨',
  'remote-new': '새 버전',
  diverged: '갈라짐'
}

/** 섹션 제목 — 바뀌면 위로 빠지고 아래에서 들어오며 바뀐다 */
export function TitleText({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState(text)
  const shownRef = useRef(text)
  const anims = useRef<Animation[]>([])
  // 섹션 제목 모핑: 위로 슬라이드아웃 → 텍스트 교체 → 아래에서 슬라이드인.
  // CSS 한 단계 페이드보다 느리고 두 단계로 해서 섹션이 바뀌는 느낌을 살린다.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // 실행 중인 애니메이션은 무조건 먼저 정리한다 — fill: forwards 가 남긴
    // opacity:0 고정 상태도 cancel 로 풀린다. 가드를 먼저 보면 A→B→A 처럼
    // 되돌아온 선택에서 사라짐 애니메이션이 끝까지 재생돼 제목이 사라진 채 남는다.
    anims.current.forEach((a) => a.cancel())
    anims.current = []
    if (shownRef.current === text) return
    if (document.documentElement.dataset.motion === 'off') {
      shownRef.current = text
      setShown(text)
      return
    }
    const out = el.animate(
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'translateY(-7px)' }
      ],
      { duration: dur(170), easing: 'ease-in', fill: 'forwards' }
    )
    anims.current.push(out)
    out.addEventListener(
      'finish',
      () => {
        // out의 fill:forwards(opacity 0 고정)를 먼저 걷는다 — 안 그러면 아래에서
        // 올라오는 애니메이션이 끝난 뒤 고정된 0이 다시 적용돼 제목이 안 뜬다.
        // 같은 태스크에서 inn을 시작하므로 첫 키프레임(opacity 0)이 즉시 덮어 빈틈이 없다.
        out.cancel()
        anims.current = []
        shownRef.current = text
        setShown(text)
        const inn = el.animate(
          [
            { opacity: 0, transform: 'translateY(7px)' },
            { opacity: 1, transform: 'none' }
          ],
          { duration: dur(380), easing: SPRING }
        )
        anims.current.push(inn)
      },
      { once: true }
    )
    return () => {
      anims.current.forEach((a) => a.cancel())
      anims.current = []
    }
  }, [text])
  return (
    <span ref={ref} className="title-text">
      {shown}
    </span>
  )
}

/** 동기화 상태 점 + 라벨 pill. 상태가 바뀌면 pop 한다. */
export function SyncPill({ state, overlay }: { state: CardSyncState; overlay?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  const prev = useRef(state)
  useEffect(() => {
    if (prev.current !== state && ref.current && document.documentElement.dataset.motion !== 'off') {
      ref.current.animate([{ scale: '0.7' }, { scale: '1.08' }, { scale: '1' }], { duration: dur(450), easing: SPRING })
    }
    prev.current = state
  }, [state])
  return (
    <span ref={ref} className={'doc-state s-' + state + (overlay ? ' is-overlay' : '')}>
      <i className="doc-state-dot" aria-hidden="true" />
      {SYNC_LABEL[state]}
    </span>
  )
}

export function FolderTree(props: {
  folders: Folder[]
  parentId: ID | null
  depth: number
  activeId: ID | null
  docs: DocumentMeta[]
  apps: HtmlApp[]
  files: FileRow[]
  onSelect: (id: ID) => void
  onMenu: (f: Folder, x: number, y: number) => void
  /** 고른 폴더에서 '최근 열람' 모드일 때 폴더 이름 옆에 표식을 붙인다 */
  recentActive?: boolean
}) {
  const children = props.folders.filter((f) => f.parentId === props.parentId)
  if (!children.length) return null
  return (
    <>
      {children.map((f) => (
        <div key={f.id}>
          <div className={'tree-item folder' + (props.activeId === f.id ? ' is-active' : '')} data-indicator-key={'folder:' + f.id} style={{ paddingLeft: 12 + props.depth * 16 }}>
            <button className="tree-main" onClick={() => props.onSelect(f.id)}>
              <Icon name="folder" size={18} /> <span className="tree-name">{f.name}</span>
              {props.recentActive && props.activeId === f.id && <span className="tree-recent-tag">최근</span>}
              <span className="count">
                {props.docs.filter((d) => d.category && (f.categories ?? []).includes(d.category)).length +
                  props.apps.filter((a) => a.category && (f.categories ?? []).includes(a.category)).length +
                  props.files.filter((x) => x.category && (f.categories ?? []).includes(x.category)).length}
              </span>
            </button>
            <button
              className="icon-mini"
              aria-label={`${f.name} 메뉴`}
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                props.onMenu(f, r.right, r.bottom)
              }}
            >
              <Icon name="more" size={16} />
            </button>
          </div>
          <FolderTree {...props} parentId={f.id} depth={props.depth + 1} />
        </div>
      ))}
    </>
  )
}

export function CategoryPicker({
  current,
  categories,
  onPick,
  onClose
}: {
  current: string | null
  categories: string[]
  onPick: (category: string | null) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const submit = () => {
    const c = normalizeCategory(name)
    if (!c) return
    onPick(c)
  }
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2 className="modal-title">카테고리 지정</h2>
        <div className="picker-list">
          <button className={'menu-item' + (current === null ? ' is-current' : '')} onClick={() => onPick(null)}>
            <Icon name="notebook" size={18} /> 미분류
          </button>
          {categories.map((c) => (
            <button key={c} className={'menu-item' + (current === c ? ' is-current' : '')} onClick={() => onPick(c)}>
              <Icon name="tag" size={18} /> {c}
            </button>
          ))}
        </div>
        <div className="cat-new-row">
          <input
            value={name}
            maxLength={MAX_CATEGORY_CHARS}
            placeholder="새 카테고리 만들기"
            aria-label="새 카테고리 이름"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && submit()}
          />
          <button className="text-btn small" disabled={!name.trim()} onClick={submit}>
            추가
          </button>
        </div>
        <div className="modal-actions">
          <button className="text-btn" onClick={onClose}>
            취소
          </button>
        </div>
      </div>
    </div>
  )
}

/** 미리보기 일괄 새로고침 — 만들 수 있는 카드 미리보기를 한 번에 다시 만든다.
 * 원본이 없어 만들 수 없는 PDF 노트는 자동으로 건너뛰고, 원본을 받으면 다음 실행부터 대상이 된다. */
export function ThumbRefreshButton() {
  const [busy, setBusy] = useState(false)
  const toast = useUI((s) => s.toast)
  return (
    <button
      className={'tb-btn thumb-refresh' + (busy ? ' spinning' : '')}
      disabled={busy}
      aria-label="미리보기 새로고침"
      title="카드 미리보기 새로고침 — 만들 수 있는 미리보기를 한 번에 다시 만듭니다"
      onClick={() => {
        setBusy(true)
        void refreshAllThumbnailsWithToast()
          .then((n) => {
            if (!n) toast('새로 만들 미리보기가 없습니다. 원본이 없는 PDF 노트는 원본을 받은 뒤 만들 수 있어요.', 'info')
          })
          .finally(() => setBusy(false))
      }}
    >
      <Icon name="replace" />
    </button>
  )
}

/** 마킹 종류 — 버튼 순서대로. cls는 CSS 클래스 꼬리(!는 클래스 이름에 못 쓴다) */
export const MARKS: { mark: Mark; label: string; cls: string }[] = [
  { mark: 'o', label: '동그라미', cls: 'o' },
  { mark: 'x', label: '엑스', cls: 'x' },
  { mark: '!', label: '느낌표', cls: 'ex' }
]
export const markInfo = (m: Mark) => MARKS.find((x) => x.mark === m)!

/** 마킹 기호 ○ ✕ ! — 반듯한 선(굵기 균일, 끝은 둥글게). 색은 currentColor. weight는 100칸 기준 선 굵기 */
export function MarkGlyph({ mark, size = 14, weight = 12 }: { mark: Mark; size?: number; weight?: number }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={weight} strokeLinecap="round">
      {mark === 'o' ? (
        <circle cx="50" cy="50" r="34" />
      ) : mark === 'x' ? (
        <path d="M23 23 77 77M77 23 23 77" />
      ) : (
        <>
          <path d="M50 14v48" />
          <circle cx="50" cy="83" r={weight * 0.62} fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  )
}
