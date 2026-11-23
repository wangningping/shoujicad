import { fitCamera } from './camera'
import { renderScene } from './render'
import type { CadDocument } from './types'

export function makeThumbnail(document: CadDocument, width = 320, height = 200): string {
  const canvas = globalThis.document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  renderScene({
    ctx,
    width,
    height,
    document,
    camera: fitCamera(document.bounds, width, height, 0.08),
    hiddenLayers: new Set<string>(),
    background: '#f7f9fc',
    showGrid: false
  })
  return canvas.toDataURL('image/png')
}
