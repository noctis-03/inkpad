// 문서(text 모드)의 머지·비교 — 캔버스 대신 블록 목록으로 보여 준다.
// 머지 화면(MergeView)과 '이 기기에서 바꾼 것'(ChangesView)이 함께 쓴다. 출처 색은 머지 캔버스와 같다.
import { useMemo } from 'react'
import { resolveItem, type MergeDraft, type MergeItem, type MergePlan, type Side } from '../../sync/merge'
import { byPos } from '../../shared/fracIndex'
import { escapeHtml, plainText, sanitizeInline } from '../../shared/richText'
import type { TextBlock } from '../../shared/model'
import { numberLabels } from '../../textdoc/model'
import { Icon } from '../Icon'
import { LAYER_COLOR } from './MergeCanvas'

/** 블록이 어떻게 바뀌었나 — 머지(main↔브랜치)와 비교(기준본↔이 기기)가 같은 말로 쓴다 */
export type TextChange = 'same' | 'mainOnly' | 'branchOnly' | 'edited' | 'delMain' | 'delBranch'

export interface TextRow {
  item: MergeItem
  /** 지금 고른 쪽의 블록 */
  block: TextBlock
  side: Side
  /** 고르지 않은 쪽 (양쪽에 있을 때) */
  other?: TextBlock
  change: TextChange
  discarded: boolean
  /** 고른 쪽이 지운 블록 — 결과에 남지 않는다 */
  deleted: boolean
}

const pick = (item: MergeItem, side: Side) => (side === 'main' ? (item.main ?? item.branch) : (item.branch ?? item.main)) as TextBlock

/** 작업본을 얹은 블록 목록 (순서 키 순). resultOnly면 결과에 남는 것만 */
export function buildTextRows(plan: MergePlan, draft: MergeDraft, resultOnly: boolean): TextRow[] {
  const rows: TextRow[] = []
  for (const item of plan.items) {
    if (item.kind !== 'tblock') continue
    const { side, discarded } = resolveItem(item, draft)
    const block = pick(item, side)
    const m = item.main as TextBlock | undefined
    const b = item.branch as TextBlock | undefined
    // 양쪽 다 지운 블록은 보일 것이 없다
    if ((!m || m.deletedAt) && (!b || b.deletedAt)) continue
    const change: TextChange =
      item.cls === 'common' ? 'same' : item.cls === 'mainOnly' ? 'mainOnly' : item.cls === 'branchOnly' ? 'branchOnly' : m?.deletedAt ? 'delMain' : b?.deletedAt ? 'delBranch' : 'edited'
    const deleted = !!block.deletedAt
    if (resultOnly && (discarded || deleted)) continue
    const other = m && b ? (side === 'main' ? b : m) : undefined
    rows.push({ item, block, side, other, change, discarded, deleted })
  }
  return rows.sort((x, y) => byPos(x.block, y.block))
}

/** 화면에 그릴 HTML — Drive에서 온 내용이라 그대로 넣지 않고 늘 정리한다 */
const safeHtml = (b: TextBlock) => (b.type === 'code' ? escapeHtml(plainText(b.html)) : sanitizeInline(b.html)) || '<span class="tm-empty">(빈 줄)</span>'

const BULLETS = ['•', '◦', '▪']

export interface TextDiffProps {
  rows: TextRow[]
  /** 출처 이름 — main·브랜치 (비교 화면에서는 기준본·이 기기) */
  sideName: (s: Side) => string
  /** 바뀐 것을 설명하는 말 */
  changeLabel: (c: TextChange) => string
  /** 바뀐 종류별 색 — 주지 않으면 출처(레이어) 색 */
  changeColors?: Partial<Record<TextChange, string>>
  /** 머지 화면만 — 비교 화면은 보기만 한다 */
  onToggleDiscard?: (key: string) => void
  onFlip?: (key: string) => void
  rowRefs?: Map<string, HTMLElement>
  /** 강조한 레이어 — 나머지는 흐리게 */
  focus?: MergeItem['cls'] | null
}

export function TextDiffList(p: TextDiffProps) {
  // 번호는 결과에 남는 블록끼리 센다
  const nums = useMemo(() => numberLabels(p.rows.filter((r) => !r.discarded && !r.deleted).map((r) => r.block)), [p.rows])
  if (!p.rows.length) return <p className="merge-empty">블록이 없습니다.</p>
  return (
    <div className="tm-list">
      {p.rows.map((r) => {
        const b = r.block
        const cls = r.item.cls
        const color = cls === 'common' ? 'transparent' : (p.changeColors?.[r.change] ?? LAYER_COLOR[cls])
        const marker =
          b.type === 'bullet' ? BULLETS[b.indent % BULLETS.length] : b.type === 'number' ? `${nums.get(b.id) ?? 1}.` : b.type === 'todo' ? (b.checked ? '☑' : '☐') : b.type === 'toggle' ? '▸' : null
        const canDiscard = !!p.onToggleDiscard && (cls === 'mainOnly' || cls === 'branchOnly')
        const canFlip = !!p.onFlip && cls === 'modified'
        return (
          <div
            key={r.item.key}
            ref={(el) => {
              if (!p.rowRefs) return
              if (el) p.rowRefs.set(r.item.key, el)
              else p.rowRefs.delete(r.item.key)
            }}
            className={`tm-row t-${b.type} l-${cls}` + (r.discarded ? ' discarded' : '') + (r.deleted ? ' deleted' : '') + (p.focus && p.focus !== cls ? ' dim' : '')}
            style={{ ['--ind' as string]: b.indent, ['--src' as string]: color }}
          >
            <div className="tm-main">
              {b.type === 'divider' ? (
                <hr className="tm-hr" />
              ) : (
                <div className="tm-text">
                  {marker && <span className="tm-marker">{marker}</span>}
                  <span className={'tm-html' + (b.type === 'code' ? ' is-code' : '')} dangerouslySetInnerHTML={{ __html: safeHtml(b) }} />
                </div>
              )}
              {r.other && !r.other.deletedAt && !r.deleted && cls === 'modified' && (
                <div className="tm-other">
                  <span className="tm-other-label">{p.sideName(r.side === 'main' ? 'branch' : 'main')}:</span>
                  <span className="tm-html" dangerouslySetInnerHTML={{ __html: safeHtml(r.other) }} />
                </div>
              )}
            </div>
            {cls !== 'common' && (
              <div className="tm-side">
                <span className="tm-chip" style={{ ['--src' as string]: color }}>
                  {p.changeLabel(r.change)}
                  {r.item.both ? ' · 양쪽이 고침' : ''}
                </span>
                {canDiscard && (
                  <button className={'text-btn' + (r.discarded ? '' : ' danger')} onClick={() => p.onToggleDiscard!(r.item.key)}>
                    {r.discarded ? '살리기' : '버리기'}
                  </button>
                )}
                {canFlip && (
                  <button className="text-btn" onClick={() => p.onFlip!(r.item.key)} title={`${p.sideName(r.side === 'main' ? 'branch' : 'main')} 쪽 버전으로`}>
                    <Icon name="swap" size={14} /> 다른 쪽
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
