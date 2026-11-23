import { createServer } from 'vite'

const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error'
})

const { buildSnapIndex, findSnap, SNAP_LABEL } = await server.ssrLoadModule('/src/core/snap.ts')
const { boundsOfEntities } = await server.ssrLoadModule('/src/core/geometry.ts')
const { parseDxf } = await server.ssrLoadModule('/src/core/dxfLoader.ts')

let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

const at = (x, y) => ({ x, y })
const makeDoc = (entities) => ({
  id: 'snap-test',
  name: 'snap-test',
  format: 'dxf',
  size: 0,
  importedAt: 0,
  version: 'AC1015',
  layers: [],
  entities,
  bounds: boundsOfEntities(entities),
  entityCounts: {},
  unsupported: {}
})
const queryAt = (index, p, extra = {}) =>
  findSnap(index, p, { radius: 14, zoom: 1, hiddenLayers: new Set(), ...extra })

const cross = makeDoc([
  { type: 'line', layer: '0', start: at(0, 0), end: at(100, 0) },
  { type: 'line', layer: '0', start: at(50, -50), end: at(50, 50) }
])
const crossIndex = buildSnapIndex(cross)
const kinds = new Set(crossIndex.points.map((p) => p.kind))
check('索引含端点/中点', kinds.has('endpoint') && kinds.has('midpoint'), `${crossIndex.points.length} 个候选点`)

const endpointHit = queryAt(crossIndex, at(1, 1))
check(
  '端点优先于近点',
  endpointHit && endpointHit.kind === 'endpoint' && endpointHit.point.x === 0 && endpointHit.point.y === 0,
  endpointHit ? `${SNAP_LABEL[endpointHit.kind]} (${endpointHit.point.x},${endpointHit.point.y})` : '未命中'
)

const crossHit = queryAt(crossIndex, at(49, 1))
check(
  '交点可捕捉且优先于中点',
  crossHit && crossHit.kind === 'intersection' && Math.abs(crossHit.point.x - 50) < 1e-6 && Math.abs(crossHit.point.y) < 1e-6,
  crossHit ? `${SNAP_LABEL[crossHit.kind]} (${crossHit.point.x},${crossHit.point.y})` : '未命中'
)

const nearestHit = queryAt(crossIndex, at(30, 1))
check(
  '线上近点可捕捉',
  nearestHit && nearestHit.kind === 'nearest' && Math.abs(nearestHit.point.y) < 1e-9 && Math.abs(nearestHit.point.x - 30) < 1e-9,
  nearestHit ? `${SNAP_LABEL[nearestHit.kind]} (${nearestHit.point.x},${nearestHit.point.y})` : '未命中'
)

check('无候选时自由拖动', queryAt(crossIndex, at(30, 40)) === null)

const circleIndex = buildSnapIndex(makeDoc([{ type: 'circle', layer: 'A', center: at(0, 0), radius: 80 }]))
const centerHit = queryAt(circleIndex, at(0.5, 0.5))
check('圆心可捕捉', !!centerHit && centerHit.kind === 'center', centerHit ? SNAP_LABEL[centerHit.kind] : '未命中')
check('抑制锚点后不吸回自身', queryAt(circleIndex, at(0.5, 0.5), { suppress: at(0, 0), suppressRadius: 2 }) === null)

const locked = centerHit
const lockedHit = queryAt(circleIndex, at(12, 12), { locked, escapeRadius: 20 })
const releasedHit = queryAt(circleIndex, at(30, 30), { locked, escapeRadius: 20 })
check(
  '释放半径内锁定不抖动',
  lockedHit && lockedHit.kind === 'center' && (releasedHit === null || releasedHit.kind !== 'center'),
  `锁定 ${lockedHit ? lockedHit.kind : 'null'} · 释放 ${releasedHit ? releasedHit.kind : 'null'}`
)
check('隐藏图层不参与捕捉', queryAt(circleIndex, at(0.5, 0.5), { hiddenLayers: new Set(['A']) }) === null)

// 锁定接管：低优先级“近点”锁定时，贴着顶点应能切到“交点/端点”
const lockedNearest = queryAt(crossIndex, at(30, 0.4))
const takeover = queryAt(crossIndex, at(49, 1), { locked: lockedNearest, escapeRadius: 20 })
check(
  '更高优先级候选近距离可接管锁定',
  lockedNearest && lockedNearest.kind === 'nearest' && takeover && takeover.kind === 'intersection',
  `锁定 ${lockedNearest ? SNAP_LABEL[lockedNearest.kind] : 'null'} → ${takeover ? SNAP_LABEL[takeover.kind] : 'null'}`
)

// 同优先级不来回抢：两端点等距时保持锁定
const tieDoc = buildSnapIndex(
  makeDoc([
    { type: 'line', layer: '0', start: at(0, 0), end: at(0, 20) },
    { type: 'line', layer: '0', start: at(6, 0), end: at(6, 20) }
  ])
)
const tieLocked = queryAt(tieDoc, at(0.5, 0.5))
const tieKept = queryAt(tieDoc, at(3, 1), { locked: tieLocked, escapeRadius: 20 })
check(
  '同优先级等距时不确定态保持锁定',
  tieLocked && tieLocked.kind === 'endpoint' && tieKept && tieKept.kind === 'endpoint' && tieKept.point.x === tieLocked.point.x,
  `锁定 x=${tieLocked ? tieLocked.point.x : '-'} → x=${tieKept ? tieKept.point.x : '-'}`
)

// 圆弧端点 / 椭圆象限
const arcIndex = buildSnapIndex(
  makeDoc([{ type: 'arc', layer: '0', center: at(0, 0), radius: 50, startAngle: 0, endAngle: Math.PI }])
)
const arcEnd = queryAt(arcIndex, at(49.5, 0.6))
check('圆弧端点可捕捉', !!arcEnd && arcEnd.kind === 'endpoint' && Math.abs(arcEnd.point.x - 50) < 1e-6, arcEnd ? `${SNAP_LABEL[arcEnd.kind]} (${arcEnd.point.x.toFixed(2)},${arcEnd.point.y.toFixed(2)})` : '未命中')

// 缩放无关：同样 14px 半径，zoom 放大 100 倍后世界半径应缩小
const zoomedHit = findSnap(crossIndex, at(0.02, 0.02), { radius: 14, zoom: 100, hiddenLayers: new Set() })
check('捕捉半径按屏幕像素换算', !!zoomedHit && zoomedHit.kind === 'endpoint', zoomedHit ? SNAP_LABEL[zoomedHit.kind] : '未命中')

// 真实图纸性能
const { readFileSync } = await import('node:fs')
const text = readFileSync('public/samples/demo.dxf', 'utf8')
const doc = parseDxf(text, 'demo.dxf', text.length, 'light')
let t0 = performance.now()
const demoIndex = buildSnapIndex(doc)
const buildMs = performance.now() - t0
t0 = performance.now()
let hits = 0
for (let i = 0; i < 200; i++) {
  if (findSnap(demoIndex, at(doc.bounds.minX + i, doc.bounds.minY + i), { radius: 14, zoom: 1, hiddenLayers: new Set() })) hits++
}
const queryMs = (performance.now() - t0) / 200
check('真实图纸索引构建', demoIndex.points.length > 20, `${demoIndex.points.length} 点 / ${demoIndex.segments.length} 段 / ${buildMs.toFixed(1)}ms`)
check('单次捕捉查询耗时', queryMs < 2, `${queryMs.toFixed(3)}ms（命中 ${hits}/200）`)

// 大规模合成图纸：5 万段
const bigEntities = []
for (let i = 0; i < 25000; i++) {
  bigEntities.push({
    type: 'line',
    layer: '0',
    start: { x: (i % 500) * 2, y: Math.floor(i / 500) * 2 },
    end: { x: (i % 500) * 2 + 1.6, y: Math.floor(i / 500) * 2 + 1.6 }
  })
}
const big = makeDoc(bigEntities)
t0 = performance.now()
const bigIndex = buildSnapIndex(big)
const bigBuild = performance.now() - t0
t0 = performance.now()
for (let i = 0; i < 200; i++) {
  findSnap(bigIndex, at(300 + i * 0.05, 40), { radius: 14, zoom: 1, hiddenLayers: new Set() })
}
const bigQuery = (performance.now() - t0) / 200
check('2.5 万线大规模索引', bigIndex.points.length > 50000, `${bigIndex.points.length} 点 / ${bigBuild.toFixed(0)}ms`)
check('大规模单次查询耗时', bigQuery < 3, `${bigQuery.toFixed(3)}ms`)

await server.close()
if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n捕捉逻辑验证通过')
