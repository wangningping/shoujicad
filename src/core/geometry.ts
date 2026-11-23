import type { Bounds, CadEntity, Point2 } from './types'

export const TAU = Math.PI * 2

export function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
}

export function extendBounds(bounds: Bounds, x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  if (x < bounds.minX) bounds.minX = x
  if (y < bounds.minY) bounds.minY = y
  if (x > bounds.maxX) bounds.maxX = x
  if (y > bounds.maxY) bounds.maxY = y
}

export function boundsOfEntities(entities: CadEntity[]): Bounds {
  const b = emptyBounds()
  for (const entity of entities) extendEntityBounds(b, entity)
  if (!Number.isFinite(b.minX)) return { minX: -1, minY: -1, maxX: 1, maxY: 1 }
  return b
}

export function extendEntityBounds(bounds: Bounds, entity: CadEntity): void {
  switch (entity.type) {
    case 'line':
      extendBounds(bounds, entity.start.x, entity.start.y)
      extendBounds(bounds, entity.end.x, entity.end.y)
      break
    case 'polyline':
    case 'solid':
      for (const p of entity.points) extendBounds(bounds, p.x, p.y)
      break
    case 'circle':
      extendBounds(bounds, entity.center.x - entity.radius, entity.center.y - entity.radius)
      extendBounds(bounds, entity.center.x + entity.radius, entity.center.y + entity.radius)
      break
    case 'arc': {
      const pts = arcPoints(entity.center, entity.radius, entity.startAngle, entity.endAngle)
      for (const p of pts) extendBounds(bounds, p.x, p.y)
      break
    }
    case 'ellipse': {
      const pts = ellipsePoints(entity.center, entity.majorAxis, entity.ratio, entity.startAngle, entity.endAngle)
      for (const p of pts) extendBounds(bounds, p.x, p.y)
      break
    }
    case 'text': {
      const w = Math.max(1, entity.text.length) * entity.height * 0.7
      extendBounds(bounds, entity.position.x, entity.position.y - entity.height)
      extendBounds(bounds, entity.position.x + w, entity.position.y + entity.height)
      break
    }
    case 'point':
      extendBounds(bounds, entity.position.x, entity.position.y)
      break
  }
}

export function arcPoints(center: Point2, radius: number, start: number, end: number): Point2[] {
  let sweep = end - start
  while (sweep < 0) sweep += TAU
  while (sweep > TAU) sweep -= TAU
  const segments = Math.max(6, Math.min(160, Math.ceil(sweep / 0.035)))
  const points: Point2[] = []
  for (let i = 0; i <= segments; i++) {
    const angle = start + (sweep * i) / segments
    points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) })
  }
  return points
}

export function ellipsePoints(
  center: Point2,
  majorAxis: Point2,
  ratio: number,
  start: number,
  end: number
): Point2[] {
  const angle = Math.atan2(majorAxis.y, majorAxis.x)
  const major = Math.hypot(majorAxis.x, majorAxis.y)
  let sweep = end - start
  while (sweep < 0) sweep += TAU
  while (sweep > TAU) sweep -= TAU
  const segments = Math.max(12, Math.min(240, Math.ceil(sweep / 0.035)))
  const points: Point2[] = []
  for (let i = 0; i <= segments; i++) {
    const t = start + (sweep * i) / segments
    const u = major * Math.cos(t)
    const v = major * ratio * Math.sin(t)
    points.push({
      x: center.x + u * Math.cos(angle) - v * Math.sin(angle),
      y: center.y + u * Math.sin(angle) + v * Math.cos(angle)
    })
  }
  return points
}

/** DXF 凸度：bulge = tan(夹角 / 4)，正值为逆时针。 */
export function bulgePoints(start: Point2, end: Point2, bulge: number): Point2[] {
  if (!Number.isFinite(bulge) || Math.abs(bulge) < 1e-6) return [start, end]
  const dx = end.x - start.x
  const dy = end.y - start.y
  const chord = Math.hypot(dx, dy)
  if (chord < 1e-9) return [start, end]
  const offset = (chord * (1 - bulge * bulge)) / (4 * bulge)
  const center = {
    x: (start.x + end.x) / 2 - (dy / chord) * offset,
    y: (start.y + end.y) / 2 + (dx / chord) * offset
  }
  const radius = Math.hypot(start.x - center.x, start.y - center.y)
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x)
  const sweep = 4 * Math.atan(bulge)
  const segments = Math.max(6, Math.min(96, Math.ceil(Math.abs(sweep) / 0.05)))
  const points: Point2[] = []
  for (let i = 0; i <= segments; i++) {
    const a = startAngle + (sweep * i) / segments
    points.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) })
  }
  return points
}

export interface Mat2D {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export function identity(): Mat2D {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
}

/** 返回 outer ∘ inner（先应用 inner，再应用 outer）。 */
export function compose(outer: Mat2D, inner: Mat2D): Mat2D {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f
  }
}

export function translation(x: number, y: number): Mat2D {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y }
}

export function rotation(radians: number): Mat2D {
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 }
}

export function scaling(sx: number, sy: number): Mat2D {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }
}

export function applyMatrix(m: Mat2D, p: Point2): Point2 {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
}

export function matrixRotation(m: Mat2D): number {
  return Math.atan2(m.b, m.a)
}

export function transformEntity(entity: CadEntity, m: Mat2D): CadEntity {
  const base = { layer: entity.layer, color: entity.color }
  const sx = Math.hypot(m.a, m.b)
  const sy = Math.hypot(m.c, m.d)
  const rot = matrixRotation(m)
  const radiusScale = (sx + sy) / 2 || 1

  switch (entity.type) {
    case 'line':
      return { ...base, type: 'line', start: applyMatrix(m, entity.start), end: applyMatrix(m, entity.end) }
    case 'polyline': {
      if (Math.abs(sx - sy) > 1e-6) {
        const flat: Point2[] = []
        entity.points.forEach((p, i) => {
          flat.push(applyMatrix(m, p))
          const bulge = entity.bulges[i] ?? 0
          if (Math.abs(bulge) > 1e-6) {
            const next = entity.points[i + 1] ?? entity.points[0]
            const arc = bulgePoints(applyMatrix(m, p), applyMatrix(m, next), bulge)
            flat.push(...arc.slice(1, -1))
          }
        })
        return { ...base, type: 'polyline', points: flat, closed: entity.closed, bulges: [] }
      }
      return {
        ...base,
        type: 'polyline',
        points: entity.points.map((p) => applyMatrix(m, p)),
        closed: entity.closed,
        bulges: [...entity.bulges]
      }
    }
    case 'circle':
      return { ...base, type: 'circle', center: applyMatrix(m, entity.center), radius: entity.radius * radiusScale }
    case 'arc':
      return {
        ...base,
        type: 'arc',
        center: applyMatrix(m, entity.center),
        radius: entity.radius * radiusScale,
        startAngle: entity.startAngle + rot,
        endAngle: entity.endAngle + rot
      }
    case 'ellipse':
      return {
        ...base,
        type: 'ellipse',
        center: applyMatrix(m, entity.center),
        majorAxis: { x: m.a * entity.majorAxis.x + m.c * entity.majorAxis.y, y: m.b * entity.majorAxis.x + m.d * entity.majorAxis.y },
        ratio: entity.ratio * (sy / (sx || 1)),
        startAngle: entity.startAngle + rot,
        endAngle: entity.endAngle + rot
      }
    case 'text':
      return {
        ...base,
        type: 'text',
        position: applyMatrix(m, entity.position),
        text: entity.text,
        height: entity.height * sy,
        rotation: entity.rotation + rot
      }
    case 'point':
      return { ...base, type: 'point', position: applyMatrix(m, entity.position) }
    case 'solid':
      return { ...base, type: 'solid', points: entity.points.map((p) => applyMatrix(m, p)) }
  }
}
