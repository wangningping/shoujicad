import { ACI_PALETTE } from './aciPalette'

export type CanvasMode = 'light' | 'dark'

/** ACI 7/8/9 是随背景解释的“黑白灰”，需要按画布底色切换。 */
export function aciToHex(index: number, mode: CanvasMode): string {
  const i = Math.round(index)
  if (i === 7) return mode === 'dark' ? '#ffffff' : '#243044'
  if (i === 8) return mode === 'dark' ? '#9aa7b8' : '#5b6879'
  if (i === 9) return mode === 'dark' ? '#d8e0ec' : '#39465a'
  const aci = Math.max(1, Math.min(255, Number.isFinite(i) ? i : 7))
  return rgbNumberToHex(ACI_PALETTE[aci] ?? ACI_PALETTE[7])
}

export function rgbNumberToHex(value: number): string {
  const n = Math.max(0, Math.min(0xffffff, Math.round(value)))
  return `#${n.toString(16).padStart(6, '0')}`
}

interface DxfColorLike {
  colorIndex?: number
  color?: number
}

/** dxf-parser 的实体：colorIndex 62，0/256 表示随块/随层。 */
export function dxfEntityColor(entity: DxfColorLike, mode: CanvasMode): string | undefined {
  const index = entity.colorIndex
  if (typeof index === 'number' && index !== 0 && index !== 256) {
    if (index < 0) return undefined
    return aciToHex(index, mode)
  }
  if (typeof entity.color === 'number' && Number.isFinite(entity.color)) {
    return rgbNumberToHex(entity.color)
  }
  return undefined
}

interface DwgColorLike {
  colorIndex?: number
  color?: number
}

/** libredwg-web 的实体：color 为 24 位 RGB，colorIndex 256 表示随层。 */
export function dwgEntityColor(entity: DwgColorLike, mode: CanvasMode): string | undefined {
  const index = entity.colorIndex
  if (typeof index === 'number' && index > 0 && index < 256) {
    return aciToHex(index, mode)
  }
  if (typeof entity.color === 'number' && Number.isFinite(entity.color) && entity.color > 0) {
    return rgbNumberToHex(entity.color)
  }
  return undefined
}

export function dxfLayerColor(colorIndex: number | undefined, color: number | undefined, mode: CanvasMode): string {
  if (typeof colorIndex === 'number' && colorIndex > 0 && colorIndex < 256) {
    return aciToHex(colorIndex, mode)
  }
  if (typeof color === 'number' && Number.isFinite(color) && color > 0) {
    return rgbNumberToHex(color)
  }
  return aciToHex(7, mode)
}
