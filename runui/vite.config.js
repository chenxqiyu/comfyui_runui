import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { loraApi, ensureFastLoraFiles } from './tools/lora-speed.mjs'

// 极速模式要在本机搬文件，dev 模式下由这个中间件提供 /api/fastlora/*
function fastLoraApiPlugin() {
  return {
    name: 'runui-fastlora-api',
    async buildStart() {
      await ensureFastLoraFiles()
    },
    configureServer(server) {
      ensureFastLoraFiles()
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/fastlora')) return next()
        loraApi(req, res).catch((err) => {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }))
        })
      })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [vue(), fastLoraApiPlugin()],
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
