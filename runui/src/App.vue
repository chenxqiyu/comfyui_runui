<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import JSZip from 'jszip'
import LoraPanel from './components/LoraPanel.vue'
import {
  apiGet,
  collectImages,
  deleteQueued,
  fetchCurrentWorkflow,
  fetchHistory,
  getPrefix,
  interruptRun,
  nodesFromHistoryEntry,
  setPrefix,
  sleep,
  submitPrompt,
  viewUrl,
} from './api'

const THEMES = [
  { id: 'day', label: '日间', mode: 'light', bg: '#f6f7f9', accent: '#2563eb' },
  { id: 'sand', label: '暖砂', mode: 'light', bg: '#f5efe3', accent: '#b45309' },
  { id: 'mint', label: '薄荷', mode: 'light', bg: '#eef6f2', accent: '#0d9488' },
  { id: 'midnight', label: '午夜', mode: 'dark', bg: '#0c1120', accent: '#60a5fa' },
  { id: 'graphite', label: '石墨', mode: 'dark', bg: '#111111', accent: '#d4d4d4' },
  { id: 'forest', label: '深林', mode: 'dark', bg: '#0b1411', accent: '#34d399' },
]
const THEME_GROUPS = [
  { name: '明亮', items: THEMES.filter((t) => t.mode === 'light') },
  { name: '暗黑', items: THEMES.filter((t) => t.mode === 'dark') },
]
const themeIdOf = (id) => (THEMES.some((t) => t.id === id) ? id : 'day')
const initialTheme = themeIdOf(localStorage.getItem('runui.theme'))
document.documentElement.dataset.theme = initialTheme

const state = reactive({
  prefix: getPrefix(),
  showSettings: false,
  theme: initialTheme,
  themeOpen: false,
  status: 'idle',
  message: '',
  nodes: {},
  entry: null,
  source: '',
  sourcePromptId: '',
  jobs: [],
  inId: '',
  inField: '',
  outId: '',
  // 每个「输入节点 + 字段」各自保存改过的提示词，切换节点后回来还在
  textDrafts: {},
  // 数字 / 开关 / 下拉字段的草稿，key 同样是 `${节点}:${字段}`
  fieldDrafts: {},
  // /object_info 缓存：{ class_type: { 字段: [候选值] } }
  nodeOptions: {},
  randomSeed: true,
  sendCount: 1,
  samplerId: '',
  samplerParams: {},
  samplerOptions: {},
  submitting: false,
  running: false,
  runPromptId: '',
  elapsed: 0,
  images: [],
  warnings: [],
  showWarnings: false,
  failed: false,
  extraData: null,
  // —— 批量对比 ——
  results: [],
  comparing: false,
  progress: { done: 0, total: 0 },
  stopFlag: false,
  packing: false,
  resultZoom: Number(localStorage.getItem('runui.resultZoom')) || 100,
  showResultImages: true,
  clipboardOff: {},
  // 禁用时记下原连线，刷新页面/跑过一轮后还能恢复
  clipboardLinks: (() => {
    try {
      const v = JSON.parse(localStorage.getItem('runui.clipboardLinks') || '{}')
      return v && typeof v === 'object' ? v : {}
    } catch {
      return {}
    }
  })(),
  lightbox: null, // { items: [{img, tags, ms, promptId}], index, source: 'results' | 'single' }
  // —— 参数收藏 ——
  presets: [],
  showSavePreset: false,
  presetName: '',
  samplerBaseline: null,
  dialog: null, // 通用确认弹窗 { title, text, confirmText, danger, onConfirm }
  // —— LoRA 堆叠浮层（固定右下角，可动态开关）——
  showLora: localStorage.getItem('runui.loraOpen') === '1',
  loraId: localStorage.getItem('runui.loraNode') || '',
  loraBaseline: {},
})

const currentTheme = computed(() => THEMES.find((t) => t.id === state.theme) || THEMES[0])

function setTheme(id) {
  state.theme = themeIdOf(id)
  state.themeOpen = false
}

watch(
  () => state.theme,
  (id) => {
    document.documentElement.dataset.theme = id
    localStorage.setItem('runui.theme', id)
  }
)

const TEXT_KEYS = ['text', 'prompt', 'string', 'value', 'content', 'positive', 'text_g', 'text_l']

// 这些字符串字段是枚举/文件名，不是提示词，别让它们混进候选
const NON_TEXT =
  /^(sampler_name|scheduler|ckpt_name|unet_name|clip_name\d*|dual_clip_name\d*|vae_name|lora_name|control_net_name|model_name|filename_prefix|image|mask|upscale_method|device|dtype|type|mode|weight_dtype|format|extension|resolution)$/i

function stringFields(node) {
  const inputs = node?.inputs || {}
  return Object.keys(inputs).filter((k) => {
    if (typeof inputs[k] !== 'string') return false
    if (NON_TEXT.test(k)) return false
    if (k.endsWith('_name') || k.endsWith('_path')) return false
    return true
  })
}

/** 越像提示词的字段排得越前 */
function scoreField(key) {
  const k = key.toLowerCase()
  if (k === 'text') return 100
  if (k === 'prompt') return 95
  if (TEXT_KEYS.includes(k)) return 80
  if (k.includes('text') || k.includes('prompt')) return 60
  return 10
}

// 候选值太多的下拉（模型/文件列表）不列出来，当普通文本框处理
const MAX_OPTIONS = 600

/** 该节点所有可写字段（排除连线值），带类型和候选值，控件的样式由 type 决定 */
function writableFields(node) {
  if (!node) return []
  const options = state.nodeOptions[node.class_type] || {}
  const out = []
  for (const [key, val] of Object.entries(node.inputs || {})) {
    if (isLinkValue(val)) continue
    const t = typeof val
    if (t === 'number') {
      out.push({ key, type: 'number', value: val, options: null })
    } else if (t === 'boolean') {
      out.push({ key, type: 'bool', value: val, options: null })
    } else if (t === 'string') {
      const list = options[key]
      const opts = Array.isArray(list) && list.length && list.length <= MAX_OPTIONS ? list : null
      out.push({ key, type: opts ? 'enum' : 'text', value: val, options: opts })
    }
  }
  return out.sort((a, b) => scoreField(b.key) - scoreField(a.key) || a.key.localeCompare(b.key))
}

/** 默认写哪个字段：有提示词字段就选提示词，否则退回第一个可写字段 */
function defaultField(node) {
  const fields = writableFields(node)
  return (fields.find((f) => f.type === 'text') || fields[0])?.key || ''
}

const nodeList = computed(() =>
  Object.entries(state.nodes || {}).map(([id, node]) => {
    const cls = String(node?.class_type || '')
    const fields = stringFields(node)
    return {
      id,
      cls,
      title: node?._meta?.title || '',
      fields,
      allFields: writableFields(node).map((f) => f.key),
      isSaver: /SaveImage|PreviewImage|SaveAnimatedWEBP|SaveVideo/i.test(cls),
      imageCount: (state.entry?.outputs?.[id]?.images || []).length,
    }
  })
)

const textNodes = computed(() => nodeList.value.filter((n) => n.fields.length))
const outNodes = computed(() => nodeList.value.filter((n) => n.isSaver || n.imageCount))

/** 当前输出链路上、可写文本的节点：给「输入节点」做快速切换 */
const wiredTextNodes = computed(() => {
  const nodes = state.nodes || {}
  const out = state.outId
  return textNodes.value
    .filter((n) => !out || reachesOutput(nodes, n.id, out))
    .sort((a, b) => {
      const sa = Math.max(...a.fields.map(scoreField))
      const sb = Math.max(...b.fields.map(scoreField))
      if (sb !== sa) return sb - sa
      return Number(a.id) - Number(b.id)
    })
})

/** 换输入节点时尽量保留还存在的字段，否则自动选最像提示词的那个 */
function chooseInputNode(id) {
  const node = id ? state.nodes?.[id] : null
  state.inId = id
  if (!node) {
    state.inField = ''
    return
  }
  loadNodeOptions(node.class_type)
  const keys = writableFields(node).map((f) => f.key)
  if (!keys.includes(state.inField)) state.inField = defaultField(node)
}

/** 这个节点是否有改过（非空草稿），用于标签高亮 */
function isInputDirty(id) {
  const prefix = `${id}:`
  return Object.keys({ ...state.textDrafts, ...state.fieldDrafts }).some(
    (key) => key.startsWith(prefix) && draftDirty(key)
  )
}

/** 某个字段的草稿是否算「改过」：文本要去空白，其它类型只要不是空串就算 */
function draftDirty(key) {
  if (String(state.textDrafts[key] ?? '').trim()) return true
  const v = state.fieldDrafts[key]
  return v !== undefined && v !== null && v !== ''
}

/**
 * loras 可能有两种形态：history 里执行过的节点是裸数组，没执行/被缓存的节点
 * 仍是 {"__value__": [...]}（提交时的包装）。链接值 ["id", 0] 不是列表，排除。
 */
function loraList(v) {
  if (isLinkValue(v)) return null
  if (Array.isArray(v)) return v
  if (Array.isArray(v?.__value__)) return v.__value__
  return null
}

function loraActive(item) {
  if (!item || typeof item !== 'object') return true
  if ('active' in item) return !!item.active
  if ('enabled' in item) return !!item.enabled
  if ('on' in item) return !!item.on
  return true
}

/** LoRA 堆叠节点：输入里有 loras 列表（Lora Stacker / LoraManager） */
const loraNodes = computed(() => {
  const out = []
  for (const [id, node] of Object.entries(state.nodes || {})) {
    const loras = loraList(node?.inputs?.loras)
    if (!loras) continue
    out.push({
      id,
      cls: String(node?.class_type || ''),
      title: node?._meta?.title || '',
      count: loras.length,
      activeCount: loras.filter(loraActive).length,
      loras,
    })
  }
  return out
})

const loraLoras = computed(() => {
  const list = loraList(state.nodes?.[state.loraId]?.inputs?.loras)
  return Array.isArray(list) ? list : []
})

/**
 * 按 lora_stack 连线把堆叠节点串成链路：上游在前、下游在后。
 * 链路最后一个节点的 LORA_STACK 输出（slot 0）若被非堆叠节点消费，
 * 记为已接入（如 CR Apply LoRA Stack）；否则是未接入的孤立堆叠。
 */
const loraChains = computed(() => {
  const nodes = state.nodes || {}
  const stackers = loraNodes.value
  const ids = new Set(stackers.map((n) => n.id))
  const byId = new Map(stackers.map((n) => [n.id, n]))

  const up = new Map()
  for (const n of stackers) {
    const link = nodes[n.id]?.inputs?.lora_stack
    if (!isLinkValue(link)) continue
    const src = String(link[0])
    if (ids.has(src) && src !== n.id) up.set(n.id, src)
  }
  const down = new Map()
  for (const [child, parent] of up) {
    const list = down.get(parent) || []
    list.push(child)
    down.set(parent, list)
  }

  const seen = new Set()
  const orderOf = (root) => {
    const order = []
    const queue = [root]
    while (queue.length) {
      const id = queue.shift()
      if (seen.has(id)) continue
      seen.add(id)
      order.push(id)
      const kids = (down.get(id) || []).filter((k) => !seen.has(k))
      if (kids.length > 1) queue.push(...kids.slice(1))
      if (kids.length) queue.unshift(kids[0])
    }
    return order
  }

  const groups = []
  for (const n of stackers) {
    if (!up.has(n.id) && !seen.has(n.id)) groups.push(orderOf(n.id))
  }
  for (const n of stackers) {
    if (!seen.has(n.id)) groups.push(orderOf(n.id))
  }

  const consumers = (id) => {
    const out = []
    for (const [cid, node] of Object.entries(nodes)) {
      if (cid === id) continue
      for (const v of Object.values(node?.inputs || {})) {
        if (isLinkValue(v) && String(v[0]) === id && v[1] === 0) {
          out.push({
            id: cid,
            cls: String(node?.class_type || ''),
            title: node?._meta?.title || '',
          })
        }
      }
    }
    return out
  }

  return groups
    .map((idsInChain) => {
      const members = idsInChain.map((id) => byId.get(id)).filter(Boolean)
      const memberIds = new Set(idsInChain)
      const tail = idsInChain[idsInChain.length - 1]
      const end = consumers(tail).find((c) => !memberIds.has(c.id)) || null
      return {
        ids: idsInChain,
        nodes: members,
        chained: idsInChain.length > 1,
        connected: !!end,
        end,
        enabled: members.reduce((sum, n) => sum + n.activeCount, 0),
        total: members.reduce((sum, n) => sum + n.count, 0),
      }
    })
    .sort((a, b) => Number(b.chained) - Number(a.chained) || Number(b.connected) - Number(a.connected))
})

const inNode = computed(() => state.nodes?.[state.inId] || null)
const inFieldsAll = computed(() => writableFields(inNode.value))
const inFieldMeta = computed(() => inFieldsAll.value.find((f) => f.key === state.inField) || null)
const inValue = computed(() =>
  inNode.value && state.inField ? inNode.value.inputs?.[state.inField] : ''
)

const promptKey = computed(() =>
  state.inId && state.inField ? `${state.inId}:${state.inField}` : ''
)
const promptText = computed({
  get: () => (promptKey.value ? state.textDrafts[promptKey.value] ?? '' : ''),
  set: (v) => {
    if (!promptKey.value) return
    state.textDrafts = { ...state.textDrafts, [promptKey.value]: v }
  },
})

/** 当前字段的编辑值：文本用提示词草稿，数字/开关/下拉用 fieldDrafts */
const fieldDraft = computed({
  get: () => {
    const f = inFieldMeta.value
    if (!f || !promptKey.value) return ''
    if (f.type === 'text') return state.textDrafts[promptKey.value] ?? ''
    const d = state.fieldDrafts[promptKey.value]
    return d === undefined ? f.value : d
  },
  set: (v) => {
    const f = inFieldMeta.value
    if (!f || !promptKey.value) return
    if (f.type === 'text') {
      promptText.value = v
      return
    }
    state.fieldDrafts = { ...state.fieldDrafts, [promptKey.value]: v }
  },
})

const TYPE_LABEL = { text: '文本', number: '数字', bool: '开关', enum: '下拉' }

function typeLabel(type) {
  return TYPE_LABEL[type] || type
}

function fieldLabel(f) {
  if (f.type === 'text') return '新提示词'
  if (f.type === 'number') return `数值 · ${f.key}`
  if (f.type === 'bool') return `开关 · ${f.key}`
  return `取值 · ${f.key}`
}

function fieldHint(f) {
  if (f.type === 'text') return '留空则沿用当前值'
  if (f.type === 'number') return '留空则沿用当前值，发送时按数字写入'
  if (f.type === 'bool') return '切换开关，发送时按 true / false 写入'
  return '从候选里挑一个，发送时按原类型写入'
}

/** 数字框：清空当「不改」，其它按数字存 */
function setFieldNumber(event) {
  const raw = event.target.value
  fieldDraft.value = raw === '' ? '' : Number(raw)
}

/* ---------------------------------------------------------------- KSampler 参数 */
// 允许在 UI 上直接改的采样参数（其余如 model / positive 是连线，不碰）
const EDITABLE_SAMPLER = /^(steps|cfg|sampler_name|scheduler|denoise|seed|noise_seed|start_at_step|end_at_step|add_noise|return_with_leftover_noise)$/i

const samplerNodes = computed(() =>
  nodeList.value.filter((n) => /KSampler|SamplerCustom/i.test(n.cls))
)

const samplerFields = computed(() => {
  const node = state.nodes?.[state.samplerId]
  if (!node) return []
  const out = []
  for (const [key, val] of Object.entries(node.inputs || {})) {
    if (!EDITABLE_SAMPLER.test(key)) continue
    const t = typeof val
    if (t !== 'number' && t !== 'string' && t !== 'boolean') continue
    out.push({ key, type: t, options: state.samplerOptions[key] || null })
  }
  return out
})

function initSamplerParams(id) {
  const node = state.nodes?.[id]
  state.samplerParams = {}
  if (!node) {
    state.samplerOptions = {}
    return
  }
  for (const [key, val] of Object.entries(node.inputs || {})) {
    if (!EDITABLE_SAMPLER.test(key)) continue
    // 统一成「值的数组」：长度 1 就是单值，多个就是参与批量对比
    if (typeof val === 'boolean') state.samplerParams[key] = val
    else if (['number', 'string'].includes(typeof val)) state.samplerParams[key] = [val]
  }
  loadSamplerOptions(node.class_type)
}

/** sampler_name / scheduler 的候选值从 /object_info 拿 */
async function loadSamplerOptions(cls) {
  if (!cls) return
  try {
    const info = await apiGet('/object_info/' + encodeURIComponent(cls))
    const required = info?.[cls]?.input?.required || {}
    const opts = {}
    for (const key of ['sampler_name', 'scheduler']) {
      const def = required[key]
      if (Array.isArray(def) && Array.isArray(def[0])) opts[key] = def[0]
    }
    state.samplerOptions = opts
  } catch {
    state.samplerOptions = {}
  }
}

/** 输入节点各字段的候选值（下拉）也从 /object_info 拿，按 class_type 缓存 */
async function loadNodeOptions(cls) {
  if (!cls || state.nodeOptions[cls]) return
  try {
    const info = await apiGet('/object_info/' + encodeURIComponent(cls))
    const def = info?.[cls]?.input || {}
    const opts = {}
    for (const group of ['required', 'optional']) {
      for (const [key, spec] of Object.entries(def[group] || {})) {
        // 老格式 ["a","b"]，新格式 ["COMBO", { options: [...] }]
        if (Array.isArray(spec) && Array.isArray(spec[0])) opts[key] = spec[0]
        else if (Array.isArray(spec) && Array.isArray(spec[1]?.options)) opts[key] = spec[1].options
      }
    }
    state.nodeOptions = { ...state.nodeOptions, [cls]: opts }
  } catch {
    /* 拿不到候选就当普通文本框，不影响写入 */
  }
}

/* ------------------------------- 多值编辑 ------------------------------- */
function valuesOf(key) {
  const v = state.samplerParams[key]
  if (Array.isArray(v)) return v
  return v === undefined || v === null ? [] : [v]
}

function addValue(field) {
  const list = valuesOf(field.key)
  if (field.type === 'string' && field.options?.length) {
    // 下拉类加一个还没选中的候选
    const next = field.options.find((o) => !list.includes(o))
    if (next === undefined) return
    state.samplerParams[field.key] = [...list, next]
  } else {
    const last = list[list.length - 1]
    state.samplerParams[field.key] = [...list, field.type === 'number' ? Number(last) || 0 : last ?? '']
  }
}

function removeValue(field, index) {
  const list = valuesOf(field.key)
  if (list.length <= 1) return
  state.samplerParams[field.key] = list.filter((_, i) => i !== index)
}

function setValueAt(field, index, value) {
  const list = [...valuesOf(field.key)]
  list[index] = value
  state.samplerParams[field.key] = list
}

/** 从下拉里挑一个候选，追加到多值列表 */
function addOptionValue(field, value) {
  if (!value) return
  const list = valuesOf(field.key)
  if (list.includes(value)) return
  state.samplerParams[field.key] = [...list, value]
}

/** 下拉选完后先归位再追加：Vue 重渲染 options 时不会把 value 顶到第一项 */
function pickAddOption(field, event) {
  const value = event.target.value
  event.target.value = ''
  if (value) addOptionValue(field, value)
}

/** 下拉里只列「还没添加过」的候选，避免选了没反应 */
function remainingOptions(field) {
  const list = valuesOf(field.key)
  return (field.options || []).filter((o) => !list.includes(o))
}

/** 多值收回成单值：只留第一个，控件变回普通下拉 */
function collapseValues(field) {
  const list = valuesOf(field.key)
  if (list.length <= 1) return
  state.samplerParams[field.key] = [list[0]]
}

function shortKey(key) {
  return String(key)
    .replace('sampler_name', 'sampler')
    .replace('scheduler', 'sched')
    .replace('noise_seed', 'seed')
}

function statusLabel(status) {
  return {
    pending: '等待',
    running: '生成中…',
    empty: '无图',
    error: '失败',
    done: '',
  }[status] || ''
}

function randomizeSamplerSeed() {
  for (const key of ['seed', 'noise_seed']) {
    if (Array.isArray(state.samplerParams[key])) {
      state.samplerParams[key] = [Math.floor(Math.random() * 1e15)]
    }
  }
}

/* ------------------------------- 参数收藏 ------------------------------- */
const PRESET_KEY = 'comfy-runui.presets'

function loadPresets() {
  try {
    const arr = JSON.parse(localStorage.getItem(PRESET_KEY) || '[]')
    state.presets = Array.isArray(arr) ? arr : []
  } catch {
    state.presets = []
  }
}

function persistPresets() {
  localStorage.setItem(PRESET_KEY, JSON.stringify(state.presets))
}

function savePreset(name) {
  const n = String(name || '').trim()
  if (!n) return
  const payload = {
    name: n,
    params: JSON.parse(JSON.stringify(state.samplerParams)),
    samplerClass: state.nodes?.[state.samplerId]?.class_type || '',
    updatedAt: Date.now(),
  }
  const exist = state.presets.find((p) => p.name === n)
  if (exist) Object.assign(exist, payload)
  else state.presets.push({ id: `p${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, isDefault: false, ...payload })
  persistPresets()
  state.showSavePreset = false
  state.presetName = ''
  state.message = exist ? `已更新收藏「${n}」` : `已收藏「${n}」`
}

function applyPreset(preset, silent = false) {
  const node = state.nodes?.[state.samplerId]
  if (!node) return
  const inputs = node.inputs || {}
  // 以工作流原始参数为底再叠加收藏值：收藏里缺某个字段时，那个控件也不会凭空消失
  const base = state.samplerBaseline || state.samplerParams || {}
  const next = JSON.parse(JSON.stringify(base))
  for (const [key, val] of Object.entries(preset.params || {})) {
    if (key in inputs) next[key] = JSON.parse(JSON.stringify(val))
  }
  // 兜底：原始值里也没有的字段（比如后加的 noise_seed）按节点当前值补上
  for (const [key, val] of Object.entries(inputs)) {
    if (!EDITABLE_SAMPLER.test(key) || next[key] !== undefined) continue
    if (typeof val === 'boolean') next[key] = val
    else if (['number', 'string'].includes(typeof val)) next[key] = [val]
  }
  state.samplerParams = next
  if (!silent) state.message = `已应用收藏「${preset.name}」`
}

/** 破坏性操作统一走这个确认弹窗 */
function openDialog(options) {
  state.dialog = {
    title: '',
    text: '',
    confirmText: '确定',
    danger: false,
    ...options,
  }
}

function closeDialog() {
  state.dialog = null
}

function runDialogConfirm() {
  const d = state.dialog
  state.dialog = null
  d?.onConfirm?.()
}

/** 点收藏的 × → 弹窗确认 */
function askDeletePreset(id) {
  const preset = state.presets.find((p) => p.id === id)
  if (!preset) return
  openDialog({
    title: '删除收藏',
    text: `确定删除收藏「${preset.name}」吗？删除后无法恢复。`,
    confirmText: '删除',
    danger: true,
    onConfirm: () => deletePreset(id),
  })
}

function deletePreset(id) {
  const target = state.presets.find((p) => p.id === id)
  state.presets = state.presets.filter((p) => p.id !== id)
  persistPresets()
  state.message = `已删除收藏「${target?.name || ''}」`
}

function toggleDefaultPreset(id) {
  const cur = state.presets.find((p) => p.id === id)
  const makeDefault = !cur?.isDefault
  for (const p of state.presets) p.isDefault = makeDefault && p.id === id
  persistPresets()
  state.message = makeDefault ? `默认收藏：${cur?.name}` : '已取消默认收藏'
}

/** 恢复成这个工作流刚载入时的原始参数 */
function resetSamplerParams() {
  if (!state.samplerBaseline) return
  state.samplerParams = JSON.parse(JSON.stringify(state.samplerBaseline))
  state.message = '已恢复工作流原始参数'
}

/* ------------------------------- 组合与变体 ------------------------------- */
/** 多值参数 + 单值参数 → 笛卡尔积，每一组就是一次要跑的任务 */
const variants = computed(() => {
  const fields = samplerFields.value
  if (!fields.length) return []
  const multi = []
  const base = {}
  for (const f of fields) {
    if (f.type === 'boolean') {
      base[f.key] = !!state.samplerParams[f.key]
      continue
    }
    const vals = valuesOf(f.key).filter((v) => v !== '' && v !== null && v !== undefined)
    if (!vals.length) continue
    if (vals.length > 1) multi.push({ key: f.key, values: vals })
    else base[f.key] = vals[0]
  }

  let combos = [{ ...base }]
  for (const m of multi) {
    const next = []
    for (const c of combos) {
      for (const v of m.values) next.push({ ...c, [m.key]: v })
    }
    combos = next
  }

  return combos.map((params, index) => ({
    index,
    params,
    // 只列出「这一维在变」的参数，用来在对图上做标注
    changed: multi.map((m) => ({ key: m.key, value: params[m.key] })),
  }))
})

const multiDims = computed(() => {
  const out = []
  for (const f of samplerFields.value) {
    if (f.type === 'boolean') continue
    const n = valuesOf(f.key).filter((v) => v !== '').length
    if (n > 1) out.push({ key: f.key, n })
  }
  return out
})

const canBatch = computed(() => canSend.value && variants.value.length > 1)

const statusText = computed(() => {
  if (state.status === 'loading') return '读取中'
  if (state.status === 'error') return '未连接'
  if (state.status === 'ready') return '已连接'
  return '待连接'
})

const canSend = computed(() => !!state.inId && !!state.inField && !state.submitting)

watch(
  () => state.inId,
  (id) => {
    const node = state.nodes?.[id]
    if (!node) {
      state.inField = ''
      return
    }
    loadNodeOptions(node.class_type)
    const keys = writableFields(node).map((f) => f.key)
    if (!keys.includes(state.inField)) state.inField = defaultField(node)
  }
)

function randomizeSeeds(nodes) {
  for (const node of Object.values(nodes)) {
    const inputs = node?.inputs || {}
    for (const key of ['seed', 'noise_seed']) {
      if (typeof inputs[key] === 'number') {
        inputs[key] = Math.floor(Math.random() * 1e15)
      }
    }
  }
}

/** 合法的节点连接：["58", 0] */
function isLinkValue(v) {
  return (
    Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number'
  )
}

/**
 * 关键：ComfyUI 默认把数组当成节点连接 [node_id, slot_index]，其余数组会被判定为非法 link。
 * 所以「值是 list 的 widget」（典型：Lora Stacker (LoraManager) 的 loras）必须包一层
 * {"__value__": [...]} 才能通过校验 —— execution.py 里专门有这个解包逻辑，
 * 注释写着 "This is used to pass list widget values to execution"。
 *
 * history 里保存的是解包之后的裸数组，直接拿来重新提交就会退化成非法连接，
 * 于是 ComfyUI 报 bad_linked_input，依赖它的输出被 "Output will be ignored" 丢掉。
 */
function wrapListWidgets(nodes) {
  let count = 0
  for (const node of Object.values(nodes)) {
    const inputs = node?.inputs || {}
    for (const key of Object.keys(inputs)) {
      const v = inputs[key]
      if (Array.isArray(v) && !isLinkValue(v)) {
        inputs[key] = { __value__: v }
        count += 1
      }
    }
  }
  return count
}

/**
 * 从输出节点反向 BFS，看 errorNode 在不在它的依赖链上。
 * ComfyUI 校验失败会让依赖它的输出整个被丢掉，日志里是
 * "Failed to validate prompt for output 62 / Output will be ignored"。
 */
function reachesOutput(nodes, errorNode, outNode) {
  if (!outNode) return false
  const target = String(errorNode)
  const seen = new Set()
  const stack = [String(outNode)]
  while (stack.length) {
    const cur = stack.pop()
    if (cur === target) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const v of Object.values(nodes?.[cur]?.inputs || {})) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string') stack.push(String(v[0]))
    }
  }
  return false
}

/**
 * ComfyUI 的 node_errors 是节点级校验信息，要分两种看：
 *   blocking = true  → 该节点在绑定输出的依赖链上，ComfyUI 会把这个输出直接忽略，本次不出图
 *   blocking = false → 只影响它自己那条支路，绑定的输出照常执行
 * 典型来源：Lora Stacker (LoraManager) 把 loras 声明成 ("LORAS", {}) 连接类型，
 * 但前端做成了 widget，提交时进的是 LoRA 对象数组，被核心校验判为非法 link。
 */
function parseNodeErrors(nodeErrors, nodes, outId) {
  const out = []
  for (const [nid, info] of Object.entries(nodeErrors || {})) {
    const cls = nodes?.[nid]?.class_type || ''
    const errs = info?.errors || []
    for (const e of errs) {
      out.push({
        node: nid,
        cls,
        field: e?.extra_info?.input_name || e?.details || '',
        type: e?.type || '',
        message: e?.message || '',
        blocking: reachesOutput(nodes, nid, outId),
      })
    }
  }
  return out
}

/** 自动挑一个「最像提示词输入」的节点：优先裸文本容器，避开 NSFWPromptSelector 这类多项选择器 */
function pickInputNode(list) {
  if (!list.length) return null
  const plain = list.filter((n) => !/Selector|Random|Preset/i.test(n.cls))
  const pool = plain.length ? plain : list
  return (
    pool.find((n) => /^PrimitiveString/i.test(n.cls)) ||
    pool.find((n) => /CLIPTextEncode/i.test(n.cls)) ||
    pool.find((n) => n.fields.length === 1 && ['text', 'prompt', 'value'].includes(n.fields[0])) ||
    pool[0]
  )
}

function applyPicked(picked) {
  state.nodes = picked.nodes || {}
  state.entry = picked.entry || null
  state.source = picked.source || ''
  state.sourcePromptId = picked.promptId || ''

  // ComfyUI 前端提交时会带 extra_pnginfo.workflow。lumi-batcher、LoraManager、
  // 预览/保存节点缺了它会报 "extra_pnginfo[0] is not a dict or missing 'workflow' key"。
  // 但把原作业的完整 workflow 原样塞回去又会让 lumi-batcher 把这次执行当成批处理子任务
  // （它 monkey patch 了 PromptQueue.task_done，会按 output_nodes 改写 outputs，
  // 结果 PreviewImage 的图就丢了），所以这里只放一个最小骨架：够用，且不带批处理配置。
  const hasExtra = !!picked.entry?.prompt?.[3]?.extra_pnginfo
  state.extraData = hasExtra
    ? {
        extra_pnginfo: {
          workflow: {
            id: picked.promptId || '',
            revision: 0,
            last_node_id: 0,
            last_link_id: 0,
            nodes: [],
            links: [],
            groups: [],
            config: {},
            extra: {},
            version: 0.4,
          },
        },
      }
    : null

  const lastOut = outNodes.value[outNodes.value.length - 1]
  state.outId = lastOut ? lastOut.id : ''
  const preferred = pickInputNode(wiredTextNodes.value)
  state.inField = ''
  chooseInputNode(preferred ? preferred.id : '')

  // 自动绑第一个 KSampler，并把它当前的采样参数读出来
  const firstSampler = samplerNodes.value[0]
  state.samplerId = firstSampler ? firstSampler.id : ''
  initSamplerParams(state.samplerId)
  // 记下原始值，供「恢复原始」用；有默认收藏就直接套上去
  state.samplerBaseline = JSON.parse(JSON.stringify(state.samplerParams))
  const defPreset = state.presets.find((p) => p.isDefault)
  if (defPreset) applyPreset(defPreset, true)

  // 带上这个作业已经出过的图，进来就能看到上次的结果
  const all = picked.entry ? collectImages(picked.entry, '') : []
  const mine = all.filter((img) => img.nodeId === state.outId)
  state.images = mine.length ? mine : all

  // LoRA 堆叠浮层：重新绑定节点，并记一份原值给「恢复原值」
  const stacks = loraNodes.value
  if (!stacks.some((n) => n.id === state.loraId)) state.loraId = stacks[0]?.id || ''
  state.loraBaseline = {}
  for (const n of stacks) {
    state.loraBaseline[n.id] = JSON.parse(
      JSON.stringify(loraList(state.nodes[n.id].inputs.loras) || [])
    )
  }
  state.clipboardOff = {}
  state.textDrafts = {}
  state.fieldDrafts = {}
  state.message = ''
}

async function loadJobs() {
  try {
    const data = await apiGet('/api/jobs?limit=25')
    state.jobs = (data.jobs || []).map((j) => ({
      id: j.id,
      status: j.status,
      time: j.create_time,
    }))
  } catch {
    state.jobs = []
  }
}

async function loadWorkflow(promptId) {
  state.status = 'loading'
  state.message = ''
  try {
    if (promptId) {
      const history = await fetchHistory(promptId)
      const got = nodesFromHistoryEntry(history[promptId])
      if (!got) throw new Error('这个作业没有留下节点图（可能已被历史清理）')
      applyPicked({ ...got, source: '选中的作业', entry: history[promptId] })
    } else {
      applyPicked(await fetchCurrentWorkflow())
    }
    state.status = 'ready'
  } catch (err) {
    state.status = 'error'
    state.message = err.message || String(err)
  }
}

async function refreshAll() {
  await loadWorkflow()
  await loadJobs()
}

/* ------------------------------------------------------------ LoRA 堆叠浮层 */
// 面板固定在视口右下角，开关状态与选中的节点跨会话记住
function toggleLora() {
  state.showLora = !state.showLora
  localStorage.setItem('runui.loraOpen', state.showLora ? '1' : '0')
}

function closeLora() {
  state.showLora = false
  localStorage.setItem('runui.loraOpen', '0')
}

function selectLoraNode(id) {
  state.loraId = id
  if (id) localStorage.setItem('runui.loraNode', id)
}

/** 写回当前作业的节点图：下一次「发送」由 buildNodes() 带出去 */
function updateLoras(list) {
  const node = state.nodes?.[state.loraId]
  if (!node?.inputs) return
  const next = Array.isArray(list) ? list : []
  // 保留原包装形态；即使写成裸数组，提交前 wrapListWidgets 也会再包上
  const cur = node.inputs.loras
  node.inputs.loras =
    cur && !Array.isArray(cur) && Array.isArray(cur.__value__) ? { ...cur, __value__: next } : next
}

function resetLoras() {
  const base = state.loraBaseline?.[state.loraId]
  if (!Array.isArray(base)) return
  updateLoras(JSON.parse(JSON.stringify(base)))
}

function applyPrefix() {
  setPrefix(state.prefix)
  state.prefix = getPrefix()
  refreshAll()
}

/**
 * 把被禁用的「剪切板获取」从输出链路上摘掉：
 * 文本口置空字符串，图片口换成一模一样的空图节点（仅存在于本次提交的副本里）。
 */
function applyClipboardToggles(nodes) {
  const off = state.clipboardOff || {}
  const disabled = Object.keys(off).filter((id) => off[id] && nodes[id])
  if (!disabled.length) return

  let emptyImageId = ''
  const emptyImage = () => {
    if (emptyImageId) return emptyImageId
    let maxId = 0
    for (const id of Object.keys(nodes)) {
      const n = Number(id)
      if (Number.isFinite(n) && n > maxId) maxId = n
    }
    let next = maxId + 1
    while (nodes[String(next)]) next += 1
    emptyImageId = String(next)
    nodes[emptyImageId] = {
      class_type: 'EmptyImage',
      inputs: { width: 512, height: 512, batch_size: 1, color: 0 },
      _meta: { title: '空图（剪切板已禁用）' },
    }
    return emptyImageId
  }

  for (const id of disabled) {
    for (const node of Object.values(nodes)) {
      for (const [key, v] of Object.entries(node?.inputs || {})) {
        if (!isLinkValue(v) || String(v[0]) !== id) continue
        if (v[1] === 0) node.inputs[key] = ''
        else if (v[1] === 1) node.inputs[key] = [emptyImage(), 0]
      }
    }
  }
}

/** 组一份可提交的节点图：写提示词 + 这一组采样参数 */
function buildNodes(params, opts = {}) {
  const nodes = JSON.parse(JSON.stringify(state.nodes))
  const node = nodes[state.inId]
  if (!node) throw new Error(`节点 ${state.inId} 不存在于当前工作流`)
  // 留空的字段沿用当前值，所以只写「动过」的那些
  applyDrafts(nodes)

  const sampler = nodes[state.samplerId]
  if (sampler?.inputs) {
    for (const [key, val] of Object.entries(params || {})) {
      if (key in sampler.inputs) sampler.inputs[key] = val
    }
  }
  // 批量对比时必须固定 seed，否则差异里混着种子噪声，比不出东西
  if (state.randomSeed && !opts.fixedSeed) randomizeSeeds(nodes)
  applyClipboardToggles(nodes)
  wrapListWidgets(nodes)
  return nodes
}

/** 把草稿写回节点图：文本按字符串、数字/开关/下拉按原类型，空值跳过 */
function applyDrafts(nodes) {
  for (const [key, raw] of Object.entries(state.textDrafts)) {
    if (!String(raw || '').trim()) continue
    const [target, field] = draftTarget(nodes, key)
    if (target?.inputs && typeof target.inputs[field] === 'string') {
      target.inputs[field] = raw
    }
  }
  for (const [key, val] of Object.entries(state.fieldDrafts)) {
    if (val === undefined || val === null || val === '') continue
    const [target, field] = draftTarget(nodes, key)
    if (target?.inputs && field in target.inputs) target.inputs[field] = val
  }
}

function draftTarget(nodes, key) {
  const sep = key.lastIndexOf(':')
  if (sep <= 0) return [null, '']
  return [nodes[key.slice(0, sep)], key.slice(sep + 1)]
}

async function send() {
  if (state.submitting) return
  if (state.comparing) {
    state.failed = false
    state.message = '正在批量对比，先停止或等它跑完再发送'
    return
  }
  if (!state.inId || !state.inField) {
    state.failed = true
    state.message = '先选好输入节点和写入字段'
    return
  }
  // 发送数量：同一套设置连着跑几遍（开随机 seed 时每遍都不一样）
  const times = Math.max(1, Math.min(50, Math.round(Number(state.sendCount) || 1)))

  state.submitting = true
  state.running = false
  state.stopFlag = false
  state.elapsed = 0
  state.warnings = []
  state.showWarnings = false
  state.failed = false
  state.results = []
  state.message = '正在提交…'
  const collected = []
  let done = 0
  let nodes = null
  try {
    for (let i = 0; i < times; i += 1) {
      // 每遍单独组图，随机 seed 才会重新抽
      nodes = buildNodes(variants.value[0]?.params || {})
      const resp = await submitPrompt(nodes, state.extraData ? { extra_data: state.extraData } : {})
      state.runPromptId = resp.prompt_id
      // 提交途中按了停止：把刚提交的这个也掐掉，别留在 ComfyUI 里跑
      if (state.stopFlag) await stopRun()
      const warnings = parseNodeErrors(resp.node_errors, nodes, state.outId)
      if (!i) state.warnings = warnings
      const blocking = warnings.filter((w) => w.blocking)
      if (blocking.length) {
        state.failed = true
        state.message =
          `已入队，但节点 ${blocking.map((w) => w.node).join(' / ')} 挡住了输出 ` +
          `${state.outId} —— ComfyUI 会把该输出整个忽略，本次不会出图（日志里是 "Output will be ignored"）`
      } else if (warnings.length) {
        state.message = `已入队 · ${warnings.length} 条校验警告（不影响绑定输出）`
      } else {
        state.message =
          times > 1 ? `已入队（第 ${i + 1}/${times} 次），等待执行…` : '已入队，等待执行…'
      }

      const res = await waitResult(resp.prompt_id)
      done = i + 1
      if (res.images.length) {
        collected.push(...res.images)
        state.images = [...collected]
      }
      if (res.stopped) {
        state.message = `已停止 · 共 ${collected.length} 张图`
        break
      }
      if (res.failed) break
      if (times > 1 && res.images.length) {
        state.message = `第 ${done}/${times} 次完成 · 累计 ${collected.length} 张图`
      }
    }
    if (times > 1 && !state.failed && !state.stopFlag) {
      state.message = `已发送 ${done} 次 · 共 ${collected.length} 张图`
    }
  } catch (err) {
    state.failed = true
    state.message = err.message || String(err)
    if (err.nodeErrors) {
      state.warnings = parseNodeErrors(err.nodeErrors, nodes, state.outId)
      state.showWarnings = true
    }
  } finally {
    state.submitting = false
    state.running = false
  }
}

/** 等一个 prompt 出图；返回 { images, entry, failed }（被取消 / 失败 / 超时返回 failed: true） */
async function waitImages(promptId, timeoutMs = 15 * 60 * 1000) {
  const started = Date.now()
  let tick = 0
  while (Date.now() - started < timeoutMs) {
    if (state.stopFlag) throw new Error('已停止')
    const history = await fetchHistory(promptId)
    const entry = history[promptId]
    if (entry?.status?.completed) {
      return { images: collectImages(entry, state.outId), entry }
    }
    tick += 1
    if (tick % 3 === 0) {
      const job = await apiGet('/api/jobs/' + promptId).catch(() => null)
      if (job?.status === 'cancelled') throw new Error('被取消')
      if (job?.status === 'failed') throw new Error('执行失败')
    }
    await sleep(800)
  }
  throw new Error('等待超时')
}

/** 批量对比：按笛卡尔积逐组串行提交，跑完一组再跑下一组，seed 固定 */
async function sendBatch() {
  const list = variants.value
  if (!list.length || !canSend.value) return

  state.results = list.map((v) => ({
    index: v.index,
    params: v.params,
    changed: v.changed,
    status: 'pending',
    images: [],
    error: '',
    promptId: '',
    ms: 0,
  }))
  state.comparing = true
  state.stopFlag = false
  state.failed = false
  state.progress = { done: 0, total: list.length }
  state.message = `开始对比：${list.length} 组（seed 固定，只变你勾的维度）`

  try {
    for (let i = 0; i < list.length; i += 1) {
      if (state.stopFlag) {
        state.message = `已停止 · 完成 ${i}/${list.length}`
        break
      }
      const r = state.results[i]
      r.status = 'running'
      const started = Date.now()
      try {
        const nodes = buildNodes(r.params, { fixedSeed: true })
        const resp = await submitPrompt(nodes, state.extraData ? { extra_data: state.extraData } : {})
        r.promptId = resp.prompt_id
        state.runPromptId = resp.prompt_id
        if (state.stopFlag) await stopRun()
        const { images } = await waitImages(resp.prompt_id)
        r.images = images
        r.status = images.length ? 'done' : 'empty'
      } catch (err) {
        r.status = 'error'
        r.error = err.message || String(err)
      }
      r.ms = Date.now() - started
      state.progress.done = i + 1
      state.message = `对比中 ${i + 1}/${list.length}`
    }
    const ok = state.results.filter((x) => x.images.length).length
    state.message = state.stopFlag
      ? `已停止 · 完成 ${ok}/${list.length} 张`
      : `对比完成 · ${ok}/${list.length} 张`
  } finally {
    state.comparing = false
  }
}

/** 停止：先掐掉 ComfyUI 里正在跑/还没跑的那个任务，再让本地轮询立刻退出 */
async function stopRun() {
  state.stopFlag = true
  state.message = '正在停止…'
  try {
    await interruptRun()
  } catch {
    /* 中断失败就只靠 stopFlag 收尾 */
  }
  if (state.runPromptId) {
    try {
      await deleteQueued([state.runPromptId])
    } catch {
      /* 已经在跑的任务删不掉，正常 */
    }
  }
}

async function waitResult(promptId) {
  state.running = true
  const started = Date.now()
  const timer = setInterval(() => {
    state.elapsed = Math.round((Date.now() - started) / 1000)
  }, 1000)
  let tick = 0
  try {
    while (Date.now() - started < 15 * 60 * 1000) {
      if (state.stopFlag) {
        state.message = '已停止'
        return { images: [], entry: null, stopped: true }
      }
      const history = await fetchHistory(promptId)
      const entry = history[promptId]
      if (entry) {
        const images = collectImages(entry, state.outId)
        if (images.length) {
          state.entry = entry
          state.message = `完成 · 用时 ${Math.round((Date.now() - started) / 1000)} 秒 · ${images.length} 张图`
          return { images, entry }
        }
        if (entry.status?.completed) {
          const outputs = entry.outputs || {}
          const withImg = Object.entries(outputs)
            .filter(([, v]) => (v?.images || []).length)
            .map(([k]) => k)
          state.message = state.outId
            ? `执行完成，但绑定的节点 ${state.outId} 没有图片输出` +
              (withImg.length ? `；本次有图的节点：${withImg.join(', ')}` : '；本次没有任何节点出图') +
              '，右侧保留的是上一次的图'
            : '执行完成，但没有任何图片输出（右侧保留的是上一次的图）'
          state.entry = entry
          return { images: [], entry }
        }
      }

      // 被取消 / 失败的作业不会写进 /history，只能靠 job 状态收尾，
      // 否则界面会一直停在「执行中」，发送按钮也一直禁用。
      tick += 1
      if (tick % 3 === 0) {
        try {
          const job = await apiGet('/api/jobs/' + promptId)
          const st = job?.status
          if (st === 'cancelled' || st === 'failed') {
            state.failed = true
            state.message =
              st === 'cancelled'
                ? `任务被取消（ComfyUI 里点了「取消当前任务」），共等待 ${Math.round((Date.now() - started) / 1000)} 秒`
                : '任务执行失败，去 ComfyUI 控制台看报错'
            return { images: [], entry: null, failed: true }
          }
        } catch {
          /* job 查不到就继续等 */
        }
      }

      await sleep(800)
    }
    state.failed = true
    state.message = '等待超时（15 分钟）'
    return { images: [], entry: null, failed: true }
  } finally {
    clearInterval(timer)
    state.running = false
  }
}

function fmtTime(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function shortId(id) {
  return id ? String(id).slice(0, 8) : ''
}

/* ------------------------------ 大图预览 ------------------------------ */
// 只列出真正出过图的组，翻页时不会停在占位格子上
const resultItems = computed(() => state.results.filter((r) => r.images.length))
/** 对比图网格的最小列宽：缩放百分比越大，单张图越大 */
const shotMin = computed(() => `${Math.round(240 * (state.resultZoom / 100))}px`)

/* ---------------- 单张图：适应可视区域 ----------------
 * 结果区只有一张图时，网格切成单列、左上对齐，图片**永远不超出可视区域**：
 *   缩放 100% = 刚好塞满可用高度/宽度里的较小者（完整可见，不滚动）
 *   往下拖 = 按比例缩小；单张图时滑块上限就是 100%，再大也没意义
 * 可用高度用 JS 量（clientHeight - 一行 figcaption），窗口变化时重算。
 */
const imagesEl = ref(null)
const imgFitH = ref(0)

const singleShot = computed(() => {
  if (state.results.length) return state.results.length === 1
  return state.images.length === 1
})

/** 单张图时缩放上限 100%：保证图不超出可见区域 */
const zoomMax = computed(() => (singleShot.value ? 100 : 200))
const zoomShown = computed(() => Math.min(state.resultZoom, zoomMax.value))

const fitStyle = computed(() => ({
  '--fit-h': imgFitH.value ? `${imgFitH.value}px` : '70vh',
  '--zoom': String(zoomShown.value / 100),
}))

function measureImages() {
  const el = imagesEl.value
  if (!el) return
  // 图片直接用满整个可视高度；底下那行文件名是浮层，不占图片尺寸
  imgFitH.value = Math.max(140, Math.round(el.clientHeight))
}

watch(
  [
    () => state.images.length,
    () => state.results.length,
    () => state.showResultImages,
    singleShot,
  ],
  async () => {
    await nextTick()
    measureImages()
  }
)

watch(
  () => state.resultZoom,
  (v) => localStorage.setItem('runui.resultZoom', String(v))
)

/* 「剪切板获取」节点：接入输出链路的才列出来，可在此单独启用/禁用 */
function clipboardFeedsOf(nodes, id) {
  const feeds = []
  for (const [cid, consumer] of Object.entries(nodes || {})) {
    if (cid === id) continue
    for (const [field, v] of Object.entries(consumer?.inputs || {})) {
      if (isLinkValue(v) && String(v[0]) === id) {
        feeds.push({
          id: cid,
          field,
          slot: v[1],
          label: String(consumer?._meta?.title || consumer?.class_type || cid),
        })
      }
    }
  }
  return feeds
}

const clipboardNodes = computed(() => {
  const nodes = state.nodes || {}
  const list = []
  for (const [id, node] of Object.entries(nodes)) {
    const cls = String(node?.class_type || '')
    const title = String(node?._meta?.title || '')
    if (!/^ClipboardNode$/i.test(cls) && !title.includes('剪切板获取')) continue

    const feeds = clipboardFeedsOf(nodes, id)
    list.push({
      id,
      cls,
      title,
      feeds,
      feedsText: feeds.map((f) => `${f.id} ${f.label}`).join('、'),
    })
  }
  return list
})

const clipboardOnCount = computed(
  () =>
    clipboardNodes.value.filter(
      (n) => n.feeds.length && !state.clipboardOff[n.id]
    ).length
)

function isClipboardOff(id) {
  if (state.clipboardOff[id]) return true
  // 上一轮禁用提交会把连线摘掉；刷新后靠「没有下游」识别成禁用
  return clipboardFeedsOf(state.nodes, id).length === 0
}

function saveClipboardLinks(id, feeds) {
  state.clipboardLinks = {
    ...state.clipboardLinks,
    [id]: feeds.map((f) => ({ id: f.id, field: f.field, slot: f.slot })),
  }
  localStorage.setItem('runui.clipboardLinks', JSON.stringify(state.clipboardLinks))
}

/** 从最近的作业里找回这个剪切板节点原来的下游连线（用于刷新后重新启用） */
async function findClipboardLinks(id) {
  try {
    const data = await apiGet('/api/jobs?limit=20')
    for (const job of data.jobs || []) {
      const history = await apiGet(`/history/${job.id}`)
      const got = nodesFromHistoryEntry(history[job.id])
      if (!got?.nodes) continue
      const feeds = clipboardFeedsOf(got.nodes, id)
      if (feeds.length) return feeds
    }
  } catch {
    /* 找不到就让用户回 ComfyUI 接 */
  }
  return []
}

function restoreClipboardLinks(id, links) {
  let restored = 0
  for (const f of links || []) {
    const consumer = state.nodes?.[f.id]
    if (consumer?.inputs && f.field in consumer.inputs) {
      consumer.inputs[f.field] = [id, f.slot]
      restored += 1
    }
  }
  return restored
}

async function toggleClipboard(id) {
  const feeds = clipboardFeedsOf(state.nodes, id)
  if (feeds.length && !state.clipboardOff[id]) {
    saveClipboardLinks(id, feeds)
    state.clipboardOff = { ...state.clipboardOff, [id]: true }
    return
  }

  // 连线可能已被上一轮提交摘掉，用记下的原连线补回来
  if (!feeds.length) {
    let restored = restoreClipboardLinks(id, state.clipboardLinks[id])
    if (!restored) {
      state.message = '正在找回这个剪切板节点的原始连线…'
      const saved = await findClipboardLinks(id)
      if (saved.length) saveClipboardLinks(id, saved)
      restored = restoreClipboardLinks(id, saved)
    }
    if (!restored) {
      state.failed = true
      state.message = '这个剪切板节点在当前工作流里没有下游连线，先在 ComfyUI 里接好再刷新'
      return
    }
    state.failed = false
    state.message = ''
  }
  state.clipboardOff = { ...state.clipboardOff, [id]: false }
}

/** 当前能打包的图片数：对比结果优先，否则单次结果 */
const downloadCount = computed(() =>
  state.results.length ? resultItems.value.length : state.images.length
)

function safeName(s) {
  return (
    String(s)
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 70) || 'img'
  )
}

/** 把当前结果打包成 zip 一次下载，文件名带上这组的参数，方便回来对号入座 */
async function downloadAll() {
  const items = state.results.length
    ? resultItems.value.map((r) => ({ img: r.images[0], tags: r.changed }))
    : state.images.map((img) => ({ img, tags: [] }))
  if (!items.length) return

  state.packing = true
  state.failed = false
  state.message = `正在打包 ${items.length} 张…`
  try {
    const zip = new JSZip()
    const folder = zip.folder('comfy-runui')
    for (let i = 0; i < items.length; i += 1) {
      const { img, tags } = items[i]
      const label = (tags || []).map((t) => `${shortKey(t.key)}=${t.value}`).join('_')
      const name = `${String(i + 1).padStart(2, '0')}${label ? `_${safeName(label)}` : ''}.png`
      const blob = await fetch(viewUrl(img)).then((r) => r.blob())
      folder.file(name, blob)
      state.message = `正在打包 ${i + 1}/${items.length}…`
    }
    const out = await zip.generateAsync({ type: 'blob' })
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(out)
    a.download = `comfy-runui-${stamp}.zip`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
    state.message = `已打包下载 ${items.length} 张`
  } catch (err) {
    state.failed = true
    state.message = `打包失败：${err?.message || err}`
  } finally {
    state.packing = false
  }
}

function openLightbox(items, index = 0, source = '') {
  if (!items.length) return
  state.lightbox = {
    items,
    index: Math.max(0, Math.min(index, items.length - 1)),
    source,
  }
}

function closeLightbox() {
  state.lightbox = null
}

function stepLightbox(delta) {
  const lb = state.lightbox
  if (!lb || lb.items.length < 2) return
  lb.index = (lb.index + delta + lb.items.length) % lb.items.length
}

/** 点某一张对比图：把它所在的那一批全部装进预览，方便左右翻 */
function openResult(index) {
  const list = resultItems.value
  const items = list.map((r) => ({
    img: r.images[0],
    tags: r.changed,
    ms: r.ms,
    promptId: r.promptId,
  }))
  const at = list.findIndex((r) => r.index === index)
  openLightbox(items, at < 0 ? 0 : at, 'results')
}

function openSingle(index) {
  openLightbox(
    state.images.map((img) => ({ img, tags: [], ms: 0, nodeId: img.nodeId })),
    index,
    'single'
  )
}

/** 对比模式下跑到新图：把它顶掉当前预览的那张 */
watch(
  () => resultItems.value.length,
  () => {
    const lb = state.lightbox
    if (!lb || lb.source !== 'results') return
    const items = resultItems.value.map((r) => ({
      img: r.images[0],
      tags: r.changed,
      ms: r.ms,
      promptId: r.promptId,
    }))
    if (!items.length) return
    const grew = items.length > lb.items.length
    lb.items = items
    lb.index = grew ? items.length - 1 : Math.min(lb.index, items.length - 1)
  }
)

/** 单次模式下新的图完成后，预览也跟着换成新图 */
watch(
  () => state.images,
  () => {
    const lb = state.lightbox
    if (!lb || lb.source !== 'single' || !state.images.length) return
    const items = state.images.map((img) => ({ img, tags: [], ms: 0, nodeId: img.nodeId }))
    // 末尾追加（发送数量 > 1）就跳到第一张新的，整批替换则从第一张开始
    const appended =
      lb.items.length > 0 &&
      lb.items.length < items.length &&
      lb.items.every((it, i) => items[i]?.img === it.img)
    const at = lb.items.length
    lb.items = items
    lb.index = appended ? at : 0
  }
)

function onLightboxKey(e) {
  if (state.themeOpen && e.key === 'Escape') {
    e.preventDefault()
    state.themeOpen = false
    return
  }
  // 弹窗打开时优先处理弹窗的键
  if (state.dialog) {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeDialog()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runDialogConfirm()
    }
    return
  }
  if (!state.lightbox) return
  if (e.key === 'ArrowLeft') {
    e.preventDefault()
    stepLightbox(-1)
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    stepLightbox(1)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeLightbox()
  }
}

/** 窗口尺寸变了，单张图的自适应高度要重算 */
function onWindowResize() {
  measureImages()
}

onMounted(() => {
  loadPresets()
  refreshAll()
  window.addEventListener('keydown', onLightboxKey)
  window.addEventListener('resize', onWindowResize)
  measureImages()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onLightboxKey)
  window.removeEventListener('resize', onWindowResize)
})
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="top-left">
        <div class="theme-pick">
          <button
            type="button"
            class="theme-btn"
            :title="`切换主题（当前：${currentTheme.label}）`"
            @click="state.themeOpen = !state.themeOpen"
          >
            <span class="theme-dot" :style="{ background: currentTheme.bg }">
              <i :style="{ background: currentTheme.accent }"></i>
            </span>
            <span class="theme-label">{{ currentTheme.label }}</span>
            <span class="theme-caret">▾</span>
          </button>
          <template v-if="state.themeOpen">
            <div class="theme-backdrop" @click="state.themeOpen = false"></div>
            <div class="theme-pop">
              <template v-for="group in THEME_GROUPS" :key="group.name">
                <p class="theme-group">{{ group.name }}</p>
                <button
                  v-for="t in group.items"
                  :key="t.id"
                  type="button"
                  class="theme-opt"
                  :class="{ on: state.theme === t.id }"
                  @click="setTheme(t.id)"
                >
                  <span class="theme-swatch">
                    <i :style="{ background: t.bg }"></i>
                    <i :style="{ background: t.accent }"></i>
                  </span>
                  <span class="theme-opt-name">{{ t.label }}</span>
                  <span v-if="state.theme === t.id" class="theme-check">✓</span>
                </button>
              </template>
            </div>
          </template>
        </div>
        <div class="brand">
          <span class="dot" :class="state.status"></span>
          <strong>ComfyUI RunUI</strong>
          <span class="hint">绑定节点 · 改提示词 · 收图</span>
        </div>
      </div>
      <div class="top-right">
        <span class="tag" :class="{ ok: state.status === 'ready', bad: state.status === 'error' }">
          {{ statusText }}
        </span>
        <button @click="state.showSettings = !state.showSettings">连接设置</button>
        <button @click="refreshAll">刷新工作流</button>
      </div>
    </header>

    <div v-if="state.showSettings" class="settings">
      <label class="label">ComfyUI 接口前缀（dev 默认 /comfy 走 vite 代理）</label>
      <div class="row">
        <input v-model="state.prefix" class="mono" type="text" placeholder="/comfy 或 http://127.0.0.1:8189" />
        <button class="primary" @click="applyPrefix">应用</button>
      </div>
      <p class="hint">直连完整地址需要 ComfyUI 启动时带 <code>--enable-cors-header</code>，否则用 /comfy 代理。</p>
    </div>

    <main class="grid">
      <section class="card col">
        <div class="card-head">
          <span>① 当前工作流</span>
          <span class="tag" v-if="state.nodes && Object.keys(state.nodes).length">
            {{ Object.keys(state.nodes).length }} 节点
          </span>
        </div>
        <div class="card-body tight">
          <div class="meta" v-if="state.sourcePromptId">
            <div><span class="hint">来源</span> {{ state.source }}</div>
            <div class="mono small">prompt {{ shortId(state.sourcePromptId) }}</div>
          </div>

          <label class="label" style="margin-top: 10px">切换到最近作业</label>
          <select
            :value="state.sourcePromptId"
            @change="loadWorkflow($event.target.value)"
          >
            <option value="">— 自动（当前/最近）—</option>
            <option v-for="j in state.jobs" :key="j.id" :value="j.id">
              {{ shortId(j.id) }} · {{ j.status }} · {{ fmtTime(j.time) }}
            </option>
          </select>

          <div class="list">
            <div
              v-for="n in nodeList"
              :key="n.id"
              class="node-row"
              :class="{ active: n.id === state.inId, out: n.id === state.outId }"
            >
              <span class="nid mono">{{ n.id }}</span>
              <span class="ncls" :title="n.title || n.cls">{{ n.cls }}</span>
              <span class="nbadges">
                <span v-if="n.fields.length" class="tag brand">文本</span>
                <span v-if="n.imageCount" class="tag ok">图 {{ n.imageCount }}</span>
                <span v-else-if="n.isSaver" class="tag">输出</span>
              </span>
              <span class="nact">
                <button v-if="n.allFields.length" @click="chooseInputNode(n.id)">入</button>
                <button v-if="n.isSaver || n.imageCount" @click="state.outId = n.id">出</button>
              </span>
            </div>
            <p v-if="!nodeList.length" class="hint">还没有载入工作流</p>
          </div>
        </div>
      </section>

      <div class="col stack">
        <section class="card grow">
          <div class="card-head"><span>② 绑定输入 · 改提示词</span></div>
          <div class="card-body">
          <!-- 剪切板获取：接入输出链路的才列出来，点击整条启用/禁用 -->
          <div class="clipbar" v-if="clipboardNodes.length">
            <span class="pkey">剪切板获取</span>
            <button
              v-for="n in clipboardNodes"
              :key="n.id"
              type="button"
              class="clip-chip"
              :class="{ off: isClipboardOff(n.id) }"
              :title="`${isClipboardOff(n.id) ? '点击启用' : '点击禁用'} · ${n.id} ${n.title || n.cls} ${n.feeds.length ? '→ ' + n.feedsText : '（无下游连线）'}`"
              @click="toggleClipboard(n.id)"
            >
              <span class="clip-box" aria-hidden="true">{{ isClipboardOff(n.id) ? '' : '✓' }}</span>
              <span class="clip-id mono">{{ n.id }}</span>
              <span class="clip-name">{{ n.title || n.cls }}</span>
              <span class="clip-to mono">{{ n.feeds.length ? `→ ${n.feedsText}` : '未接入' }}</span>
            </button>
            <span class="small clip-count mono">{{ clipboardOnCount }}/{{ clipboardNodes.length }} 启用</span>
          </div>

          <div class="in-pick">
            <div class="in-pick-head">
              <span class="label" style="margin: 0">输入节点</span>
              <span class="hint" style="margin: 0">已串联 {{ wiredTextNodes.length }} 个</span>
            </div>
            <div class="in-chips" v-if="wiredTextNodes.length">
              <button
                v-for="n in wiredTextNodes"
                :key="n.id"
                type="button"
                class="in-chip"
                :class="{ on: n.id === state.inId, dirty: isInputDirty(n.id) }"
                :title="`${n.id} · ${n.title || n.cls} · 可写字段：${n.allFields.join(' / ')}${isInputDirty(n.id) ? ' · 已修改（发送时会一并带上）' : ''}`"
                @click="chooseInputNode(n.id)"
              >
                <span class="mono">{{ n.id }}</span>
                <span class="in-title">{{ n.title || n.cls }}</span>
                <span v-if="isInputDirty(n.id)" class="in-dot" aria-hidden="true"></span>
              </button>
            </div>
            <p v-else class="hint" style="margin: 0">当前输出链路上没有可写文本的节点</p>
          </div>

          <label class="label" style="margin-top: 12px">写入字段</label>
          <select v-model="state.inField" :disabled="!inFieldsAll.length">
            <option v-if="!inFieldsAll.length" value="">该节点没有可写字段</option>
            <option v-for="f in inFieldsAll" :key="f.key" :value="f.key">
              {{ f.key }}（{{ typeLabel(f.type) }}）{{ draftDirty(`${state.inId}:${f.key}`) ? ' · 已改' : '' }}
            </option>
          </select>

          <p class="hint current" v-if="inValue !== '' && inValue !== null && inValue !== undefined">
            当前值：<span>{{ String(inValue).slice(0, 160) }}</span>
          </p>

          <template v-if="inFieldMeta">
            <label class="label" style="margin-top: 12px">{{ fieldLabel(inFieldMeta) }}</label>
            <!-- 按字段类型换控件：文本 / 下拉 / 数字 / 开关 -->
            <textarea
              v-if="inFieldMeta.type === 'text'"
              v-model="promptText"
              placeholder="输入要替换进去的提示词…"
            ></textarea>
            <select v-else-if="inFieldMeta.type === 'enum'" v-model="fieldDraft">
              <option
                v-if="fieldDraft && !inFieldMeta.options.includes(fieldDraft)"
                :value="fieldDraft"
              >
                {{ fieldDraft }}（当前值，不在候选里）
              </option>
              <option v-for="o in inFieldMeta.options" :key="o" :value="o">{{ o }}</option>
            </select>
            <input
              v-else-if="inFieldMeta.type === 'number'"
              type="number"
              step="any"
              :value="fieldDraft"
              placeholder="留空则不改"
              @input="setFieldNumber"
            />
            <label v-else class="check field-check">
              <input type="checkbox" v-model="fieldDraft" />
              <span>{{ fieldDraft ? '开' : '关' }}</span>
            </label>
            <p class="hint" style="margin: 6px 0 0">{{ fieldHint(inFieldMeta) }}</p>
          </template>

          <div class="send-row">
            <button
              class="primary"
              :class="{ sending: state.submitting }"
              @click="send"
            >
              {{ state.submitting ? '发送中…' : variants.length > 1 ? '发送第一组' : '发送到 ComfyUI' }}
            </button>
            <label class="count-field" title="一次点发送连着跑几遍；开随机 seed 时每遍的种子不同">
              <span>数量</span>
              <input
                v-model.number="state.sendCount"
                type="number"
                min="1"
                max="50"
                step="1"
                :disabled="state.submitting || state.comparing"
              />
            </label>
            <button
              v-if="variants.length > 1"
              class="compare-btn"
              :disabled="!canBatch || state.comparing"
              @click="sendBatch"
            >
              {{ state.comparing ? `对比中 ${state.progress.done}/${state.progress.total}` : `对比 ${variants.length} 组` }}
            </button>
            <button v-if="state.comparing || state.submitting" class="stop-btn" @click="stopRun">停止</button>
            <label class="check" style="margin: 0">
              <input v-model="state.randomSeed" type="checkbox" />
              <span>随机 seed</span>
            </label>
            <span class="hint" v-if="state.running && !state.comparing">执行中 · {{ state.elapsed }}s</span>
          </div>

          <p class="msg" v-if="state.message" :class="{ bad: state.failed }">{{ state.message }}</p>

          <div v-if="state.warnings.length" class="warnbox">
            <button class="warnhead" @click="state.showWarnings = !state.showWarnings">
              {{ state.showWarnings ? '收起' : '展开' }} {{ state.warnings.length }} 条校验警告
            </button>
            <ul class="warnlist" v-if="state.showWarnings">
              <li v-for="(w, i) in state.warnings" :key="i">
                节点 <b>{{ w.node }}</b> · {{ w.cls || '?' }}
                <span v-if="w.field"> · <code>{{ w.field }}</code></span>
                <span class="wtype">{{ w.type }}</span>
                <span v-if="w.blocking" class="tag bad">挡住输出 {{ state.outId }}，本次不出图</span>
                <span v-else class="tag ok">不在绑定输出路径上</span>
              </li>
            </ul>
            <p class="hint" v-if="state.showWarnings">
              多数情况是「list 型 widget 没包 <code>__value__</code>」造成的：ComfyUI 把数组当成节点连接，
              裸数组就会被判成非法 link，依赖它的输出会被直接忽略（日志：<code>Output will be ignored</code>）。
              本界面提交时会自动包装，出现这条说明有特殊情况，可以展开看看是哪个字段。
            </p>
          </div>
        </div>
        </section>

        <section class="card sampler-card">
          <div class="card-head">
            <span>③ 采样参数 · KSampler</span>
            <div class="head-actions">
              <span class="tag" v-if="samplerFields.length">{{ samplerFields.length }} 项</span>
              <button class="mini" @click="state.showSavePreset = !state.showSavePreset">
                ★ 收藏
              </button>
            </div>
          </div>
          <div class="card-body">
            <!-- 收藏列表：★ 设默认 / 点名字应用 / × 删除 -->
            <div class="preset-row" v-if="state.presets.length">
              <span class="pkey mono">收藏</span>
              <div class="preset-chips">
                <span
                  v-for="p in state.presets"
                  :key="p.id"
                  class="preset"
                  :class="{ def: p.isDefault }"
                >
                  <span
                    class="star"
                    :class="{ on: p.isDefault }"
                    :title="p.isDefault ? '取消默认' : '设为默认（载入工作流时自动套用）'"
                    @click="toggleDefaultPreset(p.id)"
                    >★</span
                  >
                  <span class="pname" title="点一下替换当前参数" @click="applyPreset(p)">{{
                    p.name
                  }}</span>
                  <span class="x" title="删除" @click.stop="askDeletePreset(p.id)">×</span>
                </span>
              </div>
            </div>

            <!-- 保存当前参数为收藏 -->
            <div class="preset-save" v-if="state.showSavePreset">
              <input
                v-model="state.presetName"
                placeholder="收藏名称，例如「FLUX 8步 低cfg」"
                @keyup.enter="savePreset(state.presetName)"
              />
              <button class="primary" @click="savePreset(state.presetName)">保存</button>
              <button @click="state.showSavePreset = false">取消</button>
            </div>

            <div class="node-pick">
              <span class="pkey mono">节点</span>
              <input v-model="state.samplerId" class="mono" type="text" placeholder="节点 id，例如 61" />
              <select
                v-if="samplerNodes.length"
                :value="state.samplerId"
                @change="state.samplerId = $event.target.value"
              >
                <option v-for="n in samplerNodes" :key="n.id" :value="n.id">
                  {{ n.id }} · {{ n.cls }}
                </option>
              </select>
            </div>

            <div class="params" v-if="samplerFields.length">
              <div class="prow" v-for="f in samplerFields" :key="f.key">
                <label class="pkey mono">
                  {{ shortKey(f.key) }}
                  <span v-if="f.type !== 'boolean' && valuesOf(f.key).length > 1" class="cnt">
                    ×{{ valuesOf(f.key).length }}
                  </span>
                </label>

                <!-- 布尔：只能单值 -->
                <input
                  v-if="f.type === 'boolean'"
                  v-model="state.samplerParams[f.key]"
                  type="checkbox"
                  class="cbox"
                />

                <!-- 枚举：只有一个值时就是普通下拉，能直接切换；点 + 才进多值对比 -->
                <div v-else-if="f.options" class="chips-edit">
                  <select
                    v-if="valuesOf(f.key).length === 1"
                    class="single-sel"
                    :value="valuesOf(f.key)[0]"
                    @change="setValueAt(f, 0, $event.target.value)"
                  >
                    <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
                  </select>

                  <template v-else>
                    <span v-for="(v, vi) in valuesOf(f.key)" :key="vi" class="chip on">
                      {{ v }}
                      <button class="x" title="移除" @click="removeValue(f, vi)">×</button>
                    </span>
                    <select
                      class="add-sel"
                      :disabled="!remainingOptions(f).length"
                      title="再添加一个候选值"
                      @change="pickAddOption(f, $event)"
                    >
                      <option value="">
                        {{ remainingOptions(f).length ? '＋ 添加' : '已全部添加' }}
                      </option>
                      <option v-for="o in remainingOptions(f)" :key="o" :value="o">{{ o }}</option>
                    </select>
                    <button
                      class="clear-all"
                      title="只保留第一个值，收回成普通下拉"
                      @click="collapseValues(f)"
                    >
                      清空
                    </button>
                  </template>

                  <button
                    v-if="valuesOf(f.key).length === 1"
                    class="add"
                    title="再加一个值，做横向对比"
                    @click="addValue(f)"
                  >
                    +
                  </button>
                </div>

                <!-- 数字 / 文本：多个值并排 -->
                <div v-else class="vals">
                  <div class="val" v-for="(v, vi) in valuesOf(f.key)" :key="vi">
                    <input
                      v-if="f.type === 'number'"
                      :value="v"
                      type="number"
                      step="any"
                      @input="setValueAt(f, vi, $event.target.value === '' ? '' : Number($event.target.value))"
                    />
                    <input v-else :value="v" type="text" @input="setValueAt(f, vi, $event.target.value)" />
                    <button
                      v-if="valuesOf(f.key).length > 1"
                      class="x"
                      title="移除"
                      @click="removeValue(f, vi)"
                    >
                      ×
                    </button>
                  </div>
                  <button class="add" title="再加一个值" @click="addValue(f)">+</button>
                </div>
              </div>
            </div>
            <p v-else class="hint">
              {{ state.samplerId ? '该节点没有可编辑的采样参数' : '当前工作流里没有 KSampler 节点' }}
            </p>

            <p class="hint combo-line" v-if="multiDims.length">
              组合 <b>{{ variants.length }}</b> 组：
              <span v-for="d in multiDims" :key="d.key" class="dim">{{ shortKey(d.key) }} ×{{ d.n }}</span>
              <br />批量对比时 seed 固定，只有你加多值的维度在变
            </p>

            <div class="send-row" style="margin-top: 6px">
              <button @click="randomizeSamplerSeed" :disabled="!samplerFields.some((f) => f.key === 'seed' || f.key === 'noise_seed')">
                随机 seed
              </button>
              <button :disabled="!state.samplerBaseline" @click="resetSamplerParams">
                恢复原始
              </button>
            </div>
            <p class="hint" style="margin: 6px 0 0">提交时只写回这些值，不碰任何连线</p>
          </div>
        </section>
      </div>

      <section class="card col">
          <div class="card-head result-head">
            <div class="head-left">
              <span>④ 对比结果</span>
              <!-- 输出节点绑定：不单独占一行，直接并进标题行 -->
              <label
                class="head-out"
                title="输出节点 ID。也可以点左侧节点列表里的「出」按钮直接绑定"
              >
                <span class="mono">输出</span>
                <input v-model="state.outId" class="mono" type="text" placeholder="例如 9" />
              </label>
            </div>
            <div class="head-actions">
              <span class="small">
                <span v-if="state.comparing" class="mono">
                  {{ state.progress.done }}/{{ state.progress.total }}
                </span>
                <span v-else-if="state.results.length" class="tag ok">
                  {{ state.results.filter((r) => r.images.length).length }} / {{ state.results.length }}
                </span>
              </span>
              <label class="zoom-ctl" title="缩放对比图大小（单张图最大 100%，不超出可视区域；点击图片仍可看大图）">
                <input
                  v-model.number="state.resultZoom"
                  type="range"
                  min="60"
                  :max="zoomMax"
                  step="10"
                  aria-label="缩放对比图"
                />
                <span class="mono zoom-val">{{ zoomShown }}%</span>
              </label>
              <button
                class="mini"
                :disabled="!downloadCount || state.packing || state.comparing"
                :title="downloadCount ? '把当前这些图打包成 zip 下载' : '还没有图片'"
                @click="downloadAll"
              >
                {{ state.packing ? '打包中…' : `⬇ 打包 ${downloadCount} 张` }}
              </button>
              <label class="img-toggle" title="关闭后只留参数和状态，图片区收起">
                <input v-model="state.showResultImages" type="checkbox" />
                <span>显示图片</span>
              </label>
            </div>
          </div>
          <div class="card-body" :style="{ '--shot-min': shotMin }">
            <!-- 批量对比结果 -->
            <template v-if="state.showResultImages">
              <div
                v-if="state.results.length"
                ref="imagesEl"
                class="images"
                :class="{ single: singleShot }"
                :style="fitStyle"
              >
                <figure
                  v-for="r in state.results"
                  :key="r.index"
                  class="shot cell"
                  :class="r.status"
                >
                  <div class="thumb" @click="r.images[0] && openResult(r.index)">
                    <img v-if="r.images[0]" :src="viewUrl(r.images[0])" :alt="String(r.index)" />
                    <div v-else class="ph">{{ statusLabel(r.status) }}</div>
                  </div>
                  <figcaption>
                    <span v-for="c in r.changed" :key="c.key" class="kv">
                      <em>{{ shortKey(c.key) }}</em>{{ c.value }}
                    </span>
                    <span v-if="r.ms" class="ms">{{ (r.ms / 1000).toFixed(1) }}s</span>
                    <span v-if="r.error" class="err">{{ r.error }}</span>
                  </figcaption>
                </figure>
              </div>

              <!-- 单次结果 / 历史图 -->
              <div v-else ref="imagesEl" class="images" :class="{ single: singleShot }" :style="fitStyle">
                <figure v-for="(img, i) in state.images" :key="i" class="shot">
                  <img :src="viewUrl(img)" :alt="img.filename" @click="openSingle(i)" />
                  <figcaption class="mono small">{{ img.nodeId }} · {{ img.filename }}</figcaption>
                </figure>
                <p v-if="!state.images.length" class="hint empty">
                  还没有图片。提交后会显示绑定节点输出的图；给采样参数填多个值就能横向对比。
                </p>
              </div>
            </template>
            <p v-else class="hint empty">图片已隐藏 · 右上角「显示图片」可以重新打开</p>
          </div>
      </section>
    </main>

    <!-- 固定右下角的 LoRA 堆叠浮层：可动态开关，改动写回当前工作流 -->
    <LoraPanel
      :open="state.showLora"
      :nodes="loraNodes"
      :chains="loraChains"
      :node-id="state.loraId"
      :loras="loraLoras"
      :baseline="state.loraBaseline[state.loraId] || null"
      @toggle="toggleLora"
      @close="closeLora"
      @select-node="selectLoraNode"
      @change="updateLoras"
      @reset="resetLoras"
    />

    <!-- 通用确认弹窗 -->
    <div v-if="state.dialog" class="modal" @click.self="closeDialog">
      <div class="modal-card">
        <h3>{{ state.dialog.title }}</h3>
        <p>{{ state.dialog.text }}</p>
        <div class="modal-actions">
          <button @click="closeDialog">取消</button>
          <button :class="state.dialog.danger ? 'danger' : 'primary'" @click="runDialogConfirm">
            {{ state.dialog.confirmText }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="state.lightbox" class="lightbox" @click.self="closeLightbox">
      <div
        v-if="state.lightbox.items.length > 1"
        class="lb-nav left"
        title="上一张（←）"
        @click.stop="stepLightbox(-1)"
      >
        ‹
      </div>
      <div
        v-if="state.lightbox.items.length > 1"
        class="lb-nav right"
        title="下一张（→）"
        @click.stop="stepLightbox(1)"
      >
        ›
      </div>

      <figure class="lb-figure">
        <img
          :src="viewUrl(state.lightbox.items[state.lightbox.index].img)"
          :alt="state.lightbox.items[state.lightbox.index].img.filename"
          @click="closeLightbox"
        />
        <figcaption>
          <div class="lb-tags">
            <span
              v-for="t in state.lightbox.items[state.lightbox.index].tags || []"
              :key="t.key"
              class="kv"
            >
              <em>{{ shortKey(t.key) }}</em>{{ t.value }}
            </span>
            <span
              v-if="!state.lightbox.items[state.lightbox.index].tags?.length"
              class="lb-note"
            >
              单张结果
            </span>
          </div>
          <div class="lb-meta">
            <span class="mono">{{ state.lightbox.items[state.lightbox.index].img.filename }}</span>
            <span v-if="state.lightbox.items[state.lightbox.index].ms">
              {{ (state.lightbox.items[state.lightbox.index].ms / 1000).toFixed(1) }}s
            </span>
            <span class="lb-counter">
              {{ state.lightbox.index + 1 }} / {{ state.lightbox.items.length }}
            </span>
          </div>
        </figcaption>
        <p class="lb-hint">← → 切换 · Esc 或点图片关闭</p>
      </figure>
    </div>
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  background: var(--card);
  border-bottom: 1px solid var(--line);
}

.top-left { display: flex; align-items: center; gap: 12px; min-width: 0; }

.brand { display: flex; align-items: center; gap: 8px; }
.brand strong { font-weight: 500; font-size: 14px; }

/* —— 左上角主题切换 —— */
.theme-pick { position: relative; flex: 0 0 auto; }
.theme-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px 4px 6px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: var(--input);
  color: var(--ink-2);
  font-size: 12px;
}
.theme-btn:hover:not(:disabled) { background: var(--panel); border-color: var(--ink-3); }
.theme-dot {
  flex: 0 0 auto;
  width: 15px;
  height: 15px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
}
.theme-dot i { width: 7px; height: 7px; border-radius: 50%; display: block; }
.theme-label { line-height: 1; }
.theme-caret { font-size: 9px; color: var(--ink-3); line-height: 1; }
.theme-backdrop { position: fixed; inset: 0; z-index: 41; }
.theme-pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 42;
  width: 188px;
  padding: 6px;
  background: var(--card);
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  box-shadow: var(--shadow);
}
.theme-group {
  margin: 6px 7px 4px;
  font-size: 10.5px;
  color: var(--ink-3);
  letter-spacing: .06em;
}
.theme-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 7px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--ink-2);
  font-size: 12px;
  text-align: left;
}
.theme-opt:hover:not(:disabled) { background: var(--panel); border-color: transparent; }
.theme-opt.on {
  color: var(--brand);
  background: var(--brand-soft);
  border-color: var(--brand-line);
}
.theme-swatch {
  flex: 0 0 auto;
  display: inline-flex;
  width: 24px;
  height: 15px;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--line-strong);
}
.theme-swatch i { flex: 1; }
.theme-swatch i + i { flex: 0 0 9px; }
.theme-opt-name { flex: 1; }
.theme-check { font-size: 11px; color: var(--brand); }

.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-3); }
.dot.ready { background: var(--ok); }
.dot.error { background: var(--bad); }
.dot.loading { background: var(--warn); }

.top-right { display: flex; align-items: center; gap: 8px; }

.settings {
  padding: 12px 16px;
  background: var(--card);
  border-bottom: 1px solid var(--line);
}
.settings .row { display: flex; gap: 8px; }
.settings code { font-family: var(--mono); background: var(--panel-2); padding: 1px 4px; border-radius: 4px; }

.grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 296px minmax(360px, 400px) minmax(0, 1fr);
  gap: 12px;
  padding: 12px;
}

.col { display: flex; flex-direction: column; min-height: 0; }
.card-body.tight { padding: 12px; }

/* ① / ④ 这类「head + body + 内部滚动区」的卡片：body 必须自己撑成 flex 列，
   否则里面的 .list / .images 的 flex:1 无效，内容只会被 card 的 overflow:hidden 裁掉 */
.card.col > .card-body {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.card.col > .card-body > * { flex: 0 0 auto; }
.card.col > .card-body > .list,
.card.col > .card-body > .images { flex: 1 1 0; min-height: 0; }

.stack { gap: 12px; }
.stack > .card.grow { flex: 0 0 auto; }
/* ③ 采样参数：卡片本身做成 flex 列，head 固定、body 占剩余并真正可滚动 */
.sampler-card {
  flex: 1 1 0;
  min-height: 150px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.sampler-card > .card-head { flex: 0 0 auto; }
.sampler-card > .card-body {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  overflow-x: hidden;
}
.card-body.scroll { overflow-y: auto; min-height: 0; }

.head-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 6px; }
.zoom-ctl {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  cursor: pointer;
}
.zoom-ctl input[type="range"] {
  width: 72px;
  height: 14px;
  padding: 0;
  border: none;
  background: transparent;
  accent-color: var(--brand);
  cursor: pointer;
}
.zoom-val { width: 32px; text-align: right; font-size: 10.5px; color: var(--ink-2); }
.img-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--ink-2);
  cursor: pointer;
  user-select: none;
}
.img-toggle input[type="checkbox"] {
  width: 14px;
  height: 14px;
  margin: 0;
  cursor: pointer;
}
.img-toggle span { white-space: nowrap; }
.img-toggle:hover { color: var(--ink); }
button.mini { padding: 3px 8px; font-size: 11px; border-radius: 6px; }

/* 参数收藏 */
.preset-row { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; }
.preset-row .pkey { padding-top: 3px; }
.preset-chips { display: flex; flex-wrap: wrap; gap: 5px; flex: 1; min-width: 0; }
.preset {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 2px 4px 2px 5px;
  font-size: 11px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--input);
  color: var(--ink-2);
  max-width: 100%;
}
.preset.def { border-color: var(--brand); background: var(--brand-soft); color: var(--brand); }
.preset .star { color: var(--line-strong); cursor: pointer; font-size: 11px; padding: 0 1px; }
.preset .star.on { color: var(--warn); }
.preset .pname {
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 3px;
  max-width: 130px;
}
.preset .pname:hover { text-decoration: underline; }
.preset .x { cursor: pointer; color: var(--ink-3); padding: 0 2px; }
.preset .x:hover { color: var(--bad); }
.preset-save { display: flex; gap: 6px; margin-bottom: 8px; }
.preset-save input { flex: 1 1 auto; min-width: 0; }
.preset-save button { flex: 0 0 auto; padding: 6px 10px; font-size: 12px; }

.params {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sampler-card input[type="text"] { padding: 4px 9px; }
.sampler-card input[type="number"] {
  padding: 4px 17px 4px 9px;
  font-family: var(--mono);
}
.sampler-card select { padding: 4px 26px 4px 9px; }
.sampler-card > .card-body { padding: 9px 12px; }
.sampler-card > .card-body::-webkit-scrollbar { width: 8px; }
.sampler-card > .card-body::-webkit-scrollbar-thumb {
  background: var(--line-strong);
  border-radius: 4px;
}
.sampler-card > .card-body::-webkit-scrollbar-track { background: transparent; }
.prow { display: grid; grid-template-columns: 84px minmax(0, 1fr); align-items: center; gap: 6px; }

/* —— 多值编辑 —— */
.chips-edit { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; }
.chips-edit .single-sel { flex: 1 1 0; min-width: 0; padding: 3px 26px 3px 9px; }
.chips-edit .chip {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 6px;
  font-size: 11px;
  border-radius: 6px;
}
.chips-edit .chip .x,
.vals .x,
.vals .add {
  border: 1px solid var(--line-strong);
  background: var(--input);
  color: var(--ink-2);
  border-radius: 5px;
  height: 20px;
  min-width: 18px;
  padding: 0;
  line-height: 1;
  font-size: 12px;
  cursor: pointer;
  flex: 0 0 auto;
}
.chips-edit .chip .x { border: none; background: transparent; height: 14px; min-width: 12px; }
.chips-edit .chip .x:hover,
.vals .x:hover,
.vals .add:hover { color: var(--ink); border-color: var(--ink-3); }
.add-sel {
  width: auto;
  min-width: 86px;
  height: 24px;
  padding: 2px 20px 2px 8px;
  font-size: 11px;
  flex: 0 0 auto;
}
.add-sel:disabled { color: var(--ink-3); background: var(--panel); cursor: not-allowed; }
.clear-all {
  flex: 0 0 auto;
  height: 22px;
  padding: 0 7px;
  font-size: 11px;
  border-radius: 6px;
  border: 1px solid var(--line-strong);
  background: var(--input);
  color: var(--ink-3);
  cursor: pointer;
}
.clear-all:hover { color: var(--bad); border-color: var(--bad-line); background: var(--bad-soft); }
.vals { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; }
.vals .val { display: flex; align-items: center; gap: 2px; flex: 1 1 96px; min-width: 0; }
.vals .val input { padding: 3px 2px 3px 7px; }
.cnt { color: var(--brand); font-size: 10px; margin-left: 2px; }
.combo-line { margin-top: 8px; line-height: 1.5; }
.combo-line b { color: var(--brand); font-size: 13px; }
.combo-line .dim { display: inline-block; margin-right: 8px; color: var(--ink-2); }
.compare-btn { border-color: var(--brand); color: var(--brand); }

/* —— 对比结果 —— */
.clipbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 10px;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-3);
}
.clipbar .pkey { padding-top: 0; }
.clip-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  padding: 3px 9px 3px 6px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: var(--input);
  color: var(--ink-2);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.clip-chip:hover { border-color: var(--brand); }
.clip-box {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  border: 1px solid var(--brand);
  background: var(--brand);
  color: var(--on-brand);
  font-size: 10px;
  line-height: 1;
}
.clip-chip.off { color: var(--ink-3); background: var(--panel-3); border-style: dashed; }
.clip-chip.off .clip-box { background: var(--input); border-color: var(--line-strong); }
.clip-chip.off .clip-name { text-decoration: line-through; }
.clip-id { color: var(--brand); flex: 0 0 auto; }
.clip-chip.off .clip-id { color: var(--ink-3); }
.clip-name {
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.clip-to {
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
  font-size: 10px;
}
.clip-count { margin-left: auto; color: var(--ink-3); }

.in-pick { margin-bottom: 12px; }
.in-pick-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.in-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  max-height: 132px;
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-3);
}
.in-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: var(--input);
  color: var(--ink-2);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.in-chip:hover { border-color: var(--brand); }
.in-chip.on { border-color: var(--brand); color: var(--brand); background: var(--brand-soft); }
.in-chip.dirty:not(.on) {
  border-color: var(--warn);
  color: var(--warn);
  background: var(--warn-soft);
}
.in-dot {
  flex: 0 0 auto;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--warn);
}
.in-title {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ④ 对比结果：输出节点输入并进标题行，省掉一整行高度 */
.result-head { flex-wrap: wrap; row-gap: 6px; }
.head-left { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
.head-out {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--ink-3);
  cursor: text;
}
.head-out > span { font-size: 11px; }
.head-out > input {
  width: 58px;
  height: 22px;
  padding: 0 6px;
  font-size: 11.5px;
  border-radius: 6px;
}
.shot.cell .thumb {
  position: relative;
  background: var(--panel-2);
  min-height: 110px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.shot.cell .thumb img { width: 100%; height: auto; display: block; cursor: zoom-in; }
.shot.cell.running .thumb { background: var(--brand-soft); }
.shot.cell.running .ph { color: var(--brand); }
.shot.cell.error .thumb { background: var(--bad-soft); }
.shot.cell.error .ph { color: var(--bad); }
.ph { color: var(--ink-3); font-size: 12px; padding: 26px 0; }
.shot.cell figcaption { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.kv {
  font-family: var(--mono);
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--brand-soft);
  border: 1px solid var(--brand-line);
  color: var(--ink);
}
.kv em { font-style: normal; color: var(--ink-3); margin-right: 3px; }
.ms { font-size: 11px; color: var(--ink-3); margin-left: auto; }
.err { font-size: 11px; color: var(--bad); }

/* 通用确认弹窗 */
.modal {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: var(--overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fade .12s ease-out;
}
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
.modal-card {
  background: var(--card);
  border-radius: 12px;
  padding: 18px 20px 16px;
  width: 340px;
  max-width: 90vw;
  box-shadow: var(--shadow);
}
.modal-card h3 { margin: 0 0 8px; font-size: 15px; font-weight: 500; color: var(--ink); }
.modal-card p {
  margin: 0 0 18px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink-2);
  word-break: break-word;
}
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
.modal-actions button { padding: 6px 14px; }
button.danger {
  background: var(--bad);
  border-color: var(--bad);
  color: #fff;
  font-weight: 500;
}
button.danger:hover:not(:disabled) { background: var(--bad-hover); border-color: var(--bad-hover); }

.lightbox {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(17, 24, 39, .9);
  display: flex;
  align-items: center;
  justify-content: center;
}
.lb-figure {
  margin: 0;
  max-width: 94vw;
  max-height: 94vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.lb-figure > img {
  max-width: 94vw;
  max-height: 80vh;
  object-fit: contain;
  border-radius: 8px;
  cursor: zoom-out;
  box-shadow: 0 16px 48px rgba(0, 0, 0, .5);
}
.lb-figure figcaption {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  color: #e5e7eb;
}
.lb-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.lb-meta {
  margin-left: auto;
  display: flex;
  gap: 14px;
  align-items: center;
  font-size: 12px;
  color: #9ca3af;
}
.lb-counter { color: #f9fafb; font-weight: 500; font-size: 13px; }
.lb-note { font-size: 12px; color: #9ca3af; }
.lb-hint { margin: 0; font-size: 11px; color: #6b7280; }

.lb-nav {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 16%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 44px;
  line-height: 1;
  color: rgba(255, 255, 255, .35);
  cursor: pointer;
  user-select: none;
  transition: background .15s, color .15s;
}
.lb-nav:hover { background: rgba(255, 255, 255, .07); color: #fff; }
.lb-nav.left { left: 0; }
.lb-nav.right { right: 0; }

.node-pick {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr) minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}
.pkey {
  font-size: 12px;
  color: var(--ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cbox { width: 16px; height: 16px; justify-self: start; }

.meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
}
.small { font-size: 12px; }

.list {
  margin-top: 10px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  flex: 1;
  min-height: 120px;
}

.node-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line-soft);
  font-size: 12px;
}
.node-row:last-child { border-bottom: none; }
.node-row.active { background: var(--brand-soft); }
.node-row.out { box-shadow: inset 3px 0 0 var(--ok); }

.nid { color: var(--brand); min-width: 26px; }
.ncls {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-2);
}
.nbadges { display: flex; gap: 4px; }
.nact { display: flex; gap: 4px; }
.nact button { padding: 2px 7px; font-size: 11px; border-radius: 6px; }

.current { margin-top: 8px; }
.current span { color: var(--ink-2); }

.check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
  color: var(--ink-2);
  font-size: 12px;
}

/* 开关字段：贴成一行输入框的样子 */
.field-check {
  margin: 0;
  padding: 7px 10px;
  background: var(--input);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
}
.field-check span { color: var(--ink); }

.send-row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; row-gap: 8px; }

/* 发送数量：紧贴发送按钮的小数字框 */
.count-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--ink-2);
}
.count-field input {
  width: 58px;
  padding: 6px 4px 6px 8px;
  text-align: center;
}

/* 停止：跟发送按钮做出区分 */
.stop-btn {
  color: var(--bad);
  background: var(--bad-soft);
  border-color: var(--bad-line);
}
.stop-btn:hover:not(:disabled) {
  color: #fff;
  background: var(--bad);
  border-color: var(--bad);
}
button.primary.sending {
  background: var(--warn);
  border-color: var(--warn);
  box-shadow: 0 0 0 3px rgba(217, 119, 6, 0.2);
  animation: send-pulse 1.1s ease-in-out infinite;
}
@keyframes send-pulse {
  0%, 100% { box-shadow: 0 0 0 2px rgba(217, 119, 6, 0.16); }
  50% { box-shadow: 0 0 0 6px rgba(217, 119, 6, 0.3); }
}

.msg {
  margin: 12px 0 0;
  padding: 8px 10px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--ink-2);
  font-size: 12px;
  word-break: break-word;
}
.msg.bad {
  background: var(--bad-soft);
  border-color: var(--bad-line);
  color: var(--bad-ink);
}

.warnbox {
  margin-top: 10px;
  padding: 8px 10px;
  background: var(--warn-soft);
  border: 1px solid var(--warn-line);
  border-radius: 8px;
}
.warnhead {
  border: none;
  background: transparent;
  padding: 0;
  color: var(--warn-ink);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.warnlist {
  margin: 8px 0 0;
  padding-left: 18px;
  color: var(--ink-2);
  font-size: 12px;
}
.warnlist li { margin-bottom: 4px; }
.warnlist code { font-family: var(--mono); background: var(--warn-code); padding: 1px 4px; border-radius: 4px; }
.wtype { font-family: var(--mono); color: var(--ink-3); margin-left: 6px; }

.row { display: flex; gap: 8px; }

.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.chip {
  padding: 3px 8px;
  font-size: 11px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: var(--input);
  color: var(--ink-2);
}
.chip.on { border-color: var(--brand); color: var(--brand); background: var(--brand-soft); }

.images {
  margin-top: 14px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--shot-min, 240px), 1fr));
  gap: 10px;
  overflow-y: auto;
}
.empty { grid-column: 1 / -1; }

.shot { margin: 0; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--card); }
.shot img { display: block; width: 100%; cursor: zoom-in; }
.shot figcaption { padding: 6px 8px; color: var(--ink-3); border-top: 1px solid var(--line); }

/* —— 只有一张图：单列、左上对齐、尺寸不超过可视区域 ——
   --fit-h 是实测的可用高度（整块，不减文件名那行）；
   底下那行文件名单做成浮层，不参与图片尺寸计算 */
.images.single {
  grid-template-columns: minmax(0, 1fr);
  justify-items: start;
  align-items: start;
  align-content: start;
  overflow: hidden;
  margin-top: 0;
}
.images.single > .shot {
  position: relative;
  width: fit-content;
  max-width: 100%;
  justify-self: start;
}
.images.single > .shot > img {
  display: block;
  height: calc(var(--fit-h, 70vh) * var(--zoom, 1));
  width: auto;
  max-width: 100%;
  object-fit: contain;
  object-position: left top;
}
/* 对比模式多一层 .thumb 包裹 */
.images.single > .shot > .thumb {
  width: fit-content;
  max-width: 100%;
  height: auto;
  min-height: 0;
  justify-content: flex-start;
  align-items: flex-start;
  background: transparent;
}
.images.single > .shot > .thumb > img {
  display: block;
  height: calc(var(--fit-h, 70vh) * var(--zoom, 1));
  width: auto;
  max-width: 100%;
  object-fit: contain;
  object-position: left top;
}
/* 文件名只占一行，别把高度撑出去 */
.images.single > .shot > figcaption,
.images.single > .shot > .thumb + figcaption {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
