/**
 * 生产用法：node tools/serve.mjs
 * 把 dist/ 静态托管在 5187，并把 /comfy 反向代理到 ComfyUI（默认 127.0.0.1:8189），
 * 这样前端不需要 ComfyUI 开 CORS。
 *
 * 环境变量：PORT=5187  COMFY=http://127.0.0.1:8189
 */
import { createServer, request as httpRequest } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const PORT = Number(process.env.PORT || 5187)
const COMFY = new URL(process.env.COMFY || 'http://127.0.0.1:8189')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function proxy(req, res) {
  const target = req.url.replace(/^\/comfy/, '') || '/'
  // 保留浏览器原始的 Host：ComfyUI 要求 Host 与 Origin 的 host:port 一致，否则 403
  const headers = { ...req.headers }
  const upstream = httpRequest(
    {
      protocol: COMFY.protocol,
      hostname: COMFY.hostname,
      port: COMFY.port || 80,
      path: target,
      method: req.method,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers)
      up.pipe(res)
    }
  )
  upstream.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`代理失败：${err.message}\n检查 ComfyUI 是否在 ${COMFY.origin} 运行`)
  })
  req.pipe(upstream)
}

const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/comfy/')) return proxy(req, res)

    const urlPath = decodeURIComponent(req.url.split('?')[0])
    let filePath = join(DIST, normalize(urlPath).replace(/^([/\\])+/, ''))
    if (!filePath.startsWith(DIST.endsWith(sep) ? DIST : DIST + sep)) {
      filePath = join(DIST, 'index.html')
    }

    let info = await stat(filePath).catch(() => null)
    if (!info || info.isDirectory()) {
      filePath = join(DIST, 'index.html')
      info = await stat(filePath).catch(() => null)
    }
    if (!info) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('dist/ 不存在，先执行 npm run build')
      return
    }

    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    })
    createReadStream(filePath).pipe(res)
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(String(err))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`RunUI:  http://127.0.0.1:${PORT}`)
  console.log(`Proxy:  /comfy  ->  ${COMFY.origin}`)
})
