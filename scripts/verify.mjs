import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const DxfParser = require('dxf-parser')

const samplePath = resolve(root, 'public/samples/demo.dxf')
const text = readFileSync(samplePath, 'utf8')
const dxf = new DxfParser().parse(text)

const layers = Object.keys(dxf.tables?.layer?.layers ?? {})
const entities = dxf.entities ?? []
const blocks = Object.keys(dxf.blocks ?? {})
const types = entities.reduce((acc, e) => {
  acc[e.type] = (acc[e.type] ?? 0) + 1
  return acc
}, {})

const checks = [
  ['DXF 版本可读', String(dxf.header?.$ACADVER ?? '').startsWith('AC1')],
  ['图层表非空', layers.length >= 5],
  ['模型空间有图元', entities.length >= 10],
  ['包含 LINE', (types.LINE ?? 0) >= 6],
  ['包含 CIRCLE / ARC', (types.CIRCLE ?? 0) >= 2 && (types.ARC ?? 0) >= 1],
  ['包含 LWPOLYLINE', (types.LWPOLYLINE ?? 0) >= 1],
  ['包含 TEXT / MTEXT', (types.TEXT ?? 0) >= 2 && (types.MTEXT ?? 0) >= 1],
  ['包含 INSERT 块', (types.INSERT ?? 0) >= 1 && blocks.includes('DOOR')]
]

let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failed++
}

console.log(`\n样例: ${samplePath}`)
console.log(`图层: ${layers.join(', ')}`)
console.log(`图元: ${JSON.stringify(types)}`)

const assetsDir = resolve(root, 'dist/assets')
const wasmFiles = existsSync(assetsDir)
  ? readdirSync(assetsDir).filter((name) => name.endsWith('.wasm'))
  : []
if (wasmFiles.length) {
  for (const name of wasmFiles) {
    console.log(`构建产物 WASM: ${name} — ${(statSync(resolve(assetsDir, name)).size / 1024 / 1024).toFixed(2)} MB`)
  }
} else {
  console.log('构建产物 WASM: 尚未构建（运行 npm run build 后检查）')
}

if (failed) {
  console.error(`\n${failed} 项检查失败`)
  process.exit(1)
}
console.log('\n基础解析验证通过')
