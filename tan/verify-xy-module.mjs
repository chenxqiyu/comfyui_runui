/**
 * 直接验证 runui 里的 src/xy.js（不经过 UI）：
 * 拿一个普通 KSampler 工作流 → buildXyPrompt → 提交 → 数图
 *   node verify-xy-module.mjs
 */
const COMFY = process.env.COMFY || 'http://127.0.0.1:8189'
const CKPT = process.env.CKPT || 'sd15\\chilloutmix_NiPrunedFp32Fix.safetensors'
const { buildXyPrompt, canXySampler, XY_AXIS_LABEL } = await import(
  'file:///F:/ai/onetest/runui/src/xy.js'
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const j = async (p) => (await fetch(COMFY + p)).json()

const plain = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: 'a photo of a cat on a table', clip: ['1', 1] } },
  3: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, lowres', clip: ['1', 1] } },
  4: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  5: {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0],
      seed: 4242,
      steps: 6,
      cfg: 7,
      sampler_name: 'euler',
      scheduler: 'normal',
      positive: ['2', 0],
      negative: ['3', 0],
      latent_image: ['4', 0],
      denoise: 1,
    },
  },
  6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
  7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'tan_mod' } },
}

console.log('支持扫描的参数:', Object.keys(XY_AXIS_LABEL).join(', '))
console.log('canXySampler(KSampler) =', JSON.stringify(canXySampler(plain, '5')))
console.log(
  'canXySampler(SaveImage) =',
  JSON.stringify(canXySampler(plain, '7'))
)

const { prompt, plotId, inputId, wasEfficient } = buildXyPrompt(plain, {
  samplerId: '5',
  axis: 'cfg',
  values: ['1', '3', '7'],
})
console.log('\n注入节点:', plotId, '(XY Plot) +', inputId, '(Manual XY Entry), wasEfficient =', wasEfficient)
console.log('KSampler 变成:', prompt['5'].class_type)
console.log('  vae_decode:', prompt['5'].inputs.vae_decode, '/ optional_vae:', JSON.stringify(prompt['5'].inputs.optional_vae), '/ script:', JSON.stringify(prompt['5'].inputs.script))
console.log('下游 VAEDecode samples:', JSON.stringify(prompt['6'].inputs.samples))

const t0 = Date.now()
const res = await fetch(COMFY + '/prompt', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt, client_id: 'tan-mod', extra_data: { extra_pnginfo: { workflow: {} } } }),
})
const body = await res.json()
console.log('\nPOST /prompt ->', res.status, JSON.stringify(body).slice(0, 200))
if (!body.prompt_id) process.exit(1)

for (;;) {
  await sleep(700)
  const h = await j('/history/' + body.prompt_id)
  const e = h[body.prompt_id]
  if (!e) {
    if (Date.now() - t0 > 180000) { console.log('超时'); process.exit(1) }
    continue
  }
  const outs = e.outputs || {}
  const imgs = Object.values(outs).flatMap((o) => o.images || [])
  const msgs = (e.status?.messages || []).filter((m) => m[0] === 'execution_error')
  if (msgs.length) console.log('ERROR:', JSON.stringify(msgs[0][1]).slice(0, 400))
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，output 节点出图 ${imgs.length} 张`)
  for (const im of imgs) console.log('  -', im.filename, im.type)
  console.log(imgs.filter((i) => i.type === 'output').length === 3 ? '\n✅ 模块逻辑正确' : '\n❌ 张数不对')

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
