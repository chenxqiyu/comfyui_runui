/**
 * 探测：ComfyUI 能不能「一次 /prompt 请求连续画出多组参数」（cfg = 1 / 3 / 7）
 * 模型：sd15\chilloutmix_NiPrunedFp32Fix.safetensors
 *
 * 覆盖 4 套 XY 方案：
 *   1. Efficiency Nodes   XY Input: CFG Scale  (first/last/count，线性插值)
 *   2. Efficiency Nodes   XY Input: Manual XY Entry (任意值，分号分隔)  ← 同库的另一种轴
 *   3. Easy-Use           easy XYPlot (x_axis + x_values，分号+空格分隔)
 *   4. tinyterra (ttN)    ttN advanced xyPlot (x_plot 文本，每行一个点)
 *   5. ComfyRoll          CR XY List —— 静态判定（它只产出参数文本，没有自循环）
 *
 * 用法：
 *   node probe-xy.mjs                # 跑全部，跑完删掉生成的图
 *   node probe-xy.mjs --keep         # 保留生成的图
 *   node probe-xy.mjs --only easy    # 只跑某一个
 *   COMFY=http://127.0.0.1:8188 node probe-xy.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const COMFY = process.env.COMFY || 'http://127.0.0.1:8189'
const OUT_DIR = process.env.COMFY_OUTPUT || 'F:\\ai\\fastai\\output'
const CKPT = process.env.CKPT || 'sd15\\chilloutmix_NiPrunedFp32Fix.safetensors'
const STEPS = Number(process.env.STEPS || 6)
const W = 512
const H = 512
// 每次跑都换 seed：ComfyUI 会按节点输入 hash 复用缓存，seed 不变的话第二次跑直接命中缓存、
// 一张都不会真画（现象就是「1.2s 完成、新增 0 张图」）
const SEED = Number(process.env.SEED || 0) || 100000 + (Date.now() % 900000)
const POS = 'a photo of a cat, sitting on a wooden table, natural light'
const NEG = 'blurry, lowres, watermark'
const CFG_LIST = process.env.CFG_LIST || '1; 3; 7'
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 240000)

const argv = process.argv.slice(2)
const KEEP = argv.includes('--keep')
const ONLY = (() => {
  const i = argv.indexOf('--only')
  return i >= 0 ? argv[i + 1] : ''
})()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const j = async (p) => (await fetch(COMFY + p)).json()

/* ---------------------------------------------------------------- 公共节点 */

function baseNodes() {
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: POS, clip: ['1', 1] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: NEG, clip: ['1', 1] } },
    4: { class_type: 'EmptyLatentImage', inputs: { width: W, height: H, batch_size: 1 } },
  }
}

/* ------------------------------------------------------------- 4 套工作流 */

/** 1) Efficiency：XY Input: CFG Scale（first/last/count） */
function buildEfficiencyLinear() {
  return {
    ...baseNodes(),
    5: {
      class_type: 'XY Input: CFG Scale',
      inputs: { batch_count: 3, first_cfg: 1, last_cfg: 7 },
    },
    6: {
      class_type: 'XY Plot',
      inputs: {
        grid_spacing: 0,
        XY_flip: 'False',
        Y_label_orientation: 'Horizontal',
        cache_models: 'True',
        ksampler_output_image: 'Images',
        X: ['5', 0],
      },
    },
    7: {
      class_type: 'KSampler (Efficient)',
      inputs: {
        model: ['1', 0],
        seed: SEED,
        steps: STEPS,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
        denoise: 1,
        preview_method: 'none',
        vae_decode: 'true',
        optional_vae: ['1', 2],
        script: ['6', 0],
      },
    },
    8: { class_type: 'SaveImage', inputs: { images: ['7', 5], filename_prefix: 'tan_eff_linear' } },
  }
}

/** 2) Efficiency：XY Input: Manual XY Entry（任意值，分号分隔） */
function buildEfficiencyManual() {
  return {
    ...baseNodes(),
    5: {
      class_type: 'XY Input: Manual XY Entry',
      inputs: { plot_type: 'CFG Scale', plot_value: CFG_LIST },
    },
    6: {
      class_type: 'XY Plot',
      inputs: {
        grid_spacing: 0,
        XY_flip: 'False',
        Y_label_orientation: 'Horizontal',
        cache_models: 'True',
        ksampler_output_image: 'Images',
        X: ['5', 0],
      },
    },
    7: {
      class_type: 'KSampler (Efficient)',
      inputs: {
        model: ['1', 0],
        seed: SEED,
        steps: STEPS,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
        denoise: 1,
        preview_method: 'none',
        vae_decode: 'true',
        optional_vae: ['1', 2],
        script: ['6', 0],
      },
    },
    8: { class_type: 'SaveImage', inputs: { images: ['7', 5], filename_prefix: 'tan_eff_manual' } },
  }
}

/** 3) Easy-Use：easy XYPlot 挂在 pipe 链上 */
function buildEasyUse() {
  return {
    1: {
      class_type: 'easy fullLoader',
      inputs: {
        ckpt_name: CKPT,
        config_name: 'Default',
        vae_name: 'Baked VAE',
        clip_skip: -2,
        lora_name: 'None',
        lora_model_strength: 1,
        lora_clip_strength: 1,
        resolution: `${W} x ${H}`,
        empty_latent_width: W,
        empty_latent_height: H,
        positive: POS,
        positive_token_normalization: 'none',
        positive_weight_interpretation: 'comfy',
        negative: NEG,
        negative_token_normalization: 'none',
        negative_weight_interpretation: 'comfy',
        batch_size: 1,
      },
    },
    2: {
      class_type: 'easy XYPlot',
      inputs: {
        grid_spacing: 0,
        output_individuals: 'True',
        flip_xy: 'False',
        x_axis: 'preSampling: cfg',
        x_values: CFG_LIST,
        y_axis: 'None',
        y_values: '',
        pipe: ['1', 0],
      },
    },
    3: {
      class_type: 'easy fullkSampler',
      inputs: {
        pipe: ['2', 0],
        steps: STEPS,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1,
        image_output: 'Hide',
        link_id: 0,
        save_prefix: 'tan_easy',
        seed: SEED,
      },
    },
    4: {
      class_type: 'easy imageSave',
      inputs: { images: ['3', 1], filename_prefix: 'tan_easy', only_preview: false },
    },
  }
}

/** 4) ttN：advanced xyPlot（x_plot 文本）
 *  语法：每个「点」= 一行 `<轴号:label>[节点id:输入名='值']`
 *  轴号只是编号，重复会互相覆盖 —— 多个值必须写成多段，不能挤在一个段里
 */
function buildTtN() {
  const vals = CFG_LIST.split(';').map((s) => s.trim()).filter(Boolean)
  const xPlot = vals.map((v, i) => `<${i + 1}:v_label>[5:cfg='${v}']`).join('\n') + '\n'
  return {
    ...baseNodes(),
    5: {
      class_type: 'ttN KSampler_v2',
      inputs: {
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent: ['4', 0],
        vae: ['1', 2],
        lora_name: 'None',
        lora_strength: 1,
        upscale_method: 'None',
        upscale_model_name: 'None',
        factor: 2,
        rescale: 'None',
        percent: 50,
        width: 1024,
        height: 1024,
        longer_side: 1024,
        crop: 'disabled',
        steps: STEPS,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1,
        image_output: 'Save',
        save_prefix: 'tan_ttn',
        file_type: 'png',
        embed_workflow: true,
        seed: SEED,
        adv_xyPlot: ['6', 0],
      },
    },
    6: {
      class_type: 'ttN advanced xyPlot',
      inputs: {
        grid_spacing: 0,
        save_individuals: true,
        flip_xy: false,
        x_plot: xPlot,
        y_plot: '',
        z_plot: '',
        invert_background: false,
      },
    },
  }
}

const CASES = [
  {
    key: 'efficiency-linear',
    label: 'Efficiency · XY Input: CFG Scale（first→last 线性）',
    build: buildEfficiencyLinear,
    prefix: 'tan_eff_linear',
  },
  {
    key: 'efficiency-manual',
    label: 'Efficiency · Manual XY Entry（任意值 ' + CFG_LIST + '）',
    build: buildEfficiencyManual,
    prefix: 'tan_eff_manual',
  },
  {
    key: 'easyuse',
    label: 'Easy-Use · easy XYPlot（x_axis=preSampling: cfg）',
    build: buildEasyUse,
    prefix: 'tan_easy',
  },
  {
    key: 'ttn',
    label: 'ttN · advanced xyPlot（x_plot 文本）',
    build: buildTtN,
    prefix: 'tan_ttn',
  },
]

/* --------------------------------------------------------------- 执行工具 */

/** 读 PNG 尺寸（用来把「拼图」和「单图」分开） */
async function pngSize(file) {
  try {
    const fd = await fs.open(file, 'r')
    const buf = Buffer.alloc(24)
    await fd.read(buf, 0, 24, 0)
    await fd.close()
    if (buf.toString('ascii', 12, 16) !== 'IHDR') return null
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  } catch {
    return null
  }
}

async function findOutputFiles(prefix) {
  const out = []
  async function walk(dir, depth = 0) {
    if (depth > 3) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) await walk(p, depth + 1)
      else if (e.name.startsWith(prefix)) out.push(p)
    }
  }
  await walk(OUT_DIR)
  const withSize = []
  for (const p of out) withSize.push({ path: p, name: path.basename(p), size: await pngSize(p) })
  return withSize
}

async function submitAndWait(prompt) {
  const t0 = Date.now()
  const res = await fetch(COMFY + '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // extra_pnginfo 必须带：ttN 的 xy executor 会拿它去跑子 prompt，
    // 不带的话 ComfyUI 注入的 extra_pnginfo 是 None，ttN 里 .get 直接炸
    body: JSON.stringify({
      prompt,
      client_id: 'tan-probe',
      extra_data: { extra_pnginfo: { workflow: {} } },
    }),
  })
  const body = await res.json()
  if (!res.ok || !body.prompt_id) {
    const ne = body.node_errors || {}
    const first = Object.entries(ne)[0]
    const msg = first
      ? `${first[0]}: ${first[1].errors?.map((x) => x.message + ' / ' + x.details).join(' | ')}`
      : JSON.stringify(body).slice(0, 300)
    throw new Error('提交被拒 · ' + msg)
  }
  const pid = body.prompt_id

  for (;;) {
    if (Date.now() - t0 > TIMEOUT_MS) throw new Error('等待超时')
    await sleep(600)
    const h = await j('/history/' + pid)
    const entry = h[pid]
    if (entry) {
      const ms = Date.now() - t0
      const status = entry.status || {}
      if (status.status_str === 'error') {
        const m = (status.messages || []).find((x) => x[0] === 'execution_error')
        const d = m ? m[1] : null
        const err = new Error(
          '执行出错 · ' +
            (d
              ? `${d.node_type || ''}#${d.node_id || ''} · ${d.exception_type || ''}: ${String(d.exception_message || '').trim()}`
              : 'unknown')
        )
        err.traceback = d ? d.traceback : null
        throw err
      }
      const histImages = Object.values(entry.outputs || {}).flatMap((o) => o.images || [])
      return { pid, ms, histImages, entry }
    }
  }
}

async function cleanup(pid, files) {
  if (KEEP) return
  for (const f of files) await fs.unlink(f).catch(() => {})
  // ComfyUI 的 history 落盘比「任务完成」稍晚一点，删一次可能扑空，重试几下
  for (let i = 0; i < 3; i++) {
    await fetch(COMFY + '/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [pid] }),
    }).catch(() => {})
    await sleep(300)
    const h = await j('/history/' + pid).catch(() => ({}))
    if (!h[pid]) return
  }
  console.log('     ⚠ history 条目没删掉：' + pid.slice(0, 8))
}

/* ------------------------------------------------------------------- 主流程 */

console.log('ComfyUI :', COMFY)
console.log('模型    :', CKPT)
console.log('参数    :', `cfg = ${CFG_LIST}  ·  ${W}x${H}  ·  steps=${STEPS}  ·  seed=${SEED}`)
console.log('判据    : 一次 POST /prompt → 多张「单图尺寸」的输出文件\n')

const results = []
for (const c of CASES) {
  if (ONLY && !c.key.includes(ONLY)) continue
  console.log('─'.repeat(72))
  console.log('▶', c.label)
  const before = new Set((await findOutputFiles(c.prefix)).map((f) => f.name))
  let row = { key: c.key, label: c.label, ok: false }
  try {
    const prompt = c.build()
    const { pid, ms, histImages } = await submitAndWait(prompt)
    await sleep(1200) // 等文件落盘
    const files = (await findOutputFiles(c.prefix)).filter((f) => !before.has(f.name))
    // 单图 = 尺寸正好等于 512x512；更大的那张是插件拼的网格图
    const singles = files.filter((f) => f.size && f.size.w === W && f.size.h === H)
    const grids = files.filter((f) => !(f.size && f.size.w === W && f.size.h === H))
    row = {
      ...row,
      ok: singles.length > 1,
      requests: 1,
      ms,
      files: files.length,
      singles: singles.length,
      grids: grids.length,
      historyImages: histImages.length,
      detail: files.map((f) => `${f.name}${f.size ? ` (${f.size.w}x${f.size.h})` : ''}`),
    }
    console.log(
      `  一次请求 ${(ms / 1000).toFixed(1)}s → ${singles.length} 张单图` +
        (grids.length ? ` + ${grids.length} 张拼图` : '') +
        `  ${singles.length > 1 ? '✅ 连续出图' : '❌ 只有 1 张'}`
    )
    for (const d of row.detail.slice(0, 8)) console.log('    -', d)
    await cleanup(pid, files.map((f) => f.path))
  } catch (err) {
    row = { ...row, ok: false, error: err.message, traceback: err.traceback || null }
    console.log('  ❌', err.message)
    if (err.traceback) {
      const tb = Array.isArray(err.traceback) ? err.traceback : String(err.traceback).split('\n')
      for (const line of tb.slice(-10)) console.log('     ' + String(line).trim())
    }
  }
  results.push(row)
}

/* ComfyRoll：静态判定，不提交 */
const comfroll = {
  key: 'comfyroll',
  label: 'ComfyRoll · CR XY List',
  ok: false,
  skipped: true,
  note:
    'CR XY 系列（CR XY List / CR XY Index / CR XY Save Grid Image）只负责「生成参数文本 + 拼网格」' +
    '，没有自循环执行节点：CR XY List 按 index 取一组值，需要外部把 index 从 0 递增并重复提交才能出多张。' +
    '所以它做不到「一次请求连续画」。',
}
if (!ONLY || 'comfyroll'.includes(ONLY)) {
  console.log('─'.repeat(72))
  console.log('▶', comfroll.label, '（静态判定，不提交）')
  console.log('  ⚠', comfroll.note)
  results.push(comfroll)
}

/* ------------------------------------------------------------------ 汇总 */
console.log('\n' + '='.repeat(72))
console.log('汇总')
console.log('='.repeat(72))
for (const r of results) {
  const mark = r.skipped ? '—' : r.ok ? '✅' : '❌'
  const info = r.skipped
    ? '不支持一次请求（需外部循环 index）'
    : r.error
      ? '失败：' + r.error
      : `1 次请求 · ${(r.ms / 1000).toFixed(1)}s · ${r.singles} 张单图` +
        (r.grids ? ` + ${r.grids} 拼图` : '')
  console.log(`${mark} ${r.key.padEnd(20)} ${info}`)
}
const report = new URL('./report.json', import.meta.url)
await fs.writeFile(report, JSON.stringify({ at: new Date().toISOString(), ckpt: CKPT, cfg: CFG_LIST, steps: STEPS, results }, null, 2))
console.log('\n报告已写入', report.pathname)
if (KEEP) console.log('（--keep：生成的图保留在', OUT_DIR, '）')
