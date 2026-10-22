/**
 * 验证「原地改造任意工作流」的可行性：
 * 把普通 KSampler 就地换成 KSampler (Efficient)（vae_decode=false，LATENT 从 slot0 挪到 slot3），
 * 下游 VAEDecode 只改槽位、不用换节点，然后注入 XY Input + XY Plot 扫 cfg。
 *
 *   node probe-inject.mjs
 */
const COMFY = process.env.COMFY || 'http://127.0.0.1:8189'
const CKPT = process.env.CKPT || 'sd15\\chilloutmix_NiPrunedFp32Fix.safetensors'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const j = async (p) => (await fetch(COMFY + p)).json()

/* ---------- 1. 一个「普通」工作流：KSampler → VAEDecode → SaveImage ---------- */
const plain = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: 'a photo of a cat on a table', clip: ['1', 1] } },
  3: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, lowres', clip: ['1', 1] } },
  4: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  5: {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0],
      seed: 777,
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
  7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'tan_inject' } },
}

/* ---------- 2. 改造：KSampler → KSampler (Efficient) + 注入 XY ---------- */
function isLink(v) {
  return Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number')
}

function nextId(nodes, taken = []) {
  let max = 0
  for (const k of Object.keys(nodes)) {
    const n = Number(k)
    if (Number.isFinite(n) && n > max) max = n
  }
  for (const t of taken) max = Math.max(max, Number(t) || 0)
  return String(max + 1)
}

const AXIS_OF = {
  cfg: 'CFG Scale',
  steps: 'Steps',
  denoise: 'Denoise',
  seed: 'Seeds++ Batch',
  sampler_name: 'Sampler',
  scheduler: 'Scheduler',
}

/**
 * @param nodes  原工作流（会被深拷贝）
 * @param samplerId 目标采样节点
 * @param axis   要扫的参数名（cfg / steps / ...）
 * @param values 取值数组
 */
function buildXy(nodes, samplerId, axis, values) {
  const out = structuredClone(nodes)
  const node = out[samplerId]
  if (!node) throw new Error('找不到采样节点 ' + samplerId)
  if (node.class_type !== 'KSampler (Efficient)') {
    if (!/^KSampler(Advanced)?$/.test(node.class_type)) {
      throw new Error('不支持的采样节点类型：' + node.class_type)
    }
    const inputs = {}
    for (const [k, v] of Object.entries(node.inputs || {})) {
      // KSamplerAdvanced 独有、Efficient 没有的输入要丢掉，否则会报 unexpected input
      if (['add_noise', 'noise_seed', 'start_at_step', 'end_at_step', 'return_with_leftover_noise'].includes(k)) {
        if (k === 'noise_seed') inputs.seed = v
        continue
      }
      inputs[k] = v
    }
    inputs.preview_method = 'none'
    // 只要 LATENT，不做内部解码 —— 下游原来的 VAEDecode 继续用
    inputs.vae_decode = 'true'
    // XY 模式下 Efficiency 会强制自己解码，但 vae 必须连上，否则它会走
    // "VAE input must be connected" 的 fallback，直接吐原始 latent（只出 1 张）
    const consumer = Object.values(out).find(
      (n) =>
        n.class_type === 'VAEDecode' &&
        isLink(n.inputs?.samples) &&
        String(n.inputs.samples[0]) === String(samplerId)
    )
    if (consumer && isLink(consumer.inputs.vae)) inputs.optional_vae = consumer.inputs.vae
    node.class_type = 'KSampler (Efficient)'
    node.inputs = inputs

    // 普通 KSampler 的 LATENT 在 slot 0，Efficient 在 slot 3 → 所有引用都要改
    for (const n of Object.values(out)) {
      for (const [k, v] of Object.entries(n.inputs || {})) {
        if (isLink(v) && String(v[0]) === String(samplerId) && Number(v[1]) === 0) {
          n.inputs[k] = [String(samplerId), 3]
        }
      }
    }
  }

  const plotId = nextId(out)
  const inputId = nextId(out, [plotId])
  out[inputId] = {
    class_type: 'XY Input: Manual XY Entry',
    inputs: { plot_type: AXIS_OF[axis] || axis, plot_value: values.join(';') },
  }
  out[plotId] = {
    class_type: 'XY Plot',
    inputs: {
      grid_spacing: 0,
      XY_flip: 'False',
      Y_label_orientation: 'Horizontal',
      cache_models: 'True',
      ksampler_output_image: 'Images',
      X: [inputId, 0],
    },
  }
  out[samplerId].inputs.script = [plotId, 0]
  return { nodes: out, plotId, inputId }
}

/* ---------- 3. 提交 ---------- */
const values = ['1', '3', '7']
const { nodes } = buildXy(plain, '5', 'cfg', values)

console.log('改造后的 KSampler 节点：')
console.log(JSON.stringify(nodes['5'], null, 1))
console.log('下游 VAEDecode：', JSON.stringify(nodes['6'].inputs))

const t0 = Date.now()
const res = await fetch(COMFY + '/prompt', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: nodes, client_id: 'tan-inject', extra_data: { extra_pnginfo: { workflow: {} } } }),
})
const body = await res.json()
console.log('\nPOST /prompt ->', res.status, JSON.stringify(body).slice(0, 300))
if (!body.prompt_id) process.exit(1)

const pid = body.prompt_id
for (;;) {
  await sleep(700)
  const h = await j('/history/' + pid)
  const e = h[pid]
  if (!e) {
    if (Date.now() - t0 > 180000) { console.log('超时'); process.exit(1) }
    continue
  }
  const imgs = Object.values(e.outputs || {}).flatMap((o) => o.images || [])
  console.log('--- history entry ---')
  console.log('status:', JSON.stringify(e.status || {}).slice(0, 300))
  console.log('outputs:', JSON.stringify(e.outputs || {}).slice(0, 600))
  const msgs = (e.status && e.status.messages) || []
  for (const m of msgs) {
    if (m[0] === 'execution_error') console.log('ERROR:', JSON.stringify(m[1]).slice(0, 600))
  }
  console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，输出 ${imgs.length} 张：`)
  for (const im of imgs) console.log('  -', im.filename)
  console.log('\n结论：', imgs.length >= values.length ? '✅ 原地改造可行，普通 KSampler 不用手工换节点' : '❌ 张数不对')

  // 清理
  await fetch(COMFY + '/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delete: [pid] }),
  })
  const fs = await import('node:fs/promises')
  for (const im of imgs) {
    await fs.unlink('F:\\ai\\fastai\\output\\' + (im.subfolder ? im.subfolder + '\\' : '') + im.filename).catch(() => {})
  }
  break
}
