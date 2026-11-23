import type { Camera } from './camera'
import { worldToScreen } from './camera'
import { arcPoints, bulgePoints, ellipsePoints, type Mat2D } from './geometry'
import type { CadDocument, CadEntity, Point2 } from './types'

export interface RenderInput {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  document: CadDocument
  camera: Camera
  hiddenLayers: ReadonlySet<string>
  background: string
  /** 夜间画布：选用实体的 darkColor，并切换网格与默认线条颜色 */
  dark?: boolean
  showGrid?: boolean
}

function visible(input: RenderInput, layer: string, color?: string): boolean {
  return !input.hiddenLayers.has(layer) && !!color
}

function path(ctx: CanvasRenderingContext2D, points: Point2[], input: RenderInput, closed: boolean): void {
  if (points.length < 2) return
  const first = worldToScreen(input.camera, input.width, input.height, points[0])
  ctx.beginPath()
  ctx.moveTo(first.x, first.y)
  for (let i = 1; i < points.length; i++) {
    const p = worldToScreen(input.camera, input.width, input.height, points[i])
    ctx.lineTo(p.x, p.y)
  }
  if (closed) ctx.closePath()
  ctx.stroke()
}

function drawGrid(input: RenderInput): void {
  const { ctx, width, height } = input
  const step = 28
  ctx.save()
  ctx.fillStyle = input.dark ? '#334156' : '#dce5f1'
  for (let x = 0; x < width; x += step) {
    for (let y = 0; y < height; y += step) {
      ctx.fillRect(x, y, 1, 1)
    }
  }
  ctx.restore()
}

function drawEntity(input: RenderInput, entity: CadEntity): void {
  const { ctx, camera, width, height } = input
  const layer = input.document.layers.find((l) => l.name === entity.layer)
  const color = input.dark
    ? entity.darkColor ?? layer?.darkColor ?? '#e6edf6'
    : entity.color ?? layer?.color ?? '#243044'
  if (!visible(input, entity.layer, color)) return

  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 1.25
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  switch (entity.type) {
    case 'line':
      path(ctx, [entity.start, entity.end], input, false)
      break
    case 'polyline': {
      const flat: Point2[] = []
      entity.points.forEach((p, i) => {
        flat.push(p)
        const bulge = entity.bulges[i] ?? 0
        if (Math.abs(bulge) > 1e-6) {
          const next = entity.points[i + 1] ?? entity.points[0]
          const arc = bulgePoints(p, next, bulge)
          flat.push(...arc.slice(1, -1))
        }
      })
      path(ctx, flat, input, entity.closed)
      break
    }
    case 'circle': {
      const pts = arcPoints(entity.center, entity.radius, 0, Math.PI * 2)
      path(ctx, pts, input, true)
      break
    }
    case 'arc':
      path(ctx, arcPoints(entity.center, entity.radius, entity.startAngle, entity.endAngle), input, false)
      break
    case 'ellipse':
      path(
        ctx,
        ellipsePoints(entity.center, entity.majorAxis, entity.ratio, entity.startAngle, entity.endAngle),
        input,
        false
      )
      break
    case 'text': {
      const p = worldToScreen(camera, width, height, entity.position)
      if (p.x < -200 || p.x > width + 200 || p.y < -50 || p.y > height + 50) return
      const size = Math.max(6, Math.min(320, entity.height * camera.zoom))
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(-(entity.rotation + camera.rotation))
      ctx.font = `${Math.round(size)}px "Arial", "Microsoft YaHei", sans-serif`
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(entity.text, 0, 0)
      ctx.restore()
      break
    }
    case 'point': {
      const p = worldToScreen(camera, width, height, entity.position)
      ctx.beginPath()
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2)
      ctx.fill()
      break
    }
    case 'solid': {
      if (entity.points.length < 3) return
      const p = worldToScreen(camera, width, height, entity.points[0])
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      for (let i = 1; i < entity.points.length; i++) {
        const q = worldToScreen(camera, width, height, entity.points[i])
        ctx.lineTo(q.x, q.y)
      }
      ctx.closePath()
      ctx.stroke()
      break
    }
  }
}

/** 组装屏幕坐标矩阵，供自定义叠加层复用。 */
export function cameraMatrix(camera: Camera, width: number, height: number): Mat2D {
  const cos = Math.cos(camera.rotation)
  const sin = Math.sin(camera.rotation)
  return {
    a: camera.zoom * cos,
    b: camera.zoom * sin,
    c: -camera.zoom * sin,
    d: camera.zoom * cos,
    e: width / 2 - camera.zoom * (cos * camera.x - sin * camera.y),
    f: height / 2 + camera.zoom * (sin * camera.x + cos * camera.y)
  }
}

export function renderScene(input: RenderInput): void {
  const { ctx, width, height } = input
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = input.background
  ctx.fillRect(0, 0, width, height)
  if (input.showGrid !== false) drawGrid(input)
  for (const entity of input.document.entities) drawEntity(input, entity)
}
