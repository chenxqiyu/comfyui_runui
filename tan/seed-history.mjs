/**
 * 往 ComfyUI 里塞一条「普通 KSampler 工作流」的执行记录，供 runui 读取/UI 验证
 *   node seed-history.mjs            提交并等待完成
 *   node seed-history.mjs --clean    只清理（按 filename_prefix=tan_seed 找）
 */
const COMFY = process.env.COMFY || 'http://127.0.0.1:8189'
const CKPT = process.env.CKPT || 'sd15\\chilloutmix_NiPrunedFp32Fix.safetensors'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const j = async (p) => (await fetch(COMFY + p)).json()

if (process.argv.includes('--clean')) {
  const h = await j('/history?max_items=20')
  let n = 0
  for (const [pid, e] of Object.entries(h)) {
    const imgs = Object.values(e.outputs || {}).flatMap((o) => o.images || [])
    if (!imgs.some((i) => /tan_seed/.test(i.filename))) continue
    await fetch(COMFY + '/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [pid] }),
    })
    const fs = await import('node:fs/promises')
    for (const im of imgs) {
      await fs.unlink('F:\\ai\\fastai\\output\\' + (im.subfolder ? im.subfolder + '\\' : '') + im.filename).catch(() => {})
    }
    n++
  }
  console.log('清理 seed 记录:', n)
  process.exit(0)
}

const prompt = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: 'a photo of a cat on a wooden table', clip: ['1', 1] } },
  3: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, lowres', clip: ['1', 1] } },
  4: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  5: {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0],
      seed: 1234,
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
  7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'tan_seed' } },
}

const res = await fetch(COMFY + '/prompt', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt, client_id: 'tan-seed' }),
})
const body = await res.json()
console.log('提交:', res.status, body.prompt_id || JSON.stringify(body).slice(0, 200))
const t0 = Date.now()
for (;;) {
  await sleep(600)
  const h = await j('/history/' + body.prompt_id)
  if (h[body.prompt_id]) {
    console.log('完成，用时', ((Date.now() - t0) / 1000).toFixed(1), 's（记录已留在 history，runui 能读到）')
    break
  }
  if (Date.now() - t0 > 120000) {
    console.log('超时')
    break
  }
}
