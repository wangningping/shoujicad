import DxfParser from 'dxf-parser'
import { dxfEntityColor, dxfLayerColor, type CanvasMode } from './aci'
import {
  boundsOfEntities,
  compose,
  rotation,
  scaling,
  transformEntity,
  translation,
  type Mat2D
} from './geometry'
import { textLines } from './text'
import type { CadDocument, CadEntity, CadLayer, Point2 } from './types'

type RawEntity = Record<string, any>
const DEG = Math.PI / 180
const MAX_INSERT_DEPTH = 3

function point(value: any): Point2 {
  return { x: Number(value?.x) || 0, y: Number(value?.y) || 0 }
}

/** $INSUNITS → 显示单位。0 表示未标注，图纸单位由绘图者约定。 */
const INSUNITS: Record<number, string> = {
  1: 'in',
  2: 'ft',
  3: 'mi',
  4: 'mm',
  5: 'cm',
  6: 'm',
  7: 'km',
  8: 'μin',
  9: 'mil',
  10: 'yd',
  11: 'Å',
  12: 'nm',
  13: 'μm',
  14: 'dm',
  15: 'dam',
  16: 'hm'
}

function dxfUnits(dxf: any): string | null {
  const code = Number(dxf?.header?.$INSUNITS)
  return INSUNITS[code] ?? null
}

function buildLayers(dxf: any, mode: CanvasMode): Map<string, CadLayer> {
  const map = new Map<string, CadLayer>()
  const records = dxf?.tables?.layer?.layers ?? {}
  for (const key of Object.keys(records)) {
    const raw = records[key]
    const name = String(raw.name ?? key)
    map.set(name, {
      name,
      color: dxfLayerColor(raw.colorIndex, raw.color, mode),
      darkColor: dxfLayerColor(raw.colorIndex, raw.color, 'dark'),
      visible: raw.visible !== false && raw.frozen !== true,
      frozen: raw.frozen === true,
      lineType: String(raw.lineType ?? 'CONTINUOUS'),
      entityCount: 0
    })
  }
  if (!map.has('0')) {
    map.set('0', {
      name: '0',
      color: dxfLayerColor(7, undefined, mode),
      darkColor: dxfLayerColor(7, undefined, 'dark'),
      visible: true,
      frozen: false,
      lineType: 'CONTINUOUS',
      entityCount: 0
    })
  }
  return map
}

function ensureLayer(map: Map<string, CadLayer>, name: string, mode: CanvasMode): CadLayer {
  const key = name || '0'
  let layer = map.get(key)
  if (!layer) {
    layer = {
      name: key,
      color: dxfLayerColor(7, undefined, mode),
      darkColor: dxfLayerColor(7, undefined, 'dark'),
      visible: true,
      frozen: false,
      lineType: 'CONTINUOUS',
      entityCount: 0
    }
    map.set(key, layer)
  }
  return layer
}

function convertEntity(
  raw: RawEntity,
  layers: Map<string, CadLayer>,
  mode: CanvasMode
): CadEntity[] {
  const layerName = String(raw.layer || '0')
  const layer = ensureLayer(layers, layerName, mode)
  const color = dxfEntityColor(raw, mode)
  const darkColor = dxfEntityColor(raw, 'dark')
  const base = { layer: layerName, color: color ?? layer.color, darkColor: darkColor ?? layer.darkColor }
  // dxf-parser 仅在实体显式设置颜色时给出 colorIndex；缺失表示 BYLAYER，仍应显示。
  // 负值在 DXF 中表示实体被关闭。
  const visible = raw.visible !== false && !(Number(raw.colorIndex) < 0)

  if (!visible) return []

  switch (String(raw.type)) {
    case 'LINE': {
      const v = raw.vertices ?? []
      if (v.length < 2) return []
      return [{ ...base, type: 'line', start: point(v[0]), end: point(v[1]) }]
    }
    case 'LWPOLYLINE':
    case 'POLYLINE': {
      const vertices: RawEntity[] = raw.vertices ?? []
      if (vertices.length < 2) return []
      return [
        {
          ...base,
          type: 'polyline',
          points: vertices.map(point),
          closed: raw.shape === true,
          bulges: vertices.map((v) => Number(v.bulge) || 0)
        }
      ]
    }
    case 'CIRCLE':
      return [{ ...base, type: 'circle', center: point(raw.center), radius: Math.abs(Number(raw.radius) || 0) }]
    case 'ARC':
      return [
        {
          ...base,
          type: 'arc',
          center: point(raw.center),
          radius: Math.abs(Number(raw.radius) || 0),
          startAngle: Number(raw.startAngle) || 0,
          endAngle: Number(raw.endAngle) || 0
        }
      ]
    case 'ELLIPSE': {
      const majorAxis = point(raw.majorAxisEndPoint)
      return [
        {
          ...base,
          type: 'ellipse',
          center: point(raw.center),
          majorAxis,
          ratio: Math.abs(Number(raw.axisRatio) || 0),
          startAngle: Number(raw.startAngle) || 0,
          endAngle: Number(raw.endAngle) || 0
        }
      ]
    }
    case 'TEXT': {
      const text = String(raw.text ?? '').trim()
      if (!text) return []
      return [
        {
          ...base,
          type: 'text',
          position: point(raw.startPoint),
          text,
          height: Math.abs(Number(raw.textHeight) || 1),
          rotation: (Number(raw.rotation) || 0) * DEG
        }
      ]
    }
    case 'MTEXT': {
      const height = Math.abs(Number(raw.height) || 1)
      const origin = point(raw.position)
      const rotation = (Number(raw.rotation) || 0) * DEG
      return textLines(String(raw.text ?? '')).map((line, i) => ({
        ...base,
        type: 'text' as const,
        position: { x: origin.x, y: origin.y - i * height * 1.5 },
        text: line,
        height,
        rotation
      }))
    }
    case 'POINT':
      return [{ ...base, type: 'point', position: point(raw.position) }]
    case 'SOLID':
    case '3DFACE': {
      const points = (raw.points ?? []).map(point)
      return points.length >= 3 ? [{ ...base, type: 'solid', points }] : []
    }
    case 'SPLINE': {
      const points = (raw.controlPoints ?? raw.fitPoints ?? []).map(point)
      return points.length >= 2
        ? [{ ...base, type: 'polyline', points, closed: raw.closed === true, bulges: [] }]
        : []
    }
    default:
      return []
  }
}

export function parseDxf(text: string, name: string, size: number, mode: CanvasMode = 'light'): CadDocument {
  const dxf: any = new DxfParser().parse(text)
  const layers = buildLayers(dxf, mode)
  const blocks: Record<string, any> = dxf?.blocks ?? {}
  const entities: CadEntity[] = []
  const unsupported: Record<string, number> = {}
  const activeInserts = new Set<string>()

  const countUnsupported = (type: string) => {
    const key = type || 'UNKNOWN'
    unsupported[key] = (unsupported[key] ?? 0) + 1
  }

  const emit = (raw: RawEntity, matrix: Mat2D | undefined, depth: number): void => {
    if (!raw || typeof raw !== 'object') return
    const type = String(raw.type ?? '')

    if (type === 'INSERT') {
      if (depth >= MAX_INSERT_DEPTH) {
        countUnsupported('INSERT(深度上限)')
        return
      }
      const blockName = String(raw.name ?? '')
      const block = blocks[blockName]
      if (!block?.entities?.length || activeInserts.has(blockName)) {
        countUnsupported('INSERT(块缺失/递归)')
        return
      }
      const local = compose(
        translation(point(raw.position).x, point(raw.position).y),
        compose(
          rotation((Number(raw.rotation) || 0) * DEG),
          scaling(Number(raw.xScale) || 1, Number(raw.yScale) || 1)
        )
      )
      const merged = matrix ? compose(matrix, local) : local
      activeInserts.add(blockName)
      for (const child of block.entities as RawEntity[]) emit(child, merged, depth + 1)
      activeInserts.delete(blockName)
      return
    }

    const converted = convertEntity(raw, layers, mode)
    if (!converted.length) {
      countUnsupported(type)
      return
    }
    for (const entity of converted) {
      const final = matrix ? transformEntity(entity, matrix) : entity
      entities.push(final)
      const layer = ensureLayer(layers, final.layer, mode)
      layer.entityCount++
    }
  }

  for (const raw of (dxf?.entities ?? []) as RawEntity[]) emit(raw, undefined, 0)

  const entityCounts: Record<string, number> = {}
  for (const entity of entities) entityCounts[entity.type] = (entityCounts[entity.type] ?? 0) + 1

  return {
    id: '',
    name,
    format: 'dxf',
    size,
    importedAt: Date.now(),
    version: String(dxf?.header?.$ACADVER ?? ''),
    layers: [...layers.values()],
    entities,
    bounds: boundsOfEntities(entities),
    entityCounts,
    unsupported,
    units: dxfUnits(dxf)
  }
}
