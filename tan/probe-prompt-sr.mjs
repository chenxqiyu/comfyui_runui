/**
 * 验证：Efficiency 的「XY Input: Prompt S/R」能不能扫提示词
 * 普通 KSampler 工作流 + Prompt S/R(pos) → 一次请求出 1(原文) + N(替换值) 张
 *
 *   node probe-prompt-sr.mjs
 */
const COMFY = process.env.COMFY || 'http://127.0.0.1:8189'
const CKPT = process.env.CKPT || 'sd15\\chilloutmix_NiPrunedFp32Fix.safetensors'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const j = async (p) => (await fetch(COMFY + p)).json()

const isLink = (v) =>
  Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number')

const BASE_TEXT = 'a cat sitting on a wooden table'
const REPLACES = ['a dog sitting on a wooden table', 'a red apple; on a table', '一只猫坐在木桌上']

function build(nodes, samplerId, { target, search, replaces }) {
  const out = structuredClone(nodes)
  const node = out[samplerId]
  const inputs = {}
  for (const [k, v] of Object.entries(node.inputs || {})) {
    if (['add_noise', 'start_at_step', 'end_at_step', 'return_with_leftover_noise'].includes(k)) continue
    if (k === 'noise_seed') { inputs.seed = v; continue }
    inputs[k] = v
  }
  inputs.preview_method = 'none'
  inputs.vae_decode = 'true'
  const consumer = Object.values(out).find(
    (n) => n.class_type === 'VAEDecode' && isLink(n.inputs?.samples) && String(n.inputs.samples[0]) === String(samplerId)
  )
  if (consumer && isLink(consumer.inputs?.vae)) inputs.optional_vae = consumer.inputs.vae
  node.class_type = 'KSampler (Efficient)'
  node.inputs = inputs
  for (const n of Object.values(out)) {
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (isLink(v) && String(v[0]) === String(samplerId) && Number(v[1]) === 0) n.inputs[k] = [String(samplerId), 3]
    }
  }

  // XY Input: Prompt S/R（replace_1..N 是独立输入，文本里带分号/中文都不怕）
  const srInputs = { target_prompt: target, search_txt: search, replace_count: replaces.length }
  for (let i = 0; i < 50; i++) srInputs[`replace_${i + 1}`] = replaces[i] || ''
  out['90'] = { class_type: 'XY Input: Prompt S/R', inputs: srInputs }
  out['91'] = {
    class_type: 'XY Plot',
    inputs: {
      grid_spacing: 0,
      XY_flip: 'False',
      Y_label_orientation: 'Horizontal',
      cache_models: 'True',
      ksampler_output_image: 'Images',
      X: ['90', 0],
    },
  }
  out[samplerId].inputs.script = ['91', 0]
  return out
}

const plain = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: BASE_TEXT, clip: ['1', 1] } },
  3: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, lowres', clip: ['1', 1] } },
  4: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  5: {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0], seed: 888, steps: 6, cfg: 7, sampler_name: 'euler', scheduler: 'normal',
      positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], denoise: 1,
    },
  },
  6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
  7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'tan_sr' } },
}

const prompt = build(plain, '5', { target: 'positive', search: BASE_TEXT, replaces: REPLACES })
console.log('Prompt S/R 节点:', JSON.stringify(prompt['90'].inputs).slice(0, 260))
console.log('期望张数: 1(原文) +', REPLACES.length, '=', REPLACES.length + 1)

const t0 = Date.now()
const res = await fetch(COMFY + '/prompt', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt, client_id: 'tan-sr', extra_data: { extra_pnginfo: { workflow: {} } } }),
})
const body = await res.json()
console.log('POST /prompt ->', res.status, JSON.stringify(body).slice(0, 200))
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
  console.log(outs.length >= REPLACES.length + 1 ? '\n✅ Prompt S/R 可用（含 1 张原文）' : '\n❌ 张数不对')

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
