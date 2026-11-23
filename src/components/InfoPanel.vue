<script setup lang="ts">
import { computed } from 'vue'
import type { CadDocument } from '../core/types'

const props = defineProps<{ document: CadDocument | null }>()

const entityLabels: Record<string, string> = {
  line: '直线',
  polyline: '多段线',
  circle: '圆',
  arc: '圆弧',
  ellipse: '椭圆',
  text: '文字',
  point: '点',
  solid: '填充/实体'
}

const total = computed(() => props.document?.entities.length ?? 0)
const width = computed(() => {
  const b = props.document?.bounds
  return b ? Math.max(0, b.maxX - b.minX) : 0
})
const height = computed(() => {
  const b = props.document?.bounds
  return b ? Math.max(0, b.maxY - b.minY) : 0
})
const formatNumber = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)
const formatSize = (bytes: number) => (bytes / 1024).toFixed(1) + ' KB'
</script>

<template>
  <div class="panel side-panel">
    <header class="panel-head compact">
      <div>
        <h2>图纸信息</h2>
        <p class="sub">只读 · 不修改源文件</p>
      </div>
    </header>

    <div v-if="!document" class="empty-info">选择一份图纸查看基本信息。</div>

    <template v-else>
      <div class="info-file">
        <span class="badge" :class="document.format">{{ document.format.toUpperCase() }}</span>
        <strong :title="document.name">{{ document.name }}</strong>
      </div>

      <dl class="info-grid">
        <div><dt>版本</dt><dd>{{ document.version || '—' }}</dd></div>
        <div><dt>文件大小</dt><dd>{{ formatSize(document.size) }}</dd></div>
        <div><dt>导入时间</dt><dd>{{ new Date(document.importedAt).toLocaleString('zh-CN') }}</dd></div>
        <div><dt>图元总数</dt><dd>{{ formatNumber(total) }}</dd></div>
        <div><dt>图层数</dt><dd>{{ document.layers.length }}</dd></div>
        <div><dt>图形范围</dt><dd>{{ formatNumber(width) }} × {{ formatNumber(height) }}</dd></div>
      </dl>

      <h3 class="section-title">图元构成</h3>
      <ul class="stat-list">
        <li v-for="(count, type) in document.entityCounts" :key="type">
          <span>{{ entityLabels[type] ?? type }}</span>
          <span>{{ formatNumber(count) }}</span>
        </li>
      </ul>

      <template v-if="Object.keys(document.unsupported).length">
        <h3 class="section-title">未显示的图元</h3>
        <ul class="stat-list muted">
          <li v-for="(count, type) in document.unsupported" :key="type">
            <span>{{ type }}</span>
            <span>{{ formatNumber(count) }}</span>
          </li>
        </ul>
        <p class="note">基础版本仅渲染常见二维图元；其余类型保留在源文件中，不会被修改。</p>
      </template>
    </template>
  </div>
</template>
