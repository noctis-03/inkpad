import { MAX_HISTORY, type ID, type Page } from '../shared/model'
import type { Entry } from './scene'

export interface PageSnapshot {
  order: ID[]
  pages: Page[] // 이 명령으로 바뀌는 페이지들의 상태
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
  pagesBefore?: PageSnapshot
  pagesAfter?: PageSnapshot
  label?: string
}

export class History {
  private undoStack: Command[] = []
  private redoStack: Command[] = []

  push(cmd: Command) {
    if (!cmd.removed.length && !cmd.added.length && !cmd.pagesAfter) return
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
