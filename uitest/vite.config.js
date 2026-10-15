import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // 相对路径，构建产物可以放在任意目录/子路径下托管
  base: './',
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5188,
    open: false,
    // dev 模式下把相似度接口转发给 python server.py
    proxy: {
      '/api': 'http://127.0.0.1:5199',
    },
  },
  build: {
    outDir: 'dist',
    // 本机存在安全删除拦截（genie-safe-delete），vite 自动清空 dist 会失败，
    // 因此关闭自动清空；需要干净重建时先手动删除 dist 目录即可。
    emptyOutDir: false,
    chunkSizeWarningLimit: 2000,
  },
})
