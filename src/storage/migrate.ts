// 스키마 마이그레이션 (NFR-10, 16.4). 모든 저장 데이터에 schemaVersion이 있다.
import { SCHEMA_VERSION, type Element } from '../shared/model'

export class SchemaTooNewError extends Error {
  constructor(public found: number) {
    super(`이 데이터는 더 새로운 앱 버전(schema ${found})에서 만들어졌습니다. 앱을 새로고침해 업데이트해 주세요.`)
  }
}

type Migration = (elements: unknown[]) => unknown[]

/** MIGRATIONS[n] = schema n → n+1 */
const MIGRATIONS: Record<number, Migration> = {
  // 예: 1: (els) => els.map(...)
}

export function needsMigration(v: number) {
  return v < SCHEMA_VERSION
}

export function assertNotTooNew(v: number | undefined) {
  if ((v ?? 1) > SCHEMA_VERSION) throw new SchemaTooNewError(v!)
}

export function migrateElements(elements: unknown[], from: number): Element[] {
  assertNotTooNew(from)
  let cur = elements
  for (let v = from; v < SCHEMA_VERSION; v++) {
    const m = MIGRATIONS[v]
    if (m) cur = m(cur)
  }
  return cur as Element[]
}
