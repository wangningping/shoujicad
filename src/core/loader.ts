import type { CanvasMode } from './aci'
import { parseDxf } from './dxfLoader'
import { parseDwg } from './dwgLoader'
import type { CadDocument, CadFormat } from './types'

export class ImportError extends Error {}

function detectFormat(file: File): CadFormat | null {
  const ext = file.name.split('.').pop()?.toLowerCase()
  if (ext === 'dxf' || ext === 'dwg') return ext
  return null
}

/** 国内工程 DXF 常见 GBK/GB18030 编码；先按 UTF-8 解，出现替换字符时回退。 */
function decodeDxf(buffer: ArrayBuffer): string {
  const utf8 = new TextDecoder('utf-8').decode(buffer)
  if (!utf8.includes('\uFFFD')) return utf8
  return new TextDecoder('gb18030').decode(buffer)
}

export async function importFile(file: File, mode: CanvasMode): Promise<CadDocument> {
  const format = detectFormat(file)
  if (!format) throw new ImportError('仅支持 .dxf 与 .dwg 文件')

  const buffer = await file.arrayBuffer()
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

  let document: CadDocument
  try {
    document = format === 'dxf'
      ? parseDxf(decodeDxf(buffer), file.name, file.size, mode)
      : await parseDwg(buffer, file.name, file.size, mode)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ImportError(`解析失败：${detail}`)
  }

  document.id = id
  if (!document.entities.length) {
    throw new ImportError('文件已读取，但未找到可显示的二维图元')
  }
  return document
}
