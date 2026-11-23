/**
 * 测量叠加层：距离、半径、夹角三种测量共用一套绘制管线。
 *
 * 约定：
 * - 琥珀色只用于测量结果（线、弧、数值标签），青绿色只用于高亮被测量的几何对象；
 *   两套颜色分工固定，用户扫一眼就能分清「量的是什么」与「量出多少」。
 * - 所有尺寸以屏幕像素为准（端点半径、箭头、标签），缩放时标注始终可读。
 * - 数值单位跟随文档 $INSUNITS；未标注时不臆造单位，由状态条提示「未标注单位」。
 */
import { worldToScreen, type Camera } from './camera'
import type { SnapKind } from './snap'
import type { Point2 } from './types'

export type MeasureKind = 'distance' | 'radius' | 'angle'

export interface Segment {
  a: Point2
  b: Point2
}

export interface DistanceMeasurement {
  kind: 'distance'
  id: number
  start: Point2
  end: Point2
  /** 端点吸附到的几何类型，用于在图上标记该端点已锁定 */
  startKind?: SnapKind
  endKind?: SnapKind
}

/** 圆/圆弧的半径测量：at 为拾取处（半径线落到圆上的点），sweep 缺省表示整圆。 */
export interface RadiusGeometry {
  center: Point2
  radius: number
  at: Point2
  sweep?: { start: number; sweep: number }
}

export interface RadiusMeasurement extends RadiusGeometry {
  kind: 'radius'
  id: number
}

/** 夹角测量：vertex 为两条直线的交点，a/b 为两条边上用于定方向的点。 */
export interface AngleGeometry {
  vertex: Point2
  a: Point2
  b: Point2
  lineA: Segment
  lineB: Segment
}

export interface AngleMeasurement extends AngleGeometry {
  kind: 'angle'
  id: number
}

export type Measurement = DistanceMeasurement | RadiusMeasurement | AngleMeasurement

/** 正在拖动的端点，绘制成可抓取的手柄。 */
export interface ActiveEndpoint {
  id: number
  which: 'start' | 'end'
}

/** 未落定的绘制状态：距离的待定首点、半径/夹角的实时预览、夹角已选中的第一条线。 */
export interface MeasureOverlay {
  pendingPoint: Point2 | null
  pendingKind: SnapKind | null
  active: ActiveEndpoint | null
  previewRadius: RadiusGeometry | null
  previewAngle: AngleGeometry | null
  pendingLine: Segment | null
  /** 夹角模式下的悬停高亮：手指/光标压在某条线上，但还没落定为「已选」 */
  hoverSegment: Segment | null
}

const TAU = Math.PI * 2

function ink(dark: boolean): string {
  return dark ? '#f5a623' : '#c47f24'
}

function accent(dark: boolean): string {
  return dark ? '#5eead4' : '#0d9488'
}

function dotFill(dark: boolean): string {
  return dark ? '#18222f' : '#fff'
}

export function formatLength(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const abs = Math.abs(value)
  if (abs >= 1000) return value.toFixed(1)
  if (abs >= 1) return value.toFixed(2)
  return value.toFixed(3)
}

export function formatAngle(value: number): string {
  if (!Number.isFinite(value)) return '0.0°'
  return `${value.toFixed(1)}°`
}

/** 数值 + 单位。单位未知（$INSUNITS=0 或 DWG 未提供）时不附单位，避免给出错误量纲。 */
export function withUnit(value: number, unit: string | null): string {
  const text = formatLength(value)
  return unit ? `${text} ${unit}` : text
}

export function measurementDistance(item: DistanceMeasurement): number {
  return Math.hypot(item.end.x - item.start.x, item.end.y - item.start.y)
}

/** 方位角：与 X 轴正方向的夹角，用于描述测得线段的走向。 */
export function measurementBearing(item: DistanceMeasurement): number {
  const degrees = (Math.atan2(item.end.y - item.start.y, item.end.x - item.start.x) * 180) / Math.PI
  return (degrees + 360) % 360
}

/** 两条边之间的夹角，取值 [0, 180]，与画布旋转、y 轴方向无关（几何量，不含屏幕翻转）。 */
export function angleAt(vertex: Point2, a: Point2, b: Point2): number {
  const a1 = Math.atan2(a.y - vertex.y, a.x - vertex.x)
  const a2 = Math.atan2(b.y - vertex.y, b.x - vertex.x)
  let delta = Math.abs(a1 - a2)
  if (delta > Math.PI) delta = TAU - delta
  return (delta * 180) / Math.PI
}

/** 从交点出发，沿线段取较远的一个端点作为方向点：夹角弧才会张在看得见的那一侧。 */
export function rayThrough(vertex: Point2, s: Segment): Point2 {
  const da = Math.hypot(s.a.x - vertex.x, s.a.y - vertex.y)
  const db = Math.hypot(s.b.x - vertex.x, s.b.y - vertex.y)
  return da >= db ? { ...s.a } : { ...s.b }
}

function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  viewportWidth: number,
  dark: boolean
): void {
  ctx.font = '600 12px "Arial", "Microsoft YaHei", sans-serif'
  const width = ctx.measureText(text).width + 16
  const height = 24
  const left = Math.max(4, Math.min(x - width / 2, viewportWidth - width - 4))
  const top = Math.max(4, y - height - 10)
  const r = 6
  ctx.fillStyle = dark ? 'rgba(24,34,50,.96)' : 'rgba(255,255,255,.96)'
  ctx.strokeStyle = ink(dark)
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(left + r, top)
  ctx.lineTo(left + width - r, top)
  ctx.quadraticCurveTo(left + width, top, left + width, top + r)
  ctx.lineTo(left + width, top + height - r)
  ctx.quadraticCurveTo(left + width, top + height, left + width - r, top + height)
  ctx.lineTo(left + r, top + height)
  ctx.quadraticCurveTo(left, top + height, left, top + height - r)
  ctx.lineTo(left, top + r)
  ctx.quadraticCurveTo(left, top, left + r, top)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = dark ? '#ffd79a' : '#8a4b06'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, left + 8, top + height / 2)
}

type Project = (p: Point2) => Point2

/** 高亮被测量的几何对象：先铺一层宽而淡的光晕，再压一条实线，保留图元本身的线形。 */
function highlight(ctx: CanvasRenderingContext2D, build: () => void, dark: boolean, alpha = 1): void {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash([])
  ctx.strokeStyle = accent(dark)
  ctx.beginPath()
  build()
  ctx.globalAlpha = 0.2 * alpha
  ctx.lineWidth = 8
  ctx.stroke()
  ctx.globalAlpha = 0.95 * alpha
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.restore()
}

function circlePath(ctx: CanvasRenderingContext2D, project: Project, geom: RadiusGeometry): void {
  const segments = 72
  const start = geom.sweep ? geom.sweep.start : 0
  const sweep = geom.sweep ? geom.sweep.sweep : TAU
  const count = Math.max(10, Math.ceil((sweep / TAU) * segments))
  for (let i = 0; i <= count; i++) {
    const t = start + (sweep * i) / count
    const p = project({
      x: geom.center.x + geom.radius * Math.cos(t),
      y: geom.center.y + geom.radius * Math.sin(t)
    })
    if (i === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  }
  if (!geom.sweep) ctx.closePath()
}

function segmentPath(ctx: CanvasRenderingContext2D, project: Project, s: Segment): void {
  const a = project(s.a)
  const b = project(s.b)
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
}

function drawRadius(
  ctx: CanvasRenderingContext2D,
  project: Project,
  geom: RadiusGeometry,
  dark: boolean,
  unit: string | null,
  alpha: number,
  width: number
): void {
  const center = project(geom.center)
  const at = project(geom.at)
  ctx.save()
  ctx.globalAlpha = alpha

  highlight(ctx, () => circlePath(ctx, project, geom), dark, alpha)

  // 圆心：十字 + 空心点，与捕捉指示器的「圆心」记号保持一致
  ctx.setLineDash([])
  ctx.strokeStyle = ink(dark)
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.moveTo(center.x - 6, center.y)
  ctx.lineTo(center.x + 6, center.y)
  ctx.moveTo(center.x, center.y - 6)
  ctx.lineTo(center.x, center.y + 6)
  ctx.stroke()

  // 半径线：圆心指向拾取点，虚线避免与图元混淆
  ctx.setLineDash([6, 4])
  ctx.beginPath()
  ctx.moveTo(center.x, center.y)
  ctx.lineTo(at.x, at.y)
  ctx.stroke()

  ctx.setLineDash([])
  ctx.fillStyle = dotFill(dark)
  ctx.beginPath()
  ctx.arc(at.x, at.y, 3.5, 0, TAU)
  ctx.fill()
  ctx.strokeStyle = ink(dark)
  ctx.stroke()

  // 标签挂在半径线中点并沿法向让开，避免压住线本身
  const dx = at.x - center.x
  const dy = at.y - center.y
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  label(ctx, `R ${withUnit(geom.radius, unit)}`, (center.x + at.x) / 2 + nx * 16, (center.y + at.y) / 2 + ny * 16, width, dark)
  ctx.restore()
}

function drawAngle(
  ctx: CanvasRenderingContext2D,
  project: Project,
  geom: AngleGeometry,
  dark: boolean,
  alpha: number,
  width: number
): void {
  const v = project(geom.vertex)
  const pa = project(geom.a)
  const pb = project(geom.b)
  const lena = Math.hypot(pa.x - v.x, pa.y - v.y)
  const lenb = Math.hypot(pb.x - v.x, pb.y - v.y)
  const radius = Math.min(64, Math.max(22, Math.min(lena, lenb) * 0.6))

  ctx.save()
  ctx.globalAlpha = alpha
  highlight(ctx, () => segmentPath(ctx, project, geom.lineA), dark, alpha)
  highlight(ctx, () => segmentPath(ctx, project, geom.lineB), dark, alpha)

  let a1 = Math.atan2(pa.y - v.y, pa.x - v.x)
  let a2 = Math.atan2(pb.y - v.y, pb.x - v.x)
  let delta = a2 - a1
  while (delta > Math.PI) delta -= TAU
  while (delta < -Math.PI) delta += TAU

  ctx.setLineDash([])
  ctx.strokeStyle = ink(dark)
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.arc(v.x, v.y, radius, a1, a1 + delta, delta < 0)
  ctx.stroke()

  // 交点小圆点，明确角度的顶点
  ctx.fillStyle = dotFill(dark)
  ctx.beginPath()
  ctx.arc(v.x, v.y, 3, 0, TAU)
  ctx.fill()
  ctx.strokeStyle = ink(dark)
  ctx.stroke()

  const mid = a1 + delta / 2
  label(
    ctx,
    formatAngle(angleAt(geom.vertex, geom.a, geom.b)),
    v.x + Math.cos(mid) * (radius + 24),
    v.y + Math.sin(mid) * (radius + 24),
    width,
    dark
  )
  ctx.restore()
}

function drawDistance(
  ctx: CanvasRenderingContext2D,
  project: Project,
  item: DistanceMeasurement,
  dark: boolean,
  unit: string | null,
  active: ActiveEndpoint | null,
  width: number
): void {
  const a = project(item.start)
  const b = project(item.end)
  ctx.setLineDash([6, 4])
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.stroke()

  ctx.setLineDash([])
  const handles: Array<{ p: Point2; kind?: SnapKind; which: 'start' | 'end' }> = [
    { p: a, kind: item.startKind, which: 'start' },
    { p: b, kind: item.endKind, which: 'end' }
  ]
  for (const handle of handles) {
    const isActive = active !== null && active.id === item.id && active.which === handle.which
    if (isActive) {
      // 拖动中的手柄：外圈光晕 + 实心圆，手指按上去就能看出抓到了哪个端点
      ctx.beginPath()
      ctx.arc(handle.p.x, handle.p.y, 13, 0, TAU)
      ctx.fillStyle = dark ? 'rgba(245,166,35,.18)' : 'rgba(196,127,36,.16)'
      ctx.fill()
      ctx.beginPath()
      ctx.arc(handle.p.x, handle.p.y, 6.5, 0, TAU)
      ctx.fillStyle = ink(dark)
      ctx.fill()
      ctx.strokeStyle = dotFill(dark)
      ctx.lineWidth = 1.6
      ctx.stroke()
      ctx.strokeStyle = ink(dark)
      ctx.lineWidth = 1.6
      continue
    }
    ctx.beginPath()
    ctx.arc(handle.p.x, handle.p.y, 4, 0, TAU)
    ctx.fillStyle = dotFill(dark)
    ctx.fill()
    ctx.strokeStyle = ink(dark)
    ctx.stroke()
    if (handle.kind) {
      // 已吸附端点加一圈细环，表示该端点锁定了几何点
      ctx.beginPath()
      ctx.arc(handle.p.x, handle.p.y, 7.5, 0, TAU)
      ctx.globalAlpha = 0.45
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  }

  label(
    ctx,
    `${withUnit(measurementDistance(item), unit)}  ·  ${measurementBearing(item).toFixed(1)}°`,
    (a.x + b.x) / 2,
    (a.y + b.y) / 2,
    width,
    dark
  )
}

/** 在图纸渲染之后叠加测量标注；尺寸以屏幕像素为准，缩放时保持可读。 */
export function renderMeasurements(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  width: number,
  height: number,
  items: readonly Measurement[],
  overlay: MeasureOverlay,
  dark = false,
  unit: string | null = null
): void {
  const hasWork =
    items.length > 0 ||
    overlay.pendingPoint !== null ||
    overlay.pendingLine !== null ||
    overlay.previewRadius !== null ||
    overlay.previewAngle !== null
  if (!hasWork) return

  const project: Project = (p) => worldToScreen(camera, width, height, p)
  ctx.save()
  ctx.strokeStyle = ink(dark)
  ctx.fillStyle = ink(dark)
  ctx.lineWidth = 1.6

  for (const item of items) {
    if (item.kind === 'distance') {
      drawDistance(ctx, project, item, dark, unit, overlay.active, width)
    } else if (item.kind === 'radius') {
      drawRadius(ctx, project, item, dark, unit, 1, width)
    } else {
      drawAngle(ctx, project, item, dark, 1, width)
    }
  }

  // 预览：按住对象时的实时结果，略淡以区别于已落定的测量
  if (overlay.previewRadius) drawRadius(ctx, project, overlay.previewRadius, dark, unit, 0.78, width)
  if (overlay.previewAngle) drawAngle(ctx, project, overlay.previewAngle, dark, 0.78, width)

  if (overlay.hoverSegment && overlay.hoverSegment !== overlay.pendingLine) {
    highlight(ctx, () => segmentPath(ctx, project, overlay.hoverSegment as Segment), dark, 0.75)
  }

  // 夹角测量：第一条线已选中，等第二个对象
  if (overlay.pendingLine) {
    highlight(ctx, () => segmentPath(ctx, project, overlay.pendingLine as Segment), dark)
    const mid = project({
      x: (overlay.pendingLine.a.x + overlay.pendingLine.b.x) / 2,
      y: (overlay.pendingLine.a.y + overlay.pendingLine.b.y) / 2
    })
    label(ctx, '已选 1/2', mid.x, mid.y - 14, width, dark)
  }

  if (overlay.pendingPoint) {
    const p = project(overlay.pendingPoint)
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.arc(p.x, p.y, 5, 0, TAU)
    ctx.fillStyle = dotFill(dark)
    ctx.fill()
    ctx.strokeStyle = ink(dark)
    ctx.stroke()
    // 十字准星，便于在手机上确认落点
    ctx.beginPath()
    ctx.moveTo(p.x - 10, p.y)
    ctx.lineTo(p.x + 10, p.y)
    ctx.moveTo(p.x, p.y - 10)
    ctx.lineTo(p.x, p.y + 10)
    ctx.stroke()
  }
  ctx.restore()
}
