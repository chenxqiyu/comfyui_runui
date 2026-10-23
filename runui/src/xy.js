/**
 * XY 单请求：把「任意工作流」的采样节点原地改造成带 XY Plot 的 KSampler (Efficient)，
 * 一次 /prompt 连续画出多组参数（引擎内部循环，模型只加载一次）。
 *
 * 两个轴：
 *   X = 提示词（Efficiency 的 Prompt S/R）—— 需要先把 Loader 换成 Efficient Loader
 *   Y = 数值 / 枚举参数（cfg / steps / denoise / sampler_name / scheduler，
 *       用 XY Input: Manual XY Entry）
 *
 * 改造只发生在提交副本上，不动 state.nodes。五个必须做对的地方：
 *   1. 采样节点 KSampler/KSamplerAdvanced → KSampler (Efficient)，丢掉它没有的输入
 *   2. VAEDecode 的 vae 复制到 optional_vae（不传会 fallback 成单张，还会崩在拼图上）
 *   3. LATENT 从 slot 0 挪到 slot 3：所有引用 [id,0] 都要改
 *   4. vae_decode 必须是 'true'
 *   5. 扫提示词时 Loader 必须换成 `Efficient Loader`：XY Plot 的 dependencies 是 DEPENDENCIES 类型，
 *      只有 Efficiency 自己的 Loader 才有这个输出，普通 CheckpointLoaderSimple 拿不到，
 *      XY Plot 会静默返回 None（表现就是「扫了但只出一张」）
 */

/** 能扫的参数 → Efficiency 的 plot_type */
export const XY_AXIS_LABEL = {
  cfg: 'CFG Scale',
  steps: 'Steps',
  denoise: 'Denoise',
  sampler_name: 'Sampler',
  scheduler: 'Scheduler',
}

const isLink = (v) =>
  Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number')

/** 这个采样节点能不能走 XY */
export function canXySampler(nodes, samplerId) {
  const cls = nodes?.[samplerId]?.class_type
  if (!cls) return { ok: false, reason: '当前工作流没有可用的采样节点' }
  if (cls === 'KSampler (Efficient)') return { ok: true, cls, already: true }
  if (/^KSampler(Advanced)?$/.test(cls)) return { ok: true, cls, already: false }
  return {
    ok: false,
    reason: `采样节点是 ${cls}，Efficiency 的 XY 只能接 KSampler / KSamplerAdvanced`,
  }
}

/** 从采样节点的 model 输入往上找，看是谁在加载模型 */
function findLoaderOf(nodes, samplerId) {
  const seen = new Set()
  const queue = []
  for (const v of Object.values(nodes[samplerId]?.inputs || {})) {
    if (isLink(v)) queue.push(String(v[0]))
  }
  while (queue.length) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    const node = nodes[id]
    if (!node) continue
    if (node.class_type === 'CheckpointLoaderSimple') return { id, cls: node.class_type }
    if (node.class_type === 'Efficient Loader') return { id, cls: node.class_type, already: true }
    if (/^(UNETLoader|UnetLoaderGGUF|CheckpointLoader)$/.test(node.class_type)) {
      return { id, cls: node.class_type, unsupported: true }
    }
    for (const v of Object.values(node.inputs || {})) {
      if (isLink(v)) queue.push(String(v[0]))
    }
  }
  return null
}

/** 扫提示词还得能有 CLIP 可用 —— 靠 Loader 换 Efficient Loader 提供 */
export function canXyPrompt(nodes, samplerId) {
  const loader = findLoaderOf(nodes, samplerId)
  if (!loader) return { ok: false, reason: '找不到加载模型的节点，提示词没法走 XY' }
  if (loader.unsupported) {
    return {
      ok: false,
      reason: `模型是 ${loader.cls} 分离加载的（没有 DEPENDENCIES 输出），提示词多值只能串行`,
    }
  }
  return { ok: true, loaderId: loader.id, already: !!loader.already }
}

function nextIds(nodes, count) {
  let max = 0
  for (const k of Object.keys(nodes)) {
    const n = Number(k)
    if (Number.isFinite(n) && n > max) max = n
  }
  return Array.from({ length: count }, (_, i) => String(max + 1 + i))
}

/** CheckpointLoaderSimple → Efficient Loader，同时把 CLIP/VAE 的槽位改过去 */
function swapLoader(out, loaderId, { positive, negative }) {
  const old = out[loaderId]
  if (!old) throw new Error('加载节点不存在')
  if (old.class_type === 'Efficient Loader') return
  out[loaderId] = {
    class_type: 'Efficient Loader',
    inputs: {
      ckpt_name: old.inputs?.ckpt_name,
      vae_name: 'Baked VAE',
      clip_skip: -1,
      lora_name: 'None',
      lora_model_strength: 1,
      lora_clip_strength: 1,
      // 它自己会编码这两个文本，但 COND+/COND- 我们不用（上游还是用户自己的 CLIPTextEncode）
      positive: String(positive || '').slice(0, 2000),
      negative: String(negative || 'blurry, lowres').slice(0, 2000),
      token_normalization: 'none',
      weight_interpretation: 'comfy',
      empty_latent_width: 512,
      empty_latent_height: 512,
      batch_size: 1,
    },
  }
  // Efficient Loader: MODEL(0) COND+(1) COND-(2) LATENT(3) VAE(4) CLIP(5) DEPENDENCIES(6)
  for (const n of Object.values(out)) {
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (!isLink(v) || String(v[0]) !== String(loaderId)) continue
      if (Number(v[1]) === 1) n.inputs[k] = [String(loaderId), 5]
      else if (Number(v[1]) === 2) n.inputs[k] = [String(loaderId), 4]
    }
  }
}

/** 采样节点换 KSampler (Efficient) + LATENT 槽位 0 → 3 */
function swapSampler(out, samplerId) {
  const node = out[samplerId]
  const chk = canXySampler(out, samplerId)
  if (!chk.ok) throw new Error(chk.reason)
  if (chk.already) return

  const inputs = {}
  for (const [k, v] of Object.entries(node.inputs || {})) {
    if (['add_noise', 'start_at_step', 'end_at_step', 'return_with_leftover_noise'].includes(k)) continue
    if (k === 'noise_seed') {
      inputs.seed = v
      continue
    }
    inputs[k] = v
  }
  inputs.preview_method = 'none'
  inputs.vae_decode = 'true'

  const consumer = Object.values(out).find(
    (n) =>
      n.class_type === 'VAEDecode' &&
      isLink(n.inputs?.samples) &&
      String(n.inputs.samples[0]) === String(samplerId)
  )
  if (consumer && isLink(consumer.inputs?.vae)) inputs.optional_vae = [...consumer.inputs.vae]
  if (!inputs.optional_vae) {
    // 退一步：找加载节点的 VAE（CheckpointLoaderSimple 的 slot 2）
    const loader = findLoaderOf(out, samplerId)
    if (loader) inputs.optional_vae = [String(loader.id), loader.already ? 4 : 2]
  }

  node.class_type = 'KSampler (Efficient)'
  node.inputs = inputs

  for (const n of Object.values(out)) {
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (isLink(v) && String(v[0]) === String(samplerId) && Number(v[1]) === 0) {
        n.inputs[k] = [String(samplerId), 3]
      }
    }
  }
}

/**
 * @param {object} nodes 当前工作流节点图（不会被修改）
 * @param {object} plan  { samplerId, axis, values, promptNodeId, promptTexts, negativeText }
 *   axis/values 有多个值 → Y 轴（数值）
 *   promptTexts 有多个值 → X 轴（提示词）
 *   两个都有就是 2D 网格
 * @returns {{ prompt, xId, yId, plotId, kinds, count, loaderId }}
 */
export function buildXyPrompt(nodes, plan) {
  const { samplerId, axis, values, promptNodeId, promptTexts } = plan || {}
  const hasParams = !!axis && Array.isArray(values) && values.length > 1
  const hasPrompts = Array.isArray(promptTexts) && promptTexts.length > 1
  if (!hasParams && !hasPrompts) throw new Error('XY 至少需要一个参数或提示词填多值')

  const out = JSON.parse(JSON.stringify(nodes))

  // 先换采样节点（此时 optional_vae 还指向原 Loader 的 slot 2），再换 Loader 统一映射槽位
  swapSampler(out, samplerId)

  const kinds = {}
  let loaderId = null
  if (hasPrompts) {
    if (!promptNodeId) throw new Error('没有选中的输入节点，提示词没法当轴')
    const loader = findLoaderOf(out, samplerId)
    if (!loader || loader.unsupported) {
      throw new Error(
        loader ? `模型是 ${loader.cls} 分离加载的，提示词多值只能串行` : '找不到加载模型的节点'
      )
    }
    loaderId = String(loader.id)
    swapLoader(out, loaderId, {
      positive: promptTexts[0],
      negative: plan.negativeText || 'blurry, lowres',
    })
    // 第一个提示词直接写进文本节点；其余交给 Prompt S/R（第一项 None = 不改，正好是第一个）
    const target = out[promptNodeId]
    if (target?.inputs && typeof target.inputs.text === 'string') {
      target.inputs.text = promptTexts[0]
    }
    kinds.x = 'prompt'
  }

  const ids = nextIds(out, hasPrompts && hasParams ? 3 : 2)
  let cursor = 0

  // XY Input
  let xInput
  if (hasPrompts) {
    const sr = {
      target_prompt: 'positive',
      search_txt: promptTexts[0],
      replace_count: promptTexts.length - 1,
    }
    for (let i = 0; i < 50; i++) sr[`replace_${i + 1}`] = promptTexts[i + 1] || ''
    out[ids[cursor]] = { class_type: 'XY Input: Prompt S/R', inputs: sr }
    xInput = [ids[cursor], 0]
    cursor += 1
  } else {
    out[ids[cursor]] = {
      class_type: 'XY Input: Manual XY Entry',
      inputs: { plot_type: XY_AXIS_LABEL[axis], plot_value: values.map(String).join(';') },
    }
    xInput = [ids[cursor], 0]
    cursor += 1
    kinds.x = 'param'
  }

  let yInput = null
  if (hasPrompts && hasParams) {
    out[ids[cursor]] = {
      class_type: 'XY Input: Manual XY Entry',
      inputs: { plot_type: XY_AXIS_LABEL[axis], plot_value: values.map(String).join(';') },
    }
    yInput = [ids[cursor], 0]
    cursor += 1
    kinds.y = 'param'
  }

  const plotInputs = {
    grid_spacing: 0,
    XY_flip: 'False',
    Y_label_orientation: 'Horizontal',
    cache_models: 'True',
    ksampler_output_image: 'Images',
    X: xInput,
  }
  if (yInput) plotInputs.Y = yInput
  if (loaderId) plotInputs.dependencies = [loaderId, 6]

  out[ids[cursor]] = { class_type: 'XY Plot', inputs: plotInputs }
  out[samplerId].inputs.script = [ids[cursor], 0]

  return {
    prompt: out,
    plotId: ids[cursor],
    xId: ids[0],
    yId: yInput ? ids[1] : null,
    kinds,
    loaderId,
    count:
      (hasPrompts ? promptTexts.length : 1) * (hasParams ? values.length : 1),
  }
}
