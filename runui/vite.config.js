import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: './',
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5187,
    open: false,
    // dev 模式下把 /comfy 转发到 ComfyUI，免去 CORS 麻烦
    // 注意：必须保留浏览器原始的 Host（changeOrigin: false）。
    // ComfyUI 有一层 origin 校验：Host 与 Origin 的 host:port 必须一致，否则 403。
    // 浏览器发的是 127.0.0.1:5187，Origin 也是 127.0.0.1:5187，两者对得上。
    proxy: {
      '/comfy': {
        target: 'http://127.0.0.1:8189',
        changeOrigin: false,
        rewrite: (p) => p.replace(/^\/comfy/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    // 本机有安全删除拦截，vite 自动清空 dist 会失败，关掉；要干净重建先手动删 dist
    emptyOutDir: false,
    chunkSizeWarningLimit: 2000,
  },
})
