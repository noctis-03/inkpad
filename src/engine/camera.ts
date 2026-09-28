import { MAX_ZOOM, MIN_ZOOM } from './constants'

/** x, y = 화면 왼쪽 위에 해당하는 월드 좌표. zoom = 화면 px / 월드 단위 */
export class Camera {
  constructor(public x = 0, public y = 0, public zoom = 1) {}

  screenToWorld(sx: number, sy: number) {
    return { x: sx / this.zoom + this.x, y: sy / this.zoom + this.y }
  }

  worldToScreen(wx: number, wy: number) {
    return { x: (wx - this.x) * this.zoom, y: (wy - this.y) * this.zoom }
  }

  /** 화면 좌표 (sx, sy)를 고정한 채 배율 변경 */
  zoomAt(sx: number, sy: number, zoom: number) {
    const w = this.screenToWorld(sx, sy)
    this.zoom = clampZoom(zoom)
    this.x = w.x - sx / this.zoom
    this.y = w.y - sy / this.zoom
  }

  clone() {
    return new Camera(this.x, this.y, this.zoom)
  }

  copy(c: Camera) {
    this.x = c.x
    this.y = c.y
    this.zoom = c.zoom
  }

  equals(c: Camera) {
    return this.x === c.x && this.y === c.y && this.zoom === c.zoom
  }
}

export function clampZoom(z: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
}
