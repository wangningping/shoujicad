<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import DrawingList from './components/DrawingList.vue'
import InfoPanel from './components/InfoPanel.vue'
import LayersPanel from './components/LayersPanel.vue'
import Viewer from './components/Viewer.vue'
import { deleteDrawing, listDrawings, saveDrawing } from './core/db'
import { importFile } from './core/loader'
import { makeThumbnail } from './core/thumbnail'
import type { StoredDrawing } from './core/types'

type Drawer = 'none' | 'list' | 'layers' | 'info'

const drawings = ref<StoredDrawing[]>([])
const activeId = ref<string | null>(null)
const hiddenLayers = ref<Set<string>>(new Set())
const busy = ref(false)
const error = ref('')
const drawer = ref<Drawer>('none')
const fileInput = ref<HTMLInputElement | null>(null)

const active = computed(() => drawings.value.find((item) => item.id === activeId.value) ?? null)
const activeDocument = computed(() => active.value?.document ?? null)
const activeLayers = computed(() => active.value?.document.layers ?? [])

function closeDrawer(): void {
  drawer.value = 'none'
}

function openDrawer(name: Drawer): void {
  drawer.value = name
}

async function refresh(): Promise<void> {
  const items = await listDrawings()
  drawings.value = items.sort((a, b) => b.importedAt - a.importedAt)
  if (!items.some((item) => item.id === activeId.value)) {
    activeId.value = items[0]?.id ?? null
  }
}

async function processFile(file: File): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const buffer = await file.arrayBuffer()
    const document = await importFile(file, 'light')
    const record: StoredDrawing = {
      id: document.id,
      name: document.name,
      format: document.format,
      size: document.size,
      importedAt: document.importedAt,
      document,
      thumbnail: makeThumbnail(document)
    }
    await saveDrawing(record, buffer)
    await refresh()
    activeId.value = document.id
    hiddenLayers.value = new Set()
    closeDrawer()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

function pickFiles(): void {
  fileInput.value?.click()
}

async function onFiles(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  for (const file of files) await processFile(file)
}

async function selectDrawing(id: string): Promise<void> {
  activeId.value = id
  hiddenLayers.value = new Set()
  closeDrawer()
}

async function removeDrawing(id: string): Promise<void> {
  const target = drawings.value.find((item) => item.id === id)
  if (!target || !window.confirm(`从本地移除「${target.name}」？原始文件也会被删除，此操作不可撤销。`)) return
  await deleteDrawing(id)
  await refresh()
}

function toggleLayer(name: string): void {
  const next = new Set(hiddenLayers.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  hiddenLayers.value = next
}

function showAllLayers(): void {
  hiddenLayers.value = new Set()
}

async function loadSample(): Promise<void> {
  try {
    const response = await fetch('./samples/demo.dxf')
    if (!response.ok) throw new Error('找不到示例文件')
    const blob = await response.blob()
    await processFile(new File([blob], '示例图纸.dxf', { type: 'application/dxf' }))
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

onMounted(() => {
  void refresh()
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined)
  }
})
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <button class="brand-button" type="button" aria-label="打开图纸列表" @click="openDrawer('list')">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></svg>
        </button>
        <div class="top-title">
          <strong :title="active?.name">{{ active?.name ?? 'CAD 查看器' }}</strong>
          <span>{{ active ? `${active.format.toUpperCase()} · ${active.document.layers.length} 个图层` : '本地看图 · 图纸不上传' }}</span>
        </div>
      </div>
      <div class="top-actions">
        <button
          class="icon-button top-icon narrow-only"
          type="button"
          title="图纸信息"
          aria-label="图纸信息"
          @click="openDrawer('info')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
        </button>
        <button v-if="!drawings.length" class="ghost" type="button" :disabled="busy" @click="loadSample">加载示例</button>
        <button class="primary" type="button" :disabled="busy" @click="pickFiles">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 16v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" /></svg>
          导入
        </button>
      </div>
    </header>

    <main class="workspace">
      <aside class="left-dock">
        <DrawingList
          :drawings="drawings"
          :active-id="activeId"
          :busy="busy"
          @import="pickFiles"
          @select="selectDrawing"
          @remove="removeDrawing"
        />
      </aside>

      <Viewer
        :document="activeDocument"
        :hidden-layers="hiddenLayers"
        @open-layers="openDrawer('layers')"
      />

      <aside class="right-dock">
        <LayersPanel :layers="activeLayers" :hidden-layers="hiddenLayers" @toggle="toggleLayer" @show-all="showAllLayers" />
        <InfoPanel :document="activeDocument" />
      </aside>
    </main>

    <div v-if="drawer !== 'none'" class="overlay" @click="closeDrawer">
      <div class="drawer" @click.stop>
        <header class="drawer-head">
          <span>{{ drawer === 'list' ? '图纸' : drawer === 'layers' ? '图层' : '图纸信息' }}</span>
          <button class="icon-button" type="button" aria-label="关闭" @click="closeDrawer">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <div class="drawer-body">
          <DrawingList
            v-if="drawer === 'list'"
            :drawings="drawings"
            :active-id="activeId"
            :busy="busy"
            @import="pickFiles"
            @select="selectDrawing"
            @remove="removeDrawing"
          />
          <LayersPanel
            v-else-if="drawer === 'layers'"
            :layers="activeLayers"
            :hidden-layers="hiddenLayers"
            @toggle="toggleLayer"
            @show-all="showAllLayers"
          />
          <InfoPanel v-else :document="activeDocument" />
        </div>
      </div>
    </div>

    <input
      ref="fileInput"
      class="visually-hidden"
      type="file"
      accept=".dxf,.dwg"
      multiple
      @change="onFiles"
    />

    <div v-if="error" class="toast" role="alert">
      <span>{{ error }}</span>
      <button type="button" aria-label="关闭提示" @click="error = ''">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
  </div>
</template>
