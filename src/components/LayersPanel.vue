<script setup lang="ts">
import type { CadLayer } from '../core/types'

defineProps<{
  layers: CadLayer[]
  hiddenLayers: Set<string>
}>()

const emit = defineEmits<{
  toggle: [name: string]
  'show-all': []
}>()
</script>

<template>
  <div class="panel side-panel">
    <header class="panel-head compact">
      <div>
        <h2>图层</h2>
        <p class="sub">{{ layers.length }} 个图层</p>
      </div>
      <button class="text-button" type="button" @click="emit('show-all')">全部显示</button>
    </header>

    <ul class="layer-list">
      <li v-for="layer in layers" :key="layer.name">
        <button
          type="button"
          class="layer-row"
          :aria-pressed="!hiddenLayers.has(layer.name)"
          @click="emit('toggle', layer.name)"
        >
          <span class="eye">
            <svg v-if="!hiddenLayers.has(layer.name)" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" />
              <circle cx="12" cy="12" r="2.5" />
            </svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 3l18 18M10.6 6.2A10.9 10.9 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.6M6.3 8.1C3.7 9.8 2 12 2 12s3.6 6 10 6c1.4 0 2.7-.2 3.8-.7" />
            </svg>
          </span>
          <span class="swatch" :style="{ background: layer.color }" />
          <span class="layer-name" :title="layer.name">{{ layer.name }}</span>
          <span class="count">{{ layer.entityCount }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
