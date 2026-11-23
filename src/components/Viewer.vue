<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createCamera, fitCamera, panByScreen, rotateAt, screenToWorld, zoomAt, worldToScreen, type Camera } from '../core/camera'
import {
  angleAt,
  rayThrough,
  renderMeasurements,
  type ActiveEndpoint,
  type AngleGeometry,
  type MeasureKind,
  type Measurement,
  type RadiusGeometry,
  type Segment
} from '../core/measure'
import { arcSweep, intersectLines, pickCircle, pickLine, segmentOf, type PickHit } from '../core/pick'
import { renderScene } from '../core/render'
import { findSnap, getSnapIndex, renderSnapIndicator, type SnapHit, type SnapKind } from '../core/snap'
import type { Point2 } from '../core/types'
import type { CadDocument } from '../core/types'

const props = defineProps<{
  document: CadDocument | null
  hiddenLayers: Set<string>
}>()

const emit = defineEmits<{
  'open-layers': []
}>()

const host = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const camera = ref<Camera>(createCamera())
const fitZoom = ref(1)
const cssWidth = ref(1)
const cssHeight = ref(1)

let ctx: CanvasRenderingContext2D | null = null
let resizeObserver: ResizeObserver | null = null
let frame = 0

const pointers = new Map<number, Point2>()
let lastPan: Point2 | null = null
let pinch: { distance: number; angle: number; center: Point2 } | null = null
let tapStart: Point2 | null = null
let tapMoved = false
let nextMeasureId = 1
let noticeTimer = 0

/** 半径/夹角的「按住对象」手势：按下命中对象时接管，不参与平移 */
interface PickGesture {
  pointerId: number
  kind: 'radius' | 'angle'
  press: Point2
}
let pickGesture: PickGesture | null = null

/** 端点拖拽的吸附半径与释放半径（屏幕像素）：两者不同才有滞回，避免指尖在阈值边缘抖动。 */
const SNAP_RADIUS = 14
const SNAP_ESCAPE = 20
/** 手指按下后需要移动多少像素才认为开始拖动，过滤轻触抖动 */
const DRAG_DEADZONE = 4
/** 手指离端点多近算按中手柄 */
const HANDLE_HIT_RADIUS = 20
/** 半径/夹角选择对象的拾取半径（屏幕像素）：比端点吸附略宽，便于点中细线 */
const PICK_RADIUS = 18

interface DragState {
  pointerId: number
  id: number
  which: 'start' | 'end'
  /** 按下时端点所在位置，用于抑制“吸附回自身” */
  anchor: Point2
  press: Point2
  locked: SnapHit | null
  moved: boolean
  /** 手指是否已经离开锚点的捕捉圈；离开前原锚点不参与吸附 */
  escaped: boolean
}

let dragState: DragState | null = null

const measureMode = ref<MeasureKind | null>(null)
/** 关闭测量后再次点工具按钮时回到的上一把工具 */
const lastMeasureKind = ref<MeasureKind>('distance')
const measurements = ref<Measurement[]>([])
const pendingPoint = ref<Point2 | null>(null)
const pendingKind = ref<SnapKind | null>(null)
/** 夹角：已选中的第一条线及其实体下标（下标用于识别「又点了同一条线」） */
const pendingLine = ref<Segment | null>(null)
const pendingLineIndex = ref<number | null>(null)
/** 半径/夹角的实时预览：按住对象期间随手指更新，松手才落定 */
const previewRadius = ref<RadiusGeometry | null>(null)
const previewAngle = ref<AngleGeometry | null>(null)
/** 夹角：手指正压着的线，还没落定为「已选」 */
const hoverSegment = ref<Segment | null>(null)
/** 无效选择的即时提示 */
const notice = ref('')
const nightMode = ref(false)
const moreOpen = ref(false)
const moreButton = ref<HTMLElement | null>(null)
const moreMenu = ref<HTMLElement | null>(null)
const activeEndpoint = ref<ActiveEndpoint | null>(null)
const snapHit = ref<SnapHit | null>(null)

const background = computed(() => (nightMode.value ? '#18222f' : '#f7f9fc'))
const zoomPercent = computed(() => Math.max(1, Math.round((camera.value.zoom / fitZoom.value) * 100)))
const rotationDeg = computed(() => Math.round(((camera.value.rotation * 180) / Math.PI) % 360))

const MEASURE_LABEL: Record<MeasureKind, string> = { distance: '测距', radius: '半径', angle: '夹角' }
const measureTools: Array<{ kind: MeasureKind; label: string }> = [
  { kind: 'distance', label: '测距' },
  { kind: 'radius', label: '半径' },
  { kind: 'angle', label: '夹角' }
]
/** 当前工具：关闭状态显示「上一把」，点一下就回到它 */
const measureKind = computed(() => measureMode.value ?? lastMeasureKind.value)
const measureLabel = computed(() => MEASURE_LABEL[measureKind.value])
const unitLabel = computed(() => props.document?.units ?? null)
const measureHint = computed(() => {
  if (!measureMode.value) return '单指平移 · 双指缩放旋转'
  if (measureMode.value === 'radius') return '轻点圆或圆弧测半径'
  if (measureMode.value === 'angle') return pendingLine.value ? '再点另一条直线' : '依次点选两条直线'
  return activeEndpoint.value ? '拖动端点 · 自动吸附几何点' : '轻点两点测距 · 按住端点可拖动'
})

function scheduleRender(): void {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    if (!ctx || !props.document) return
    renderScene({
      ctx,
      width: cssWidth.value,
      height: cssHeight.value,
      document: props.document,
      camera: camera.value,
      hiddenLayers: props.hiddenLayers,
      background: background.value,
      dark: nightMode.value
    })
    renderMeasurements(
      ctx,
      camera.value,
      cssWidth.value,
      cssHeight.value,
      measurements.value,
      {
        pendingPoint: pendingPoint.value,
        pendingKind: pendingKind.value,
        active: activeEndpoint.value,
        previewRadius: previewRadius.value,
        previewAngle: previewAngle.value,
        pendingLine: pendingLine.value,
        hoverSegment: hoverSegment.value
      },
      nightMode.value,
      unitLabel.value
    )
    renderSnapIndicator(ctx, camera.value, cssWidth.value, cssHeight.value, snapHit.value, nightMode.value)
  })
}

function resize(): void {
  if (!host.value || !canvas.value) return
  const rect = host.value.getBoundingClientRect()
  cssWidth.value = Math.max(1, rect.width)
  cssHeight.value = Math.max(1, rect.height)
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.value.width = Math.round(cssWidth.value * dpr)
  canvas.value.height = Math.round(cssHeight.value * dpr)
  canvas.value.style.width = `${cssWidth.value}px`
  canvas.value.style.height = `${cssHeight.value}px`
  ctx = canvas.value.getContext('2d')
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  scheduleRender()
}

function fit(): void {
  if (!props.document) return
  const next = fitCamera(props.document.bounds, cssWidth.value, cssHeight.value)
  fitZoom.value = next.zoom
  camera.value = next
  scheduleRender()
}

function zoomBy(factor: number): void {
  camera.value = zoomAt(
    camera.value,
    cssWidth.value,
    cssHeight.value,
    { x: cssWidth.value / 2, y: cssHeight.value / 2 },
    factor
  )
  scheduleRender()
}

function rotateBy(degrees: number): void {
  camera.value = rotateAt(
    camera.value,
    cssWidth.value,
    cssHeight.value,
    { x: cssWidth.value / 2, y: cssHeight.value / 2 },
    (degrees * Math.PI) / 180
  )
  scheduleRender()
}

function clearPendingPick(): void {
  pendingLine.value = null
  pendingLineIndex.value = null
  previewRadius.value = null
  previewAngle.value = null
  hoverSegment.value = null
}

/** 切换测量工具（距离 / 半径 / 夹角），同时清掉未落定的中间状态。 */
function setMeasureMode(kind: MeasureKind | null): void {
  measureMode.value = kind
  if (kind) lastMeasureKind.value = kind
  pendingPoint.value = null
  pendingKind.value = null
  clearPendingPick()
  cancelEndpointDrag()
  snapHit.value = null
  notice.value = ''
  tapStart = null
  tapMoved = false
  scheduleRender()
}

function toggleMeasure(): void {
  setMeasureMode(measureMode.value ? null : lastMeasureKind.value)
}

/** 从「更多」浮层里选工具：选完直接进入，浮层收起，接下来就是点图纸。 */
function chooseMeasureTool(kind: MeasureKind): void {
  moreOpen.value = false
  setMeasureMode(kind)
}

function showNotice(text: string): void {
  notice.value = text
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, 2600)
}

function toggleNight(): void {
  nightMode.value = !nightMode.value
}

function toggleMore(): void {
  moreOpen.value = !moreOpen.value
}

/** 回正：旋转始终绕视口中心，因此只需把角度归零，缩放与中心保持不变。 */
function resetRotation(): void {
  if (camera.value.rotation === 0) return
  camera.value = { ...camera.value, rotation: 0 }
  scheduleRender()
}

/** 点空白处收起浮层；点在按钮或浮层内部时保留，避免误收。 */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!moreOpen.value) return
  const target = event.target as Node | null
  if (target && (moreButton.value?.contains(target) || moreMenu.value?.contains(target))) return
  moreOpen.value = false
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') moreOpen.value = false
}

function clearMeasurements(): void {
  measurements.value = []
  pendingPoint.value = null
  pendingKind.value = null
  clearPendingPick()
  cancelEndpointDrag()
  snapHit.value = null
  notice.value = ''
  scheduleRender()
}

/** 统一的吸附查询：半径按屏幕像素给定，缩放到任何比例手感一致。 */
function snapAt(world: Point2, locked: SnapHit | null = null, suppress: Point2 | null = null): SnapHit | null {
  if (!props.document) return null
  return findSnap(getSnapIndex(props.document), world, {
    radius: SNAP_RADIUS,
    zoom: camera.value.zoom,
    hiddenLayers: props.hiddenLayers,
    locked,
    escapeRadius: SNAP_ESCAPE,
    suppress,
    suppressRadius: 2
  })
}

function toScreen(p: Point2): Point2 {
  return worldToScreen(camera.value, cssWidth.value, cssHeight.value, p)
}

/** 屏幕坐标处拾取对象：半径只认圆/圆弧，夹角只认直线。 */
function pickAt(screen: Point2, kind: 'radius' | 'angle'): PickHit | null {
  if (!props.document) return null
  const world = screenToWorld(camera.value, cssWidth.value, cssHeight.value, screen)
  const options = { radiusPx: PICK_RADIUS, zoom: camera.value.zoom, hiddenLayers: props.hiddenLayers }
  return kind === 'radius'
    ? pickCircle(props.document, world, options)
    : pickLine(props.document, world, options)
}

function radiusGeometry(hit: PickHit): RadiusGeometry | null {
  const entity = hit.entity
  if (entity.type !== 'circle' && entity.type !== 'arc') return null
  if (!Number.isFinite(entity.radius) || entity.radius <= 0) return null
  return {
    center: { ...entity.center },
    radius: entity.radius,
    at: { ...hit.point },
    sweep:
      entity.type === 'arc'
        ? { start: entity.startAngle, sweep: arcSweep(entity.startAngle, entity.endAngle) }
        : undefined
  }
}

/** 实时预览：命中就给出结果，未命中清空——松手时才决定是落定还是提示无效。 */
function applyPreview(hit: PickHit | null): void {
  if (!hit) {
    previewRadius.value = null
    previewAngle.value = null
    hoverSegment.value = null
    scheduleRender()
    return
  }
  if (measureMode.value === 'radius') {
    previewRadius.value = radiusGeometry(hit)
    previewAngle.value = null
    hoverSegment.value = null
  } else {
    previewRadius.value = null
    const seg = segmentOf(hit.entity)
    if (!seg) return
    if (pendingLine.value) {
      const vertex = intersectLines(pendingLine.value, seg)
      hoverSegment.value = null
      previewAngle.value = vertex
        ? {
            vertex,
            a: rayThrough(vertex, pendingLine.value),
            b: rayThrough(vertex, seg),
            lineA: pendingLine.value,
            lineB: seg
          }
        : null
    } else {
      previewAngle.value = null
      hoverSegment.value = seg
    }
  }
  scheduleRender()
}

function commitRadius(hit: PickHit): void {
  const geom = radiusGeometry(hit)
  previewRadius.value = null
  if (!geom) {
    showNotice('这个对象没有有效半径')
    scheduleRender()
    return
  }
  measurements.value = [...measurements.value, { kind: 'radius', id: nextMeasureId++, ...geom }]
  // 成功落定即撤销之前的无效提示，否则提示会压在新结果上
  notice.value = ''
  scheduleRender()
}

/** 夹角：第一次点选记下一条线，第二次点选求交并落定。 */
function commitAngle(hit: PickHit): void {
  const seg = segmentOf(hit.entity)
  hoverSegment.value = null
  previewAngle.value = null
  if (!seg) {
    showNotice('请点选直线')
    scheduleRender()
    return
  }
  const first = pendingLine.value
  if (!first || pendingLineIndex.value === null) {
    pendingLine.value = seg
    pendingLineIndex.value = hit.index
    scheduleRender()
    return
  }
  if (pendingLineIndex.value === hit.index) {
    showNotice('这条线已选中，请点另一条')
    scheduleRender()
    return
  }
  const vertex = intersectLines(first, seg)
  if (!vertex) {
    showNotice('两条直线平行或重合，没有夹角')
    scheduleRender()
    return
  }
  const a = rayThrough(vertex, first)
  const b = rayThrough(vertex, seg)
  if (angleAt(vertex, a, b) < 0.05) {
    showNotice('夹角约为 0°，请确认不是同一条线')
    scheduleRender()
    return
  }
  measurements.value = [
    ...measurements.value,
    { kind: 'angle', id: nextMeasureId++, vertex, a, b, lineA: { ...first }, lineB: seg }
  ]
  notice.value = ''
  pendingLine.value = null
  pendingLineIndex.value = null
  scheduleRender()
}

/** 命中已有测量端点，返回最近的一个；用于判断这次按下是拖端点还是平移图纸。 */
function hitTestEndpoint(screen: Point2): ActiveEndpoint | null {
  let best: ActiveEndpoint | null = null
  let bestDist = HANDLE_HIT_RADIUS
  for (const item of measurements.value) {
    // 半径与夹角没有可拖动的端点，只有距离测量参与手柄命中
    if (item.kind !== 'distance') continue
    const a = toScreen(item.start)
    const da = Math.hypot(a.x - screen.x, a.y - screen.y)
    if (da <= bestDist) {
      bestDist = da
      best = { id: item.id, which: 'start' }
    }
    const b = toScreen(item.end)
    const db = Math.hypot(b.x - screen.x, b.y - screen.y)
    if (db < bestDist) {
      bestDist = db
      best = { id: item.id, which: 'end' }
    }
  }
  return best
}

function endpointOf(id: number, which: 'start' | 'end'): Point2 | null {
  const item = measurements.value.find((m) => m.id === id)
  if (!item || item.kind !== 'distance') return null
  return item[which]
}

function updateEndpoint(id: number, which: 'start' | 'end', point: Point2, kind: SnapKind | null): void {
  measurements.value = measurements.value.map((item) => {
    if (item.id !== id || item.kind !== 'distance') return item
    return which === 'start'
      ? { ...item, start: point, startKind: kind ?? undefined }
      : { ...item, end: point, endKind: kind ?? undefined }
  })
}

function cancelEndpointDrag(): void {
  dragState = null
  activeEndpoint.value = null
}

function beginEndpointDrag(event: PointerEvent, target: ActiveEndpoint, screen: Point2): void {
  const anchor = endpointOf(target.id, target.which)
  if (!anchor) return
  dragState = {
    pointerId: event.pointerId,
    id: target.id,
    which: target.which,
    anchor: { ...anchor },
    press: { ...screen },
    locked: null,
    moved: false,
    escaped: false
  }
  activeEndpoint.value = target
  snapHit.value = null
  pointers.clear()
  lastPan = null
  pinch = null
  tapStart = null
  tapMoved = false
  scheduleRender()
}

/** 拖动端点的每一次移动：先试吸附，命中就贴到几何点，否则跟随手指。返回是否消费了该事件。 */
function moveEndpointDrag(event: PointerEvent): boolean {
  if (!dragState || event.pointerId !== dragState.pointerId) return false
  const screen = localPoint(event)
  const travel = Math.hypot(screen.x - dragState.press.x, screen.y - dragState.press.y)
  if (!dragState.moved && travel < DRAG_DEADZONE) return true
  dragState.moved = true

  const world = screenToWorld(camera.value, cssWidth.value, cssHeight.value, screen)
  // 手指还没离开原锚点的捕捉圈时，原锚点不参与吸附：否则端点会被自己“粘住”拖不动
  const anchorScreen = toScreen(dragState.anchor)
  if (!dragState.escaped && Math.hypot(anchorScreen.x - screen.x, anchorScreen.y - screen.y) > SNAP_RADIUS) {
    dragState.escaped = true
  }
  const suppress = dragState.escaped ? null : dragState.anchor
  let hit = snapAt(world, dragState.locked, suppress)

  // 拖到另一端点会得到零长度测量，这种吸附没有意义
  if (hit) {
    const other = endpointOf(dragState.id, dragState.which === 'start' ? 'end' : 'start')
    if (other) {
      const a = toScreen(hit.point)
      const b = toScreen(other)
      if (Math.hypot(a.x - b.x, a.y - b.y) < 2) hit = null
    }
  }

  dragState.locked = hit
  updateEndpoint(dragState.id, dragState.which, hit ? hit.point : world, hit?.kind ?? null)
  snapHit.value = hit
  scheduleRender()
  return true
}

function addMeasurePoint(screen: Point2): void {
  if (measureMode.value !== 'distance') return
  const world = screenToWorld(camera.value, cssWidth.value, cssHeight.value, screen)
  const hit = snapAt(world)
  const point = hit ? hit.point : world
  if (!pendingPoint.value) {
    pendingPoint.value = point
    pendingKind.value = hit?.kind ?? null
    scheduleRender()
    return
  }
  // 两个落点几乎重合多半是误触或重复点了同一个吸附点，忽略这次
  const a = toScreen(pendingPoint.value)
  const b = toScreen(point)
  if (Math.hypot(a.x - b.x, a.y - b.y) < DRAG_DEADZONE) return
  measurements.value = [
    ...measurements.value,
    {
      kind: 'distance',
      id: nextMeasureId++,
      start: pendingPoint.value,
      end: point,
      startKind: pendingKind.value ?? undefined,
      endKind: hit?.kind
    }
  ]
  pendingPoint.value = null
  pendingKind.value = null
  notice.value = ''
  scheduleRender()
}

function measurePointers(): { distance: number; angle: number; center: Point2 } | null {
  const values = [...pointers.values()]
  if (values.length < 2) return null
  const [a, b] = values
  return {
    distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
    angle: Math.atan2(b.y - a.y, b.x - a.x),
    center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }
}

function localPoint(event: PointerEvent): Point2 {
  const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function onPointerDown(event: PointerEvent): void {
  if (!props.document) return
  // 拖端点期间不接受第二根手指，避免拖动与双指手势互相打架
  if (dragState) return
  const point = localPoint(event)
  if (measureMode.value && pointers.size === 0) {
    const target = hitTestEndpoint(point)
    if (target) {
      try {
        ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
      } catch {
        // 合成事件或已释放的指针无需捕获
      }
      beginEndpointDrag(event, target, point)
      return
    }
  }
  // 半径/夹角：按在对象上就进入「按住预览」手势，不参与平移
  if ((measureMode.value === 'radius' || measureMode.value === 'angle') && pointers.size === 0 && !pickGesture) {
    const hit = pickAt(point, measureMode.value)
    if (hit) {
      try {
        ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
      } catch {
        // 合成事件或已释放的指针无需捕获
      }
      pickGesture = { pointerId: event.pointerId, kind: measureMode.value, press: point }
      applyPreview(hit)
      return
    }
  }
  try {
    ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
  } catch {
    // 合成事件或已释放的指针无需捕获
  }
  pointers.set(event.pointerId, point)
  lastPan = pointers.size === 1 ? { ...point } : null
  if (pointers.size === 1) {
    tapStart = { ...point }
    tapMoved = false
  } else {
    tapStart = null
    tapMoved = true
  }
  pinch = measurePointers()
}

function onPointerMove(event: PointerEvent): void {
  if (dragState) {
    moveEndpointDrag(event)
    return
  }
  if (pickGesture) {
    if (event.pointerId !== pickGesture.pointerId) return
    const hit = pickAt(localPoint(event), pickGesture.kind)
    if (hit) applyPreview(hit)
    return
  }
  // 桌面端鼠标悬停即可预览，不必先按下
  if (!pointers.size && event.pointerType === 'mouse' && (measureMode.value === 'radius' || measureMode.value === 'angle')) {
    applyPreview(pickAt(localPoint(event), measureMode.value))
    return
  }
  if (!pointers.has(event.pointerId)) return
  const current = localPoint(event)
  pointers.set(event.pointerId, current)
  if (tapStart && pointers.size === 1 && Math.hypot(current.x - tapStart.x, current.y - tapStart.y) > 8) {
    tapMoved = true
  }

  if (pointers.size === 1 && lastPan) {
    camera.value = panByScreen(camera.value, current.x - lastPan.x, current.y - lastPan.y)
    lastPan = { ...current }
  } else if (pointers.size >= 2) {
    tapStart = null
    const next = measurePointers()
    if (pinch && next) {
      camera.value = zoomAt(camera.value, cssWidth.value, cssHeight.value, pinch.center, next.distance / pinch.distance)
      let delta = next.angle - pinch.angle
      while (delta > Math.PI) delta -= Math.PI * 2
      while (delta < -Math.PI) delta += Math.PI * 2
      camera.value = rotateAt(camera.value, cssWidth.value, cssHeight.value, next.center, delta)
      camera.value = panByScreen(camera.value, next.center.x - pinch.center.x, next.center.y - pinch.center.y)
    }
    pinch = next
    lastPan = null
  }
  scheduleRender()
}

function onPointerEnd(event: PointerEvent): void {
  if (pickGesture) {
    if (event.pointerId !== pickGesture.pointerId) return
    const kind = pickGesture.kind
    pickGesture = null
    const hit = pickAt(localPoint(event), kind)
    if (!hit) {
      previewRadius.value = null
      previewAngle.value = null
      hoverSegment.value = null
      showNotice(kind === 'radius' ? '没点中圆或圆弧，请对准线条再点' : '没点中直线，请对准线条再点')
      scheduleRender()
      return
    }
    if (kind === 'radius') commitRadius(hit)
    else commitAngle(hit)
    return
  }
  if (dragState) {
    if (event.pointerId !== dragState.pointerId) return
    // 轻点手柄不产生位移，视为一次普通落点操作，避免“想拖但没拖动”丢点
    const wasTap = !dragState.moved && measureMode.value
    cancelEndpointDrag()
    snapHit.value = null
    if (wasTap) addMeasurePoint(localPoint(event))
    scheduleRender()
    return
  }
  const isTap = measureMode.value && pointers.size === 1 && !!tapStart && !tapMoved
  const tapPoint = isTap ? localPoint(event) : null
  pointers.delete(event.pointerId)
  pinch = measurePointers()
  const remaining = [...pointers.values()]
  lastPan = remaining.length === 1 ? { ...remaining[0] } : null
  if (!remaining.length) {
    tapStart = null
    tapMoved = false
  }
  if (tapPoint) {
    if (measureMode.value === 'distance') addMeasurePoint(tapPoint)
    else if (measureMode.value === 'radius') showNotice('没点中圆或圆弧，请对准线条再点')
    else if (measureMode.value === 'angle') showNotice('没点中直线，请对准线条再点')
  }
}

function onWheel(event: WheelEvent): void {
  if (!props.document) return
  event.preventDefault()
  const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  camera.value = zoomAt(
    camera.value,
    cssWidth.value,
    cssHeight.value,
    { x: event.clientX - rect.left, y: event.clientY - rect.top },
    Math.exp(-event.deltaY * 0.0015)
  )
  scheduleRender()
}

let warmToken = 0
watch(
  () => props.document?.id,
  async () => {
    clearMeasurements()
    await nextTick()
    resize()
    fit()
    warmSnapIndex()
  }
)

/** 图纸加载后利用空闲时间建好捕捉索引，首次拖端点不会卡一下。 */
function warmSnapIndex(): void {
  const doc = props.document
  if (!doc) return
  const token = ++warmToken
  const run = (): void => {
    if (token !== warmToken) return
    getSnapIndex(doc)
  }
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 1200 })
  } else {
    window.setTimeout(run, 120)
  }
}

watch(() => props.hiddenLayers, scheduleRender, { deep: false })
watch(
  [measureMode, pendingPoint, measurements, nightMode, previewRadius, previewAngle, pendingLine, hoverSegment],
  scheduleRender
)

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    resize()
  })
  if (host.value) resizeObserver.observe(host.value)
  resize()
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('keydown', onDocumentKeydown)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  if (frame) cancelAnimationFrame(frame)
  if (noticeTimer) window.clearTimeout(noticeTimer)
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  document.removeEventListener('keydown', onDocumentKeydown)
})

defineExpose({ fit, zoomBy, rotateBy })
</script>

<template>
  <section ref="host" class="viewer">
    <canvas
      v-show="props.document"
      ref="canvas"
      class="canvas"
      :class="{ measuring: measureMode }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerEnd"
      @pointercancel="onPointerEnd"
      @wheel="onWheel"
    />

    <div v-if="!props.document" class="empty">
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <rect x="7" y="7" width="34" height="34" rx="4" fill="none" stroke="currentColor" stroke-width="2" />
        <path d="M7 18h34M7 29h34M18 7v34M29 7v34" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".5" />
      </svg>
      <p>选择或导入 DXF / DWG 图纸开始查看</p>
    </div>

    <div v-if="props.document" class="drawing-caption" :class="{ dark: nightMode }">
      <span class="format-tag">{{ props.document.format.toUpperCase() }}</span>
      <span class="caption-name" :title="props.document.name">{{ props.document.name }}</span>
    </div>

    <div
      v-if="props.document"
      class="toolbar-dock"
      :class="{ dark: nightMode, measuring: measureMode }"
      role="toolbar"
      aria-label="看图工具"
    >
      <button type="button" title="放大" aria-label="放大" @click="zoomBy(1.25)">
        <svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M10.5 7.5v6M7.5 10.5h6M15.5 15.5 21 21" /></svg>
        <span>放大</span>
      </button>
      <button type="button" title="缩小" aria-label="缩小" @click="zoomBy(0.8)">
        <svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M7.5 10.5h6M15.5 15.5 21 21" /></svg>
        <span>缩小</span>
      </button>
      <button type="button" title="全图显示" aria-label="全图显示" @click="fit">
        <svg viewBox="0 0 24 24"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></svg>
        <span>全图</span>
      </button>
      <span class="dock-sep" aria-hidden="true" />
      <button
        type="button"
        :class="{ active: measureMode }"
        :title="measureMode ? `退出${measureLabel}` : `${measureLabel}：轻点图纸选择`"
        :aria-label="measureLabel"
        :aria-pressed="measureMode !== null"
        @click="toggleMeasure"
      >
        <svg v-if="measureKind === 'radius'" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="8" />
          <path d="M12 12h8" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
        </svg>
        <svg v-else-if="measureKind === 'angle'" viewBox="0 0 24 24">
          <path d="M4 19h16M4 19 16 5" />
          <path d="M13.4 19a8.4 8.4 0 0 0-2.5-5.7" opacity=".55" />
        </svg>
        <svg v-else viewBox="0 0 24 24"><path d="M3 8h18v8H3zM7 8v4M11 8v3M15 8v4M19 8v3" /></svg>
        <span>{{ measureLabel }}</span>
      </button>
      <button class="dock-layers" type="button" title="图层" aria-label="图层" @click="emit('open-layers')">
        <svg viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5 9-5Zm9 9-9 5-9-5M21 16l-9 5-9-5" /></svg>
        <span>图层</span>
      </button>
      <button
        ref="moreButton"
        class="dock-more"
        type="button"
        title="更多工具"
        aria-label="更多工具"
        aria-haspopup="menu"
        :aria-expanded="moreOpen"
        :class="{ active: moreOpen }"
        @click="toggleMore"
      >
        <svg viewBox="0 0 24 24"><path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="2.6" /></svg>
        <span>更多</span>
      </button>

      <div
        v-if="moreOpen && props.document"
        ref="moreMenu"
        class="dock-menu"
        :class="{ dark: nightMode }"
        role="menu"
        aria-label="更多工具"
      >
        <div class="menu-seg" role="group" aria-label="测量工具">
          <button
            v-for="tool in measureTools"
            :key="tool.kind"
            type="button"
            :class="{ on: measureKind === tool.kind }"
            :aria-pressed="measureKind === tool.kind"
            @click="chooseMeasureTool(tool.kind)"
          >
            {{ tool.label }}
          </button>
        </div>
        <span class="menu-sep" aria-hidden="true" />
        <button type="button" role="menuitem" @click="rotateBy(-15)">
          <svg viewBox="0 0 24 24"><path d="M4 10a8 8 0 1 1 1.7 7M4 5v5h5" /></svg>
          <span>左转 15°</span>
          <em v-if="rotationDeg !== 0">{{ rotationDeg }}°</em>
        </button>
        <button type="button" role="menuitem" @click="rotateBy(15)">
          <svg viewBox="0 0 24 24"><path d="M20 10a8 8 0 1 0-1.7 7M20 5v5h-5" /></svg>
          <span>右转 15°</span>
        </button>
        <button type="button" role="menuitem" :disabled="camera.rotation === 0" @click="resetRotation">
          <svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-3.2-6.4M20 4v4.5h-4.5" /></svg>
          <span>回正 0°</span>
        </button>
        <span class="menu-sep" aria-hidden="true" />
        <button
          type="button"
          role="menuitemcheckbox"
          :aria-checked="nightMode"
          :class="{ 'is-on': nightMode }"
          @click="toggleNight"
        >
          <svg v-if="nightMode" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
          <svg v-else viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z" /></svg>
          <span>夜间画布</span>
          <em v-if="nightMode">已开</em>
        </button>
      </div>
    </div>

    <div v-if="props.document" class="status" :class="{ dark: nightMode }">
      <span>{{ zoomPercent }}%</span>
      <i />
      <span>{{ rotationDeg }}°</span>
      <template v-if="measurements.length">
        <i />
        <button class="status-clear" type="button" title="清除全部测量" aria-label="清除全部测量" @click="clearMeasurements">
          <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
          {{ measurements.length }} 项
        </button>
      </template>
      <template v-if="measureMode">
        <i />
        <span class="status-unit">{{ unitLabel ?? '单位未标注' }}</span>
      </template>
      <span class="hint">{{ measureHint }}</span>
    </div>

    <div v-if="notice" class="pick-notice" :class="{ dark: nightMode }" role="status">{{ notice }}</div>
  </section>
</template>
