/**
 * 验证：核心节点 ConditioningCombine 能不能让「一次采样出多张」（每个 prompt 一张）
 * 原理：positive 里塞 N 个同 area 的 conditioning，ComfyUI 会把它们 cat 成 batch 一起采样。
 *
 *   node probe-cond-batch.mjs
 */
const COMFY = process.env.COMFY || 'http://127.0.0.1:8189'
const CKPT = process.env.CKPT || 'sd15\\chilloutmix_NiPrunedFp32Fix.safetensors'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const j = async (p) => (await fetch(COMFY + p)).json()

const TEXTS = [
  'a cat sitting on a wooden table',
  'a dog sitting on a wooden table',
  'a red apple on a wooden table',
]

/** 给一个「CLIPTextEncode 当 positive」的工作流套上 batch：复制 N-1 份 + 链式 Combine */
function buildBatch(nodes, { textNodeId, texts }) {
  const out = structuredClone(nodes)
  const src = out[textNodeId]
  if (!src) throw new Error('找不到文本节点')
  const clip = src.inputs.clip
  if (!clip) throw new Error('文本节点没有 clip 输入')

  // 找最大 id 往后排
  let max = 0
  for (const k of Object.keys(out)) {
    const n = Number(k)
    if (Number.isFinite(n) && n > max) max = n
  }
  let next = max + 1

  // 第一个用原节点（改成第一个值），其余复制
  src.inputs.text = texts[0]
  const encIds = [String(textNodeId)]
  for (let i = 1; i < texts.length; i++) {
    const id = String(next++)
    out[id] = {
      class_type: src.class_type,
      inputs: { ...JSON.parse(JSON.stringify(src.inputs)), text: texts[i] },
    }
    encIds.push(id)
  }

  // 链式 Combine：((c1+c2)+c3)...
  let merged = [encIds[0], 0]
  for (let i = 1; i < encIds.length; i++) {
    const id = String(next++)
    out[id] = {
      class_type: 'ConditioningCombine',
      inputs: { conditioning_1: merged, conditioning_2: [encIds[i], 0] },
    }
    merged = [id, 0]
  }

  // 所有原来消费原文本节点输出的地方，改接链头
  for (const n of Object.values(out)) {
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (Array.isArray(v) && v.length === 2 && String(v[0]) === String(textNodeId) && Number(v[1]) === 0) {
        if (n.class_type === 'ConditioningCombine' && k === 'conditioning_1') continue
        if (String(n.class_type) === src.class_type && v !== src.inputs.clip) {
          // 复制出来的节点自己也引用原节点？跳过
        }
        n.inputs[k] = merged
      }
    }
  }
  return out
}

const plain = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: TEXTS[0], clip: ['1', 1] } },
  3: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, lowres', clip: ['1', 1] } },
  4: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  5: {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0], seed: 999, steps: 6, cfg: 7, sampler_name: 'euler', scheduler: 'normal',
      positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], denoise: 1,
    },
  },
  6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
  7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'tan_cond' } },
}

const prompt = buildBatch(plain, { textNodeId: '2', texts: TEXTS })
console.log('KSampler.positive ->', JSON.stringify(prompt['5'].inputs.positive))
console.log('新增节点:', Object.keys(prompt).filter((k) => !(k in plain)).length, '个')
console.log('期望张数:', TEXTS.length)

const t0 = Date.now()
const res = await fetch(COMFY + '/prompt', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt, client_id: 'tan-cond', extra_data: { extra_pnginfo: { workflow: {} } } }),
})
const body = await res.json()
console.log('POST /prompt ->', res.status, JSON.stringify(body).slice(0, 300))
if (!body.prompt_id) process.exit(1)

for (;;) {
  await sleep(700)
  const h = await j('/history/' + body.prompt_id)
  const e = h[body.prompt_id]
  if (!e) {
    if (Date.now() - t0 > 240000) { console.log('超时'); process.exit(1) }
    continue
  }
  const errs = (e.status?.messages || []).filter((m) => m[0] === 'execution_error')
  if (errs.length) console.log('ERROR:', JSON.stringify(errs[0][1]).slice(0, 500))
  const imgs = Object.values(e.outputs || {}).flatMap((o) => o.images || [])
  const outs = imgs.filter((i) => i.type === 'output')
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，单图 ${outs.length} 张`)
  for (const im of outs) console.log('  -', im.filename)
  console.log(outs.length === TEXTS.length ? '\n✅ ConditioningCombine 能一次出 N 张' : '\n❌ 张数不对（' + outs.length + '）')

  await fetch(COMFY + '/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delete: [body.prompt_id] }),
  })
  const fs = await import('node:fs/promises')
  for (const im of imgs) {
    const dir = im.type === 'temp' ? 'temp' : 'output'
    await fs.unlink(`F:\\ai\\fastai\\${dir}\\` + (im.subfolder ? im.subfolder + '\\' : '') + im.filename).catch(() => {})
  }
  break
}
