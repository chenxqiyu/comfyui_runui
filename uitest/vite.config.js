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
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2000,
  },
})
