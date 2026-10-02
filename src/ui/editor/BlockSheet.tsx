import { useEffect, useRef, useState } from 'react'
import { BLOCK_FONT_SIZES, PEN_COLORS, useUI } from '../../app/store'
import type { Engine } from '../../engine/engine'
import type { BlockRec } from '../../engine/scene'
import { MIN_TEXT_W, isSafeUrl, type Element, type ID, type LinkElement, type TextBox } from '../../shared/model'
import { Icon } from '../Icon'

/**
 * 하단 컨텍스트 시트 (대안 A) + 블록 목록 (대안 B 흡수).
 *
 * 왜 시트인가: 블록을 따라다니는 팝업은 화면 가장자리에서 잘리고 도구 위치가 매번 달라진다.
 * 화면 하단에 고정하면 어느 블록을 잡아도 도구 위치가 같아 펜슬 사용자의 근육 기억이 성립한다.
 * 데이터는 전부 엔진이 소유하고, 여기는 표시와 조작만 담당한다 (BlockLayer와 같은 원칙).
 */
export type SheetTab = 'style' | 'list'

const FONT_FAMILIES: { label: string; value?: string }[] = [
  { label: '본문' },
  { label: '고정폭', value: "ui-monospace, 'SF Mono', Menlo, monospace" },
  { label: '손글씨', value: "'Snell Roundhand', 'Apple SD Gothic Neo', cursive" }
]

const wOf = (e: Element) => (e.type === 'text' || e.type === 'link' ? e.w : 0)

const bodyOf = (e: Element) =>
  e.type === 'text' ? (e as TextBox).text : e.type === 'link' ? (e as LinkElement).label : ''

export function BlockSheet({
  engine,
  block,
  tab,
  onTab,
  onClose,
  onEditText
}: {
  engine: Engine
  block: BlockRec | null
  tab: SheetTab
  onTab: (t: SheetTab) => void
  onClose: () => void
  onEditText: (id: ID) => void
}) {
  const settings = useUI((s) => s.settings)
  const setSettings = useUI((s) => s.setSettings)
  const style = useUI((s) => s.style)
  const setStyle = useUI((s) => s.setStyle)
  const toast = useUI((s) => s.toast)

  const ref = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [urlDraft, setUrlDraft] = useState('')
  const [filter, setFilter] = useState('')

  const el = block && (block.el.type === 'text' || block.el.type === 'link') ? block.el : null
  const isLink = el?.type === 'link'
  const url = isLink ? (el as LinkElement).url : ''

  useEffect(() => setUrlDraft(url), [url, block?.el.id])

  /**
   * 시트 위의 포인터는 엔진으로 새지 않게 캡처 단계에서 끊는다.
   * (엔진은 #canvas-root에 리스너를 두고, 시트는 그 자식이라 캡처가 먼저 온다)
   */
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const stop = (e: Event) => e.stopPropagation()
    const evs = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel'] as const
    for (const n of evs) node.addEventListener(n, stop, true)
    return () => {
      for (const n of evs) node.removeEventListener(n, stop, true)
    }
  }, [])

  const nameOf = (b: BlockRec) => bodyOf(b.el) || (b.el.type === 'link' ? '이름 없는 링크' : '빈 텍스트 블록')

  const stepFont = (dir: number) => {
    if (!el) return
    const cur = el.fontSize
    let i = BLOCK_FONT_SIZES.indexOf(cur)
    if (i < 0) i = BLOCK_FONT_SIZES.findIndex((s) => s >= cur)
    if (i < 0) i = BLOCK_FONT_SIZES.length - 1
    const next = BLOCK_FONT_SIZES[Math.max(0, Math.min(BLOCK_FONT_SIZES.length - 1, i + dir))]
    if (next === cur) return
    setStyle({ ...style, block: { ...style.block, fontSize: next } })
    engine.updateBlock(el.id, { fontSize: next })
  }

  const pickColor = (c: string) => {
    if (!el) return
    setStyle({ ...style, block: { ...style.block, color: c } })
    engine.updateBlock(el.id, { color: c })
  }

  const bumpWidth = (dir: number) => {
    if (!el) return
    const next = Math.max(MIN_TEXT_W, Math.round((el.w + dir * 16) / 8) * 8)
    if (next === el.w) return
    engine.updateBlock(el.id, { w: next })
  }

  const applyUrl = () => {
    if (!el || !isLink) return
    const v = urlDraft.trim()
    if (v && !isSafeUrl(v)) {
      toast('링크 주소는 http(s):// 또는 mailto: 로 시작해야 합니다.', 'error')
      return
    }
    engine.updateBlock(el.id, { url: v })
  }

  const openUrl = () => {
    if (!isSafeUrl(url)) {
      toast('링크 주소는 http(s):// 또는 mailto: 로 시작해야 합니다.', 'error')
      return
    }
    window.open(url.trim(), '_blank', 'noopener,noreferrer')
  }

  const removeBlock = (id: ID) => {
    engine.deleteBlock(id)
    engine.clearSelection()
  }

  const duplicate = () => {
    if (!el) return
    engine.selectBlock(el.id)
    engine.duplicateSelection()
  }

  const all = engine.blocks()
  const q = filter.trim().toLowerCase()
  const rows = q ? all.filter((b) => nameOf(b).toLowerCase().includes(q)) : all

  return (
    <div
      className={'block-sheet' + (collapsed ? ' is-collapsed' : '')}
      ref={ref}
      role="dialog"
      aria-label="블록 인스펙터"
    >
      <button
        className="bs-grip"
        onClick={() => setCollapsed(!collapsed)}
        aria-label={collapsed ? '시트 펼치기' : '시트 접기'}
      />

      {tab === 'style' && el && !collapsed && (
        <div className="bs-spec">
          <div
            className="bs-spec-t"
            style={{
              fontSize: Math.min(el.fontSize, 22),
              color: el.color,
              fontFamily: el.fontFamily ?? 'inherit',
              textAlign: el.align ?? 'left'
            }}
          >
            {bodyOf(el) || (isLink ? '이름 없는 링크' : '빈 텍스트 블록')}
          </div>
          <div className="bs-spec-m">
            <span>{isLink ? 'LINK' : 'TEXT'}</span>
            <span>
              {Math.round(el.w)} × {Math.round(el.h ?? 0)}
            </span>
            <span>{el.fontSize}px</span>
            <span>{el.color.slice(0, 7)}</span>
          </div>
        </div>
      )}

      <div className="bs-bar">
        <div className="bs-tabs" role="tablist">
          <button
            className={'bs-tab' + (tab === 'style' ? ' is-active' : '')}
            onClick={() => onTab('style')}
            role="tab"
            aria-selected={tab === 'style'}
          >
            스타일
          </button>
          <button
            className={'bs-tab' + (tab === 'list' ? ' is-active' : '')}
            onClick={() => onTab('list')}
            role="tab"
            aria-selected={tab === 'list'}
          >
            블록 목록 <span className="bs-count">{all.length}</span>
          </button>
        </div>
        <div className="bs-bar-spacer" />
        <span className="bs-hint">Esc 닫기 · ⌘Z 되돌리기</span>
        <button className="bs-close" onClick={onClose} aria-label="닫기">
          <Icon name="close" size={18} />
        </button>
      </div>

      {tab === 'style' && el && (
        <div className="bs-grid">
          <section className="bs-sec">
            <h4>크기 · 정렬</h4>
            <div className="bs-row">
              <button className="bs-btn" onClick={() => stepFont(-1)} aria-label="글자 작게">
                A−
              </button>
              <span className="bs-val">{el.fontSize}</span>
              <button className="bs-btn" onClick={() => stepFont(1)} aria-label="글자 크게">
                A+
              </button>
            </div>
            <div className="bs-row">
              {FONT_FAMILIES.map((f) => (
                <button
                  key={f.label}
                  className={'bs-btn' + ((el.fontFamily ?? undefined) === f.value ? ' is-on' : '')}
                  onClick={() => engine.updateBlock(el.id, { fontFamily: f.value })}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="bs-row">
              {(['left', 'center', 'right'] as const).map((a) => (
                <button
                  key={a}
                  className={'bs-btn' + ((el.align ?? 'left') === a ? ' is-on' : '')}
                  onClick={() => engine.updateBlock(el.id, { align: a })}
                >
                  {a === 'left' ? '왼쪽' : a === 'center' ? '가운데' : '오른쪽'}
                </button>
              ))}
            </div>
          </section>

          <section className="bs-sec">
            <h4>색</h4>
            <div className="bs-row wrap">
              {PEN_COLORS.map((c) => (
                <button
                  key={c}
                  className={'bs-sw' + (el.color.slice(0, 7) === c.slice(0, 7) ? ' is-on' : '')}
                  style={{ ['--swatch' as string]: c }}
                  onClick={() => pickColor(c)}
                  aria-label={`색 ${c}`}
                />
              ))}
            </div>
            <label className="bs-custom" aria-label="직접 선택">
              <Icon name="palette" size={16} />
              <span>직접 선택</span>
              <input
                type="color"
                value={el.color.slice(0, 7)}
                onChange={(e) => pickColor(e.target.value + (el.color.slice(7, 9) || 'ff'))}
              />
            </label>
          </section>

          <section className="bs-sec">
            <h4>{isLink ? '링크' : '내용'}</h4>
            {isLink ? (
              <>
                <div className="bs-url" title={url}>
                  {url || '주소 없음'}
                </div>
                <div className="bs-row">
                  <input
                    className="bs-input"
                    value={urlDraft}
                    placeholder="https://…"
                    spellCheck={false}
                    onChange={(e) => setUrlDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') applyUrl()
                    }}
                  />
                </div>
                <div className="bs-row">
                  <button className="bs-btn" onClick={applyUrl}>
                    주소 적용
                  </button>
                  <button className="bs-btn" disabled={!isSafeUrl(url)} onClick={openUrl}>
                    <Icon name="external" size={15} />
                    열기
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="bs-row">
                  <button className="bs-btn" onClick={() => onEditText(el.id)}>
                    <Icon name="edit" size={15} />
                    내용 편집
                  </button>
                </div>
                <div className="bs-row">
                  <span className="bs-meta">{(el as TextBox).text.length}자 · {Math.round(el.w)}pt 폭</span>
                </div>
              </>
            )}
          </section>

          <section className="bs-sec">
            <h4>폭 · 정리</h4>
            <div className="bs-row">
              <button className="bs-btn" onClick={() => bumpWidth(-1)} aria-label="폭 줄이기">
                −
              </button>
              <span className="bs-val">{Math.round(el.w)}</span>
              <button className="bs-btn" onClick={() => bumpWidth(1)} aria-label="폭 늘리기">
                ＋
              </button>
            </div>
            <div className="bs-row">
              <button
                className={'bs-btn' + (settings.blockSnap ? ' is-on' : '')}
                onClick={() => setSettings({ blockSnap: !settings.blockSnap })}
              >
                <Icon name="grid" size={15} />
                스냅 {settings.blockSnap ? '켜짐' : '꺼짐'}
              </button>
            </div>
            <div className="bs-row">
              <button className="bs-btn" onClick={duplicate}>
                <Icon name="copy" size={15} />
                복제
              </button>
              <button className="bs-btn danger" onClick={() => removeBlock(el.id)}>
                <Icon name="trash" size={15} />
                삭제
              </button>
            </div>
          </section>
        </div>
      )}

      {tab === 'list' && (
        <div className="bs-list">
          <input
            className="bs-input"
            style={{ maxWidth: 220 }}
            value={filter}
            placeholder="블록 찾기"
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="bs-rows">
            {rows.map((b) => {
              if (b.el.type !== 'text' && b.el.type !== 'link') return null
              const on = b.el.id === block?.el.id
              return (
                <div key={b.el.id} className={'bs-row-item' + (on ? ' is-on' : '')}>
                  <button
                    className="bs-row-main"
                    onClick={() => {
                      engine.selectBlock(b.el.id)
                      onTab('style')
                    }}
                  >
                    <Icon name={b.el.type === 'link' ? 'link' : 'type'} size={15} />
                    <span className="bs-row-t">{nameOf(b)}</span>
                    <span className="bs-row-n">{Math.round(wOf(b.el))}pt</span>
                  </button>
                  <button className="bs-row-del" onClick={() => removeBlock(b.el.id)} aria-label="블록 삭제">
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              )
            })}
            {!rows.length && <p className="bs-empty">해당하는 블록이 없습니다.</p>}
          </div>
        </div>
      )}
    </div>
  )
}
