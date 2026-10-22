/**
 * 探测：XY 一次请求多张时，ComfyUI 的 WebSocket 会推几次 executed / progress？
 * 目的：看能不能「画完一张就先显示一张」。
 *   node probe-ws.mjs
 */
import { buildXyPrompt } from '../runui/src/xy.js'

const B = 'http://127.0.0.1:8189'
const CLIENT = 'tan-ws-' + Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1) 找一条干净的工作流（不含 runui 注入的 XY 节点）
const h = await (await fetch(B + '/history?max_items=20')).json()
let picked = null
for (const id of Object.keys(h)) {
  const nodes = h[id]?.prompt?.[2]
  if (!nodes) continue
  const cls = Object.values(nodes).map((n) => n.class_type)
  if (cls.some((c) => /^XY Input: /.test(c))) continue
  if (!cls.includes('KSampler')) continue
  picked = { id, nodes }
  break
}
if (!picked) throw new Error('没有干净的 KSampler 工作流')
console.log('用工作流', picked.id.slice(0, 8), '·', Object.keys(picked.nodes).length, '节点')

const nodes = picked.nodes
const samplerId = Object.keys(nodes).find((k) => nodes[k].class_type === 'KSampler')
// 找接进 positive 的文本节点
const encId = Object.keys(nodes).find(
  (k) => nodes[k].class_type === 'CLIPTextEncode' && Array.isArray(nodes[k].inputs?.clip)
)
const textNodeId = Object.keys(nodes).find((k) => nodes[k].class_type === 'CLIPTextEncode')
console.log('sampler', samplerId, '· text', textNodeId, '· enc', encId)

// history 里的数组 widget 要包成 __value__（跟 runui 提交时一样）
const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number'
for (const n of Object.values(nodes)) {
  for (const k of Object.keys(n.inputs || {})) {
    const v = n.inputs[k]
    if (Array.isArray(v) && !isLink(v)) n.inputs[k] = { __value__: v }
  }
}

const cfgOrig = nodes[samplerId].inputs?.cfg
const promptText = nodes[textNodeId]?.inputs?.text || 'a cat'

// 2) 构造 XY 版本：提示词 3 组（模拟「一组提示词」）
const { prompt } = buildXyPrompt(JSON.parse(JSON.stringify(nodes)), {
  samplerId,
  axis: '',
  values: [],
  promptNodeId: textNodeId,
  promptTexts: [
    `${promptText}, best quality`,
    'a dog, best quality',
    'a red apple',
  ],
})
console.log('XY 改造后', Object.keys(prompt).length, '节点 · 原 cfg', cfgOrig)

// 3) 连 WS
const ws = new WebSocket(`ws://127.0.0.1:8189/ws?clientId=${CLIENT}`)
const events = []
const t0 = Date.now()
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = () => rej(new Error('ws 连接失败'))
})
ws.onmessage = (ev) => {
  try {
    const m = JSON.parse(ev.data)
    const dt = Date.now() - t0
    if (m.type === 'executed') {
      const imgs = (m.data?.output?.images || []).map((i) => i.filename)
      events.push({ t: dt, type: 'executed', node: m.data?.node, n: imgs.length, imgs })
    } else if (['execution_start', 'execution_success', 'execution_error', 'execution_interrupted', 'execution_cached'].includes(m.type)) {
      events.push({ t: dt, type: m.type })
    } else if (m.type === 'progress') {
      events.push({ t: dt, type: 'progress', v: m.data?.value, max: m.data?.max, node: m.data?.node })
    }
  } catch {}
}

// 4) 提交
const r = await fetch(B + '/prompt', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt,
    client_id: CLIENT,
    extra_data: { extra_pnginfo: { workflow: {} } },
  }),
})
const j = await r.json()
if (!r.ok) throw new Error('提交失败 ' + JSON.stringify(j).slice(0, 300))
const pid = j.prompt_id
console.log('提交', pid)

// 5) 等完成
for (let i = 0; i < 120; i++) {
  await sleep(500)
  if (events.some((e) => ['execution_success', 'execution_error'].includes(e.type))) break
}
await sleep(1200)

console.log('\n=== 事件时间线 ===')
for (const e of events) {
  const extra = e.type === 'executed' ? `node=${e.node} 图=${e.n} ${e.imgs.join(',')}` : e.type === 'progress' ? `node=${e.node} ${e.v}/${e.max}` : ''
  console.log(`${String(e.t).padStart(6)}ms  ${e.type.padEnd(18)} ${extra}`)
}

const ex = events.filter((e) => e.type === 'executed')
console.log('\nexecuted 次数:', ex.length, '· 合计图数:', ex.reduce((a, b) => a + b.n, 0))

// 6) 清理
await fetch(B + '/history', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ delete: [pid] }),
}).catch(() => {})
const fs = await import('node:fs/promises')
const outDir = 'F:\\ai\\fastai\\output'
try {
  for (const f of await fs.readdir(outDir)) {
    if (ex.some((e) => e.imgs.includes(f))) await fs.unlink(outDir + '\\' + f).catch(() => {})
  }
  console.log('测试产物已清理')
} catch {}
ws.close()
