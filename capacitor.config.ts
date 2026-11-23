import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.cadmeasure.viewer',
  appName: 'CAD测量查看器',
  webDir: 'dist',
  server: {
    // 与 Capacitor 本地服务器同源，保证 fetch/IndexedDB/WASM 正常加载
    androidScheme: 'https'
  },
  android: {
    // 构建时允许通过 http 调试本地资源，不用于生产分发
    allowMixedContent: true
  }
}

export default config
