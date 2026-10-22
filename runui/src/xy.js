/**
 * XY 单请求：把「任意工作流」的采样节点原地改造成带 XY Plot 的 KSampler (Efficient)，
 * 这样一次 /prompt 就能连续画出 N 组参数（引擎内部循环，模型只加载一次）。
 *
 * 改造只发生在提交用的副本上，不动 state.nodes：
 *   1. KSampler / KSamplerAdvanced → KSampler (Efficient)（保留同名输入，丢掉它没有的）
 *   2. 把下游 VAEDecode 的 vae 连接复制一份到 optional_vae
 *      —— Efficiency 在 XY 模式下没 vae 会直接 fallback 成单张，且拼图时字体为 0 会崩
 *   3. LATENT 从 slot 0 挪到 slot 3：所有引用 [id,0] 的位置都要改，否则下游拿到的是 MODEL
 *   4. 注入 XY Input: Manual XY Entry + XY Plot，接到 script
 *
 * vae_decode 必须是 'true'：设 'false' 时 XY 分支产不出图，最后 PIL 画标注会报
 * "font size must be greater than 0"。
 */

/** 能扫的参数 → Efficiency 的 plot_type */
export const XY_AXIS_LABEL = {
  cfg: 'CFG Scale',
  steps: 'Steps',
  denoise: 'Denoise',
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

function nextIds(nodes, count) {
  let max = 0
  for (const k of Object.keys(nodes)) {
    const n = Number(k)
    if (Number.isFinite(n) && n > max) max = n
  }
  return Array.from({ length: count }, (_, i) => String(max + 1 + i))
}

/**
 * @param {object} nodes     当前工作流节点图（不会被修改）
 * @param {object} plan      { samplerId, axis, values: [] }
 * @returns {{ prompt: object, plotId: string, inputId: string, wasEfficient: boolean }}
 */
export function buildXyPrompt(nodes, plan) {
  const { samplerId, axis, values } = plan || {}
  const label = XY_AXIS_LABEL[axis]
  if (!label) throw new Error(`XY 不支持扫描参数 ${axis}`)
  if (!Array.isArray(values) || values.length < 2) throw new Error('XY 至少要有 2 个取值')

  const out = JSON.parse(JSON.stringify(nodes))
  const node = out[samplerId]
  if (!node) throw new Error('采样节点不存在')
  const chk = canXySampler(out, samplerId)
  if (!chk.ok) throw new Error(chk.reason)

  const wasEfficient = chk.already

  if (!wasEfficient) {
    const inputs = {}
    for (const [k, v] of Object.entries(node.inputs || {})) {
      // KSamplerAdvanced 独有、Efficient 没有的输入必须去掉，否则报 unexpected input
      if (
        ['add_noise', 'start_at_step', 'end_at_step', 'return_with_leftover_noise'].includes(k)
      ) {
        continue
      }
      if (k === 'noise_seed') {
        inputs.seed = v
        continue
      }
      inputs[k] = v
    }
    inputs.preview_method = 'none'
    inputs.vae_decode = 'true' // 必须是 true，见文件头注释

    // VaE：Efficiency 在 XY 模式下强制要 vae，否则直接 fallback 出单张
    const consumer = Object.values(out).find(
      (n) =>
        n.class_type === 'VAEDecode' &&
        isLink(n.inputs?.samples) &&
        String(n.inputs.samples[0]) === String(samplerId)
    )
    if (consumer && isLink(consumer.inputs?.vae)) inputs.optional_vae = consumer.inputs.vae

    node.class_type = 'KSampler (Efficient)'
    node.inputs = inputs

    // LATENT 换槽：0 → 3（MODEL/COND+/COND-/LATENT/VAE/IMAGE）
    for (const n of Object.values(out)) {
      for (const [k, v] of Object.entries(n.inputs || {})) {
        if (isLink(v) && String(v[0]) === String(samplerId) && Number(v[1]) === 0) {
          n.inputs[k] = [String(samplerId), 3]
        }
      }
    }
  }

  const [plotId, inputId] = nextIds(out, 2)
  out[inputId] = {
    class_type: 'XY Input: Manual XY Entry',
    inputs: { plot_type: label, plot_value: values.map((v) => String(v)).join(';') },
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

  return { prompt: out, plotId, inputId, wasEfficient }
}
