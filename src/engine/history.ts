import { MAX_HISTORY, type Element, type ID, type Page } from '../shared/model'
import type { Entry } from './scene'

export interface PageSnapshot {
  order: ID[]
  pages: Page[] // 이 명령으로 바뀌는 페이지들의 상태
}

/** 아직 렌더 인덱스(R-tree)에 없는 요소(텍스트 등)의 저장 단위 위치 */
export interface ElementEntry {
  element: Element
  pageId: ID
  key: string
}

/**
 * Command 기반 Undo/Redo.
 * 모든 편집을 "지운 획 / 추가한 획 (+ 페이지 구조 전후)"로 표현한다.
 *  - 그리기: added / 지우개: removed / 부분 지우개·올가미 이동: removed + added
 *  - 페이지 삭제: 페이지 + 그 페이지의 획을 함께 복원하는 복합 명령 (16.6)
 */
export interface Command {
  removed: Entry[]
  added: Entry[]
  /** 텍스트·이미지·도형처럼 R-tree에 없는 요소의 추가/삭제 (undo 대상) */
  extrasRemoved?: ElementEntry[]
  extrasAdded?: ElementEntry[]
  pagesBefore?: PageSnapshot
  pagesAfter?: PageSnapshot
  label?: string
}

export class History {
  private undoStack: Command[] = []
  private redoStack: Command[] = []

  push(cmd: Command) {
    if (!cmd.removed.length && !cmd.added.length && !cmd.extrasRemoved?.length && !cmd.extrasAdded?.length && !cmd.pagesAfter) return
    this.undoStack.push(cmd)
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift()
    this.redoStack.length = 0
  }

  popUndo() {
    const c = this.undoStack.pop()
    if (c) this.redoStack.push(c)
    return c
  }

  popRedo() {
    const c = this.redoStack.pop()
    if (c) this.undoStack.push(c)
    return c
  }

  get canUndo() {
    return this.undoStack.length > 0
  }

  get canRedo() {
    return this.redoStack.length > 0
  }

  clear() {
    this.undoStack.length = 0
    this.redoStack.length = 0
  }
}
