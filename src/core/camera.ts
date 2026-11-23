import type { Bounds, Point2 } from './types'

export interface Camera {
  /** 视口中心对应的世界坐标 */
  x: number
  y: number
  /** 像素 / 世界单位 */
  zoom: number
  /** 弧度，逆时针 */
  rotation: number
}

export function createCamera(): Camera {
  return { x: 0, y: 0, zoom: 1, rotation: 0 }
}

export function fitCamera(bounds: Bounds, width: number, height: number, padding = 0.12): Camera {
  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerY = (bounds.minY + bounds.maxY) / 2
  const w = Math.max(1e-6, bounds.maxX - bounds.minX)
  const h = Math.max(1e-6, bounds.maxY - bounds.minY)
  const zoom = Math.max(
    1e-9,
    Math.min(width / w, height / h) * (1 - padding)
  )
  return { x: centerX, y: centerY, zoom, rotation: 0 }
}

export function worldToScreen(camera: Camera, width: number, height: number, p: Point2): Point2 {
  const cos = Math.cos(camera.rotation)
  const sin = Math.sin(camera.rotation)
  const dx = p.x - camera.x
  const dy = p.y - camera.y
  const rx = dx * cos - dy * sin
  const ry = dx * sin + dy * cos
  return {
    x: width / 2 + rx * camera.zoom,
    y: height / 2 - ry * camera.zoom
  }
}

export function screenToWorld(camera: Camera, width: number, height: number, p: Point2): Point2 {
  const cos = Math.cos(camera.rotation)
  const sin = Math.sin(camera.rotation)
  const rx = (p.x - width / 2) / camera.zoom
  const ry = -(p.y - height / 2) / camera.zoom
  return {
    x: camera.x + rx * cos + ry * sin,
    y: camera.y - rx * sin + ry * cos
  }
}

/** 以屏幕锚点为中心缩放，保持锚点下的世界坐标不动。 */
export function zoomAt(camera: Camera, width: number, height: number, anchor: Point2, factor: number): Camera {
  const before = screenToWorld(camera, width, height, anchor)
  const zoom = Math.max(1e-9, Math.min(1e9, camera.zoom * factor))
  const next = { ...camera, zoom }
  const after = screenToWorld(next, width, height, anchor)
  return { ...next, x: next.x + before.x - after.x, y: next.y + before.y - after.y }
}

/** 拖动平移：屏幕位移换算为世界位移（含旋转与 Y 翻转）。 */
export function panByScreen(camera: Camera, dx: number, dy: number): Camera {
  const cos = Math.cos(camera.rotation)
  const sin = Math.sin(camera.rotation)
  const worldDx = dx / camera.zoom
  const worldDy = -dy / camera.zoom
  return {
    ...camera,
    x: camera.x - (worldDx * cos + worldDy * sin),
    y: camera.y - (-worldDx * sin + worldDy * cos)
  }
}

/** 双指旋转：围绕屏幕锚点旋转，锚点世界坐标保持不变。 */
export function rotateAt(camera: Camera, width: number, height: number, anchor: Point2, delta: number): Camera {
  const before = screenToWorld(camera, width, height, anchor)
  const next = { ...camera, rotation: camera.rotation + delta }
  const after = screenToWorld(next, width, height, anchor)
  return { ...next, x: next.x + before.x - after.x, y: next.y + before.y - after.y }
}
