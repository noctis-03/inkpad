// 카테고리 지정 창 — 노트·앱·파일 ⋯ 메뉴의 「카테고리 지정」과 선택 모드의 일괄 지정이 함께 쓴다.
//  - 입력 칸 하나로 검색과 새로 만들기: 입력하면 목록이 걸러지고, 같은 이름이 없으면 맨 아래 「새로 만들기」
//  - 사이드바와 같은 묶음: "[태그] 이름"은 '이름' 묶음 아래 [태그]로, 카테고리별 개수.
//    색 점은 두지 않는다 — 이름만으로 고르는 창이라 글자가 먼저 읽히게
//  - 카테고리 없음은 목록과 구분선으로 나눈다
//  - 숨긴 카테고리는 흐리게 + 「숨김」. 고르면 목록에서 사라진다는 것을 먼저 알린다
//  - ↑↓로 고르고 Enter로 지정, Esc로 닫기. 좁은 화면에서는 아래에서 올라오는 시트
import { useEffect, useMemo, useRef, useState } from 'react'
import { MAX_CATEGORY_CHARS, normalizeCategory } from '../../shared/model'
import { splitCategory } from '../../shared/util'
import { Icon } from '../Icon'
import { useEscClose } from '../sheetParts'

export interface CategoryPickerProps {
  /** 무엇에 지정하는가 — 노트 제목, 또는 'n개 항목' */
  title: string
  /** 대상들의 지금 카테고리별 개수 (null = 카테고리 없음). 하나만 고쳐도 같은 꼴 */
  current: Map<string | null, number>
  /** 대상 수 */
  total: number
  /** 이 기기의 카테고리 전체 (숨긴 것 포함) */
  categories: string[]
  /** 카테고리별 항목 수 */
  counts: Map<string, number>
  hidden: Set<string>
  /** 최근에 지정한 카테고리 (앞이 최근) */
  recent: string[]
  onPick: (c: string | null) => void
  onClose: () => void
}

type Row =
  | { t: 'none' }
  | { t: 'sep' }
  | { t: 'group'; name: string; items: string[]; open: boolean }
  | { t: 'cat'; name: string; label: string; child: boolean }
  | { t: 'suggest'; name: string }
  | { t: 'create'; name: string }

const ko = (a: string, b: string) => a.localeCompare(b, 'ko')
const loose = (s: string) => s.replace(/\s+/g, '').toLowerCase()
/** "[과제] 디지털 시스템" → "디지털 시스템 · 과제" (토스트·최근 칩) */
export const categoryDisplay = (c: string) => {
  const s = splitCategory(c)
  return s.group ? `${s.label} · ${s.group}` : c
}

export function CategoryPicker(p: CategoryPickerProps) {
  const [q, setQ] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const [active, setActive] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useEscClose(p.onClose)

  // "[태그] 이름" → 이름 묶음. 사이드바와 같은 순서: 묶음 → [태그] 없는 카테고리
  const { groups, plain } = useMemo(() => {
    const g = new Map<string, string[]>()
    const plain: string[] = []
    for (const c of p.categories) {
      const s = splitCategory(c)
      if (!s.group) plain.push(c)
      else g.set(s.label, [...(g.get(s.label) ?? []), c])
    }
    const groups = [...g].sort((a, b) => ko(a[0], b[0])).map(([name, items]) => ({ name, items: items.sort((a, b) => ko(splitCategory(a).group!, splitCategory(b).group!)) }))
    return { groups, plain: plain.sort(ko) }
  }, [p.categories])

  // 지금 카테고리가 든 묶음은 펼친 채로 연다
  const [open, setOpen] = useState<Set<string>>(() => new Set(groups.filter((g) => g.items.some((c) => p.current.has(c))).map((g) => g.name)))

  const query = q.replace(/\s+/g, ' ').trim()
  const lq = query.toLowerCase()
  const created = normalizeCategory(query)

  const rows = useMemo(() => {
    const out: Row[] = []
    const match = (s: string) => s.toLowerCase().includes(lq)
    const cat = (name: string, label: string, child: boolean) => out.push({ t: 'cat', name, label, child })
    if (!lq) out.push({ t: 'none' }, { t: 'sep' })
    for (const g of groups) {
      const items = !lq || match(g.name) ? g.items : g.items.filter(match)
      if (!items.length) continue
      const isOpen = !!lq || open.has(g.name)
      out.push({ t: 'group', name: g.name, items: g.items, open: isOpen })
      if (isOpen) for (const c of items) cat(c, splitCategory(c).group!, true)
    }
    for (const c of plain) if (!lq || match(c)) cat(c, c, false)
    if (created) {
      const similar = p.categories.find((c) => c !== created && loose(c) === loose(created))
      if (similar) out.push({ t: 'suggest', name: similar })
      if (!p.categories.includes(created)) out.push({ t: 'create', name: created })
    }
    return out
  }, [groups, plain, lq, open, created, p.categories])

  // ↑↓·Enter가 고를 수 있는 줄
  const pickable = rows.map((r, i) => (r.t === 'none' || r.t === 'cat' || r.t === 'suggest' || r.t === 'create' ? i : -1)).filter((i) => i >= 0)
  // 검색하면 첫 결과가 Enter 대상 — 같은 이름이 있으면 그것, 없으면 첫 줄
  useEffect(() => {
    if (!lq) return setActive(-1)
    const exact = rows.findIndex((r) => r.t === 'cat' && r.name.toLowerCase() === lq)
    setActive(exact >= 0 ? exact : (pickable[0] ?? -1))
  }, [lq])
  useEffect(() => {
    if (active >= 0) listRef.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // 열 때: 마우스·키보드 기기면 입력 칸에 바로(터치 기기는 자판이 목록을 가리므로 누를 때), 지금 카테고리가 보이게
  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) inputRef.current?.focus()
    listRef.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' })
  }, [])

  const choose = (c: string | null) => {
    if (c && p.hidden.has(c) && confirm !== c) return setConfirm(c)
    p.onPick(c)
  }
  const runRow = (r: Row) => {
    if (r.t === 'none') choose(null)
    else if (r.t === 'cat' || r.t === 'suggest' || r.t === 'create') choose(r.name)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return // 한글 조합 중의 Enter·화살표는 입력기 몫
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!pickable.length) return
      const at = pickable.indexOf(active)
      const next = e.key === 'ArrowDown' ? (at < 0 ? 0 : Math.min(at + 1, pickable.length - 1)) : at <= 0 ? 0 : at - 1
      setActive(pickable[next])
    } else if (e.key === 'Enter' && active >= 0 && rows[active]) {
      e.preventDefault()
      runRow(rows[active])
    }
  }

  const state = (c: string | null) => {
    const n = p.current.get(c) ?? 0
    return { full: n > 0 && n === p.total, part: n > 0 && n < p.total, n }
  }
  const summary =
    p.total > 1
      ? '지금: ' +
        [...p.current]
          .sort((a, b) => b[1] - a[1])
          .map(([c, n]) => `${c === null ? '없음' : categoryDisplay(c)} ${n}`)
          .join(' · ')
      : null
  const recent = lq ? [] : p.recent.filter((c) => p.categories.includes(c)).slice(0, 3)

  const mark = (c: string | null) => {
    const s = state(c)
    return (
      <>
        {s.part && <span className="cp-part">{`${s.n}/${p.total}`}</span>}
        <span className="cp-check" aria-hidden="true">
          {s.full ? <Icon name="check" size={18} /> : s.part ? <span className="cp-dash" /> : null}
        </span>
      </>
    )
  }

  return (
    <div className="modal-backdrop cp-backdrop" onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="modal cp" role="dialog" aria-modal="true" aria-labelledby="cp-title" onKeyDown={onKey}>
        <div className="cp-head">
          <div className="cp-head-text">
            <h2 className="cp-title" id="cp-title">
              카테고리 지정
            </h2>
            <div className="cp-target">{p.title}</div>
            {summary && <div className="cp-target">{summary}</div>}
          </div>
          <button className="sheet-close cp-close" aria-label="닫기" onClick={p.onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>

        <label className="cp-search">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={q}
            maxLength={MAX_CATEGORY_CHARS}
            placeholder="검색 또는 새로 만들기"
            aria-label="카테고리 검색 또는 새 카테고리 이름"
            role="combobox"
            aria-expanded="true"
            aria-controls="cp-list"
            aria-activedescendant={active >= 0 ? `cp-row-${active}` : undefined}
            onChange={(e) => {
              setQ(e.target.value)
              setConfirm(null)
            }}
          />
          {q && (
            <button className="cp-clear" aria-label="지우기" onClick={() => (setQ(''), inputRef.current?.focus())}>
              <Icon name="close" size={14} />
            </button>
          )}
        </label>

        {recent.length > 0 && (
          <div className="cp-recent">
            <span className="cp-recent-label">최근</span>
            {recent.map((c) => (
              <button key={c} className="cp-chip" onClick={() => choose(c)}>
                {categoryDisplay(c)}
              </button>
            ))}
          </div>
        )}

        <div className="cp-list" id="cp-list" role="listbox" aria-label="카테고리" ref={listRef}>
          {rows.map((r, i) => {
            const act = i === active ? ' is-active' : ''
            const rowProps = { id: `cp-row-${i}`, 'data-row': i, role: 'option' as const, onPointerEnter: () => lq && setActive(i) }
            if (r.t === 'sep') return <div key="sep" className="cp-sep" />
            if (r.t === 'none') {
              const s = state(null)
              return (
                <button key="none" {...rowProps} aria-selected={s.full} className={'cp-row' + (s.full ? ' is-current' : '') + act} onClick={() => choose(null)}>
                  <span className="cp-name">카테고리 없음</span>
                  {mark(null)}
                </button>
              )
            }
            if (r.t === 'group') {
              const n = r.items.reduce((a, c) => a + (p.counts.get(c) ?? 0), 0)
              const holdsCurrent = !r.open && r.items.some((c) => state(c).full || state(c).part)
              return (
                <button
                  key={'g:' + r.name}
                  className="cp-group"
                  aria-expanded={r.open}
                  disabled={!!lq}
                  onClick={() =>
                    setOpen((o) => {
                      const next = new Set(o)
                      if (next.has(r.name)) next.delete(r.name)
                      else next.add(r.name)
                      return next
                    })
                  }
                >
                  <span className={'cp-chev' + (r.open ? ' is-open' : '')} aria-hidden="true">
                    <Icon name="chevronRight" size={14} />
                  </span>
                  <span className="cp-name">{r.name}</span>
                  {holdsCurrent && <span className="cp-group-cur">현재</span>}
                  {!r.open && <span className="cp-count">{n}</span>}
                </button>
              )
            }
            if (r.t === 'cat') {
              const s = state(r.name)
              const hidden = p.hidden.has(r.name)
              return (
                <div key={'c:' + r.name} className={'cp-cat' + (r.child ? ' is-child' : '') + (s.full ? ' is-current' : '') + (confirm === r.name ? ' is-confirm' : '') + act}>
                  <button {...rowProps} aria-selected={s.full} className="cp-row" onClick={() => choose(r.name)}>
                    <span className={'cp-name' + (hidden ? ' is-hidden' : '')}>{r.label}</span>
                    {hidden && (
                      <span className="cp-badge">
                        <Icon name="eyeOff" size={11} />
                        숨김
                      </span>
                    )}
                    <span className="cp-count">{p.counts.get(r.name) || ''}</span>
                    {mark(r.name)}
                  </button>
                </div>
              )
            }
            if (r.t === 'suggest')
              return (
                <button key="suggest" {...rowProps} className={'cp-row cp-suggest' + act} onClick={() => choose(r.name)}>
                  <span className="cp-name">
                    혹시 <b>‘{r.name}’</b>?
                  </span>
                  <span className="cp-count">기존</span>
                </button>
              )
            // create
            const s = splitCategory(r.name)
            return (
              <button key="create" {...rowProps} className={'cp-row cp-create' + act} onClick={() => choose(r.name)}>
                <span className="cp-plus" aria-hidden="true">
                  <Icon name="plus" size={12} />
                </span>
                <span className="cp-name">
                  <span className="cp-create-title">‘{r.name}’ 새로 만들기</span>
                  <span className="cp-create-sub">{s.group ? `‘${s.label}’ 묶음 안 [${s.group}]` : '새 카테고리'}
                  </span>
                </span>
                {r.name.length > MAX_CATEGORY_CHARS - 10 && <span className="cp-count">{`${r.name.length}/${MAX_CATEGORY_CHARS}`}</span>}
              </button>
            )
          })}
          {lq && !rows.length && <div className="cp-empty">일치하는 카테고리가 없습니다</div>}
          {!lq && !p.categories.length && (
            <div className="cp-empty">
              아직 카테고리가 없어요. 위에 이름을 입력해 만드세요.
              <span className="cp-empty-hint">
                예: <code>[과제] 디지털 시스템</code> — ‘디지털 시스템’ 묶음 안에 [과제]로 모입니다
              </span>
            </div>
          )}
        </div>

        {confirm && (
          <div className="cp-confirm" role="alert">
            <div className="cp-confirm-text">
              <b>‘{confirm}’</b>은(는) 이 기기에서 숨긴 카테고리예요. 지정하면 {p.total > 1 ? '이 항목들이' : '이 항목이'} 라이브러리 목록에서 보이지 않습니다.
            </div>
            <div className="cp-confirm-actions">
              <button className="text-btn" onClick={() => setConfirm(null)}>
                취소
              </button>
              <button className="text-btn primary" onClick={() => p.onPick(confirm)}>
                그래도 지정
              </button>
            </div>
          </div>
        )}

        <div className="cp-foot">
          <span className="cp-keys">↑↓ 이동 · Enter 지정 · Esc 닫기</span>
        </div>
      </div>
    </div>
  )
}
