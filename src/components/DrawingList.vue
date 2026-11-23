<script setup lang="ts">
import type { StoredDrawing } from '../core/types'

defineProps<{
  drawings: StoredDrawing[]
  activeId: string | null
  busy: boolean
}>()

const emit = defineEmits<{
  import: []
  select: [id: string]
  remove: [id: string]
}>()

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<template>
  <div class="panel list-panel">
    <header class="panel-head">
      <div>
        <h2>图纸</h2>
        <p class="sub">本地保存 · {{ drawings.length }} 份</p>
      </div>
      <button class="primary small" type="button" :disabled="busy" @click="emit('import')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        导入
      </button>
    </header>

    <p v-if="busy" class="notice">正在解析图纸，请稍候…</p>

    <ul class="drawing-list">
      <li
        v-for="item in drawings"
        :key="item.id"
        :class="['drawing-item', { active: item.id === activeId }]"
      >
        <button class="drawing-main" type="button" @click="emit('select', item.id)">
          <div class="thumb">
            <img v-if="item.thumbnail" :src="item.thumbnail" :alt="`${item.name} 预览`" />
            <svg v-else viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
          </div>
          <div class="meta">
            <span class="name" :title="item.name">{{ item.name }}</span>
            <span class="tags">
              <span class="badge" :class="item.format">{{ item.format.toUpperCase() }}</span>
              <span>{{ formatSize(item.size) }}</span>
            </span>
            <span class="date">{{ formatDate(item.importedAt) }}</span>
          </div>
        </button>
        <button
          class="icon-button remove"
          type="button"
          :title="`移除 ${item.name}`"
          :aria-label="`移除 ${item.name}`"
          @click="emit('remove', item.id)"
        >
          <svg viewBox="0 0 24 24"><path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13M10 11v5M14 11v5" /></svg>
        </button>
      </li>
    </ul>

    <p v-if="!drawings.length && !busy" class="empty-list">
      还没有图纸。点击「导入」选择本地 DXF 或 DWG 文件。
    </p>
  </div>
</template>
