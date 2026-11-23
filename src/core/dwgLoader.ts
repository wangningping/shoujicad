import { aciToHex, dwgEntityColor, rgbNumberToHex, type CanvasMode } from './aci'
import { boundsOfEntities } from './geometry'
import { textLines } from './text'
import type { CadDocument, CadEntity, CadLayer, Point2 } from './types'

type RawEntity = Record<string, any>

let loaderPromise: Promise<any> | null = null

/**
 * WASM 约 7.8MB，按需动态加载；解析前不会阻塞 DXF 路径。
 * 不传 baseDir，交由 Emscripten glue 的 new URL(..., import.meta.url) 定位：
 * 开发态指向 node_modules 内的 wasm/，构建态指向 Vite 产出的带哈希资源。
 */
function getLibreDwg(): Promise<any> {
  if (!loaderPromise) {
    loaderPromise = import('@mlightcad/libredwg-web').then(async ({ LibreDwg, Dwg_File_Type }) => ({
      lib: await LibreDwg.create(),
      fileType: Dwg_File_Type.DWG as number
    }))
  }
  return loaderPromise
}

function point(value: any): Point2 {
  return { x: Number(value?.x) || 0, y: Number(value?.y) || 0 }
}

function buildLayers(db: any, mode: CanvasMode): Map<string, CadLayer> {
  const map = new Map<string, CadLayer>()
  const entries = db?.tables?.LAYER?.entries ?? []
  for (const entry of entries) {
    const name = String(entry?.name ?? '')
    if (!name) continue
    const pickColor = (target: CanvasMode): string => {
      const index = Number(entry.colorIndex)
      return index > 0 && index < 256
        ? aciToHex(index, target)
        : Number(entry.color) > 0
          ? rgbNumberToHex(entry.color)
          : aciToHex(7, target)
    }
    map.set(name, {
      name,
      color: pickColor(mode),
      darkColor: pickColor('dark'),
      visible: entry.off !== true && entry.frozen !== true,
      frozen: entry.frozen === true,
      lineType: String(entry.lineType ?? 'CONTINUOUS'),
      entityCount: 0
    })
  }
  if (!map.has('0')) {
    map.set('0', {
      name: '0',
      color: aciToHex(7, mode),
      darkColor: aciToHex(7, 'dark'),
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
      color: aciToHex(7, mode),
      darkColor: aciToHex(7, 'dark'),
      visible: true,
      frozen: false,
      lineType: 'CONTINUOUS',
      entityCount: 0
    }
    map.set(key, layer)
  }
  return layer
}

function convertEntity(raw: RawEntity, layers: Map<string, CadLayer>, mode: CanvasMode): CadEntity[] {
  const layerName = String(raw.layer || '0')
  const layer = ensureLayer(layers, layerName, mode)
  const base = {
    layer: layerName,
    color: dwgEntityColor(raw, mode) ?? layer.color,
    darkColor: dwgEntityColor(raw, 'dark') ?? layer.darkColor
  }
  if (raw.isVisible === false) return []

  switch (String(raw.type)) {
    case 'LINE':
      return [{ ...base, type: 'line', start: point(raw.startPoint), end: point(raw.endPoint) }]
    case 'LWPOLYLINE': {
      const vertices = raw.vertices ?? []
      if (vertices.length < 2) return []
      return [
        {
          ...base,
          type: 'polyline',
          points: vertices.map(point),
          closed: (Number(raw.flag) & 1) !== 0,
          bulges: vertices.map((v: RawEntity) => Number(v.bulge) || 0)
        }
      ]
    }
    case 'POLYLINE2D': {
      const vertices = (raw.vertices ?? []).filter((v: RawEntity) => v && typeof v.x === 'number')
      if (vertices.length < 2) return []
      return [
        {
          ...base,
          type: 'polyline',
          points: vertices.map(point),
          closed: (Number(raw.flag) & 1) !== 0,
          bulges: vertices.map((v: RawEntity) => Number(v.bulge) || 0)
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
    case 'ELLIPSE':
      return [
        {
          ...base,
          type: 'ellipse',
          center: point(raw.center),
          majorAxis: point(raw.majorAxisEndPoint),
          ratio: Math.abs(Number(raw.axisRatio) || 0),
          startAngle: Number(raw.startAngle) || 0,
          endAngle: Number(raw.endAngle) || 0
        }
      ]
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
          rotation: Number(raw.rotation) || 0
        }
      ]
    }
    case 'MTEXT': {
      const height = Math.abs(Number(raw.textHeight) || 1)
      const origin = point(raw.insertionPoint)
      const rotation = Number(raw.rotation) || 0
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
    case 'TRACE': {
      const points = [raw.corner1, raw.corner2, raw.corner3, raw.corner4]
        .filter((p) => p && typeof p.x === 'number')
        .map(point)
      return points.length >= 3 ? [{ ...base, type: 'solid', points }] : []
    }
    default:
      return []
  }
}

export async function parseDwg(
  data: ArrayBuffer,
  name: string,
  size: number,
  mode: CanvasMode = 'light'
): Promise<CadDocument> {
  const { lib, fileType } = await getLibreDwg()
  let ptr: number | undefined
  let version = ''

  try {
    ptr = lib.dwg_read_data(data, fileType)
    if (!ptr) throw new Error('LibreDWG 无法读取该文件（格式不支持或文件损坏）')
    const versionInfo = lib.dwg_get_version_type(ptr)
    version = `DWG v${String(versionInfo?.version ?? '')}`
    const db = lib.convert(ptr)
    const layers = buildLayers(db, mode)
    const entities: CadEntity[] = []
    const unsupported: Record<string, number> = {}

    for (const raw of (db?.entities ?? []) as RawEntity[]) {
      const converted = convertEntity(raw, layers, mode)
      if (!converted.length) {
        const key = String(raw?.type ?? 'UNKNOWN')
        unsupported[key] = (unsupported[key] ?? 0) + 1
        continue
      }
      for (const entity of converted) {
        entities.push(entity)
        ensureLayer(layers, entity.layer, mode).entityCount++
      }
    }

    const entityCounts: Record<string, number> = {}
    for (const entity of entities) entityCounts[entity.type] = (entityCounts[entity.type] ?? 0) + 1

    return {
      id: '',
      name,
      format: 'dwg',
      size,
      importedAt: Date.now(),
      version,
      layers: [...layers.values()],
      entities,
      bounds: boundsOfEntities(entities),
      entityCounts,
      unsupported
    }
  } finally {
    if (ptr) lib.dwg_free(ptr)
  }
}
