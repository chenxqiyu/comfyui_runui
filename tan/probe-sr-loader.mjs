/**
 * 第三条路：把 CheckpointLoaderSimple 换成 Efficiency 的 `Efficient Loader`（它有 DEPENDENCIES 输出），
 * 这样 XY Plot 的 dependencies 能连上，Prompt S/R 才真正生效。
 * 预期：一次请求出 3 张（提示词1 原文 + 2 个替换值）
 *
 *   node probe-sr-loader.mjs
 */
const COMFY = process.env.COMFY || 'http://127.0.0.1:8189'
const CKPT = process.env.CKPT || 'sd15\\chilloutmix_NiPrunedFp32Fix.safetensors'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const j = async (p) => (await fetch(COMFY + p)).json()
const isLink = (v) =>
  Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number')

const P = ['a cat sitting on a wooden table', 'a dog sitting on a wooden table', 'a red apple on a wooden table']

function build(nodes, { loaderId, samplerId, textNodeId, texts }) {
  const out = structuredClone(nodes)

  // 1) Loader 换成 Efficient Loader，并把 CLIP/VAE 的槽位改过去
  const old = out[loaderId]
  out[loaderId] = {
    class_type: 'Efficient Loader',
    inputs: {
      ckpt_name: old.inputs.ckpt_name,
      vae_name: 'Baked VAE',
      clip_skip: -1,
      lora_name: 'None',
      lora_model_strength: 1,
      lora_clip_strength: 1,
      positive: texts[0],
      negative: 'blurry, lowres',
      token_normalization: 'none',
      weight_interpretation: 'comfy',
      empty_latent_width: 512,
      empty_latent_height: 512,
      batch_size: 1,
    },
  }
  for (const n of Object.values(out)) {
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (!isLink(v) || String(v[0]) !== String(loaderId)) continue
      if (Number(v[1]) === 1) n.inputs[k] = [String(loaderId), 5] // CLIP
      if (Number(v[1]) === 2) n.inputs[k] = [String(loaderId), 4] // VAE
    }
  }

  // 2) 采样节点 → KSampler (Efficient)
  const node = out[samplerId]
  const inputs = {}
  for (const [k, v] of Object.entries(node.inputs || {})) {
    if (['add_noise', 'start_at_step', 'end_at_step', 'return_with_leftover_noise'].includes(k)) continue
    if (k === 'noise_seed') { inputs.seed = v; continue }
    inputs[k] = v
  }
  inputs.preview_method = 'none'
  inputs.vae_decode = 'true'
  inputs.optional_vae = [String(loaderId), 4]
  node.class_type = 'KSampler (Efficient)'
  node.inputs = inputs
  for (const n of Object.values(out)) {
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (isLink(v) && String(v[0]) === String(samplerId) && Number(v[1]) === 0) {
        n.inputs[k] = [String(samplerId), 3]
      }
    }
  }

  // 3) 文本节点写第一个提示词；其余交给 Prompt S/R（第一项 None = 不改，正好等于第一个提示词）
  out[textNodeId].inputs.text = texts[0]
  const sr = { target_prompt: 'positive', search_txt: texts[0], replace_count: texts.length - 1 }
  for (let i = 0; i < 50; i++) sr[`replace_${i + 1}`] = texts[i + 1] || ''
  out['90'] = { class_type: 'XY Input: Prompt S/R', inputs: sr }
  out['91'] = {
    class_type: 'XY Plot',
    inputs: {
      grid_spacing: 0,
      XY_flip: 'False',
      Y_label_orientation: 'Horizontal',
      cache_models: 'True',
      ksampler_output_image: 'Images',
      dependencies: [String(loaderId), 6],
      X: ['90', 0],
    },
  }
  out['92'] = {
    class_type: 'XY Input: Manual XY Entry',
    inputs: { plot_type: 'CFG Scale', plot_value: '5;7;9' },
  }
  out['91'].inputs.Y = ['92', 0]
  out[samplerId].inputs.script = ['91', 0]
  return out
}

const plain = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: P[0], clip: ['1', 1] } },
  3: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, lowres', clip: ['1', 1] } },
  4: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  5: {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0], seed: 555, steps: 6, cfg: 7, sampler_name: 'euler', scheduler: 'normal',
      positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], denoise: 1,
    },
  },
  6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
  7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'tan_srl' } },
}

const prompt = build(plain, { loaderId: '1', samplerId: '5', textNodeId: '2', texts: P })
console.log('Loader.clip 引用:', JSON.stringify(prompt['2'].inputs.clip), '(应为 [1,5])')
console.log('VAEDecode.vae :', JSON.stringify(prompt['6'].inputs.vae), '(应为 [1,4])')
console.log('XY Plot deps  :', JSON.stringify(prompt['91'].inputs.dependencies))
console.log('Prompt S/R    :', JSON.stringify(prompt['90'].inputs).slice(0, 240))
console.log('期望张数: 3 提示词 × 3 cfg = 9')

const t0 = Date.now()
const res = await fetch(COMFY + '/prompt', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt, client_id: 'tan-srl', extra_data: { extra_pnginfo: { workflow: {} } } }),
})
const body = await res.json()
console.log('POST /prompt ->', res.status, JSON.stringify(body).slice(0, 250))
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
  if (errs.length) console.log('ERROR:', JSON.stringify(errs[0][1]).slice(0, 600))
  const imgs = Object.values(e.outputs || {}).flatMap((o) => o.images || [])
  const outs = imgs.filter((i) => i.type === 'output')
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，单图 ${outs.length} 张`)
  for (const im of outs) console.log('  -', im.filename)
  console.log(outs.length === 9 ? '\n✅ 换 Efficient Loader + Prompt S/R 可以一次出 N 张' : '\n❌ 张数不对')

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
