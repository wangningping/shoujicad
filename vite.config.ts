import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  plugins: [vue()],
  // WASM glue 通过 new URL('libredwg-web.wasm', import.meta.url) 定位资源，
  // 预打包会改写 import.meta.url，开发环境必须排除该依赖。
  optimizeDeps: {
    exclude: ['@mlightcad/libredwg-web']
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200
  }
})
