/**
 * 对象拾取：按屏幕像素阈值判断「点中了哪个图元」，供半径/夹角测量选择目标。
 *
 * 与 snap.ts 的分工：snap 找「几何点」（端点/中点/圆心…）用于落点吸附；
 * pick 找「整个图元」，用于选中被测对象。两者都不依赖渲染路径，可单独回归。
 */
import type { CadDocument, ArcEntity, CadEntity, CircleEntity, Point2 } from './types'

export interface Segment {
  a: Point2
  b: Point2
}

export interface PickHit {
  /** 在 document.entities 中的下标，用于判断是否重复选中同一对象 */
  index: number
  entity: CadEntity
  /** 拾取点投影到几何上的最近点 */
  point: Point2
  distancePx: number
}

export interface PickOptions {
  /** 拾取半径（屏幕像素），手指比鼠标粗，通常给 16–20 */
  radiusPx: number
  /** 像素 / 世界单位 */
  zoom: number
  hiddenLayers?: ReadonlySet<string>
}

const TAU = Math.PI * 2
const EMPTY_LAYERS: ReadonlySet<string> = new Set()

/** 两条线的方向夹角小于该值时视为平行：sin(0.0001°) 量级，远小于测量分辨率。 */
const PARALLEL_EPS = 1e-6

export function arcSweep(start: number, end: number): number {
  let sweep = end - start
  while (sweep <= 1e-9) sweep += TAU
  while (sweep > TAU) sweep -= TAU
  return sweep
}

function onCircle(entity: CircleEntity | ArcEntity, angle: number): Point2 {
  return {
    x: entity.center.x + entity.radius * Math.cos(angle),
    y: entity.center.y + entity.radius * Math.sin(angle)
  }
}

function closestOnSegment(p: Point2, a: Point2, b: Point2): Point2 {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-18) return { x: a.x, y: a.y }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return { x: a.x + dx * t, y: a.y + dy * t }
}

function segmentDistance(p: Point2, a: Point2, b: Point2): number {
  const q = closestOnSegment(p, a, b)
  return Math.hypot(p.x - q.x, p.y - q.y)
}

/**
 * 选择圆或圆弧。圆弧只认自身扫掠范围内的点：点在外侧空白处不该选中它，
 * 否则密集图纸里很容易误选到隔壁的弧。
 */
export function pickCircle(document: CadDocument, world: Point2, options: PickOptions): PickHit | null {
  const zoom = options.zoom
  if (!Number.isFinite(zoom) || zoom <= 0) return null
  const hidden = options.hiddenLayers ?? EMPTY_LAYERS
  const limit = Math.max(1, options.radiusPx) / zoom

  let best: PickHit | null = null
  for (let index = 0; index < document.entities.length; index++) {
    const entity = document.entities[index]
    if (entity.type !== 'circle' && entity.type !== 'arc') continue
    if (hidden.has(entity.layer)) continue
    if (!(entity.radius > 0)) continue

    const c = entity.center
    const d = Math.hypot(world.x - c.x, world.y - c.y)
    let point: Point2
    let dist: number

    if (entity.type === 'arc') {
      const sweep = arcSweep(entity.startAngle, entity.endAngle)
      let rel = Math.atan2(world.y - c.y, world.x - c.x) - entity.startAngle
      while (rel < 0) rel += TAU
      while (rel > TAU) rel -= TAU
      if (rel <= sweep) {
        point = onCircle(entity, entity.startAngle + rel)
        dist = Math.abs(d - entity.radius)
      } else {
        const p1 = onCircle(entity, entity.startAngle)
        const p2 = onCircle(entity, entity.endAngle)
        const d1 = Math.hypot(world.x - p1.x, world.y - p1.y)
        const d2 = Math.hypot(world.x - p2.x, world.y - p2.y)
        point = d1 <= d2 ? p1 : p2
        dist = Math.min(d1, d2)
      }
    } else {
      const angle = d > 1e-9 ? Math.atan2(world.y - c.y, world.x - c.x) : 0
      point = onCircle(entity, angle)
      dist = Math.abs(d - entity.radius)
    }

    if (dist > limit) continue
    if (!best || dist * zoom < best.distancePx) {
      best = { index, entity, point, distancePx: dist * zoom }
    }
  }
  return best
}

/** 选择直线。多段线不参与：一条多段线包含多个方向，夹角会变得没有意义。 */
export function pickLine(document: CadDocument, world: Point2, options: PickOptions): PickHit | null {
  const zoom = options.zoom
  if (!Number.isFinite(zoom) || zoom <= 0) return null
  const hidden = options.hiddenLayers ?? EMPTY_LAYERS
  const limit = Math.max(1, options.radiusPx) / zoom

  let best: PickHit | null = null
  for (let index = 0; index < document.entities.length; index++) {
    const entity = document.entities[index]
    if (entity.type !== 'line') continue
    if (hidden.has(entity.layer)) continue
    const dist = segmentDistance(world, entity.start, entity.end)
    if (dist > limit) continue
    if (!best || dist * zoom < best.distancePx) {
      best = { index, entity, point: closestOnSegment(world, entity.start, entity.end), distancePx: dist * zoom }
    }
  }
  return best
}

export function segmentOf(entity: CadEntity): Segment | null {
  if (entity.type !== 'line') return null
  return { a: { ...entity.start }, b: { ...entity.end } }
}

/**
 * 两条直线（无限延长）的交点。平行时返回 null —— 这是夹角测量最主要的无效输入。
 * 用相对判据而不是绝对判据：图纸单位从毫米到米都可能，绝对阈值会随量纲失效。
 */
export function intersectLines(a: Segment, b: Segment): Point2 | null {
  const rx = a.b.x - a.a.x
  const ry = a.b.y - a.a.y
  const sx = b.b.x - b.a.x
  const sy = b.b.y - b.a.y
  const lenR = Math.hypot(rx, ry)
  const lenS = Math.hypot(sx, sy)
  if (lenR < 1e-12 || lenS < 1e-12) return null
  const denom = rx * sy - ry * sx
  if (Math.abs(denom) <= PARALLEL_EPS * lenR * lenS) return null
  const qpx = b.a.x - a.a.x
  const qpy = b.a.y - a.a.y
  const t = (qpx * sy - qpy * sx) / denom
  return { x: a.a.x + rx * t, y: a.a.y + ry * t }
}
