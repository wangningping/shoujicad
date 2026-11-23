/** 与具体文件格式无关的中间模型：DXF / DWG 都归一化到这里。 */

export interface Point2 {
  x: number
  y: number
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface CadLayer {
  name: string
  /** 浅色画布下的 CSS 颜色，如 #243044 */
  color: string
  /** 夜间画布下的颜色；ACI 7/8/9 需要随底色反转 */
  darkColor: string
  visible: boolean
  frozen: boolean
  lineType: string
  entityCount: number
}

interface EntityBase {
  layer: string
  /** 覆盖图层颜色；未指定时按图层颜色绘制 */
  color?: string
  /** 夜间画布下的覆盖颜色 */
  darkColor?: string
}

export interface LineEntity extends EntityBase {
  type: 'line'
  start: Point2
  end: Point2
}

export interface PolylineEntity extends EntityBase {
  type: 'polyline'
  points: Point2[]
  closed: boolean
  /** 与 points 对应的凸度，用于绘制圆弧段 */
  bulges: number[]
}

export interface CircleEntity extends EntityBase {
  type: 'circle'
  center: Point2
  radius: number
}

export interface ArcEntity extends EntityBase {
  type: 'arc'
  center: Point2
  radius: number
  /** 弧度，逆时针 */
  startAngle: number
  endAngle: number
}

export interface EllipseEntity extends EntityBase {
  type: 'ellipse'
  center: Point2
  /** 长轴半向量 */
  majorAxis: Point2
  /** 短轴/长轴 比值 */
  ratio: number
  startAngle: number
  endAngle: number
}

export interface TextEntity extends EntityBase {
  type: 'text'
  position: Point2
  text: string
  height: number
  /** 弧度，逆时针 */
  rotation: number
}

export interface PointEntity extends EntityBase {
  type: 'point'
  position: Point2
}

export interface SolidEntity extends EntityBase {
  type: 'solid'
  points: Point2[]
}

export type CadEntity =
  | LineEntity
  | PolylineEntity
  | CircleEntity
  | ArcEntity
  | EllipseEntity
  | TextEntity
  | PointEntity
  | SolidEntity

export type CadFormat = 'dxf' | 'dwg'

export interface CadDocument {
  id: string
  name: string
  format: CadFormat
  /** 原始文件字节数 */
  size: number
  importedAt: number
  /** 如 AC1027 / AC1032 */
  version: string
  layers: CadLayer[]
  entities: CadEntity[]
  bounds: Bounds
  /** 按实体类型统计，供信息面板展示 */
  entityCounts: Record<string, number>
  /** 解析时被跳过的实体类型及数量 */
  unsupported: Record<string, number>
  /** 图纸单位（DXF $INSUNITS 映射后的符号，如 mm / m）；未标注时为 null */
  units?: string | null
}

export interface StoredDrawing {
  id: string
  name: string
  format: CadFormat
  size: number
  importedAt: number
  document: CadDocument
  /** 列表缩略图 dataURL */
  thumbnail: string
}

export interface StoredFile {
  id: string
  /** 原始文件字节，仅用于重新解析；应用不提供编辑能力 */
  file: ArrayBuffer
}
