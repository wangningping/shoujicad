/**
 * 对象捕捉（OSNAP）：把图纸几何索引化成可捕捉点，供测量端点吸附。
 *
 * 设计要点：
 * - 候选点全部在构建索引时算好（端点/中点/圆心/象限点），交点与近点在查询时按需计算。
 * - 距离阈值统一用「屏幕像素」，由查询方传入 zoom，缩放时手感一致。
 * - 返回分值而不是第一个命中项：优先级（端点 > 交点 > 圆心 > 中点 > 象限点 > 近点）
 *   加上距离惩罚，避免远处的端点压过手边更精确的中点。
 * - 由调用方传入 locked / escapeRadius 形成滞回，避免阈值边缘来回抖动。
 */
import { worldToScreen, type Camera } from './camera'
import { bulgePoints, TAU } from './geometry'
import type { CadDocument, CadEntity, Point2 } from './types'

export type SnapKind = 'endpoint' | 'intersection' | 'center' | 'midpoint' | 'quadrant' | 'nearest'

export const SNAP_LABEL: Record<SnapKind, string> = {
  endpoint: '端点',
  intersection: '交点',
  center: '圆心',
  midpoint: '中点',
  quadrant: '象限点',
  nearest: '近点'
}

/** 基础优先级分值。 */
const KIND_SCORE: Record<SnapKind, number> = {
  endpoint: 60,
  intersection: 54,
  center: 46,
  midpoint: 36,
  quadrant: 26,
  nearest: 14
}

/** 各类捕捉点的有效半径系数：近点只在小范围内生效，避免满屏都在吸附。 */
const KIND_RADIUS: Record<SnapKind, number> = {
  endpoint: 1,
  intersection: 1,
  center: 1,
  midpoint: 0.92,
  quadrant: 0.86,
  nearest: 0.45
}

export interface SnapHit {
  point: Point2
  kind: SnapKind
  /** 世界单位下的距离，便于调试 */
  distance: number
}

interface SnapPointRecord {
  x: number
  y: number
  kind: SnapKind
  layer: string
}

interface SnapSegmentRecord {
  ax: number
  ay: number
  bx: number
  by: number
  layer: string
  entity: number
}

export interface SnapIndex {
  points: SnapPointRecord[]
  segments: SnapSegmentRecord[]
  pointCells: Map<string, number[]>
  segmentCells: Map<string, number[]>
  /** 网格边长（世界单位） */
  cell: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const CIRCLE_SEGMENTS = 56
const ELLIPSE_SEGMENTS = 44
const MAX_CELL_SCAN = 900
const DEFAULT_MAX_INTERSECTION_SEGMENTS = 80
const EMPTY_LAYERS: ReadonlySet<string> = new Set()

function mid(a: Point2, b: Point2): Point2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function distancePx(a: Point2, b: Point2, zoom: number): number {
  return Math.hypot(a.x - b.x, a.y - b.y) * zoom
}

interface Builder {
  points: SnapPointRecord[]
  segments: SnapSegmentRecord[]
  entity: number
}

function addPoint(b: Builder, p: Point2, kind: SnapKind, layer: string): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return
  b.points.push({ x: p.x, y: p.y, kind, layer })
}

function addSegment(b: Builder, a: Point2, c: Point2, layer: string): void {
  if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return
  if (a.x === c.x && a.y === c.y) return
  b.segments.push({ ax: a.x, ay: a.y, bx: c.x, by: c.y, layer, entity: b.entity })
}

function addChain(b: Builder, pts: Point2[], layer: string): void {
  for (let i = 1; i < pts.length; i++) addSegment(b, pts[i - 1], pts[i], layer)
}

function sampleArc(center: Point2, radius: number, start: number, sweep: number, segments: number): Point2[] {
  const out: Point2[] = []
  const count = Math.max(4, segments)
  for (let i = 0; i <= count; i++) {
    const angle = start + (sweep * i) / count
    out.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) })
  }
  return out
}

function sampleEllipse(
  center: Point2,
  major: Point2,
  ratio: number,
  start: number,
  sweep: number,
  segments: number
): Point2[] {
  const rot = Math.atan2(major.y, major.x)
  const a = Math.hypot(major.x, major.y)
  const bLen = a * ratio
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  const out: Point2[] = []
  const count = Math.max(6, segments)
  for (let i = 0; i <= count; i++) {
    const t = start + (sweep * i) / count
    const u = a * Math.cos(t)
    const v = bLen * Math.sin(t)
    out.push({ x: center.x + u * cos - v * sin, y: center.y + u * sin + v * cos })
  }
  return out
}

function normalizeSweep(start: number, end: number): number {
  let sweep = end - start
  while (sweep <= 1e-9) sweep += TAU
  while (sweep > TAU) sweep -= TAU
  return sweep
}

function collectEntity(b: Builder, entity: CadEntity): void {
  const layer = entity.layer
  switch (entity.type) {
    case 'line': {
      addPoint(b, entity.start, 'endpoint', layer)
      addPoint(b, entity.end, 'endpoint', layer)
      addPoint(b, mid(entity.start, entity.end), 'midpoint', layer)
      addSegment(b, entity.start, entity.end, layer)
      return
    }
    case 'polyline': {
      const pts = entity.points
      if (!pts.length) return
      if (pts.length === 1) {
        addPoint(b, pts[0], 'endpoint', layer)
        return
      }
      for (const p of pts) addPoint(b, p, 'endpoint', layer)
      const count = entity.closed ? pts.length : pts.length - 1
      for (let i = 0; i < count; i++) {
        const a = pts[i]
        const c = pts[(i + 1) % pts.length]
        const bulge = entity.bulges[i] ?? 0
        if (Math.abs(bulge) > 1e-6) {
          const arc = bulgePoints(a, c, bulge)
          addChain(b, arc, layer)
          addPoint(b, arc[Math.floor(arc.length / 2)], 'midpoint', layer)
        } else {
          addPoint(b, mid(a, c), 'midpoint', layer)
          addSegment(b, a, c, layer)
        }
      }
      return
    }
    case 'circle': {
      const { center, radius } = entity
      addPoint(b, center, 'center', layer)
      const arc = sampleArc(center, radius, 0, TAU, CIRCLE_SEGMENTS)
      addChain(b, arc, layer)
      for (const angle of [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2]) {
        addPoint(b, { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) }, 'quadrant', layer)
      }
      return
    }
    case 'arc': {
      const { center, radius, startAngle, endAngle } = entity
      const sweep = normalizeSweep(startAngle, endAngle)
      addPoint(b, center, 'center', layer)
      addPoint(b, { x: center.x + radius * Math.cos(startAngle), y: center.y + radius * Math.sin(startAngle) }, 'endpoint', layer)
      addPoint(b, { x: center.x + radius * Math.cos(endAngle), y: center.y + radius * Math.sin(endAngle) }, 'endpoint', layer)
      addPoint(
        b,
        {
          x: center.x + radius * Math.cos(startAngle + sweep / 2),
          y: center.y + radius * Math.sin(startAngle + sweep / 2)
        },
        'midpoint',
        layer
      )
      for (const angle of [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2]) {
        let delta = angle - startAngle
        while (delta < 0) delta += TAU
        if (delta <= sweep + 1e-9) {
          addPoint(b, { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) }, 'quadrant', layer)
        }
      }
      addChain(b, sampleArc(center, radius, startAngle, sweep, Math.max(8, Math.ceil((sweep / TAU) * CIRCLE_SEGMENTS))), layer)
      return
    }
    case 'ellipse': {
      const { center, majorAxis, ratio, startAngle, endAngle } = entity
      const sweep = normalizeSweep(startAngle, endAngle)
      addPoint(b, center, 'center', layer)
      const rot = Math.atan2(majorAxis.y, majorAxis.x)
      const a = Math.hypot(majorAxis.x, majorAxis.y)
      const bLen = a * ratio
      const cos = Math.cos(rot)
      const sin = Math.sin(rot)
      const at = (t: number): Point2 => ({
        x: center.x + a * Math.cos(t) * cos - bLen * Math.sin(t) * sin,
        y: center.y + a * Math.cos(t) * sin + bLen * Math.sin(t) * cos
      })
      if (sweep >= TAU - 1e-6) {
        for (const t of [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2]) addPoint(b, at(t), 'quadrant', layer)
      } else {
        addPoint(b, at(startAngle), 'endpoint', layer)
        addPoint(b, at(endAngle), 'endpoint', layer)
        addPoint(b, at(startAngle + sweep / 2), 'midpoint', layer)
        for (const t of [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2]) {
          let delta = t - startAngle
          while (delta < 0) delta += TAU
          if (delta <= sweep + 1e-9) addPoint(b, at(t), 'quadrant', layer)
        }
      }
      addChain(
        b,
        sampleEllipse(center, majorAxis, ratio, startAngle, sweep, Math.ceil((sweep / TAU) * ELLIPSE_SEGMENTS)),
        layer
      )
      return
    }
    case 'solid': {
      const pts = entity.points
      for (const p of pts) addPoint(b, p, 'endpoint', layer)
      const count = pts.length === 4 && pts[3].x === pts[2].x && pts[3].y === pts[2].y ? 3 : pts.length
      for (let i = 0; i < count; i++) {
        const a = pts[i]
        const c = pts[(i + 1) % count]
        addPoint(b, mid(a, c), 'midpoint', layer)
        addSegment(b, a, c, layer)
      }
      return
    }
    case 'text':
      addPoint(b, entity.position, 'endpoint', layer)
      return
    case 'point':
      addPoint(b, entity.position, 'endpoint', layer)
      return
  }
}

function cellKey(ix: number, iy: number): string {
  return `${ix}:${iy}`
}

function insertPointCell(index: SnapIndex, recordIndex: number, p: SnapPointRecord): void {
  const ix = Math.floor((p.x - index.minX) / index.cell)
  const iy = Math.floor((p.y - index.minY) / index.cell)
  const key = cellKey(ix, iy)
  const bucket = index.pointCells.get(key)
  if (bucket) bucket.push(recordIndex)
  else index.pointCells.set(key, [recordIndex])
}

function insertSegmentCell(index: SnapIndex, recordIndex: number, s: SnapSegmentRecord): void {
  const step = index.cell * 0.5
  const length = Math.hypot(s.bx - s.ax, s.by - s.ay)
  const steps = Math.max(1, Math.min(256, Math.ceil(length / step)))
  let lastKey = ''
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const x = s.ax + (s.bx - s.ax) * t
    const y = s.ay + (s.by - s.ay) * t
    const key = cellKey(Math.floor((x - index.minX) / index.cell), Math.floor((y - index.minY) / index.cell))
    if (key === lastKey) continue
    lastKey = key
    const bucket = index.segmentCells.get(key)
    if (bucket) bucket.push(recordIndex)
    else index.segmentCells.set(key, [recordIndex])
  }
}

export function buildSnapIndex(document: CadDocument): SnapIndex {
  const builder: Builder = { points: [], segments: [], entity: 0 }
  for (let i = 0; i < document.entities.length; i++) {
    builder.entity = i
    collectEntity(builder, document.entities[i])
  }
  const b = document.bounds
  const extent = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1e-6)
  const index: SnapIndex = {
    points: builder.points,
    segments: builder.segments,
    pointCells: new Map(),
    segmentCells: new Map(),
    cell: extent / 64,
    minX: b.minX,
    minY: b.minY,
    maxX: b.maxX,
    maxY: b.maxY
  }
  builder.points.forEach((p, i) => insertPointCell(index, i, p))
  builder.segments.forEach((s, i) => insertSegmentCell(index, i, s))
  return index
}

const indexCache = new WeakMap<CadDocument, SnapIndex>()

/** 解析后的文档只构建一次索引；文档对象被替换时自动失效。 */
export function getSnapIndex(document: CadDocument): SnapIndex {
  let index = indexCache.get(document)
  if (!index) {
    index = buildSnapIndex(document)
    indexCache.set(document, index)
  }
  return index
}

interface CellWindow {
  ix0: number
  iy0: number
  ix1: number
  iy1: number
  tooLarge: boolean
}

function cellWindow(index: SnapIndex, minX: number, minY: number, maxX: number, maxY: number): CellWindow {
  const ix0 = Math.floor((minX - index.minX) / index.cell) - 1
  const iy0 = Math.floor((minY - index.minY) / index.cell) - 1
  const ix1 = Math.floor((maxX - index.minX) / index.cell) + 1
  const iy1 = Math.floor((maxY - index.minY) / index.cell) + 1
  const cells = (ix1 - ix0 + 1) * (iy1 - iy0 + 1)
  return { ix0, iy0, ix1, iy1, tooLarge: cells > MAX_CELL_SCAN }
}

function gatherPoints(index: SnapIndex, win: CellWindow, minX: number, minY: number, maxX: number, maxY: number): number[] {
  if (win.tooLarge) {
    const out: number[] = []
    index.points.forEach((p, i) => {
      if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) out.push(i)
    })
    return out
  }
  const seen = new Set<number>()
  const out: number[] = []
  for (let ix = win.ix0; ix <= win.ix1; ix++) {
    for (let iy = win.iy0; iy <= win.iy1; iy++) {
      const bucket = index.pointCells.get(cellKey(ix, iy))
      if (!bucket) continue
      for (const i of bucket) {
        if (seen.has(i)) continue
        seen.add(i)
        out.push(i)
      }
    }
  }
  return out
}

function gatherSegments(index: SnapIndex, win: CellWindow, minX: number, minY: number, maxX: number, maxY: number): number[] {
  if (win.tooLarge) {
    const out: number[] = []
    index.segments.forEach((s, i) => {
      if (Math.max(s.ax, s.bx) < minX || Math.min(s.ax, s.bx) > maxX) return
      if (Math.max(s.ay, s.by) < minY || Math.min(s.ay, s.by) > maxY) return
      out.push(i)
    })
    return out
  }
  const seen = new Set<number>()
  const out: number[] = []
  for (let ix = win.ix0; ix <= win.ix1; ix++) {
    for (let iy = win.iy0; iy <= win.iy1; iy++) {
      const bucket = index.segmentCells.get(cellKey(ix, iy))
      if (!bucket) continue
      for (const i of bucket) {
        if (seen.has(i)) continue
        seen.add(i)
        out.push(i)
      }
    }
  }
  return out
}

function closestOnSegment(target: Point2, s: SnapSegmentRecord): Point2 {
  const dx = s.bx - s.ax
  const dy = s.by - s.ay
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-18) return { x: s.ax, y: s.ay }
  let t = ((target.x - s.ax) * dx + (target.y - s.ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return { x: s.ax + dx * t, y: s.ay + dy * t }
}

function intersectSegments(a: SnapSegmentRecord, b: SnapSegmentRecord, eps = 1e-9): Point2 | null {
  const rX = a.bx - a.ax
  const rY = a.by - a.ay
  const sX = b.bx - b.ax
  const sY = b.by - b.ay
  const denom = rX * sY - rY * sX
  if (Math.abs(denom) < 1e-12) return null
  const qpX = b.ax - a.ax
  const qpY = b.ay - a.ay
  const t = (qpX * sY - qpY * sX) / denom
  const u = (qpX * rY - qpY * rX) / denom
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null
  return { x: a.ax + rX * t, y: a.ay + rY * t }
}

export interface SnapQuery {
  /** 捕捉半径（屏幕像素） */
  radius: number
  /** 像素 / 世界单位，来自相机 */
  zoom: number
  hiddenLayers?: ReadonlySet<string>
  /** 上一次命中的目标：在释放半径内保持不变，形成滞回 */
  locked?: SnapHit | null
  /** 释放半径（像素），默认 1.45 倍捕捉半径 */
  escapeRadius?: number
  /** 需要忽略的锚点（拖拽起点），用于避免端点吸附回自身 */
  suppress?: Point2 | null
  /** 锚点忽略半径（像素），默认 2 */
  suppressRadius?: number
  maxIntersectionSegments?: number
}

/**
 * 查询捕捉点。返回分值最高的候选；无候选时返回 null，调用方保持自由拖动。
 *
 * 滞回策略（避免拖动时抖动，又不能把端点“扣住”）：
 * - 已锁定目标在释放半径内继续生效，不会因指尖微动而反复切换；
 * - 若出现优先级更高、且已经贴得很近的候选（例如从边线滑到顶点），允许接管；
 * - 同优先级之间的切换只由距离决定，绝不来回跳。
 */
export function findSnap(index: SnapIndex, target: Point2, query: SnapQuery): SnapHit | null {
  const zoom = query.zoom
  if (!Number.isFinite(zoom) || zoom <= 0) return null
  const radiusPx = Math.max(2, query.radius)
  const escapePx = Math.max(radiusPx, query.escapeRadius ?? radiusPx * 1.45)
  const hidden = query.hiddenLayers ?? EMPTY_LAYERS

  const suppressed = (p: Point2): boolean => {
    const anchor = query.suppress
    if (!anchor) return false
    return distancePx(anchor, p, zoom) <= (query.suppressRadius ?? 2)
  }

  const radiusWorld = radiusPx / zoom
  // 用对象承载结果，避免闭包赋值后 TS 把变量窄化成 never
  const picked: { hit: SnapHit | null; score: number; priority: number } = { hit: null, score: 0, priority: 0 }

  const consider = (p: Point2, kind: SnapKind): void => {
    const limit = radiusPx * KIND_RADIUS[kind]
    const px = distancePx(target, p, zoom)
    if (px > limit) return
    if (suppressed(p)) return
    const score = KIND_SCORE[kind] * (1 - 0.4 * (px / limit))
    if (score <= picked.score) return
    picked.score = score
    picked.priority = KIND_SCORE[kind]
    picked.hit = { point: { x: p.x, y: p.y }, kind, distance: px / zoom }
  }

  const minX = target.x - radiusWorld
  const minY = target.y - radiusWorld
  const maxX = target.x + radiusWorld
  const maxY = target.y + radiusWorld
  const win = cellWindow(index, minX, minY, maxX, maxY)

  for (const i of gatherPoints(index, win, minX, minY, maxX, maxY)) {
    const record = index.points[i]
    if (record.layer && hidden.has(record.layer)) continue
    consider(record, record.kind)
  }

  const segmentIds = gatherSegments(index, win, minX, minY, maxX, maxY)
  const limit = query.maxIntersectionSegments ?? DEFAULT_MAX_INTERSECTION_SEGMENTS
  if (segmentIds.length >= 2 && segmentIds.length <= limit) {
    for (let i = 0; i < segmentIds.length; i++) {
      const a = index.segments[segmentIds[i]]
      for (let j = i + 1; j < segmentIds.length; j++) {
        const b = index.segments[segmentIds[j]]
        if (a.entity === b.entity) continue
        if (hidden.has(a.layer) || hidden.has(b.layer)) continue
        const p = intersectSegments(a, b)
        if (p) consider(p, 'intersection')
      }
    }
  }

  for (const id of segmentIds) {
    const s = index.segments[id]
    if (hidden.has(s.layer)) continue
    consider(closestOnSegment(target, s), 'nearest')
  }

  const fresh = picked.hit
  if (!fresh) {
    if (query.locked && distancePx(target, query.locked.point, zoom) <= escapePx && !suppressed(query.locked.point)) {
      return query.locked
    }
    return null
  }

  const locked = query.locked
  if (!locked) return fresh
  const lockedPx = distancePx(target, locked.point, zoom)
  if (lockedPx > escapePx || suppressed(locked.point)) return fresh

  // 更高优先级的候选已经进入近距离范围时接管，例如边线近点 → 顶点端点
  if (picked.priority > KIND_SCORE[locked.kind] && distancePx(target, fresh.point, zoom) <= radiusPx * 0.75) return fresh
  return { ...locked, distance: lockedPx / zoom }
}

/** 捕捉指示：几何形状随类型变化，配文字标签，方便在手机上确认抓到了什么。 */
export function renderSnapIndicator(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  width: number,
  height: number,
  hit: SnapHit | null,
  dark = false
): void {
  if (!hit) return
  const p = worldToScreen(camera, width, height, hit.point)
  const accent = dark ? '#5eead4' : '#0d9488'
  const halo = dark ? 'rgba(20,30,44,.9)' : 'rgba(255,255,255,.95)'
  const size = 7

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const strokeShape = (path: () => void) => {
    ctx.beginPath()
    path()
    ctx.strokeStyle = halo
    ctx.lineWidth = 3.6
    ctx.stroke()
    ctx.beginPath()
    path()
    ctx.strokeStyle = accent
    ctx.lineWidth = 1.9
    ctx.stroke()
  }

  // 十字准线，明确当前落点
  ctx.strokeStyle = dark ? 'rgba(94,234,212,.55)' : 'rgba(13,148,136,.45)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(p.x - size - 8, p.y)
  ctx.lineTo(p.x - size - 2, p.y)
  ctx.moveTo(p.x + size + 2, p.y)
  ctx.lineTo(p.x + size + 8, p.y)
  ctx.moveTo(p.x, p.y - size - 8)
  ctx.lineTo(p.x, p.y - size - 2)
  ctx.moveTo(p.x, p.y + size + 2)
  ctx.lineTo(p.x, p.y + size + 8)
  ctx.stroke()

  switch (hit.kind) {
    case 'endpoint':
      strokeShape(() => ctx.rect(p.x - size + 1, p.y - size + 1, size * 2 - 2, size * 2 - 2))
      break
    case 'midpoint':
      strokeShape(() => {
        ctx.moveTo(p.x, p.y - size)
        ctx.lineTo(p.x + size, p.y + size - 1)
        ctx.lineTo(p.x - size, p.y + size - 1)
        ctx.closePath()
      })
      break
    case 'center':
      strokeShape(() => ctx.arc(p.x, p.y, size - 1, 0, TAU))
      break
    case 'quadrant':
      strokeShape(() => {
        ctx.moveTo(p.x, p.y - size)
        ctx.lineTo(p.x + size, p.y)
        ctx.lineTo(p.x, p.y + size)
        ctx.lineTo(p.x - size, p.y)
        ctx.closePath()
      })
      break
    case 'intersection':
      strokeShape(() => {
        ctx.moveTo(p.x - size + 1, p.y - size + 1)
        ctx.lineTo(p.x + size - 1, p.y + size - 1)
        ctx.moveTo(p.x + size - 1, p.y - size + 1)
        ctx.lineTo(p.x - size + 1, p.y + size - 1)
      })
      break
    case 'nearest':
      strokeShape(() => {
        ctx.moveTo(p.x - size + 1, p.y + size - 1)
        ctx.lineTo(p.x + size - 1, p.y - size + 1)
        ctx.moveTo(p.x + 2.4, p.y)
        ctx.arc(p.x, p.y, 2.4, 0, TAU)
      })
      break
  }

  // 类型标签
  const text = SNAP_LABEL[hit.kind]
  ctx.font = '600 11px "Arial", "Microsoft YaHei", sans-serif'
  const padX = 6
  const boxH = 19
  const boxW = ctx.measureText(text).width + padX * 2
  let left = p.x + size + 10
  if (left + boxW > width - 4) left = p.x - size - 10 - boxW
  let top = p.y - size - 26
  if (top < 4) top = p.y + size + 10
  left = Math.max(4, left)
  top = Math.max(4, Math.min(top, height - boxH - 4))

  ctx.beginPath()
  const r = 5
  ctx.moveTo(left + r, top)
  ctx.lineTo(left + boxW - r, top)
  ctx.quadraticCurveTo(left + boxW, top, left + boxW, top + r)
  ctx.lineTo(left + boxW, top + boxH - r)
  ctx.quadraticCurveTo(left + boxW, top + boxH, left + boxW - r, top + boxH)
  ctx.lineTo(left + r, top + boxH)
  ctx.quadraticCurveTo(left, top + boxH, left, top + boxH - r)
  ctx.lineTo(left, top + r)
  ctx.quadraticCurveTo(left, top, left + r, top)
  ctx.closePath()
  ctx.fillStyle = dark ? 'rgba(20,30,44,.94)' : 'rgba(255,255,255,.96)'
  ctx.fill()
  ctx.strokeStyle = accent
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = dark ? '#b8f5ea' : '#0b6b62'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, left + padX, top + boxH / 2 + 0.5)

  ctx.restore()
}
