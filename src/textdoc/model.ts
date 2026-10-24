// 문서(text 모드) 편집 상태 — 블록 목록, 되돌리기, 저장 예약.
// React는 useSyncExternalStore로 rev를 구독한다. DOM(contenteditable)은 편집기가 다루고, 여기는 값만 안다.
import { byPos, slotKeys } from '../shared/fracIndex'
import { escapeHtml, plainText, sanitizeInline } from '../shared/richText'
import { TEXT_MAX_INDENT, type ID, type TextBlock, type TextBlockType } from '../shared/model'
import { ulid } from '../shared/ulid'
import type { TextSaveBatch } from '../storage/repo'

export interface Change {
  before: TextBlock | null
  after: TextBlock | null
}

/** 캐럿 자리 — 되돌리면 이리로 돌아간다 */
export interface Caret {
  id: ID
  offset: number | 'start' | 'end'
}

interface Entry {
  changes: Change[]
  caretBefore?: Caret
  caretAfter?: Caret
}

const MAX_HISTORY = 300
/** 연속 입력을 한 번의 되돌리기로 묶는 간격 */
const TYPING_IDLE_MS = 800
const SAVE_DEBOUNCE_MS = 500

/** 블록 종류가 바뀔 때의 HTML — 코드 블록은 글자만 담는다 */
function htmlFor(type: TextBlockType, html: string, prev: TextBlockType): string {
  if (type === 'divider') return ''
  if (type === 'code' && prev !== 'code') return escapeHtml(plainText(html))
  if (type !== 'code' && prev === 'code') return escapeHtml(plainText(html)).replace(/\n/g, '<br>')
  return html
}

/** 저장할 때의 정리 — 서식 HTML은 허용 태그만, 코드 블록은 글자만 */
export function cleanForSave(b: TextBlock): TextBlock {
  const html = b.type === 'code' ? escapeHtml(plainText(b.html)) : b.type === 'divider' ? '' : sanitizeInline(b.html)
  return html === b.html ? b : { ...b, html }
}

export class TextDocModel {
  readonly documentId: ID
  readOnly: boolean
  private list: TextBlock[]
  private rev = 0
  private listeners = new Set<() => void>()
  private undoStack: Entry[] = []
  private redoStack: Entry[] = []
  /** 입력 중인 블록의 시작 값 — 쉬면(TYPING_IDLE_MS) 한 건으로 기록한다 */
  private typing: { start: TextBlock; caret?: Caret; timer: number } | null = null
  /** makeBlock이 만든 새 블록 id → 함께 다시 매길 이웃 키 (같은 키 이웃 사이에 끼울 때, shared/fracIndex slotKeys). exec가 변경에 넣는다 */
  private pendingRepos = new Map<ID, Map<ID, string>>()
  private dirty = new Map<ID, TextBlock>()
  private deleted = new Set<ID>()
  private saveTimer = 0
  private saving: Promise<void> | null = null
  saveState: 'saved' | 'pending' | 'saving' | 'error' = 'saved'
  onSaveState?: (s: TextDocModel['saveState'], err?: unknown) => void
  /** 되돌리기 뒤 등 캐럿을 옮겨야 할 때 — 편집기가 구독해 DOM에 반영한다 */
  onFocus?: (c: Caret) => void

  constructor(documentId: ID, blocks: TextBlock[], private persist: (b: TextSaveBatch) => Promise<void>, readOnly = false) {
    this.documentId = documentId
    this.readOnly = readOnly
    this.list = [...blocks].sort(byPos)
  }

  // ───────── 구독 ─────────
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  version = () => this.rev
  private emit() {
    this.rev++
    for (const fn of [...this.listeners]) fn()
  }

  get blocks(): readonly TextBlock[] {
    return this.list
  }
  get(id: ID): TextBlock | undefined {
    return this.list.find((b) => b.id === id)
  }
  indexOf(id: ID): number {
    return this.list.findIndex((b) => b.id === id)
  }
  get canUndo() {
    return this.undoStack.length > 0 || !!this.typing
  }
  get canRedo() {
    return this.redoStack.length > 0
  }

  // ───────── 적용 ─────────

  /** 변경을 목록에 반영한다 (기록·저장 예약 포함). 순서(pos)가 바뀐 블록도 다시 정렬된다 */
  private applyChanges(changes: Change[], inverse: boolean) {
    for (const ch of changes) {
      const next = inverse ? ch.before : ch.after
      const gone = inverse ? ch.after : ch.before
      if (next) {
        const i = this.indexOf(next.id)
        if (i >= 0) this.list[i] = next
        else this.list.push(next)
        this.dirty.set(next.id, next)
        this.deleted.delete(next.id)
      } else if (gone) {
        const i = this.indexOf(gone.id)
        if (i >= 0) this.list.splice(i, 1)
        this.dirty.delete(gone.id)
        this.deleted.add(gone.id)
      }
    }
    this.list.sort(byPos)
    this.scheduleSave()
    this.emit()
  }

  /** 기록되는 편집 한 건. 진행 중이던 입력을 먼저 한 건으로 닫는다 */
  exec(changes: Change[], caret?: { before?: Caret; after?: Caret }) {
    const repos = new Map<ID, string>()
    for (const ch of changes) if (!ch.before && ch.after) this.pendingRepos.get(ch.after.id)?.forEach((pos, id) => repos.set(id, pos))
    this.pendingRepos.clear()
    if (this.readOnly || !changes.length) return
    changes = this.withRepos(changes, repos)
    this.commitTyping()
    this.applyChanges(changes, false)
    this.undoStack.push({ changes, caretBefore: caret?.before, caretAfter: caret?.after })
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift()
    this.redoStack.length = 0
    if (caret?.after) this.onFocus?.(caret.after)
  }

  /** 다시 매길 키(repos)를 변경에 넣는다 — 이미 바뀌는 블록이면 그 변경에, 아니면 키만 바꾸는 변경을 더한다 */
  private withRepos(changes: Change[], repos: Map<ID, string>): Change[] {
    if (!repos.size) return changes
    const now = Date.now()
    const out = changes.map((ch) => (ch.after && repos.has(ch.after.id) ? { ...ch, after: { ...ch.after, pos: repos.get(ch.after.id)! } } : ch))
    for (const [id, pos] of repos) {
      const b = this.get(id)
      if (b && !changes.some((ch) => (ch.after ?? ch.before)?.id === id)) out.push({ before: b, after: { ...b, pos, updatedAt: now } })
    }
    return out
  }

  /**
   * 입력 — 글자가 바뀔 때마다 부른다. 바로 반영·저장 예약하고, 기록은 쉴 때 한 건으로 묶는다.
   * (편집기 DOM이 이미 이 HTML이므로 다시 그리지 않는다 — 편집기는 html이 DOM과 같으면 건드리지 않는다)
   */
  input(id: ID, html: string, caret?: Caret) {
    if (this.readOnly) return
    const cur = this.get(id)
    if (!cur || cur.html === html) return
    if (this.typing && this.typing.start.id !== id) this.commitTyping()
    if (!this.typing) this.typing = { start: cur, caret, timer: 0 }
    clearTimeout(this.typing.timer)
    this.typing.timer = window.setTimeout(() => this.commitTyping(), TYPING_IDLE_MS)
    const next = { ...cur, html, updatedAt: Date.now() }
    const i = this.indexOf(id)
    this.list[i] = next
    this.dirty.set(id, next)
    this.scheduleSave()
    this.emit()
  }

  /** 진행 중인 입력을 되돌리기 한 건으로 닫는다 */
  commitTyping() {
    const t = this.typing
    if (!t) return
    this.typing = null
    clearTimeout(t.timer)
    const cur = this.get(t.start.id)
    if (!cur || cur.html === t.start.html) return
    this.undoStack.push({ changes: [{ before: t.start, after: cur }], caretBefore: t.caret ?? { id: cur.id, offset: 'end' }, caretAfter: { id: cur.id, offset: 'end' } })
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift()
    this.redoStack.length = 0
  }

  undo() {
    if (this.readOnly) return
    this.commitTyping()
    const e = this.undoStack.pop()
    if (!e) return
    this.applyChanges(e.changes, true)
    this.redoStack.push(e)
    this.onFocus?.(this.caretFor(e.caretBefore, e.changes, true))
  }

  redo() {
    if (this.readOnly) return
    this.commitTyping()
    const e = this.redoStack.pop()
    if (!e) return
    this.applyChanges(e.changes, false)
    this.undoStack.push(e)
    this.onFocus?.(this.caretFor(e.caretAfter, e.changes, false))
  }

  /** 되돌린 뒤 캐럿 — 기록한 자리가 지금 없으면 바뀐 블록 중 남아 있는 것의 끝 */
  private caretFor(c: Caret | undefined, changes: Change[], inverse: boolean): Caret {
    if (c && this.get(c.id)) return c
    for (const ch of changes) {
      const b = inverse ? ch.before : ch.after
      if (b && this.get(b.id)) return { id: b.id, offset: 'end' }
    }
    const first = this.list[0]
    return { id: first?.id ?? '', offset: 'end' }
  }

  // ───────── 편집 동작 (모두 exec 한 건) ─────────

  /** 새 블록 — after 뒤에 (null = 맨 앞) */
  makeBlock(afterId: ID | null, init: Partial<TextBlock> = {}): TextBlock {
    const i = afterId ? this.indexOf(afterId) : -1
    const { keys, repos } = slotKeys(this.list, i + 1, 1)
    const id = ulid()
    if (repos.size) this.pendingRepos.set(id, repos)
    const now = Date.now()
    return {
      id,
      documentId: this.documentId,
      type: 'p',
      html: '',
      indent: 0,
      ...init,
      pos: keys[0],
      createdAt: now,
      updatedAt: now
    }
  }

  patch(id: ID, p: Partial<TextBlock>, caret?: { before?: Caret; after?: Caret }) {
    const cur = this.get(id)
    if (!cur) return
    this.exec([{ before: cur, after: { ...cur, ...p, updatedAt: Date.now() } }], caret)
  }

  setType(id: ID, type: TextBlockType, caretAfter?: Caret) {
    const cur = this.get(id)
    if (!cur || cur.type === type) return
    const p: Partial<TextBlock> = { type, html: htmlFor(type, cur.html, cur.type) }
    if (type === 'todo') p.checked = false
    this.patch(id, p, { before: { id, offset: 'end' }, after: caretAfter ?? { id, offset: 'end' } })
  }

  setIndent(id: ID, indent: number) {
    const cur = this.get(id)
    if (!cur) return
    const i = this.indexOf(id)
    // 바로 위 블록보다 한 단계 넘게 깊어지지 않게
    const max = Math.min(TEXT_MAX_INDENT, i > 0 ? this.list[i - 1].indent + 1 : 0)
    const v = Math.max(0, Math.min(max, indent))
    if (v === cur.indent) return
    this.patch(id, { indent: v })
  }

  /** 캐럿에서 둘로 나눈다: 지금 블록은 head, 아래 새 블록은 tail (Enter) */
  split(id: ID, head: string, tail: string) {
    const cur = this.get(id)
    if (!cur) return
    // 목록·할 일은 같은 종류로 이어 가고, 제목·인용·토글 등은 문단으로
    const keep: TextBlockType[] = ['bullet', 'number', 'todo']
    const type: TextBlockType = keep.includes(cur.type) ? cur.type : 'p'
    // 펼친 토글에서 나누면 새 줄은 토글 안쪽(한 단계 깊게)으로
    const indent = cur.type === 'toggle' && !cur.collapsed ? Math.min(TEXT_MAX_INDENT, cur.indent + 1) : cur.indent
    const nb = this.makeBlock(id, { type, indent, html: tail, ...(type === 'todo' ? { checked: false } : {}) })
    this.exec(
      [
        { before: cur, after: { ...cur, html: head, updatedAt: Date.now() } },
        { before: null, after: nb }
      ],
      { before: { id, offset: plainText(head).length }, after: { id: nb.id, offset: 'start' } }
    )
  }

  /** id를 위 블록에 붙인다 (맨 앞에서 Backspace). 캐럿은 붙은 자리 */
  mergeUp(id: ID) {
    const i = this.indexOf(id)
    if (i <= 0) return
    const cur = this.list[i]
    const prev = this.list[i - 1]
    if (prev.type === 'divider') {
      // 구분선은 지우기만 한다
      this.exec([{ before: prev, after: null }], { before: { id, offset: 'start' }, after: { id, offset: 'start' } })
      return
    }
    const at = plainText(prev.html).length
    const html = prev.type === 'code' ? prev.html + escapeHtml(plainText(cur.html)) : prev.html + (cur.type === 'code' ? escapeHtml(plainText(cur.html)) : cur.html)
    this.exec(
      [
        { before: prev, after: { ...prev, html, updatedAt: Date.now() } },
        { before: cur, after: null }
      ],
      { before: { id, offset: 'start' }, after: { id: prev.id, offset: at } }
    )
  }

  remove(ids: ID[], focus?: Caret) {
    const changes: Change[] = ids
      .map((id) => this.get(id))
      .filter((b): b is TextBlock => !!b)
      .map((b) => ({ before: b, after: null }))
    // 문서가 비면 빈 문단 하나를 남긴다
    let f = focus
    if (changes.length === this.list.length) {
      const nb = this.makeBlock(null)
      changes.push({ before: null, after: nb })
      f = { id: nb.id, offset: 'start' }
    }
    this.exec(changes, { before: { id: ids[0], offset: 'end' }, after: f })
  }

  /** 블록과 그 안쪽(더 깊이 들여쓴 뒤 블록들)을 함께 */
  subtree(id: ID): TextBlock[] {
    const i = this.indexOf(id)
    if (i < 0) return []
    const root = this.list[i]
    const out = [root]
    for (let k = i + 1; k < this.list.length && this.list[k].indent > root.indent; k++) out.push(this.list[k])
    return out
  }

  /** 블록(과 그 안쪽)을 옮긴다 — beforeId 앞으로 (null = 맨 뒤). 들여쓰기는 상대값을 지키며 새 자리에 맞춘다 */
  move(id: ID, beforeId: ID | null) {
    const group = this.subtree(id)
    if (!group.length || (beforeId && group.some((b) => b.id === beforeId))) return
    const rest = this.list.filter((b) => !group.includes(b))
    const at = beforeId ? rest.findIndex((b) => b.id === beforeId) : rest.length
    const prev = rest[at - 1] ?? null
    const next = rest[at] ?? null
    if (prev?.id === this.list[this.indexOf(id) - 1]?.id && next?.id === this.list[this.indexOf(group[group.length - 1].id) + 1]?.id) return
    const { keys, repos } = slotKeys(rest, at, group.length)
    const maxIndent = prev ? Math.min(TEXT_MAX_INDENT, prev.indent + 1) : 0
    const shift = Math.min(0, maxIndent - group[0].indent) // 새 자리에서 너무 깊으면 함께 얕게
    const now = Date.now()
    const changes: Change[] = group.map((b, k) => ({ before: b, after: { ...b, pos: keys[k], indent: Math.max(0, b.indent + shift), updatedAt: now } }))
    this.exec(this.withRepos(changes, repos), { before: { id, offset: 'end' }, after: { id, offset: 'end' } })
  }

  duplicate(id: ID) {
    const group = this.subtree(id)
    const last = group[group.length - 1]
    const i = this.indexOf(last.id)
    const { keys, repos } = slotKeys(this.list, i + 1, group.length)
    const now = Date.now()
    const copies = group.map((b, k) => ({ before: null, after: { ...b, id: ulid(), pos: keys[k], createdAt: now, updatedAt: now } }))
    this.exec(this.withRepos(copies, repos), { after: { id: copies[0].after.id, offset: 'end' } })
  }

  /**
   * 여러 줄 붙여넣기 — 첫 줄은 캐럿 자리에 이어 쓰고(head + 첫 줄), 나머지는 새 블록으로, 마지막 줄 뒤에 tail을 붙인다.
   * lines는 이미 블록으로 나눈 것(종류·HTML)이다.
   */
  pasteLines(id: ID, head: string, tail: string, lines: { type: TextBlockType; html: string; checked?: boolean }[]) {
    const cur = this.get(id)
    if (!cur || !lines.length) return
    const changes: Change[] = []
    const now = Date.now()
    const [first, ...more] = lines
    const i = this.indexOf(id)
    const { keys, repos } = slotKeys(this.list, i + 1, more.length)
    const firstHtml = head + first.html + (more.length ? '' : tail)
    changes.push({ before: cur, after: { ...cur, html: firstHtml, ...(cur.html === '' && head === '' && first.type !== 'p' ? { type: first.type, checked: first.checked } : {}), updatedAt: now } })
    let lastId = id
    let lastLen = plainText(firstHtml).length - plainText(more.length ? '' : tail).length
    more.forEach((ln, k) => {
      const pos = keys[k]
      const html = ln.html + (k === more.length - 1 ? tail : '')
      const nb: TextBlock = { id: ulid(), documentId: this.documentId, type: ln.type, html, indent: cur.indent, pos, createdAt: now, updatedAt: now, ...(ln.type === 'todo' ? { checked: !!ln.checked } : {}) }
      changes.push({ before: null, after: nb })
      lastId = nb.id
      lastLen = plainText(ln.html).length
    })
    this.exec(this.withRepos(changes, repos), { before: { id, offset: plainText(head).length }, after: { id: lastId, offset: lastLen } })
  }

  // ───────── 저장 ─────────

  get hasPendingChanges() {
    return this.dirty.size > 0 || this.deleted.size > 0
  }

  private setSaveState(s: TextDocModel['saveState'], err?: unknown) {
    if (this.saveState === s && !err) return
    this.saveState = s
    this.onSaveState?.(s, err)
  }

  private scheduleSave() {
    if (this.readOnly) return
    this.setSaveState('pending')
    clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => void this.flush(), SAVE_DEBOUNCE_MS)
  }

  /** 바뀐 블록을 기록한다. 진행 중인 저장이 있으면 끝난 뒤 이어서 */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer)
    if (this.saving) await this.saving
    if (!this.hasPendingChanges) {
      if (this.saveState !== 'error') this.setSaveState('saved')
      return
    }
    const up = [...this.dirty.values()]
    const del = [...this.deleted]
    this.dirty.clear()
    this.deleted.clear()
    this.setSaveState('saving')
    this.saving = (async () => {
      try {
        await this.persist({ documentId: this.documentId, upsert: up.map(cleanForSave), delete: del })
        this.setSaveState(this.hasPendingChanges ? 'pending' : 'saved')
      } catch (e) {
        // 실패하면 다시 넣는다 — 그 사이 더 새로 바뀐 블록은 덮지 않는다
        for (const b of up) if (!this.dirty.has(b.id) && !this.deleted.has(b.id) && this.get(b.id)) this.dirty.set(b.id, this.get(b.id)!)
        for (const id of del) if (!this.get(id)) this.deleted.add(id)
        this.setSaveState('error', e)
        this.saveTimer = window.setTimeout(() => void this.flush(), 5000)
      } finally {
        this.saving = null
      }
    })()
    await this.saving
    if (this.hasPendingChanges && this.saveState !== 'error') await this.flush()
  }

  destroy() {
    if (this.typing) this.commitTyping()
    clearTimeout(this.saveTimer)
  }
}

/** 번호 목록 번호 — 같은 들여쓰기의 이어진 number 블록끼리 1부터 */
export function numberLabels(blocks: readonly TextBlock[]): Map<ID, number> {
  const out = new Map<ID, number>()
  const counters: number[] = []
  for (const b of blocks) {
    // 더 얕은 블록이 나오면 그보다 깊은 번호는 끊긴다
    counters.length = Math.min(counters.length, b.indent + 1)
    if (b.type === 'number') {
      counters[b.indent] = (counters[b.indent] ?? 0) + 1
      out.set(b.id, counters[b.indent])
    } else counters[b.indent] = 0
  }
  return out
}

/** 접힌 토글 안쪽을 뺀 보이는 블록 */
export function visibleBlocks(blocks: readonly TextBlock[]): TextBlock[] {
  const out: TextBlock[] = []
  let hideDeeperThan = Infinity
  for (const b of blocks) {
    if (b.indent > hideDeeperThan) continue
    hideDeeperThan = Infinity
    out.push(b)
    if (b.type === 'toggle' && b.collapsed) hideDeeperThan = b.indent
  }
  return out
}
