/**
 * 半径/夹角测量与对象拾取的 Node 端回归：不依赖 DOM，直接跑几何判定。
 * 覆盖：夹角计算、直线求交、平行判定、圆/弧拾取、直线拾取、单位格式化、真实图纸端到端。
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error'
})

const { angleAt, rayThrough, measurementDistance, measurementBearing, formatLength, withUnit } =
  await server.ssrLoadModule('/src/core/measure.ts')
const { pickCircle, pickLine, intersectLines, segmentOf, arcSweep } = await server.ssrLoadModule('/src/core/pick.ts')
const { boundsOfEntities } = await server.ssrLoadModule('/src/core/geometry.ts')
const { parseDxf } = await server.ssrLoadModule('/src/core/dxfLoader.ts')

let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps
const at = (x, y) => ({ x, y })
const seg = (ax, ay, bx, by) => ({ a: at(ax, ay), b: at(bx, by) })

const makeDoc = (entities) => ({
  id: 'pick-test',
  name: 'pick-test',
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
const opts = (extra = {}) => ({ radiusPx: 18, zoom: 1, ...extra })

// ---------- 夹角计算 ----------
check('直角 90°', near(angleAt(at(0, 0), at(10, 0), at(0, 10)), 90), `${angleAt(at(0, 0), at(10, 0), at(0, 10)).toFixed(2)}`)
check('锐角 45°', near(angleAt(at(0, 0), at(10, 0), at(10, 10)), 45), angleAt(at(0, 0), at(10, 0), at(10, 10)).toFixed(2))
check('钝角 135°', near(angleAt(at(0, 0), at(10, 0), at(-10, 10)), 135), angleAt(at(0, 0), at(10, 0), at(-10, 10)).toFixed(2))
check('同向退化 0°', near(angleAt(at(0, 0), at(10, 0), at(5, 0)), 0))
check('夹角恒在 [0,180]', angleAt(at(0, 0), at(-10, -10), at(10, 10)) <= 180.0001)

// ---------- 方向点选择 ----------
const far = rayThrough(at(0, 0), seg(-40, 0, 120, 0))
check('交点取较远端点作为方向点', near(far.x, 120), `x=${far.x}`)
const farNeg = rayThrough(at(0, 0), seg(60, 0, -90, 0))
check('方向点与线段方向无关（取远端）', near(farNeg.x, -90), `x=${farNeg.x}`)

// ---------- 直线求交 ----------
const cross = intersectLines(seg(0, 0, 10, 0), seg(5, -5, 5, 5))
check('正交直线交点正确', !!cross && near(cross.x, 5) && near(cross.y, 0), cross ? `(${cross.x},${cross.y})` : 'null')
const ext = intersectLines(seg(0, 0, 1, 0), seg(4, -1, 4, 1))
check('延长线相交也算有效', !!ext && near(ext.x, 4), ext ? `x=${ext.x}` : 'null')
check('平行直线返回 null', intersectLines(seg(0, 0, 10, 0), seg(0, 5, 10, 5)) === null)
check('共线重合返回 null', intersectLines(seg(0, 0, 10, 0), seg(5, 0, 15, 0)) === null)
check('零长度线段返回 null', intersectLines(seg(3, 3, 3, 3), seg(0, 0, 10, 0)) === null)
check(
  '平行判据与量纲无关（放大 1000 倍仍判平行）',
  intersectLines(seg(0, 0, 10000, 0), seg(0, 5000, 10000, 5000)) === null
)

// ---------- 圆 / 圆弧拾取 ----------
const circleDoc = makeDoc([
  { type: 'circle', layer: 'A', center: at(0, 0), radius: 100 },
  { type: 'circle', layer: 'B', center: at(0, 0), radius: 110 },
  { type: 'arc', layer: 'C', center: at(0, 0), radius: 60, startAngle: 0, endAngle: Math.PI / 2 }
])

const edge = pickCircle(circleDoc, at(100.4, 0), opts())
check('点中圆周即选中，最近点吸附到圆上', !!edge && near(edge.point.x, 100) && edge.distancePx < 0.5, edge ? `${edge.point.x.toFixed(2)} · ${edge.distancePx.toFixed(2)}px` : 'null')
check('同心圆取更近的那个', !!edge && near(edge.entity.radius, 100), edge ? `R=${edge.entity.radius}` : '')
check('点圆心不选中（径向距离超阈值）', pickCircle(circleDoc, at(0, 0), opts()) === null)
check('远离圆返回 null', pickCircle(circleDoc, at(400, 400), opts()) === null)
check('圆弧扫掠内命中', !!pickCircle(circleDoc, at(0, 60.5), opts()))

// 圆弧单独成图，避免同心圆干扰：扫掠范围外的点不该选中它
const arcOnly = makeDoc([{ type: 'arc', layer: 'C', center: at(0, 0), radius: 60, startAngle: 0, endAngle: Math.PI / 2 }])
check('圆弧扫掠外不误选', pickCircle(arcOnly, at(-60, 0), opts()) === null)
check('圆弧端点附近仍可选中（回退到端点距离）', !!pickCircle(arcOnly, at(0, 60.4), opts()))

const soloCircle = makeDoc([{ type: 'circle', layer: 'A', center: at(0, 0), radius: 100 }])
check('隐藏图层不参与拾取', pickCircle(soloCircle, at(100.2, 0), opts({ hiddenLayers: new Set(['A']) })) === null)
check('恢复显示后可拾取', !!pickCircle(soloCircle, at(100.2, 0), opts()))

// 同一世界偏移下，缩放越大屏幕距离越大：阈值按像素算的结果必须跟着变
check(
  '拾取阈值按屏幕像素换算（放大后同样的世界偏移就点不中了）',
  !!pickCircle(soloCircle, at(103, 0), opts({ radiusPx: 4, zoom: 1 })) &&
    pickCircle(soloCircle, at(103, 0), opts({ radiusPx: 4, zoom: 4 })) === null
)

// ---------- 直线拾取 ----------
const lineDoc = makeDoc([
  { type: 'line', layer: 'A', start: at(0, 0), end: at(100, 0) },
  { type: 'polyline', layer: 'A', points: [at(0, 20), at(50, 20), at(50, 60)], closed: false, bulges: [0, 0] }
])
const onLine = pickLine(lineDoc, at(40, 0.6), opts())
check('点中直线', !!onLine && near(onLine.point.y, 0), onLine ? `y=${onLine.point.y}` : 'null')
check('偏离直线不选中', pickLine(lineDoc, at(40, 25), opts()) === null)
check('多段线不参与夹角拾取', pickLine(lineDoc, at(25, 20.2), opts()) === null)
check('segmentOf 只接受直线', segmentOf(lineDoc.entities[0]) !== null && segmentOf(lineDoc.entities[1]) === null)

// ---------- 数值格式化 ----------
check('长度格式化：大数一位小数', formatLength(1234.56) === '1234.6', formatLength(1234.56))
check('长度格式化：中段两位', formatLength(12.345) === '12.35', formatLength(12.345))
check('长度格式化：小于 1 三位', formatLength(0.1234) === '0.123', formatLength(0.1234))
check('非法数值兜底', formatLength(Number.NaN) === '0' && formatLength(Infinity) === '0')
check('带单位格式化', withUnit(1234.56, 'mm') === '1234.6 mm', withUnit(1234.56, 'mm'))
check('单位未知时不臆造', withUnit(12.345, null) === '12.35', withUnit(12.345, null))

// ---------- 真实图纸端到端 ----------
const text = readFileSync('public/samples/demo.dxf', 'utf8')
const doc = parseDxf(text, 'demo.dxf', text.length, 'light')
check('DXF 单位解析为 mm', doc.units === 'mm', String(doc.units))

const circleEntity = doc.entities.find((e) => e.type === 'circle')
const probePoint = at(circleEntity.center.x + circleEntity.radius, circleEntity.center.y)
const realCircle = pickCircle(doc, probePoint, opts({ zoom: 1 }))
check(
  '真实图纸：圆拾取半径与图元一致',
  !!realCircle && realCircle.entity.radius === circleEntity.radius,
  realCircle ? `R=${realCircle.entity.radius}` : 'null'
)
check('真实图纸：拾取点落在圆周上', !!realCircle && near(Math.hypot(realCircle.point.x - circleEntity.center.x, realCircle.point.y - circleEntity.center.y), circleEntity.radius, 1e-6))

const lines = doc.entities.filter((e) => e.type === 'line')
let angleCase = null
for (let i = 0; i < lines.length && !angleCase; i++) {
  for (let j = i + 1; j < lines.length; j++) {
    const a = seg(lines[i].start.x, lines[i].start.y, lines[i].end.x, lines[i].end.y)
    const b = seg(lines[j].start.x, lines[j].start.y, lines[j].end.x, lines[j].end.y)
    const v = intersectLines(a, b)
    if (!v) continue
    const deg = angleAt(v, rayThrough(v, a), rayThrough(v, b))
    if (deg > 5 && deg < 175) {
      angleCase = { a, b, v, deg }
      break
    }
  }
}
if (angleCase) {
  // 用点积独立复算，避免和 angleAt 共用同一套实现
  const u1 = { x: angleCase.a.b.x - angleCase.a.a.x, y: angleCase.a.b.y - angleCase.a.a.y }
  const u2 = { x: angleCase.b.b.x - angleCase.b.a.x, y: angleCase.b.b.y - angleCase.b.a.y }
  const dot = Math.abs(u1.x * u2.x + u1.y * u2.y) / (Math.hypot(u1.x, u1.y) * Math.hypot(u2.x, u2.y))
  const expected = (Math.acos(Math.min(1, dot)) * 180) / Math.PI
  check('真实图纸：两线夹角与点积复算一致', Math.abs(angleCase.deg - expected) < 1e-6, `${angleCase.deg.toFixed(3)}° vs ${expected.toFixed(3)}°`)
  check('真实图纸：交点落在两条无限延长线上', near(
    (angleCase.v.x - angleCase.a.a.x) * (angleCase.a.b.y - angleCase.a.a.y) - (angleCase.v.y - angleCase.a.a.y) * (angleCase.a.b.x - angleCase.a.a.x),
    0,
    1e-6
  ))
} else {
  check('真实图纸：找到可测夹角的两条直线', false)
}

// ---------- 性能：大图纸里拾取的耗时 ----------
const many = []
for (let i = 0; i < 20000; i++) {
  many.push({ type: 'line', layer: 'A', start: at(i, 0), end: at(i, 100) })
}
for (let i = 0; i < 500; i++) {
  many.push({ type: 'circle', layer: 'A', center: at(i * 10, 50), radius: 5 })
}
const bigDoc = makeDoc(many)
const t0 = performance.now()
let hits = 0
for (let k = 0; k < 20; k++) {
  if (pickLine(bigDoc, at(100.5 + k, 50), opts({ zoom: 1 }))) hits++
  if (pickCircle(bigDoc, at(500 + k * 10, 50), opts({ zoom: 1 }))) hits++
}
const cost = (performance.now() - t0) / 40
check('大图纸（2 万线 + 500 圆）单次拾取 < 20ms', cost < 20, `${cost.toFixed(2)}ms/次，命中 ${hits}`)

await server.close()
console.log(failed === 0 ? '\n测量与拾取验证通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
