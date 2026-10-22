/**
 * 把 ComfyUI 的 /object_info 存成本地 JSON，方便反复查节点签名（不用每次等 15 秒）
 *   node dump-object-info.mjs
 */
import fs from 'node:fs/promises'

const COMFY = process.env.COMFY || 'http://127.0.0.1:8189'
const t0 = Date.now()
const res = await fetch(COMFY + '/object_info')
const info = await res.json()
const out = new URL('./object_info.json', import.meta.url)
await fs.writeFile(out, JSON.stringify(info))
const names = Object.keys(info)
console.log(`节点类 ${names.length} 个，耗时 ${Date.now() - t0}ms`)
console.log('已写入', out.pathname)
