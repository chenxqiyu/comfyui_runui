<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { apiGet, apiUrl, fastApply, fastJob, fastRestore, fastStatus, sleep } from '../api'

const props = defineProps({
  open: { type: Boolean, default: false },
  nodes: { type: Array, default: () => [] }, // [{ id, cls, title, count, activeCount, loras }]
  chains: { type: Array, default: () => [] }, // [{ ids, nodes, chained, connected, end, enabled, total }]
  nodeId: { type: String, default: '' },
  loras: { type: Array, default: () => [] },
  baseline: { type: Array, default: null },
  // 权重对比：{ [节点id]: { [LoRA 下标]: [权重...] } }
  sweeps: { type: Object, default: () => ({}) },
  sweepDims: { type: Number, default: 0 },
  sweepCombos: { type: Number, default: 1 },
  // 已经加到「新提示词」里的触发词，用于在面板里标亮
  addedWords: { type: Array, default: () => [] },
})

const emit = defineEmits([
  'toggle',
  'close',
  'select-node',
  'change',
  'reset',
  'sweep',
  'clear-sweeps',
  'prompt-tag-toggle',
])

const items = computed(() => (Array.isArray(props.loras) ? props.loras : []))
const currentNode = computed(() => props.nodes.find((n) => n.id === props.nodeId) || null)
const chainOfNode = computed(
  () => props.chains.find((c) => c.ids.includes(props.nodeId)) || null
)
const chainPos = computed(() => {
  const chain = chainOfNode.value
  if (!chain?.chained) return ''
  return `串联 ${chain.ids.indexOf(props.nodeId) + 1}/${chain.ids.length}`
})

/** 串联时把整条链上启用的 LoRA 按「上游 → 下游」合并展示 */
const previewItems = computed(() => {
  const chain = chainOfNode.value
  if (!chain?.chained) return items.value
  return chain.nodes.flatMap((n) => (Array.isArray(n.loras) ? n.loras : []))
})
const previewEnabled = computed(
  () => previewItems.value.filter((x) => isActive(x) && !isBypassed(x)).length
)
const previewLabel = computed(() => (chainOfNode.value?.chained ? '串联启用预览' : 'lora堆栈'))

function readName(item) {
  if (item && typeof item === 'object') return String(item.name ?? item.lora ?? '')
  return String(item ?? '')
}

/** 名称行会被省略号截断，悬停时用 tooltip 显示完整名称，并带上点击含义 */
function nameTitle(item) {
  const name = readName(item)
  const hint = isActive(item) ? '点击停用这条 LoRA（移出已勾选）' : '点击启用这条 LoRA（加回已勾选）'
  return name ? `${name}\n${hint}` : hint
}

function readStrength(item) {
  const n = Number(item?.strength)
  return Number.isFinite(n) ? n : 1
}

function readClip(item) {
  const n = Number(item?.clipStrength)
  return Number.isFinite(n) ? n : readStrength(item)
}

/** clip 行展开 = CLIP 强度单独生效；收起时跟模型强度同步（与 LoraManager 一致） */
function clipOpen(item) {
  return !!(item && typeof item === 'object' && item.expanded)
}

function isActive(item) {
  if (!item || typeof item !== 'object') return true
  if ('active' in item) return !!item.active
  if ('enabled' in item) return !!item.enabled
  if ('on' in item) return !!item.on
  return true
}

function clone(item) {
  if (item && typeof item === 'object') return { ...item }
  return { name: String(item ?? ''), strength: 1 }
}

/** 禁用保留：还在已勾选列表里，但生成时不参与 */
function isBypassed(item) {
  return !!(item && typeof item === 'object' && item.bypass)
}

function setBypass(index, value) {
  const list = items.value.map(clone)
  const item = list[index]
  if (!item) return
  if (value) item.bypass = true
  else delete item.bypass
  commit(list)
}

const activeCount = computed(() => items.value.filter(isActive).length)
const allActive = computed(() => items.value.length > 0 && activeCount.value === items.value.length)

/** 列表筛选：默认只看已勾选，另有未勾选 / 全部 */
const filter = ref('active')
const filters = computed(() => [
  { key: 'active', label: '已勾选', count: activeCount.value },
  { key: 'inactive', label: '未勾选', count: items.value.length - activeCount.value },
  { key: 'all', label: '全部', count: items.value.length },
  { key: 'fast', label: '极速', count: fastCount.value },
])
const visibleRows = computed(() =>
  items.value
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      if (filter.value === 'active') return isActive(item)
      if (filter.value === 'inactive') return !isActive(item)
      if (filter.value === 'fast') return isFast(item)
      return true
    })
)
const emptyText = computed(() => {
  if (!items.value.length) return '还没有 LoRA，用上面的输入框粘贴标签添加'
  if (filter.value === 'active') return '没有已勾选的 LoRA'
  if (filter.value === 'inactive') return '没有未勾选的 LoRA'
  if (filter.value === 'fast') return '这个堆叠里还没有 LoRA 在极速目录'
  return '没有可编辑的 LoRA'
})

/** 只列启用中的，生成 <lora:name:0.70> / <lora:name:0.70:0.60> 预览 */
const promptText = computed(() =>
  previewItems.value
    .filter((x) => isActive(x) && !isBypassed(x) && readName(x))
    .map(loraTag)
    .join('')
)

/** 展开 clip 后一律写第三段（clip 为 1.00 也写成 1.00:1.00） */
function loraTag(item) {
  const name = cleanName(readName(item))
  const strength = readStrength(item).toFixed(2)
  if (!clipOpen(item)) return `<lora:${name}:${strength}>`
  return `<lora:${name}:${strength}:${readClip(item).toFixed(2)}>`
}

function cleanName(name) {
  return String(name)
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.(safetensors|ckpt|pt|bin)$/i, '')
}

const fmtStrength = (item) => readStrength(item).toFixed(2)
const fmtClip = (item) => readClip(item).toFixed(2)

function commit(list) {
  emit('change', list)
}

function setActive(index, value) {
  const list = items.value.map(clone)
  const item = list[index]
  if (!item) return
  item.active = value
  if ('on' in item) item.on = value
  if ('enabled' in item) item.enabled = value
  commit(list)
}

/** Toggle All：全部启用时再点就全部停用 */
function toggleAll() {
  const next = !allActive.value
  commit(
    items.value.map((x) => {
      const item = clone(x)
      item.active = next
      if ('on' in item) item.on = next
      if ('enabled' in item) item.enabled = next
      return item
    })
  )
}

function setStrength(index, raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  const list = items.value.map(clone)
  const item = list[index]
  if (!item) return
  item.strength = Math.round(n * 100) / 100
  // 没展开 clip 时 clip 强度跟随模型强度，避免留下旧值
  if (!clipOpen(item)) item.clipStrength = item.strength
  commit(list)
}

/* 手输立即生效：编辑期间输入框用本地草稿文本，避免回写的格式化值打断输入 */
const drafts = ref({})
const draftKey = (i, field) => `${i}:${field}`

function inputText(i, item, field) {
  const draft = drafts.value[draftKey(i, field)]
  if (draft !== undefined) return draft
  return field === 'clip' ? fmtClip(item) : fmtStrength(item)
}

function setDraft(i, field, text) {
  drafts.value = { ...drafts.value, [draftKey(i, field)]: text }
}

function clearDraft(i, field) {
  const key = draftKey(i, field)
  if (drafts.value[key] === undefined) return
  const next = { ...drafts.value }
  delete next[key]
  drafts.value = next
}

/** 每敲一个有效数字就写回，不等回车/失焦；空串和小数点中间态先攒着 */
function onStrengthInput(index, event) {
  const raw = event.target.value
  setDraft(index, 'strength', raw)
  if (raw.trim() === '' || !Number.isFinite(Number(raw))) return
  setStrength(index, raw)
}

function onClipInput(index, event) {
  const raw = event.target.value
  setDraft(index, 'clip', raw)
  if (raw.trim() === '' || !Number.isFinite(Number(raw))) return
  setClipStrength(index, raw)
}

function nudgeStrength(index, delta) {
  setStrength(index, readStrength(items.value[index]) + delta)
}

/* ---------------------------------------------------------------- CLIP 控制
 * 展开后 clip 强度单独生效；收起时同步回模型强度（跟 LoraManager 的收起行为一致）。
 */
function setClipStrength(index, raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  const list = items.value.map(clone)
  const item = list[index]
  if (!item) return
  item.clipStrength = Math.round(n * 100) / 100
  item.expanded = true
  commit(list)
}

function nudgeClip(index, delta) {
  setClipStrength(index, readClip(items.value[index]) + delta)
}

function toggleClip(index) {
  const list = items.value.map(clone)
  const item = list[index]
  if (!item) return
  if (clipOpen(item)) {
    item.expanded = false
    item.clipStrength = Math.round(readStrength(item) * 100) / 100
  } else {
    item.expanded = true
    if (!Number.isFinite(Number(item.clipStrength))) {
      item.clipStrength = Math.round(readStrength(item) * 100) / 100
    }
  }
  commit(list)
}

/* ---------------------------------------------------------------- 权重对比
 * 给一条启用的 LoRA 填多个权重，生成时按笛卡尔积逐组出图。
 * 对比值只存在 App 的提交维度里，不会覆盖堆叠里的原权重。
 */
const round2 = (n) => Math.round(n * 100) / 100

function sweepOf(index) {
  const list = props.sweeps?.[props.nodeId]?.[index]
  return Array.isArray(list) ? list : []
}

function hasSweep(index) {
  return sweepOf(index).length >= 2
}

/** 当前节点里有几条 LoRA 开了权重对比 */
const nodeSweepCount = computed(
  () => items.value.reduce((n, _, i) => n + (hasSweep(i) ? 1 : 0), 0)
)

/** 默认围绕当前权重给三档：-0.2 / 当前 / +0.2（不往负数走） */
function defaultSweep(item) {
  const base = round2(readStrength(item))
  const values = [...new Set([round2(base - 0.2), base, round2(base + 0.2)])]
    .filter((v) => v >= 0)
    .sort((a, b) => a - b)
  if (values.length < 2) values.push(round2(base + 0.4))
  return [...new Set(values)].sort((a, b) => a - b)
}

function emitSweep(index, values) {
  const clean = []
  for (const v of values) {
    const n = round2(Number(v))
    if (Number.isFinite(n) && !clean.includes(n)) clean.push(n)
  }
  // 少于两个值就不算对比
  emit('sweep', { nodeId: props.nodeId, index, values: clean.length >= 2 ? clean : [] })
}

function toggleSweep(index) {
  if (hasSweep(index)) emitSweep(index, [])
  else emitSweep(index, defaultSweep(items.value[index]))
}

function setSweepValue(index, vi, value) {
  const vals = [...sweepOf(index)]
  vals[vi] = value
  emitSweep(index, vals)
}

function onSweepValue(index, vi, event) {
  const raw = event.target.value
  const n = Number(raw)
  if (raw === '' || !Number.isFinite(n)) {
    event.target.value = Number(sweepOf(index)[vi]).toFixed(2)
    return
  }
  setSweepValue(index, vi, round2(n))
}

function addSweepValue(index) {
  const vals = sweepOf(index)
  const last = vals.length ? Math.max(...vals) : readStrength(items.value[index])
  emitSweep(index, [...vals, round2(last + 0.2)])
}

function removeSweepValue(index, vi) {
  const vals = sweepOf(index).filter((_, i) => i !== vi)
  emitSweep(index, vals)
}

const SWEEP_PRESETS = [0.4, 0.6, 0.8, 1]
function sweepPresets(index) {
  const vals = sweepOf(index)
  return SWEEP_PRESETS.filter((p) => !vals.includes(p))
}

function addSweepPreset(index, value) {
  emitSweep(index, [...sweepOf(index), value])
}

const fmtSweep = (v) => Number(v).toFixed(2)

/** 手动添加：识别 <lora:名称:权重[:clip]>，一条输入里可以贴多个 */
const addText = ref('')
const addError = ref('')

function parseLoraTags(text) {
  const out = []
  const re =
    /<\s*lora\s*:\s*([^:>]+?)\s*(?::\s*(-?\d*\.?\d+)\s*)?(?::\s*(-?\d*\.?\d+)\s*)?>/gi
  let m
  while ((m = re.exec(text))) {
    const name = m[1].trim()
    if (!name) continue
    const n = m[2] === undefined ? 1 : Number(m[2])
    const clip = m[3] === undefined ? null : Number(m[3])
    out.push({
      name,
      strength: Number.isFinite(n) ? n : 1,
      clip: clip !== null && Number.isFinite(clip) ? clip : null,
    })
  }
  return out
}

function addFromText() {
  const parsed = parseLoraTags(addText.value)
  if (!parsed.length) {
    addError.value = '没识别到 <lora:名称:权重> 格式'
    return
  }
  const list = items.value.map(clone)
  for (const { name, strength, clip } of parsed) {
    const weight = Math.round(strength * 100) / 100
    const clipWeight = clip === null ? null : Math.round(clip * 100) / 100
    // 同名已存在就更新强度并勾选，避免重复堆叠
    const at = list.findIndex(
      (x) => cleanName(readName(x)).toLowerCase() === cleanName(name).toLowerCase()
    )
    if (at >= 0) {
      const item = list[at]
      item.active = true
      if ('on' in item) item.on = true
      if ('enabled' in item) item.enabled = true
      item.strength = weight
      if (clipWeight === null) {
        if (!clipOpen(item)) item.clipStrength = weight
      } else {
        item.clipStrength = clipWeight
        item.expanded = true
      }
    } else {
      const item = { name, strength: weight, active: true }
      if (clipWeight !== null) {
        item.clipStrength = clipWeight
        item.expanded = true
      }
      list.push(item)
    }
  }
  commit(list)
  addText.value = ''
  addError.value = ''
  filter.value = 'active'
}

/* ---------------------------------------------------------------- 极速模式
 * 把已勾选的 LoRA 的实体文件搬到快盘（默认 F:\ai\fastlora），
 * 原位置留一个软连接，ComfyUI 请求的路径不变 → 加载却走快盘。
 * 搬过的东西记在 _fastlora-manifest.json，并生成一份离线一键还原 ps1。
 */
const fast = ref({
  ready: false, // 本机服务（/api/fastlora）在不在
  fastDir: '',
  scriptFile: '',
  keys: [], // 已在极速目录里的名字（小写，含「路径/名」和「名」两种键）
  count: 0,
  sizeTotal: 0,
  err: '',
})
const fastKeys = computed(() => new Set(fast.value.keys || []))
const job = ref(null)
const busy = computed(() => job.value?.state === 'running')
const askRestore = ref(false)

/** 名字归一：去掉扩展名、反斜杠转正斜杠、小写 */
function normName(name) {
  return String(name || '')
    .replace(/\\/g, '/')
    .replace(/\.(safetensors|sft|pt|pth|ckpt|bin)$/i, '')
    .trim()
    .toLowerCase()
}

/* ---------------------------------------------------------------- 预览图
 * LoraManager 的 /api/lm/loras/list 只返回前 100 条，工作流里的 LoRA 经常不在里面，
 * 所以按名字逐条问 /api/lm/loras/preview-url；结果缓存，'' 表示确认没有预览图。
 */
const previews = ref({})
const previewBusy = new Set()
const itemNames = computed(() => [...new Set(items.value.map(readName).filter(Boolean))])

function setPreview(key, url) {
  previews.value = { ...previews.value, [key]: url }
}

async function fetchPreview(name) {
  const key = normName(name)
  if (!key || key in previews.value || previewBusy.has(key)) return
  previewBusy.add(key)
  try {
    const data = await apiGet(
      `/api/lm/loras/preview-url?name=${encodeURIComponent(name)}&license_flags=true`
    )
    const url = String(data?.preview_url || '')
    // 查不到时后端也返回 success，只是指向通用的 no-preview 图，按无预览处理
    const usable = data?.success && url && !url.includes('/no-preview.')
    setPreview(key, usable ? apiUrl(url) : '')
  } catch {
    // LoRA Manager 不可用：先留空，下次打开面板再试
  } finally {
    previewBusy.delete(key)
  }
}

/** 打开面板时并发 6 路把这一屏的 LoRA 预览图都问一遍 */
function loadPreviews() {
  const names = itemNames.value
  let next = 0
  const worker = async () => {
    while (next < names.length) await fetchPreview(names[next++])
  }
  return Promise.all(Array.from({ length: Math.min(6, names.length) }, worker))
}

function previewOf(item) {
  const key = normName(readName(item))
  return key ? previews.value[key] || '' : ''
}

/** 图挂了（文件被挪走/改名）就不再重试，退回空缩略图位 */
function onPreviewError(item) {
  const key = normName(readName(item))
  if (key) setPreview(key, '')
}

/* ---------------------------------------------------------------- 悬停看大图 */
const bigPreview = ref(null)
let bigTimer = null

function showBigUrl(url, name, event) {
  if (!url) return
  const rect = event.currentTarget.getBoundingClientRect()
  clearTimeout(bigTimer)
  // 稍等一下再弹，鼠标扫过一排的时候不至于每行都闪一下
  bigTimer = setTimeout(() => {
    // 大图固定贴在缩略图右边，右边放不下才往左收
    let left = rect.right + 12
    if (left + 312 > window.innerWidth - 12) left = Math.max(12, window.innerWidth - 12 - 312)
    bigPreview.value = {
      url,
      name,
      left,
      top: Math.max(12, Math.min(rect.top + rect.height / 2 - 200, window.innerHeight - 400)),
    }
  }, 160)
}

function showBigPreview(item, event) {
  showBigUrl(previewOf(item), readName(item), event)
}

function hideBigPreview() {
  clearTimeout(bigTimer)
  bigPreview.value = null
}

/* ---------------------------------------------------------------- 已勾选预览图 */
const gallery = ref(false)
/* 顶置：已启用（勾选且没禁用）的排前面，临时禁用的沉到下面 */
const galleryTop = ref(true)
const checkedPreviews = computed(() => {
  const seen = new Set()
  const out = []
  items.value.forEach((item, index) => {
    if (!isActive(item)) return
    const name = readName(item)
    const url = previewOf(item)
    if (!url || seen.has(name)) return
    seen.add(name)
    out.push({ index, item, name, url, bypassed: isBypassed(item) })
  })
  return out
})
watch(gallery, (on) => {
  if (on) loadPreviews()
  else closePromptPanel()
})

/** 顶置开启时：启用中的在前，临时禁用的排后面 */
const galleryItems = computed(() => {
  const list = checkedPreviews.value
  if (!galleryTop.value) return list
  return [
    ...list.filter((p) => !p.bypassed),
    ...list.filter((p) => p.bypassed),
  ]
})

/* 预览图下的名称点击即复制，短暂显示「已复制」 */
const copiedName = ref('')
let copiedTimer = null

async function copyName(name) {
  if (!name) return
  try {
    await navigator.clipboard.writeText(name)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = name
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  copiedName.value = name
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    copiedName.value = ''
  }, 1100)
}

/* ---------------------------------------------------------------- 提示词标签
 * 卡片的「标签」按钮：按名字查到文件路径，再用 LoraManager 的 metadata 接口取 trainedWords。
 * 点触发词 → 交给 App 排成标签，写在「＋ 加一个提示词」上面一行，并同步进提示词。
 */
const promptPanel = ref(null) // { name, left, top }
const promptWords = ref({}) // name -> string[]
const promptBusy = new Set()
const promptImagePrompts = ref({}) // name -> [{ i, text }]，civitai 例图里带的完整提示词
const promptDescriptions = ref({}) // name -> 清洗过的描述 HTML（空串 = 没有描述，不显示 tab）
const promptFreq = ref({}) // name -> [{ word, count }]，LoraManager 的词频表（训练词 tab）
/** 描述 / 训练词 tab 只在有内容时出现，默认停在标签那一页 */
const promptTab = ref('tags')
/** 随机组合：默认抽 10 个，可以自己改；randTag 记着上一次随机出来的串，用来「再点一下取消」 */
const randCount = ref(10)
const randTag = ref('')
/** 「前 n 个按顺序串联」当前挂着的那条 */
const topTag = ref('')
/** 默认第一条：这个 LoRA 还没点过触发词时，自动把第一条加上 */
const autoFirst = ref(false)
/** 例图提示词：默认单选（选另一张会替换），勾上「多选」才允许同时选多条 */
const exampleMulti = ref(false)

function normalizeWords(meta) {
  const raw = meta?.trainedWords || meta?.civitai?.trainedWords || []
  return (Array.isArray(raw) ? raw : []).map((w) => String(w || '').trim()).filter(Boolean)
}

/** /api/lm/trained-words 的 [[词, 次数], …]：去首尾空格，同名只留次数高的那条（接口里会带前导空格的重复项） */
function normalizeFreqWords(data) {
  const raw = data?.trained_words || data?.trainedWords || []
  const out = []
  const seen = new Set()
  for (const it of Array.isArray(raw) ? raw : []) {
    const word = String(Array.isArray(it) ? it[0] : it?.word ?? it ?? '').trim()
    if (!word || seen.has(word)) continue
    seen.add(word)
    out.push({ word, count: Number(Array.isArray(it) ? it[1] : it?.count) || 0 })
  }
  return out
}

/** 例图里的提示词：按 images 顺序记下标，方便在面板里标「图 N」；只有图没有 prompt 的也留着 */
function normalizeImagePrompts(meta) {
  const imgs = Array.isArray(meta?.images) ? meta.images : []
  const out = []
  const seen = new Set()
  imgs.forEach((img, i) => {
    // 例图提示词常带换行/BOM，压成一行再当标签，免得把「一组提示词」按换行拆散
    const text = String(img?.meta?.prompt || '')
      .replace(/\uFEFF/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    const url = String(img?.url || '')
    if (!text && !url) return
    const dedupe = text || `url:${url}`
    if (seen.has(dedupe)) return
    seen.add(dedupe)
    out.push({ i, text, url })
  })
  return out.slice(0, 12)
}

/* Civitai 的描述是富文本：只留白名单标签，属性除 a[href] 全部丢掉，
 * 脚本/样式类标签整段删除，免得把远端 HTML 直接 v-html 进页面。 */
const DESC_TAGS = new Set([
  'P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'UL', 'OL', 'LI',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'CODE', 'PRE', 'HR',
  'A', 'SPAN', 'DIV', 'SMALL', 'SUB', 'SUP', 'DL', 'DT', 'DD',
])
const DESC_DROP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'LINK', 'META'])
const DESC_MAX = 20000

function escapeText(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function cleanChildren(parent) {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === 3) continue
    if (node.nodeType !== 1) {
      node.remove()
      continue
    }
    const el = node
    if (DESC_DROP.has(el.tagName)) {
      el.remove()
      continue
    }
    if (!DESC_TAGS.has(el.tagName)) {
      cleanChildren(el)
      el.replaceWith(...el.childNodes)
      continue
    }
    const href = el.tagName === 'A' ? el.getAttribute('href') || '' : ''
    for (const attr of [...el.attributes]) el.removeAttribute(attr.name)
    if (el.tagName === 'A') {
      cleanChildren(el)
      if (/^(https?:\/\/|\/)/i.test(href)) {
        el.setAttribute('href', href)
        el.setAttribute('target', '_blank')
        el.setAttribute('rel', 'noopener noreferrer')
      } else {
        el.replaceWith(...el.childNodes)
        continue
      }
    }
    cleanChildren(el)
  }
}

/** 描述 -> 可安全 v-html 的片段；纯文本描述按换行转 <br>，空描述返回空串 */
function cleanDescription(raw) {
  let text = String(raw || '').trim()
  if (!text) return ''
  if (text.length > DESC_MAX) text = text.slice(0, DESC_MAX)
  if (!/<[a-z!/][^>]*>/i.test(text)) return escapeText(text).replace(/\r?\n/g, '<br>')
  const doc = new DOMParser().parseFromString(text, 'text/html')
  cleanChildren(doc.body)
  if (!doc.body.textContent.trim() && !doc.body.querySelector('hr, br, li')) return ''
  return doc.body.innerHTML.trim()
}

/** 工作流里的名字可能带目录前缀 / 扩展名 / 训练步数后缀，逐个变体去搜 */
function searchTerms(name) {
  const base = String(name || '').replace(/\\/g, '/').split('/').pop()
  const stem = base.replace(/\.(safetensors|sft|pt|pth|ckpt|bin)$/i, '')
  const out = []
  for (const t of [name, base, stem, stem.replace(/([-_.]step[-_]?\d+)$/i, '')]) {
    const v = String(t || '').trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

async function fetchTrainedWords(name, force = false) {
  const key = normName(name)
  if (!key || promptBusy.has(key)) return
  if (force) {
    // 每次点「标签」都重取一遍，元数据改过也能立刻看到
    const next = { ...promptWords.value }
    delete next[key]
    promptWords.value = next
    const nextPrompts = { ...promptImagePrompts.value }
    delete nextPrompts[key]
    promptImagePrompts.value = nextPrompts
    const nextDesc = { ...promptDescriptions.value }
    delete nextDesc[key]
    promptDescriptions.value = nextDesc
    const nextFreq = { ...promptFreq.value }
    delete nextFreq[key]
    promptFreq.value = nextFreq
  } else if (key in promptWords.value) return
  promptBusy.add(key)
  try {
    // metadata 接口只认 file_path，先按名字搜一条拿路径
    const baseName = String(name || '').replace(/\\/g, '/').split('/').pop()
    const baseKey = normName(baseName)
    // 工作流里写的是文件名（facialcummassive_FLUX），列表里的 model_name 可能是
    // 「Facial cum massive FLUX」，所以文件名、模型名都要比，再退一步去掉空格比
    const loose = (s) => normName(s).replace(/[^a-z0-9]+/g, '')
    const hitOf = (rows) =>
      rows.find((it) =>
        [it.model_name, it.file_name].some((n) => {
          const k = normName(n)
          return k === key || (baseKey && k === baseKey)
        })
      ) ||
      rows.find((it) =>
        [it.model_name, it.file_name].some((n) => loose(n) === loose(baseName))
      ) ||
      null
    let hit = null
    let weak = null
    for (const term of searchTerms(name)) {
      const list = await apiGet(
        `/api/lm/loras/list?search=${encodeURIComponent(term)}&page=1&page_size=20`
      )
      const rows = list?.items || []
      if (!rows.length) continue
      hit = hitOf(rows)
      if (hit) break
      if (!weak) weak = rows[0]
    }
    if (!hit) hit = weak
    let words = normalizeWords({ trainedWords: hit?.civitai?.trainedWords })
    let prompts = []
    let describe = ''
    let freq = []
    if (hit?.file_path) {
      const q = encodeURIComponent(hit.file_path)
      // 描述 / metadata / 词频一次并发取完，三个 tab 不用各自等往返
      const [metaRes, descRes, freqRes] = await Promise.allSettled([
        apiGet(`/api/lm/loras/metadata?file_path=${q}`),
        apiGet(`/api/lm/loras/model-description?file_path=${q}`),
        apiGet(`/api/lm/trained-words?file_path=${q}`),
      ])
      // metadata 读不到就退回列表里自带的触发词
      if (metaRes.status === 'fulfilled') {
        const metaWords = normalizeWords(metaRes.value?.metadata)
        if (metaWords.length) words = metaWords
        prompts = normalizeImagePrompts(metaRes.value?.metadata)
      }
      if (descRes.status === 'fulfilled') describe = cleanDescription(descRes.value?.description)
      if (freqRes.status === 'fulfilled') freq = normalizeFreqWords(freqRes.value)
    }
    promptWords.value = { ...promptWords.value, [key]: words }
    promptImagePrompts.value = { ...promptImagePrompts.value, [key]: prompts }
    promptDescriptions.value = { ...promptDescriptions.value, [key]: describe }
    promptFreq.value = { ...promptFreq.value, [key]: freq }
  } catch {
    promptWords.value = { ...promptWords.value, [key]: [] }
    promptImagePrompts.value = { ...promptImagePrompts.value, [key]: [] }
    promptDescriptions.value = { ...promptDescriptions.value, [key]: '' }
    promptFreq.value = { ...promptFreq.value, [key]: [] }
  } finally {
    promptBusy.delete(key)
  }
}

const promptKeyNow = computed(() => normName(promptPanel.value?.name || ''))
const promptWordsNow = computed(() => promptWords.value[promptKeyNow.value] || [])
const promptPromptsNow = computed(() => promptImagePrompts.value[promptKeyNow.value] || [])
const promptDescNow = computed(() => promptDescriptions.value[promptKeyNow.value] || '')
const promptFreqNow = computed(() => promptFreq.value[promptKeyNow.value] || [])
/** 训练词 tab 顶部两个批量操作：全部串成一条 / 随机抽 n 条 */
const allWordsTag = computed(() => promptFreqNow.value.map((w) => w.word).join(', '))
const allWordsOn = computed(() => !!allWordsTag.value && props.addedWords.includes(allWordsTag.value))
const randTagOn = computed(() => !!randTag.value && props.addedWords.includes(randTag.value))
const topTagOn = computed(() => !!topTag.value && props.addedWords.includes(topTag.value))
/** 「前 n 个」用的 n：跟随机共用那个输入框，超过词表长度按词表长度算 */
const topCount = computed(() =>
  Math.max(1, Math.min(Math.floor(Number(randCount.value) || 1), promptFreqNow.value.length || 1))
)
const topTagCount = computed(() => (topTag.value ? topTag.value.split(', ').length : 0))
/** 训练词 tab 当前挂在新提示词上的条目（单选词 + 批量组合），清除按钮按它计数 */
const freqPickedNow = computed(() => {
  const picked = new Set(props.addedWords)
  const out = new Set()
  for (const w of promptFreqNow.value) if (picked.has(w.word)) out.add(w.word)
  for (const t of freqAggregates.value[promptKeyNow.value] || []) if (picked.has(t)) out.add(t)
  return out
})
// 没有对应内容时那个 tab 不显示，停在它上面也要退回标签页
const activePromptTab = computed(() => {
  const tab = promptTab.value
  if (tab === 'desc' && promptDescNow.value) return 'desc'
  if (tab === 'words' && promptFreqNow.value.length) return 'words'
  return 'tags'
})
const promptLoading = computed(
  () => !!promptPanel.value && !(promptKeyNow.value in promptWords.value)
)

/** 训练词 tab 批量生成的组合标签（全部串联 / 随机组合），不是词表里的单条词，单独记一份好让卡片亮灯 */
const freqAggregates = ref({}) // name -> string[]

function rememberAggregate(key, text, on) {
  if (!key || !text) return
  const list = new Set(freqAggregates.value[key] || [])
  if (on) list.add(text)
  else list.delete(text)
  freqAggregates.value = { ...freqAggregates.value, [key]: [...list] }
}

/** 每张卡里已经加进「新提示词」的标签（触发词 + 例图提示词 + 训练词），用于卡片右上角亮灯 */
const taggedByCard = computed(() => {
  const picked = new Set(props.addedWords)
  const out = new Map()
  if (!picked.size) return out
  for (const p of checkedPreviews.value) {
    const key = normName(p.name)
    if (!key || out.has(key)) continue
    const words = new Set(
      [
        ...(promptWords.value[key] || []),
        ...(promptImagePrompts.value[key] || []).map((it) => it.text),
        ...(promptFreq.value[key] || []).map((it) => it.word),
        ...(freqAggregates.value[key] || []),
      ].filter((w) => picked.has(w))
    )
    if (words.size) out.set(key, [...words])
  }
  return out
})
function taggedWords(p) {
  return taggedByCard.value.get(normName(p?.name)) || []
}

// 「默认第一条」：勾选中的 LoRA 都自动贡献第一条触发词；整条都没点过词才加
const enabledLoraNames = computed(() =>
  items.value
    .filter((it) => isActive(it) && !isBypassed(it))
    .map((it) => readName(it))
    .filter(Boolean)
)
let autoFirstRun = 0
const autoSettled = new Set() // 已经自动加过第一条的 LoRA；再勾回来会重新加

async function runAutoFirst(names) {
  if (!autoFirst.value || !names.length) return
  const run = ++autoFirstRun
  const seen = new Set(props.addedWords)
  for (const name of names) {
    const key = normName(name)
    if (!key) continue
    if (!(key in promptWords.value)) await fetchTrainedWords(name)
    if (run !== autoFirstRun) return
    const words = promptWords.value[key] || []
    if (!words.length || words.some((w) => seen.has(w))) continue
    seen.add(words[0])
    emitTag(name, words[0])
  }
}

watch(autoFirst, (on) => {
  autoSettled.clear()
  for (const n of enabledLoraNames.value) autoSettled.add(normName(n))
  if (on) runAutoFirst([...enabledLoraNames.value])
})

// 新勾上的 LoRA 也照办；取消勾选后名字会被移出，重新勾上时再补一次
watch(enabledLoraNames, (list) => {
  const fresh = list.filter((n) => !autoSettled.has(normName(n)))
  autoSettled.clear()
  for (const n of list) autoSettled.add(normName(n))
  if (autoFirst.value) runAutoFirst(fresh)
})

function openPromptPanel(p, event) {
  // 同一个 LoRA 再点一次不关面板，只把触发词刷新到最新
  if (promptPanel.value?.name === p.name) {
    fetchTrainedWords(p.name, true)
    return
  }
  const rect = event.currentTarget.getBoundingClientRect()
  const width = 300
  const height = 420
  // 固定贴在按钮右边；右边真放不下再往左收，但优先靠右贴边
  let left = rect.right + 8
  if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8)
  promptPanel.value = {
    name: p.name,
    left,
    top: Math.max(8, Math.min(rect.top - 8, window.innerHeight - height - 8)),
  }
  promptTab.value = 'tags'
  // 换了个 LoRA，上次随机/前 N 串出来的组合不再对应这个面板
  randTag.value = ''
  topTag.value = ''
  closeWeightMenu()
  hideBigPreview()
  fetchTrainedWords(p.name, true)
}

function closePromptPanel() {
  promptPanel.value = null
  hideBigPreview()
}

/** 面板不点外面关闭，改成按住标题栏拖动；拖的过程中只改 left/top，不碰其它状态 */
let promptDrag = null

function onPromptDragStart(event) {
  if (event.button !== 0 || !promptPanel.value) return
  if (event.target.closest?.('.lp-tags-close')) return
  const rect = event.currentTarget.closest('.lp-tags')?.getBoundingClientRect()
  if (!rect) return
  promptDrag = {
    dx: event.clientX - rect.left,
    dy: event.clientY - rect.top,
    width: rect.width,
    height: rect.height,
  }
  window.addEventListener('mousemove', onPromptDragMove)
  window.addEventListener('mouseup', onPromptDragEnd)
  event.preventDefault()
}

function onPromptDragMove(event) {
  if (!promptDrag || !promptPanel.value) return
  const { dx, dy, width, height } = promptDrag
  promptPanel.value = {
    ...promptPanel.value,
    left: Math.min(Math.max(0, event.clientX - dx), Math.max(0, window.innerWidth - width)),
    top: Math.min(Math.max(0, event.clientY - dy), Math.max(0, window.innerHeight - height)),
  }
}

function onPromptDragEnd() {
  promptDrag = null
  window.removeEventListener('mousemove', onPromptDragMove)
  window.removeEventListener('mouseup', onPromptDragEnd)
}

/** 点触发词：加进「新提示词」；已经加过的再点一次就取消 */
function emitTag(name, word) {
  const key = normName(name)
  if (!key || !word) return
  emit('prompt-tag-toggle', { id: key, name, word })
}

function addPromptTag(word) {
  emitTag(promptPanel.value?.name || '', word)
}

/** 训练词：点一下加进新提示词，同时静默复制一份；取消时只取消、不复制 */
function pickFreqWord(word) {
  const wasAdded = props.addedWords.includes(word)
  addPromptTag(word)
  if (!wasAdded) copyQuiet(word)
}

/** 全部串成一个标签：词表是确定的，同一串再点一次就整体取消 */
function pickAllWords() {
  if (!allWordsTag.value) return
  const name = promptPanel.value?.name || ''
  const wasAdded = allWordsOn.value
  emitTag(name, allWordsTag.value)
  rememberAggregate(promptKeyNow.value, allWordsTag.value, !wasAdded)
  if (!wasAdded) copyQuiet(allWordsTag.value)
}

/** 随机组合：抽 n 个不重复的词串成一条标签；上一条随机组合还挂着就先换掉它 */
function pickRandomWords() {
  const list = promptFreqNow.value
  if (!list.length) return
  const name = promptPanel.value?.name || ''
  const key = promptKeyNow.value
  if (randTagOn.value) {
    emitTag(name, randTag.value)
    rememberAggregate(key, randTag.value, false)
  }
  const n = Math.max(1, Math.min(Math.floor(Number(randCount.value) || 1), list.length))
  randCount.value = n
  const pool = list.map((w) => w.word)
  const picked = []
  for (let i = 0; i < n; i++) picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
  randTag.value = picked.join(', ')
  emitTag(name, randTag.value)
  rememberAggregate(key, randTag.value, true)
  copyQuiet(randTag.value)
}

/** 只撤掉当前这条随机组合，不动面板里点出来的其它标签 */
function clearRandomTag() {
  if (!randTagOn.value) return
  emitTag(promptPanel.value?.name || '', randTag.value)
  rememberAggregate(promptKeyNow.value, randTag.value, false)
  randTag.value = ''
}

/** 前 n 个按顺序串联：取词频最高的前 n 个原样用逗号串起来；同一串再点一次撤掉 */
function pickTopWords() {
  const list = promptFreqNow.value
  if (!list.length) return
  const name = promptPanel.value?.name || ''
  const key = promptKeyNow.value
  const text = list.slice(0, topCount.value).map((w) => w.word).join(', ')
  if (props.addedWords.includes(text)) {
    emitTag(name, text)
    rememberAggregate(key, text, false)
    if (topTag.value === text) topTag.value = ''
    return
  }
  // 换了 n 再点：先把上一条「前 N」撤掉，别同时挂两条
  if (topTag.value && topTag.value !== text && props.addedWords.includes(topTag.value)) {
    emitTag(name, topTag.value)
    rememberAggregate(key, topTag.value, false)
  }
  topTag.value = text
  emitTag(name, text)
  rememberAggregate(key, text, true)
  copyQuiet(text)
}

/** 一键清掉这个 LoRA 的训练词点选：单词、全部串联、随机组合都撤掉 */
function clearFreqPicks() {
  const name = promptPanel.value?.name || ''
  const key = promptKeyNow.value
  for (const text of freqPickedNow.value) emitTag(name, text)
  randTag.value = ''
  topTag.value = ''
  freqAggregates.value = { ...freqAggregates.value, [key]: [] }
}

/** 例图提示词：点选就把整段复制走，不给任何提示；单选时选另一张会把这一组里已选的那条换掉 */
function pickExamplePrompt(p) {
  const name = promptPanel.value?.name || ''
  const key = normName(name)
  if (!key || !p?.text) return
  const wasAdded = props.addedWords.includes(p.text)
  if (!exampleMulti.value) {
    const list = promptImagePrompts.value[key] || []
    for (const it of list) {
      if (it.text !== p.text && props.addedWords.includes(it.text)) emitTag(name, it.text)
    }
  }
  emitTag(name, p.text)
  // 取消勾选时不复制，只有真正加进新提示词才顺手放进剪贴板
  if (!wasAdded) copyQuiet(p.text)
}

/** 静默复制：不弹提示、不改按钮文案，失败就算了 */
function copyQuiet(text) {
  if (!text) return
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {})
      return
    }
  } catch { /* 走下面的兜底 */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  } catch { /* 剪贴板不可用就只当没复制 */ }
}

function isFast(item) {
  const n = normName(readName(item))
  if (!n) return false
  return fastKeys.value.has(n)
}

function fastTip(item) {
  if (!fast.value.ready) return '本机服务未启动，极速模式不可用'
  if (isFast(item)) return `⚡ 已在极速目录：${fast.value.fastDir}\n原路径下是软连接，ComfyUI 照常能用`
  return '这条 LoRA 还在原目录（慢盘）。打开极速模式会把已勾选的搬进快盘'
}

const fastCount = computed(() => items.value.filter(isFast).length)
const fastOn = computed(() => fast.value.count > 0)
/** 已勾选但还没进快盘的那些 */
const pendingFastNames = computed(() =>
  items.value
    .filter((it) => isActive(it) && !isFast(it))
    .map(readName)
    .filter(Boolean)
)

const fastSub = computed(() => {
  if (!fast.value.ready) return '本机服务不可用 · 用 npm run dev / serve 启动才有极速模式'
  if (busy.value) {
    const j = job.value
    const verb = j.kind === 'restore' ? '还原' : '搬进快盘'
    // 首次搬运前要先扫一遍 LoRA 目录（跟软链，慢盘上几秒），这时还没文件名，就把日志摊出来
    if (!j.current) {
      const last = j.log?.length ? j.log[j.log.length - 1].msg : ''
      return last || `${verb}中…`
    }
    return `${verb}中 ${j.done}/${j.total || '?'} · ${j.current}`
  }
  if (job.value?.state === 'partial' && job.value.errors?.length) {
    return `上次 ${job.value.failed} 个没成功 · ${job.value.errors[0]}`
  }
  if (fastOn.value) {
    const mb = (fast.value.sizeTotal / 1073741824).toFixed(2)
    return `${fast.value.count} 个在快盘 · ${mb} GB`
  }
  return '未使用 · 打开后把已勾选的 LoRA 搬进快盘'
})

const fastPct = computed(() => {
  const j = job.value
  if (!j || !j.total) return busy.value ? 8 : 0
  return Math.min(100, Math.round((j.done / j.total) * 100))
})

async function refreshFast() {
  try {
    const d = await fastStatus()
    fast.value = {
      ready: true,
      fastDir: d.fastDir || '',
      scriptFile: d.scriptFile || '',
      keys: Array.isArray(d.keys) ? d.keys : [],
      count: Number(d.count || 0),
      sizeTotal: Number(d.sizeTotal || 0),
      err: '',
    }
  } catch (err) {
    fast.value = { ...fast.value, ready: false, err: err?.message || String(err) }
  }
}

let pollToken = 0

/** 轮询后台任务进度，跑完刷新一次状态 */
async function track(jobId) {
  const token = ++pollToken
  for (;;) {
    let got
    try {
      got = await fastJob(jobId)
    } catch (err) {
      fast.value = { ...fast.value, err: err?.message || String(err) }
      break
    }
    if (token !== pollToken) return
    job.value = got.job
    if (got.job.state !== 'running') break
    await sleep(400)
  }
  await refreshFast()
}

async function applyFast(names) {
  fast.value = { ...fast.value, err: '' }
  try {
    const res = await fastApply(names)
    job.value = res.job
    await track(res.job.id)
  } catch (err) {
    if (err.job) {
      job.value = err.job
      await track(err.job.id)
    } else {
      fast.value = { ...fast.value, err: err?.message || String(err) }
    }
  }
}

async function turnOnFast() {
  const names = items.value.filter(isActive).map(readName).filter(Boolean)
  if (!names.length) {
    fast.value = { ...fast.value, err: '先把要加速的 LoRA 勾上，再打开极速模式' }
    return
  }
  await applyFast(names)
}

/** 开关已经开着时，把新勾选、还没加速的追加进去 */
async function doAppend() {
  askRestore.value = false
  const names = pendingFastNames.value
  if (!names.length) return
  await applyFast(names)
}

async function doRestore() {
  askRestore.value = false
  fast.value = { ...fast.value, err: '' }
  try {
    const res = await fastRestore([])
    job.value = res.job
    await track(res.job.id)
  } catch (err) {
    if (err.job) {
      job.value = err.job
      await track(err.job.id)
    } else {
      fast.value = { ...fast.value, err: err?.message || String(err) }
    }
  }
}

function onSwitch() {
  if (busy.value || !fast.value.ready) return
  if (fastOn.value) {
    askRestore.value = true
    return
  }
  turnOnFast()
}

function dismissFastErr() {
  fast.value = { ...fast.value, err: '' }
}

/* ---------------------------------------------------------------- 常用权重
 * 点权重输入框弹出常用值，选中即写回；仍然可以直接手输 / ‹ › 微调。
 */
const WEIGHT_PRESETS = [
  0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8,
  0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2,
]

const weightMenu = ref(null) // { index, field: 'strength' | 'clip', left, top }

function openWeightMenu(index, event, field = 'strength') {
  if (field === 'strength' && hasSweep(index)) return
  const rect = event.currentTarget.getBoundingClientRect()
  const width = 232
  const height = 218
  weightMenu.value = {
    index,
    field,
    left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    top:
      rect.bottom + 6 + height > window.innerHeight
        ? Math.max(8, rect.top - height - 6)
        : rect.bottom + 6,
  }
}

/** 弹层里高亮的那一格 */
function menuValue() {
  const menu = weightMenu.value
  const item = menu ? items.value[menu.index] : null
  if (!menu || !item) return null
  return menu.field === 'clip' ? readClip(item) : readStrength(item)
}

function closeWeightMenu() {
  weightMenu.value = null
}

function pickWeight(value) {
  const menu = weightMenu.value
  if (!menu) return
  if (menu.field === 'clip') setClipStrength(menu.index, value)
  else setStrength(menu.index, value)
  weightMenu.value = null
}

function onWeightKeydown(event) {
  if (event.key === 'Escape') {
    closeWeightMenu()
    event.target.blur()
  }
}

function onDocMouseDown(event) {
  if (!weightMenu.value) return
  if (event.target.closest?.('.lp-weight-menu')) return
  if (event.target.closest?.('.lp-step')) return
  closeWeightMenu()
}

onMounted(() => {
  refreshFast()
  if (props.open) loadPreviews()
  document.addEventListener('mousedown', onDocMouseDown, true)
  window.addEventListener('resize', closeWeightMenu)
})
watch(
  () => props.open,
  (open) => {
    if (open) {
      refreshFast()
      loadPreviews()
    } else {
      closeWeightMenu()
      hideBigPreview()
      closePromptPanel()
      drafts.value = {}
    }
  }
)
watch(itemNames, (names) => {
  if (props.open) names.forEach(fetchPreview)
})
watch(
  () => props.nodeId,
  () => {
    closeWeightMenu()
    closePromptPanel()
    drafts.value = {}
    if (props.open) loadPreviews()
  }
)
onBeforeUnmount(() => {
  pollToken++
  clearTimeout(bigTimer)
  clearTimeout(copiedTimer)
  document.removeEventListener('mousedown', onDocMouseDown, true)
  window.removeEventListener('resize', closeWeightMenu)
  onPromptDragEnd()
})

</script>

<template>
  <div v-if="nodes.length || open" class="lora-dock">
    <section v-if="open" class="lp" role="dialog" aria-label="LoRA 堆叠器">
      <header class="lp-head">
        <div class="lp-title">
          <span class="lp-dot"></span>
          <div class="lp-title-text">
            <strong>LORA堆叠器</strong>
            <span class="lp-sub">
              <template v-if="currentNode">
                {{ currentNode.cls }} · 节点 {{ nodeId }}<template v-if="chainPos"> · {{ chainPos }}</template>
              </template>
              <template v-else>当前工作流没有 LoRA 堆叠节点</template>
            </span>
          </div>
        </div>
        <div class="lp-actions">
          <button type="button" class="lp-close" title="收起面板" @click="emit('close')">×</button>
        </div>
      </header>

      <!-- 极速模式：把已勾选的 LoRA 实体文件搬到快盘，原位置留软连接 -->
      <div
        class="lp-fastbar"
        :class="{ on: fastOn, busy, off: !fast.ready }"
        :title="fast.ready ? `快盘目录：${fast.fastDir}\n还原脚本：${fast.scriptFile}` : fastSub"
      >
        <span class="lp-fastbar-bolt" :class="{ on: fastOn }">⚡</span>
        <div class="lp-fastbar-text">
          <span class="lp-fastbar-title">极速模式</span>
          <span class="lp-fastbar-sub">{{ fastSub }}</span>
        </div>
        <button
          type="button"
          class="lp-switch"
          :class="{ on: fastOn, busy, disabled: !fast.ready || busy }"
          :disabled="!fast.ready || busy"
          :title="
            !fast.ready
              ? '本机服务未启动，极速模式不可用'
              : fastOn
                ? '关闭并把极速目录里的 LoRA 还原回原路径'
                : `把当前已勾选的 ${activeCount} 个 LoRA 搬进 ${fast.fastDir}`
          "
          :aria-pressed="fastOn"
          @click="onSwitch"
        >
          <i></i>
        </button>
      </div>
      <div v-if="busy || job?.state === 'partial'" class="lp-progress" :class="{ bad: job?.state === 'partial' }">
        <i :style="{ width: fastPct + '%' }"></i>
      </div>

      <div v-if="askRestore" class="lp-ask">
        <span>
          {{ fast.count }} 个在快盘<template v-if="pendingFastNames.length">
            · 还能再搬 {{ pendingFastNames.length }} 个</template
          >
        </span>
        <div class="lp-ask-actions">
          <button v-if="pendingFastNames.length" type="button" @click="doAppend">搬新的</button>
          <button type="button" class="danger" @click="doRestore">全部还原</button>
          <button type="button" @click="askRestore = false">取消</button>
        </div>
      </div>

      <p v-if="fast.err && fast.ready" class="lp-fast-err" @click="dismissFastErr">
        {{ fast.err }}
      </p>

      <div v-if="chains.length" class="lp-chains">
        <div v-for="chain in chains" :key="chain.ids.join('>')" class="lp-chain">
          <span class="lp-chain-tag" :class="{ live: chain.chained || chain.connected }">
            {{ chain.chained ? `串联 ${chain.ids.length}` : chain.connected ? '已接入' : '未接入' }}
          </span>
          <template v-for="(n, ni) in chain.nodes" :key="n.id">
            <span v-if="ni" class="lp-chain-arrow">→</span>
            <button
              type="button"
              class="lp-chip"
              :class="{ on: n.id === nodeId, muted: !n.activeCount }"
              :title="`${n.cls}${n.title ? ' · ' + n.title : ''}\n启用 ${n.activeCount}/${n.count}，点击编辑`"
              @click="emit('select-node', n.id)"
            >
              <span class="lp-chip-id">{{ n.id }}</span>
              <span class="lp-chip-count">{{ n.activeCount }}/{{ n.count }}</span>
            </button>
          </template>
          <template v-if="chain.end">
            <span class="lp-chain-arrow">→</span>
            <span class="lp-chain-end" :title="`${chain.end.cls} · 节点 ${chain.end.id}`">
              {{ chain.end.id }} {{ chain.end.title || chain.end.cls }}
            </span>
          </template>
        </div>
        <p v-if="chains.some((c) => c.chained)" class="lp-chains-hint">
          上游堆叠会并入下游，预览按串联顺序合并启用项
        </p>
      </div>

      <div v-if="!currentNode" class="lp-empty">
        <p>没有可编辑的 LoRA 堆叠项。</p>
        <p class="lp-empty-sub">
          先在 ComfyUI 里跑一次带 LoRA 堆叠器（LoraManager）的工作流，再点右上角「刷新工作流」。
        </p>
      </div>

      <template v-else>
        <label class="lp-gallery-toggle" @click.stop>
          <input v-model="gallery" type="checkbox" />
          <span>已勾选预览图</span>
        </label>
        <div class="lp-stack">
          <div class="lp-stack-head">
            <span class="lp-stack-label">{{ previewLabel }}</span>
            <span class="lp-sync"><i></i>{{ previewEnabled }}/{{ previewItems.length }} 启用</span>
          </div>
          <textarea
            class="lp-prompt"
            readonly
            spellcheck="false"
            :value="promptText"
            :title="chainOfNode?.chained ? '串联链路上启用中的 LoRA 标签（只读）' : '启用中的 LoRA 标签预览（只读）'"
          ></textarea>
          <div class="lp-add">
            <input
              v-model="addText"
              class="lp-add-input"
              type="text"
              placeholder="粘贴 <lora:f_FLUX:1> 后回车"
              spellcheck="false"
              @input="addError = ''"
              @keydown.enter.prevent="addFromText"
            />
            <button type="button" class="lp-add-btn" :disabled="!addText.trim()" @click="addFromText">
              添加
            </button>
          </div>
          <p v-if="addError" class="lp-add-err">{{ addError }}</p>
          <p v-if="nodeSweepCount" class="lp-sweep-note">
            当前节点 {{ nodeSweepCount }} 条 LoRA 开了权重对比：生成时按对比值，上面标签里是原权重。
          </p>
        </div>

        <div class="lp-list">
          <div class="lp-list-head">
            <label class="lp-check lp-toggle-all">
              <input type="checkbox" :checked="allActive" @change="toggleAll" />
              <span>Toggle All</span>
            </label>
            <div class="lp-filter" role="group" aria-label="筛选 LoRA">
              <button
                v-for="f in filters"
                :key="f.key"
                type="button"
                :class="{ on: filter === f.key }"
                @click="filter = f.key"
              >
                {{ f.label }}<span class="lp-filter-count">{{ f.count }}</span>
              </button>
            </div>
          </div>
          <div class="lp-rows" @scroll="hideBigPreview">
            <div
              v-for="({ item, index: i }) in visibleRows"
              :key="i"
              class="lp-row-wrap"
              :class="{
                on: isActive(item) && !isBypassed(item),
                off: !isActive(item),
                sweeping: hasSweep(i),
                bypassed: isBypassed(item),
              }"
            >
              <div
                class="lp-thumb"
                :class="{ empty: !previewOf(item) }"
                @mouseenter="showBigPreview(item, $event)"
                @mouseleave="hideBigPreview"
              >
                <img
                  v-if="previewOf(item)"
                  :src="previewOf(item)"
                  :alt="readName(item)"
                  :title="readName(item)"
                  loading="lazy"
                  @error="onPreviewError(item)"
                />
              </div>
              <div class="lp-row">
                <label class="lp-check" @click.stop>
                  <input
                    type="checkbox"
                    :checked="isActive(item)"
                    :title="isActive(item) ? '停用这一条' : '启用这一条'"
                    @change="setActive(i, $event.target.checked)"
                  />
                </label>
                <span
                  class="lp-bolt"
                  :class="{ on: isFast(item) }"
                  :title="fastTip(item)"
                  @click.stop
                  >⚡</span
                >
                <span
                  class="lp-name"
                  :title="nameTitle(item)"
                  @click.stop="setActive(i, !isActive(item))"
                  >{{ readName(item) || '（未命名）' }}</span
                >
                <button
                  type="button"
                  class="lp-keep"
                  :class="{ on: isBypassed(item) }"
                  :disabled="!isActive(item)"
                  :title="
                    isBypassed(item)
                      ? '取消禁用：重新参与生成'
                      : '禁用但保留：留在已勾选列表里，生成时不生效'
                  "
                  @click.stop="setBypass(i, !isBypassed(item))"
                >
                  ⊘
                </button>
                <div
                  class="lp-step"
                  :class="{ muted: hasSweep(i) }"
                  :title="hasSweep(i) ? '这条已开权重对比，生成时按下面的多个权重' : ''"
                  @click.stop
                >
                  <button
                    type="button"
                    class="lp-arrow"
                    title="减少 0.05"
                    :disabled="hasSweep(i)"
                    @click="nudgeStrength(i, -0.05)"
                  >
                    ‹
                  </button>
                  <input
                    type="number"
                    step="0.05"
                    :value="inputText(i, item, 'strength')"
                    title="强度：输入即生效；点击弹出常用权重"
                    :disabled="hasSweep(i)"
                    @focus="$event.target.select(); openWeightMenu(i, $event)"
                    @click.stop="openWeightMenu(i, $event)"
                    @input="onStrengthInput(i, $event)"
                    @blur="clearDraft(i, 'strength')"
                    @keydown="onWeightKeydown"
                    @keyup.enter="$event.target.blur()"
                  />
                  <button
                    type="button"
                    class="lp-arrow"
                    title="增加 0.05"
                    :disabled="hasSweep(i)"
                    @click="nudgeStrength(i, 0.05)"
                  >
                    ›
                  </button>
                </div>
                <button
                  type="button"
                  class="lp-clip-btn"
                  :class="{ on: clipOpen(item) }"
                  :title="
                    clipOpen(item)
                      ? `收起 CLIP 控制：收起后 clip 强度跟随模型强度${fmtStrength(item)}`
                      : '展开 CLIP 控制：单独设置 clip 强度（展开后标签写第三段，如 1.00:1.00）'
                  "
                  @click.stop="toggleClip(i)"
                >
                  clip
                </button>
                <button
                  type="button"
                  class="lp-cmp"
                  :class="{ on: hasSweep(i) }"
                  :disabled="!isActive(item) || isBypassed(item)"
                  :title="
                    hasSweep(i)
                      ? '关闭权重对比'
                      : '权重对比：勾多个权重，生成时各出一张（不改堆叠原值）'
                  "
                  @click.stop="toggleSweep(i)"
                >
                  {{ hasSweep(i) ? `×${sweepOf(i).length}` : '⇄' }}
                </button>
              </div>
              <div v-if="clipOpen(item)" class="lp-clip" @click.stop>
                <span class="lp-clip-tag" title="展开后标签一律写第三段（clip 为 1.00 也写成 1.00:1.00）">[clip]</span>
                <span class="lp-clip-name" :title="readName(item)">{{ readName(item) }}</span>
                <div class="lp-step lp-clip-step">
                  <button type="button" class="lp-arrow" title="减少 0.05" @click="nudgeClip(i, -0.05)">
                    ‹
                  </button>
                  <input
                    type="number"
                    step="0.05"
                    :value="inputText(i, item, 'clip')"
                    title="CLIP 强度：输入即生效；点击弹出常用权重"
                    @focus="$event.target.select(); openWeightMenu(i, $event, 'clip')"
                    @click.stop="openWeightMenu(i, $event, 'clip')"
                    @input="onClipInput(i, $event)"
                    @blur="clearDraft(i, 'clip')"
                    @keydown="onWeightKeydown"
                    @keyup.enter="$event.target.blur()"
                  />
                  <button type="button" class="lp-arrow" title="增加 0.05" @click="nudgeClip(i, 0.05)">
                    ›
                  </button>
                </div>
              </div>
              <div v-if="hasSweep(i)" class="lp-sweep" @click.stop>
                <div class="lp-sweep-head">
                  <span class="lp-sweep-title">权重对比</span>
                  <span class="lp-sweep-sub">每个权重各出一张 · 不改原值</span>
                  <button type="button" class="lp-sweep-off" @click="toggleSweep(i)">收起</button>
                </div>
                <div class="lp-sweep-vals">
                  <label v-for="(w, wi) in sweepOf(i)" :key="wi" class="lp-sweep-val">
                    <input
                      type="number"
                      step="0.05"
                      :value="fmtSweep(w)"
                      title="这一档权重（可直接改）"
                      @change="onSweepValue(i, wi, $event)"
                      @keyup.enter="$event.target.blur()"
                    />
                    <button
                      type="button"
                      class="lp-sweep-del"
                      title="移除这一档"
                      @click="removeSweepValue(i, wi)"
                    >
                      ×
                    </button>
                  </label>
                  <button
                    type="button"
                    class="lp-sweep-add"
                    title="再加一个权重"
                    @click="addSweepValue(i)"
                  >
                    ＋
                  </button>
                </div>
                <div v-if="sweepPresets(i).length" class="lp-sweep-presets">
                  <span>快速加</span>
                  <button
                    v-for="p in sweepPresets(i)"
                    :key="p"
                    type="button"
                    @click="addSweepPreset(i, p)"
                  >
                    {{ p.toFixed(1) }}
                  </button>
                </div>
              </div>
            </div>
            <div v-if="!visibleRows.length" class="lp-rows-empty">{{ emptyText }}</div>
          </div>
        </div>

        <footer class="lp-foot">
          <span class="lp-hint" :class="{ warn: sweepDims }">
            <template v-if="sweepDims">
              权重对比 {{ sweepDims }} 项 · 共 {{ sweepCombos }} 组，逐组生成
            </template>
            <template v-else>改动会写回当前工作流，下次「发送」生效</template>
          </span>
          <div class="lp-foot-actions">
            <button
              v-if="sweepDims"
              type="button"
              class="lp-reset warn"
              title="清除所有 LoRA 的权重对比"
              @click="emit('clear-sweeps')"
            >
              清除对比
            </button>
            <button type="button" class="lp-reset" :disabled="!baseline" @click="emit('reset')">
              恢复原值
            </button>
          </div>
        </footer>
      </template>
    </section>

    <button
      type="button"
      class="lora-fab"
      :class="{ on: open }"
      :title="open ? '收起 LoRA 堆叠面板' : '打开 LoRA 堆叠面板'"
      @click="emit('toggle')"
    >
      <span class="fab-dot"></span>
      <span class="fab-label">LoRA 堆叠</span>
      <span v-if="nodes.length" class="fab-count">{{ nodes.length }}</span>
      <span v-if="fast.count" class="fab-fast" :title="`${fast.count} 个 LoRA 已在极速目录 ${fast.fastDir}`">
        ⚡{{ fast.count }}
      </span>
      <span class="fab-caret">{{ open ? '▾' : '▴' }}</span>
    </button>

    <Teleport to="body">
      <section
        v-if="promptPanel"
        class="lp-tags"
        :style="{ left: promptPanel.left + 'px', top: promptPanel.top + 'px' }"
      >
        <header class="lp-tags-head" title="按住这里拖动面板" @mousedown="onPromptDragStart">
          <span class="lp-tags-title">提示词</span>
          <span class="lp-tags-name" :title="promptPanel.name">{{ promptPanel.name }}</span>
          <button type="button" class="lp-tags-close" title="关闭" @click="closePromptPanel">
            ×
          </button>
        </header>
        <div v-if="promptDescNow || promptFreqNow.length" class="lp-tags-tabs">
          <button
            type="button"
            class="lp-tags-tab"
            :class="{ on: activePromptTab === 'tags' }"
            @click="promptTab = 'tags'"
          >
            标签
          </button>
          <button
            v-if="promptFreqNow.length"
            type="button"
            class="lp-tags-tab"
            :class="{ on: activePromptTab === 'words' }"
            :title="`LoraManager 里 ${promptFreqNow.length} 个训练词，按出现次数排`"
            @click="promptTab = 'words'"
          >
            训练词
          </button>
          <button
            v-if="promptDescNow"
            type="button"
            class="lp-tags-tab"
            :class="{ on: activePromptTab === 'desc' }"
            title="LoraManager 里的模型描述"
            @click="promptTab = 'desc'"
          >
            模型描述
          </button>
        </div>
        <div class="lp-tags-body">
          <div v-if="activePromptTab === 'desc'" class="lp-tags-desc" v-html="promptDescNow"></div>
          <div v-else-if="activePromptTab === 'words'" class="lp-words">
            <div class="lp-words-ops">
              <button
                type="button"
                class="lp-words-btn"
                :class="{ on: allWordsOn }"
                :title="
                  allWordsOn
                    ? '再点一下从「新提示词」里移除这条'
                    : `把 ${promptFreqNow.length} 个训练词用逗号串成一条，放进新提示词`
                "
                @click="pickAllWords"
              >
                {{ allWordsOn ? `取消全部串联（${promptFreqNow.length} 词）` : `全部串成一个标签（${promptFreqNow.length} 词）` }}
              </button>
              <div class="lp-words-rand">
                <span class="lp-words-rand-text">随机抽取</span>
                <input
                  v-model.number="randCount"
                  class="lp-words-num"
                  type="number"
                  min="1"
                  :max="promptFreqNow.length"
                  title="随机组合用的词数，超过词表长度按词表长度算"
                />
                <span class="lp-words-rand-text">个</span>
                <button
                  type="button"
                  class="lp-words-btn lp-words-rand-btn"
                  title="按上面的数量立刻随机组合成一条标签；已经有随机组合就直接换掉"
                  @click="pickRandomWords"
                >
                  随机组合
                </button>
                <button
                  type="button"
                  class="lp-words-btn lp-words-rand-btn"
                  :disabled="!randTagOn"
                  :title="randTagOn ? `移除这条随机组合：${randTag}` : '当前没有随机组合'"
                  @click="clearRandomTag"
                >
                  取消随机
                </button>
              </div>
              <button
                type="button"
                class="lp-words-btn lp-words-top"
                :class="{ on: topTagOn }"
                :title="
                  topTagOn
                    ? `再点一下从「新提示词」里移除：\n${topTag}`
                    : `取词频最高的前 ${topCount} 个，按现在的顺序用逗号串成一条标签`
                "
                @click="pickTopWords"
              >
                {{ topTagOn ? `取消前 ${topTagCount} 个串联` : `前 ${topCount} 个按顺序串联` }}
              </button>
              <button
                type="button"
                class="lp-words-btn lp-words-clear"
                :disabled="!freqPickedNow.size"
                :title="
                  freqPickedNow.size
                    ? '把这个 LoRA 的训练词点选全部撤掉（单个词和批量组合都算）'
                    : '当前没有训练词点选'
                "
                @click="clearFreqPicks"
              >
                清除训练词点选{{ freqPickedNow.size ? `（${freqPickedNow.size}）` : '' }}
              </button>
            </div>
            <div class="lp-words-scroll">
              <div class="lp-words-head">
                <span>训练词 · 点一下加到新提示词</span>
                <span class="lp-words-found">找到 {{ promptFreqNow.length }} 个词</span>
              </div>
              <div class="lp-words-grid">
                <button
                  v-for="w in promptFreqNow"
                  :key="w.word"
                  type="button"
                  class="lp-words-chip"
                  :class="{ on: addedWords.includes(w.word) }"
                  :title="
                    addedWords.includes(w.word)
                      ? `${w.word}\n再点一下从「新提示词」里移除`
                      : `${w.word}${w.count ? ` · 出现 ${w.count} 次` : ''}\n点一下加进新提示词并复制`
                  "
                  @click="pickFreqWord(w.word)"
                >
                  <span class="lp-words-text">{{ w.word }}</span>
                  <span v-if="w.count" class="lp-words-badge">{{ w.count }}</span>
                </button>
              </div>
            </div>
          </div>
          <template v-else>
            <div class="lp-tags-scroll">
              <div class="lp-tags-list">
                <span class="lp-tags-label">触发词 · 点一下加到新提示词</span>
                <p v-if="promptLoading" class="lp-tags-empty">读取中…</p>
                <p v-else-if="!promptWordsNow.length" class="lp-tags-empty">
                  这个 LoRA 没取到触发词（需要 LoraManager 里有它的 metadata）
                </p>
                <button
                  v-for="w in promptWordsNow"
                  :key="w"
                  type="button"
                  class="lp-tags-word"
                  :class="{ on: addedWords.includes(w) }"
                  :title="addedWords.includes(w) ? `${w}\n再点一下从「新提示词」里移除` : w"
                  @click="addPromptTag(w)"
                >
                  {{ w }}
                </button>
              </div>
              <div v-if="promptPromptsNow.length" class="lp-tags-list">
                <div class="lp-tags-list-head">
                  <span class="lp-tags-label">
                    例图提示词 · {{ exampleMulti ? '多选' : '单选，选另一张会替换' }}
                  </span>
                  <label
                    class="lp-tags-multi"
                    title="关闭：一次只用一张例图提示词，选另一张会替换已选的；开启：可以同时选多张"
                  >
                    <input v-model="exampleMulti" type="checkbox" />
                    <span>多选</span>
                  </label>
                </div>
                <button
                  v-for="p in promptPromptsNow"
                  :key="p.i + p.text"
                  type="button"
                  class="lp-tags-word lp-tags-prompt"
                  :class="{ on: addedWords.includes(p.text), blank: !p.text }"
                  @click="pickExamplePrompt(p)"
                  @mouseenter="showBigUrl(p.url, `图 ${p.i + 1}`, $event)"
                  @mouseleave="hideBigPreview"
                >
                  <img v-if="p.url" class="lp-tags-thumb" :src="p.url" alt="" loading="lazy" />
                  <span class="lp-tags-prompt-text">
                    <em class="lp-tags-idx">图 {{ p.i + 1 }}</em>{{ p.text }}
                  </span>
                </button>
              </div>
            </div>
            <p class="lp-tags-foot">标签排在「＋ 加一个提示词」上面，拖动可换顺序</p>
          </template>
        </div>
      </section>
    </Teleport>

    <Teleport to="body">
      <section v-if="gallery" class="lp-gallery" aria-label="已勾选 LoRA 预览图">
        <header class="lp-gallery-head">
          <span>已勾选预览图</span>
          <span class="lp-gallery-count">{{ checkedPreviews.length }} 张</span>
          <label class="lp-gallery-pin" title="开启后：已启用的排前面，临时禁用的沉到下面">
            <input v-model="galleryTop" type="checkbox" />
            <span>顶置</span>
          </label>
          <label
            class="lp-gallery-pin sub"
            title="开启后：点开某个 LoRA 的标签面板时，没点过触发词就自动选中第一条"
          >
            <input v-model="autoFirst" type="checkbox" />
            <span>默认第一条</span>
          </label>
          <button type="button" class="lp-gallery-close" title="关掉预览图面板" @click="gallery = false">
            ×
          </button>
        </header>
        <div v-if="checkedPreviews.length" class="lp-gallery-grid">
          <figure
            v-for="p in galleryItems"
            :key="p.name"
            class="lp-gallery-item"
            :class="{ bypassed: p.bypassed }"
          >
            <button
              type="button"
              class="lp-g-shot"
              :title="
                p.bypassed
                  ? '点击取消临时禁用：重新参与生成'
                  : '点击临时禁用：留在已勾选里，生成时不生效'
              "
              @click.stop="setBypass(p.index, !p.bypassed)"
            >
              <img :src="p.url" :alt="p.name" loading="lazy" />
              <span
                v-if="taggedWords(p).length"
                class="lp-g-tagdot"
                :title="`已加进新提示词 ${taggedWords(p).length} 条：\n${taggedWords(p).join('\n')}`"
              >
                {{ taggedWords(p).length }}
              </span>
              <span v-if="p.bypassed" class="lp-g-off">⊘ 已禁用</span>
            </button>
            <button
              type="button"
              class="lp-g-name"
              :class="{ copied: copiedName === p.name }"
              :title="`点击复制：${p.name}`"
              @click.stop="copyName(p.name)"
            >
              {{ copiedName === p.name ? '已复制' : p.name }}
            </button>
            <div class="lp-g-ctrl" @click.stop>
              <button
                type="button"
                class="lp-g-tag"
                :class="{ on: promptPanel?.name === p.name, tagged: taggedWords(p).length }"
                :title="
                  taggedWords(p).length
                    ? `这个 LoRA 已有 ${taggedWords(p).length} 条标签进了新提示词\n${taggedWords(p).join('\n')}\n点击查看触发词`
                    : '提示词标签：查看这个 LoRA 的触发词，点一下加进新提示词'
                "
                @click.stop="openPromptPanel(p, $event)"
              >
                标签
              </button>
              <div class="lp-g-step" :class="{ muted: hasSweep(p.index) }">
                <button
                  type="button"
                  class="lp-g-arrow"
                  :disabled="hasSweep(p.index)"
                  title="减少 0.05"
                  @click="nudgeStrength(p.index, -0.05)"
                >
                  ‹
                </button>
                <input
                  type="number"
                  step="0.05"
                  :value="inputText(p.index, p.item, 'strength')"
                  title="模型强度：输入即生效；点击弹出常用权重"
                  :disabled="hasSweep(p.index)"
                  @focus="$event.target.select(); openWeightMenu(p.index, $event)"
                  @click.stop="openWeightMenu(p.index, $event)"
                  @input="onStrengthInput(p.index, $event)"
                  @blur="clearDraft(p.index, 'strength')"
                  @keydown="onWeightKeydown"
                  @keyup.enter="$event.target.blur()"
                />
                <button
                  type="button"
                  class="lp-g-arrow"
                  :disabled="hasSweep(p.index)"
                  title="增加 0.05"
                  @click="nudgeStrength(p.index, 0.05)"
                >
                  ›
                </button>
              </div>
              <button
                type="button"
                class="lp-clip-btn lp-g-clip"
                :class="{ on: clipOpen(p.item) }"
                :title="
                  clipOpen(p.item)
                    ? '收起 CLIP 控制：clip 强度跟随模型强度'
                    : '展开 CLIP 控制：单独设置 clip 强度'
                "
                @click.stop="toggleClip(p.index)"
              >
                clip
              </button>
              <button
                type="button"
                class="lp-cmp lp-g-cmp"
                :class="{ on: hasSweep(p.index) }"
                :disabled="p.bypassed"
                :title="
                  hasSweep(p.index)
                    ? '关闭权重对比'
                    : '权重对比：生成时按多个权重各出一张'
                "
                @click.stop="toggleSweep(p.index)"
              >
                {{ hasSweep(p.index) ? `×${sweepOf(p.index).length}` : '⇄' }}
              </button>
            </div>
            <div
              v-if="clipOpen(p.item)"
              class="lp-g-step lp-g-clip-step"
              @click.stop
            >
              <span class="lp-g-clip-tag">clip</span>
              <button
                type="button"
                class="lp-g-arrow"
                title="减少 0.05"
                @click="nudgeClip(p.index, -0.05)"
              >
                ‹
              </button>
              <input
                type="number"
                step="0.05"
                :value="inputText(p.index, p.item, 'clip')"
                title="CLIP 强度：输入即生效；点击弹出常用权重"
                @focus="$event.target.select(); openWeightMenu(p.index, $event, 'clip')"
                @click.stop="openWeightMenu(p.index, $event, 'clip')"
                @input="onClipInput(p.index, $event)"
                @blur="clearDraft(p.index, 'clip')"
                @keydown="onWeightKeydown"
                @keyup.enter="$event.target.blur()"
              />
              <button
                type="button"
                class="lp-g-arrow"
                title="增加 0.05"
                @click="nudgeClip(p.index, 0.05)"
              >
                ›
              </button>
            </div>
          </figure>
        </div>
        <p v-else class="lp-gallery-empty">已勾选的 LoRA 还没有预览图</p>
      </section>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="bigPreview"
        class="lp-big"
        :style="{ left: bigPreview.left + 'px', top: bigPreview.top + 'px' }"
      >
        <img :src="bigPreview.url" :alt="bigPreview.name" />
        <div class="lp-big-name">{{ bigPreview.name }}</div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="weightMenu"
        class="lp-weight-menu"
        :style="{ left: weightMenu.left + 'px', top: weightMenu.top + 'px' }"
        @mousedown.stop
      >
        <div class="lp-weight-head">
          <span>{{ weightMenu.field === 'clip' ? 'CLIP 常用权重' : '常用权重' }}</span>
          <span class="lp-weight-hint">也可直接输入</span>
        </div>
        <div class="lp-weight-grid">
          <button
            v-for="w in WEIGHT_PRESETS"
            :key="w"
            type="button"
            class="lp-weight-val"
            :class="{ on: Math.abs((menuValue() ?? -1) - w) < 0.001 }"
            @click="pickWeight(w)"
          >
            {{ w.toFixed(2) }}
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 固定在视口右下角，不影响原有布局 */
.lora-dock {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 55;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  pointer-events: none;
}
.lora-dock > * { pointer-events: auto; }

/* —— 面板：贴合截图里的节点外观 —— */
.lp {
  width: 460px;
  height: min(700px, calc(100vh - 110px));
  display: flex;
  flex-direction: column;
  background: #383838;
  border: 1px solid #4f4f4f;
  border-radius: 12px;
  box-shadow: 0 22px 60px rgba(0, 0, 0, .55), inset 0 1px 0 rgba(255, 255, 255, .05);
  color: #d6d6d6;
  overflow: hidden;
  animation: lp-in .14s ease-out;
}
@keyframes lp-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

.lp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px 8px 12px;
  background: linear-gradient(#2f2f2f, #282828);
  border-bottom: 1px solid #1f1f1f;
}
.lp-title { display: flex; align-items: center; gap: 9px; min-width: 0; }
.lp-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: #7a7a7a;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .16);
}
.lp-title-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.35; }
.lp-title-text strong { font-size: 13px; font-weight: 600; color: #e3e3e3; letter-spacing: .2px; }
.lp-sub {
  font-size: 10.5px;
  color: #8f8f8f;
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lp-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.lp-close {
  width: 22px;
  height: 22px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  line-height: 1;
  color: #a8a8a8;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
}
.lp-close:hover { color: #f0f0f0; background: #3d3d3d; border-color: #4f4f4f; }

/* —— 极速模式条 —— */
.lp-fastbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  background: #2b2b2b;
  border-bottom: 1px solid #1f1f1f;
}
.lp-fastbar.on { background: linear-gradient(#332f22, #2b2820); }
.lp-fastbar.off { opacity: .72; }
.lp-fastbar-bolt {
  flex: 0 0 auto;
  font-size: 13px;
  line-height: 1;
  color: #6a6a6a;
  filter: grayscale(1);
  opacity: .6;
}
.lp-fastbar-bolt.on {
  color: #ffd24a;
  filter: none;
  opacity: 1;
  text-shadow: 0 0 8px rgba(255, 210, 74, .8);
}
.lp-fastbar-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.3;
  flex: 1 1 auto;
}
.lp-fastbar-title { font-size: 12px; color: #dedede; font-weight: 600; letter-spacing: .2px; }
.lp-fastbar-sub {
  font-size: 10px;
  color: #8d8d8d;
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lp-fastbar.on .lp-fastbar-sub { color: #b9a97b; }

/* 开关 */
.lp-switch {
  position: relative;
  flex: 0 0 auto;
  width: 38px;
  height: 20px;
  padding: 0;
  border-radius: 999px;
  border: 1px solid #4d4d4d;
  background: #1f1f1f;
  cursor: pointer;
  transition: background .15s, border-color .15s;
}
.lp-switch i {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #8a8a8a;
  transition: transform .16s ease, background .15s;
}
.lp-switch:hover:not(.disabled) { border-color: #6c6c6c; }
.lp-switch.on { background: #4a3f1e; border-color: #8a7330; }
.lp-switch.on i { transform: translateX(18px); background: #ffd24a; box-shadow: 0 0 8px rgba(255, 210, 74, .75); }
.lp-switch.disabled { opacity: .45; cursor: not-allowed; }
.lp-switch.busy i { animation: lp-pulse .9s ease-in-out infinite; }
@keyframes lp-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .35; }
}

/* 进度条 */
.lp-progress {
  flex: 0 0 auto;
  height: 2px;
  background: #232323;
  overflow: hidden;
}
.lp-progress i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #ffcf4a, #ffb020);
  transition: width .3s ease;
}
.lp-progress.bad i { background: #c9564f; }

/* 还原确认 */
.lp-ask {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 12px;
  font-size: 11px;
  color: #e7cfa0;
  background: #3a3222;
  border-bottom: 1px solid #1f1f1f;
}
.lp-ask-actions { display: flex; gap: 6px; flex: 0 0 auto; }
.lp-ask-actions button {
  height: 21px;
  padding: 0 8px;
  font-size: 11px;
  color: #d8d8d8;
  background: #454545;
  border: 1px solid #5c5c5c;
  border-radius: 5px;
  cursor: pointer;
}
.lp-ask-actions button:hover { background: #525252; }
.lp-ask-actions button.danger { color: #ffdede; background: #6d3a37; border-color: #8e4a46; }
.lp-ask-actions button.danger:hover { background: #7d4340; }

.lp-fast-err {
  flex: 0 0 auto;
  margin: 0;
  padding: 6px 12px;
  font-size: 10.5px;
  line-height: 1.5;
  color: #f0b0ab;
  background: #3a2725;
  border-bottom: 1px solid #1f1f1f;
  cursor: pointer;
}

/* —— 串联链路 —— */
.lp-chains {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 12px 0;
}
.lp-chain {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}
.lp-chain-tag {
  flex: 0 0 auto;
  padding: 2px 7px;
  font-size: 10px;
  line-height: 1.4;
  color: #8f8f8f;
  background: #2c2c2c;
  border: 1px solid #474747;
  border-radius: 999px;
}
.lp-chain-tag.live { color: #9ccf7f; border-color: #4f6b3f; background: #2b3428; }
.lp-chain-arrow { color: #6f6f6f; font-size: 11px; line-height: 1; }
.lp-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 7px;
  font-family: var(--mono);
  font-size: 11px;
  color: #cfcfcf;
  background: #2a2a2a;
  border: 1px solid #4a4a4a;
  border-radius: 6px;
  cursor: pointer;
}
.lp-chip:hover { background: #363636; border-color: #5c5c5c; }
.lp-chip.on {
  border-color: #5b9bd5;
  background: #2d3a46;
  color: #d8ebff;
  box-shadow: 0 0 0 1px rgba(91, 155, 213, .25);
}
.lp-chip.muted .lp-chip-id { color: #8f8f8f; }
.lp-chip-count {
  padding: 0 4px;
  border-radius: 999px;
  background: #3c3c3c;
  color: #9f9f9f;
  font-size: 9.5px;
  line-height: 14px;
}
.lp-chip.on .lp-chip-count { background: #3d5468; color: #cfe6fb; }
.lp-chip.muted .lp-chip-count { color: #7d7d7d; }
.lp-chain-end {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
  font-size: 10.5px;
  color: #8f8f8f;
}
.lp-chains-hint { margin: 0; font-size: 10px; color: #7f7f7f; line-height: 1.5; }

/* —— lora 堆栈文本预览 —— */
/* 已勾选预览图开关（在「串联启用预览」上方） */
.lp-gallery-toggle {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 12px 0;
  font-size: 11.5px;
  color: #b9b9b9;
  cursor: pointer;
  user-select: none;
}
.lp-gallery-toggle input {
  width: 13px;
  height: 13px;
  margin: 0;
  accent-color: #4b8fce;
  cursor: pointer;
}
.lp-gallery-toggle:hover { color: #e2e2e2; }

.lp-stack { flex: 0 0 auto; padding: 10px 12px 0; }
.lp-stack-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.lp-stack-label { font-size: 12px; color: #bdbdbd; }
.lp-sync {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  color: #9a9a9a;
  font-family: var(--mono);
}
.lp-sync i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #8fce6b;
  box-shadow: 0 0 6px rgba(143, 206, 107, .7);
}
.lp-prompt {
  width: 100%;
  height: 72px;
  padding: 7px 9px;
  resize: none;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.6;
  color: #d0d0d0;
  background: #1e1e1e;
  border: 1px solid #3f3f3f;
  border-radius: 7px;
  outline: none;
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: #555 transparent;
}
.lp-prompt:focus { border-color: #5b7fa5; }

/* —— 手动添加 <lora:名称:权重> —— */
.lp-add { display: flex; gap: 6px; margin-top: 8px; }
.lp-add-input {
  flex: 1 1 0;
  width: auto;
  min-width: 0;
  height: 27px;
  padding: 0 8px;
  font-family: var(--mono);
  font-size: 11px;
  color: #dedede;
  background: #1e1e1e;
  border: 1px solid #3f3f3f;
  border-radius: 6px;
  outline: none;
}
.lp-add-input::placeholder { color: #777; }
.lp-add-input:focus { border-color: #5b7fa5; box-shadow: none; }
.lp-add-btn {
  flex: 0 0 auto;
  height: 27px;
  padding: 0 11px;
  font-size: 11px;
  color: #cfe6fb;
  background: #3d5468;
  border: 1px solid #4d6a85;
  border-radius: 6px;
  cursor: pointer;
}
.lp-add-btn:hover:not(:disabled) { background: #46617a; border-color: #5b7fa5; }
.lp-add-btn:disabled { opacity: .45; cursor: not-allowed; }
.lp-add-err { margin: 5px 0 0; font-size: 10.5px; color: #e08b8b; }
.lp-sweep-note { margin: 7px 0 0; font-size: 10.5px; line-height: 1.5; color: #8fb4d4; }

/* —— 列表 —— */
.lp-list {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  margin: 10px 12px 0;
  background: #333;
  border: 1px solid #474747;
  border-radius: 8px;
  overflow: hidden;
}
.lp-list-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  background: #2e2e2e;
  border-bottom: 1px solid #434343;
}
.lp-check { display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
.lp-check input[type="checkbox"] {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: #4b8fce;
  cursor: pointer;
}
.lp-toggle-all span { font-size: 12px; color: #cfcfcf; }
.lp-filter {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  flex: 0 0 auto;
  background: #262626;
  border: 1px solid #424242;
  border-radius: 7px;
}
.lp-filter button {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 20px;
  padding: 0 5px;
  font-size: 10px;
  color: #9a9a9a;
  background: transparent;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
}
.lp-filter button:hover { color: #dedede; background: #343434; }
.lp-filter button.on { color: #d6e9fb; background: #3d5468; }
.lp-filter-count { font-family: var(--mono); font-size: 9px; opacity: .85; }
.lp-rows-empty { padding: 18px 12px; text-align: center; font-size: 11px; color: #8a8a8a; }
.lp-rows {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #555 transparent;
}
.lp-rows::-webkit-scrollbar { width: 8px; }
.lp-rows::-webkit-scrollbar-thumb { background: #555; border-radius: 4px; }
.lp-rows::-webkit-scrollbar-track { background: transparent; }

/* 左侧固定缩略图位（44px），没有预览图也占位，保证各行控件对齐 */
.lp-row-wrap {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  column-gap: 8px;
  padding-left: 10px;
  border-bottom: 1px solid #3d3d3d;
}
.lp-row-wrap:last-child { border-bottom: none; }
.lp-thumb {
  grid-row: 1 / -1;
  align-self: start;
  width: 44px;
  height: 44px;
  border-radius: 6px;
  overflow: hidden;
  background: #262626;
  border: 1px solid #3d3d3d;
}
.lp-thumb.empty { border-style: dashed; border-color: #383838; }
.lp-thumb:not(.empty) { cursor: zoom-in; }
.lp-thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* 悬停缩略图时在缩略图右侧弹出大图 */
.lp-big {
  position: fixed;
  z-index: 9999;
  pointer-events: none;
  padding: 5px;
  background: #1f1f1f;
  border: 1px solid #4f4f4f;
  border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, .6);
}
.lp-big img {
  display: block;
  max-width: 300px;
  max-height: 380px;
  border-radius: 6px;
  object-fit: contain;
}
.lp-big-name {
  max-width: 300px;
  padding: 5px 2px 1px;
  font-size: 11px;
  color: #b9b9b9;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 已勾选预览图面板：屏幕右上、LoRA 面板左侧，互不遮挡 */
.lp-gallery {
  position: fixed;
  top: 16px;
  right: 492px;
  z-index: 54;
  width: 420px;
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  background: #383838;
  border: 1px solid #4f4f4f;
  border-radius: 12px;
  box-shadow: 0 22px 60px rgba(0, 0, 0, .55);
  overflow: hidden;
}
.lp-gallery-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid #454545;
  font-size: 12px;
  color: #d6d6d6;
}
.lp-gallery-count { font-size: 11px; color: #9a9a9a; }
.lp-gallery-pin {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #b9b9b9;
  cursor: pointer;
  user-select: none;
}
.lp-gallery-pin input {
  width: 13px;
  height: 13px;
  margin: 0;
  accent-color: #4b8fce;
  cursor: pointer;
}
.lp-gallery-pin.sub { margin-left: 0; }
.lp-gallery-pin:hover { color: #e2e2e2; }
.lp-gallery-close {
  margin-left: 0;
  width: 22px;
  height: 22px;
  padding: 0;
  font-size: 15px;
  line-height: 1;
  color: #9a9a9a;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.lp-gallery-close:hover { background: #4a4a4a; color: #f0f0f0; }
.lp-gallery-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px;
  padding: 12px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #555 transparent;
}
.lp-gallery-item { margin: 0; min-width: 0; }
.lp-g-shot {
  position: relative;
  display: block;
  width: 100%;
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
}
.lp-g-shot img {
  display: block;
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: cover;
  background: #262626;
  border: 1px solid #4a4a4a;
  border-radius: 8px;
  transition: border-color .12s;
}
.lp-g-shot:hover img { border-color: #7a7a7a; }
.lp-g-off {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  padding: 3px 8px;
  font-size: 11px;
  white-space: nowrap;
  color: #ffd7d7;
  background: rgba(58, 22, 22, .82);
  border: 1px solid #7a4444;
  border-radius: 999px;
}
/* 卡片有标签被加进「新提示词」：右上角亮个计数点，配色跟 clip 点亮一致 */
.lp-g-tagdot {
  position: absolute;
  top: 6px;
  right: 6px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--mono);
  font-size: 9.5px;
  line-height: 1;
  color: #b9e6da;
  background: rgba(30, 45, 42, .92);
  border: 1px solid #476b64;
  border-radius: 999px;
  box-shadow: 0 0 6px rgba(127, 208, 192, .55);
  pointer-events: none;
}
.lp-g-name {
  display: block;
  width: 100%;
  margin-top: 4px;
  padding: 0;
  font-size: 11px;
  text-align: left;
  color: #b9b9b9;
  background: transparent;
  border: none;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lp-g-name:hover { color: #f0f0f0; }
.lp-g-name.copied { color: #7bd39a; }
.lp-g-ctrl {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 5px;
}
.lp-g-step {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
  height: 22px;
  background: #1f1f1f;
  border: 1px solid #4a4a4a;
  border-radius: 6px;
  overflow: hidden;
}
.lp-g-step input {
  width: 100%;
  min-width: 0;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  color: #dedede;
  font-family: var(--mono);
  font-size: 11px;
  text-align: center;
  outline: none;
  -moz-appearance: textfield;
  appearance: textfield;
}
.lp-g-step input::-webkit-outer-spin-button,
.lp-g-step input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  appearance: none;
  margin: 0;
}
.lp-g-step input:focus { background: #262626; }
.lp-g-step.muted { opacity: .5; }
.lp-g-step.muted input,
.lp-g-step.muted .lp-g-arrow { cursor: not-allowed; }
.lp-g-arrow {
  width: 16px;
  height: 20px;
  flex: 0 0 auto;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  line-height: 1;
  color: #9a9a9a;
  background: transparent;
  border: none;
  cursor: pointer;
}
.lp-g-arrow:hover:not(:disabled) { background: #404040; color: #e6e6e6; }
.lp-g-clip {
  width: 30px;
  height: 22px;
  font-size: 9px;
}
.lp-g-cmp {
  width: 26px;
  height: 22px;
}
/* 卡片里的「标签」：打开触发词面板 */
.lp-g-tag {
  position: relative;
  flex: 0 0 auto;
  width: 34px;
  height: 22px;
  padding: 0;
  font-size: 10px;
  line-height: 1;
  color: #8f8f8f;
  background: #2a2a2a;
  border: 1px solid #484848;
  border-radius: 6px;
  cursor: pointer;
  transition: color .12s, background .12s, border-color .12s;
}
.lp-g-tag:hover { color: #dedede; background: #343434; border-color: #5f5f5f; }
.lp-g-tag.on {
  color: #cfe6fb;
  background: #3d5468;
  border-color: #4d6a85;
}
/* 已经有标签进了新提示词：跟 clip 点亮同一套配色，右上角加个亮 */
.lp-g-tag.tagged,
.lp-g-tag.on.tagged {
  color: #b9e6da;
  background: #2f4440;
  border-color: #476b64;
  box-shadow: 0 0 0 1px rgba(127, 208, 192, .16);
}
.lp-g-tag.tagged::after {
  content: '';
  position: absolute;
  top: 3px;
  right: 3px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #7fd0c0;
  box-shadow: 0 0 5px rgba(127, 208, 192, .8);
}

/* 触发词面板：只负责把这个 LoRA 的触发词交出去，标签队列显示在主提示词框上方 */
.lp-tags {
  position: fixed;
  z-index: 9998;
  width: 300px;
  max-height: min(420px, calc(100vh - 24px));
  display: flex;
  flex-direction: column;
  background: #3a3a3a;
  border: 1px solid #565656;
  border-radius: 10px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, .6);
  overflow: hidden;
}
.lp-tags-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: #333;
  border-bottom: 1px solid #4a4a4a;
  /* 标题栏就是拖动手柄 */
  cursor: move;
  user-select: none;
}
.lp-tags-title { flex: 0 0 auto; font-size: 11.5px; color: #dedede; }
.lp-tags-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 10.5px;
  color: #9fb7a8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lp-tags-close {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  padding: 0;
  font-size: 14px;
  line-height: 1;
  color: #9a9a9a;
  background: transparent;
  border: none;
  border-radius: 5px;
  cursor: pointer;
}
.lp-tags-close:hover { background: #4a4a4a; color: #f0f0f0; }
/* 有模型描述才有这排 tab；没描述时整条不渲染 */
.lp-tags-tabs {
  display: flex;
  gap: 4px;
  padding: 6px 8px 0;
  background: #333;
}
.lp-tags-tab {
  flex: 1 1 0;
  padding: 4px 6px;
  font-size: 10.5px;
  color: #9a9a9a;
  background: transparent;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  cursor: pointer;
  transition: color .12s, background .12s, border-color .12s;
}
.lp-tags-tab:hover { color: #dedede; }
.lp-tags-tab.on { color: #cfe6fb; background: #3a3a3a; border-color: #4a4a4a; }
/* 描述可能是很长的富文本：独立滚动，不撑高面板 */
.lp-tags-desc {
  flex: 1 1 auto;
  min-height: 0;
  padding: 8px 10px;
  overflow-y: auto;
  font-size: 11px;
  line-height: 1.6;
  color: #cfcfcf;
  word-break: break-word;
  scrollbar-width: thin;
  scrollbar-color: #555 transparent;
}
.lp-tags-desc :deep(p),
.lp-tags-desc :deep(ul),
.lp-tags-desc :deep(ol),
.lp-tags-desc :deep(blockquote),
.lp-tags-desc :deep(pre),
.lp-tags-desc :deep(dl) { margin: 0 0 6px; }
.lp-tags-desc :deep(ul),
.lp-tags-desc :deep(ol) { padding-left: 16px; }
.lp-tags-desc :deep(h1),
.lp-tags-desc :deep(h2),
.lp-tags-desc :deep(h3),
.lp-tags-desc :deep(h4),
.lp-tags-desc :deep(h5),
.lp-tags-desc :deep(h6) {
  margin: 0 0 6px;
  font-size: 12px;
  line-height: 1.45;
  color: #e8e8e8;
}
.lp-tags-desc :deep(a) { color: #7fb2e5; }
.lp-tags-desc :deep(hr) { margin: 6px 0; border: none; border-top: 1px solid #4a4a4a; }
.lp-tags-desc :deep(pre),
.lp-tags-desc :deep(code) { font-family: var(--mono); font-size: 10.5px; }
.lp-tags-body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.lp-tags-scroll {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #555 transparent;
}
.lp-tags-list { display: flex; flex-direction: column; gap: 4px; }
.lp-tags-label { font-size: 10.5px; color: #b9b9b9; }
.lp-tags-list-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.lp-tags-list-head .lp-tags-label {
  flex: 1 1 auto;
  min-width: 0;
}
.lp-tags-multi {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: #9a9a9a;
  cursor: pointer;
  user-select: none;
}
.lp-tags-multi:hover { color: #d6d6d6; }
.lp-tags-multi input {
  width: 12px;
  height: 12px;
  margin: 0;
  accent-color: #4b8fce;
  cursor: pointer;
}
.lp-tags-foot {
  margin: 0;
  padding: 6px 8px;
  font-size: 10px;
  line-height: 1.5;
  color: #8f8f8f;
  background: #333;
  border-top: 1px solid #4a4a4a;
}
/* 训练词 tab：上面两条批量操作，下面是按词频排的 chip 墙 */
.lp-words {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 8px;
}
.lp-words-ops {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 7px;
  border-bottom: 1px dashed #4a4a4a;
}
.lp-words-btn {
  width: 100%;
  padding: 5px 8px;
  font-size: 10.5px;
  text-align: left;
  color: #cfe6fb;
  background: #2f3742;
  border: 1px solid #40566b;
  border-radius: 6px;
  cursor: pointer;
}
.lp-words-btn:hover { background: #38434f; border-color: #4d6b85; }
.lp-words-btn.on { color: #7bd39a; background: #2f3d34; border-color: #476b4f; }
.lp-words-rand { display: flex; align-items: center; gap: 5px; }
.lp-words-rand-text { flex: 0 0 auto; font-size: 10px; color: #9a9a9a; }
.lp-words-num {
  flex: 0 0 auto;
  width: 46px;
  padding: 3px 4px;
  font-family: var(--mono);
  font-size: 10.5px;
  text-align: center;
  color: #dedede;
  background: #2b2b2b;
  border: 1px solid #4a4a4a;
  border-radius: 5px;
}
.lp-words-rand-btn { flex: 1 1 0; width: auto; padding: 5px 4px; text-align: center; }
.lp-words-rand-btn:disabled {
  color: #7a7a7a;
  background: #333;
  border-color: #444;
  cursor: default;
}
.lp-words-clear {
  color: #dbb3b3;
  background: #3a2f2f;
  border-color: #5c4343;
  text-align: center;
}
.lp-words-clear:hover:not(:disabled) { color: #f2c6c6; background: #473535; border-color: #7a5652; }
.lp-words-clear:disabled {
  color: #7a7a7a;
  background: #333;
  border-color: #444;
  cursor: default;
}
.lp-words-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #555 transparent;
}
.lp-words-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 6px;
  font-size: 10.5px;
  color: #b9b9b9;
}
.lp-words-found {
  flex: 0 0 auto;
  font-size: 10px;
  color: #8f8f8f;
}
.lp-words-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.lp-words-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 3px 4px 3px 7px;
  font-size: 11px;
  color: #7fb2e5;
  background: #2f2f2f;
  border: 1px solid #464646;
  border-radius: 6px;
  cursor: pointer;
}
.lp-words-chip:hover { background: #3a3a3a; border-color: #5a5a5a; }
.lp-words-chip.on { color: #7bd39a; background: #2f3d34; border-color: #476b4f; }
.lp-words-text {
  min-width: 0;
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lp-words-badge {
  flex: 0 0 auto;
  padding: 0 5px;
  font-size: 9.5px;
  line-height: 14px;
  color: #b0b0b0;
  background: #3d3d3d;
  border-radius: 7px;
}
.lp-words-chip.on .lp-words-badge { color: #a9d4b6; background: #3b4a40; }
.lp-tags-word {
  display: block;
  width: 100%;
  padding: 4px 6px;
  font-size: 10.5px;
  text-align: left;
  color: #d6d6d6;
  background: #2f2f2f;
  border: 1px solid #4a4a4a;
  border-radius: 5px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lp-tags-word:hover { color: #f0f0f0; background: #3f3f3f; border-color: #5f5f5f; }
.lp-tags-word.on { color: #7bd39a; background: #2f3d34; border-color: #476b4f; }
/* 例图提示词很长：缩略图 + 两行截断，悬停看大图 */
.lp-tags-prompt {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 4px;
  text-align: left;
}
/* 例图没有提示词：只占个图位，点它没反应 */
.lp-tags-prompt.blank { cursor: default; }
.lp-tags-thumb {
  flex: 0 0 auto;
  width: 38px;
  height: 46px;
  object-fit: cover;
  border-radius: 4px;
  background: #2a2a2a;
}
.lp-tags-prompt-text {
  flex: 1 1 auto;
  min-width: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  white-space: normal;
  line-height: 1.45;
  overflow: hidden;
}
.lp-tags-idx {
  font-style: normal;
  font-family: var(--mono);
  font-size: 9px;
  color: #8fc7a6;
  margin-right: 5px;
}
.lp-tags-empty { margin: 0; font-size: 10.5px; line-height: 1.5; color: #8f8f8f; }
.lp-g-clip-step { margin-top: 4px; }
.lp-g-clip-tag {
  flex: 0 0 auto;
  padding-left: 4px;
  font-family: var(--mono);
  font-size: 9px;
  color: #8fc7a6;
}
.lp-gallery-item.bypassed img { opacity: .45; filter: grayscale(.6); }
.lp-gallery-item.bypassed .lp-g-name {
  color: #e07070;
  text-decoration: line-through;
  text-decoration-color: #a15959;
}
.lp-gallery-item.bypassed .lp-g-name.copied {
  color: #7bd39a;
  text-decoration: none;
}
.lp-gallery-item.bypassed .lp-g-step input { color: #e07070; }
.lp-gallery-empty { margin: 0; padding: 16px 12px; font-size: 11.5px; color: #9a9a9a; }
@media (max-width: 1000px) {
  .lp-gallery { right: 16px; max-height: 46vh; }
}
/* 已勾选 = 绿字；未勾选 = 灰字；临时禁用（⊘）= 红字 */
.lp-row-wrap.on .lp-name { color: #7bd39a; }
.lp-row-wrap.off .lp-name { color: #858585; }
.lp-row-wrap.sweeping { background: #2f3438; }
/* 禁用保留：仍勾选，但生成时不生效 */
.lp-row-wrap.bypassed .lp-name {
  color: #e07070;
  text-decoration: line-through;
  text-decoration-color: #a15959;
}
.lp-row-wrap.bypassed .lp-step { opacity: .55; }

.lp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 10px 0;
  cursor: default;
}
.lp-row.off .lp-name { color: #858585; }
/* 极速目录里的行：点亮的闪电；否则灰掉 */
.lp-bolt {
  flex: 0 0 auto;
  width: 13px;
  text-align: center;
  font-size: 11px;
  line-height: 1;
  color: #5c5c5c;
  filter: grayscale(1);
  opacity: .45;
  cursor: help;
}
.lp-bolt.on {
  color: #ffd24a;
  filter: none;
  opacity: 1;
  text-shadow: 0 0 7px rgba(255, 210, 74, .75);
}
.lp-name {
  flex: 1 1 auto;
  min-width: 0;
  padding: 2px 4px;
  margin: -2px -4px;
  border-radius: 4px;
  font-size: 12px;
  color: #d6d6d6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: color .12s, background .12s;
}
/* 只有名称这一片区域承担「启用/停用」，避免行内误点 */
.lp-name:hover { color: #f2f2f2; background: #424242; }
/* 悬停保留各自的状态色：绿 / 红，不亮回普通行 */
.lp-row-wrap.on .lp-name:hover { color: #a5e9bd; background: #2f3d34; }
.lp-row-wrap.bypassed .lp-name:hover {
  color: #f08b8b;
  text-decoration: line-through;
  text-decoration-color: #a15959;
  background: #3d2b2b;
}

/* 强度步进：‹ 1.00 › */
.lp-step {
  display: flex;
  align-items: center;
  height: 24px;
  flex: 0 0 auto;
  background: #1f1f1f;
  border: 1px solid #4a4a4a;
  border-radius: 6px;
  overflow: hidden;
}
.lp-step input {
  width: 48px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  color: #dedede;
  font-family: var(--mono);
  font-size: 11px;
  text-align: center;
  outline: none;
  -moz-appearance: textfield;
  appearance: textfield;
}
.lp-step input::-webkit-outer-spin-button,
.lp-step input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  appearance: none;
  margin: 0;
}
.lp-step input:focus { background: #262626; box-shadow: none; }
/* 权重数字跟着名称的状态色走 */
.lp-row-wrap.on .lp-step input { color: #7bd39a; }
.lp-row-wrap.off .lp-step input { color: #858585; }
.lp-row-wrap.bypassed .lp-step input { color: #e07070; }
.lp-arrow {
  width: 20px;
  height: 22px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  line-height: 1;
  color: #9a9a9a;
  background: transparent;
  border: none;
  border-radius: 0;
  cursor: pointer;
}
.lp-arrow:hover:not(:disabled) { background: #404040; color: #e6e6e6; }
.lp-arrow:active:not(:disabled) { background: #4a4a4a; }
.lp-step.muted { opacity: .5; }
.lp-step.muted input,
.lp-step.muted .lp-arrow { cursor: not-allowed; }

/* 对比开关：⇄ / ×N */
.lp-cmp {
  flex: 0 0 auto;
  width: 30px;
  height: 24px;
  padding: 0;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1;
  color: #8f8f8f;
  background: #2a2a2a;
  border: 1px solid #484848;
  border-radius: 6px;
  cursor: pointer;
  transition: color .12s, background .12s, border-color .12s;
}
.lp-cmp:hover:not(:disabled) { color: #dedede; background: #343434; border-color: #5f5f5f; }
.lp-cmp.on {
  color: #cfe6fb;
  background: #3d5468;
  border-color: #4d6a85;
  box-shadow: 0 0 0 1px rgba(91, 155, 213, .2);
}
.lp-cmp:disabled { opacity: .35; cursor: not-allowed; }

/* 禁用保留开关：⊘ */
.lp-keep {
  flex: 0 0 auto;
  width: 26px;
  height: 24px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  line-height: 1;
  color: #8f8f8f;
  background: #2a2a2a;
  border: 1px solid #484848;
  border-radius: 6px;
  cursor: pointer;
  transition: color .12s, background .12s, border-color .12s;
}
/* 已临时禁用的按钮悬停时保留琥珀色高亮，不回落到普通灰 */
.lp-keep:hover:not(:disabled):not(.on) { color: #dedede; background: #343434; border-color: #5f5f5f; }
.lp-keep.on:hover { color: #ffcf5c; background: #54471f; border-color: #7a6430; }
.lp-keep.on {
  color: #ffcf5c;
  background: #4a3f22;
  border-color: #6d5a29;
  box-shadow: 0 0 0 1px rgba(255, 207, 92, .18);
}
.lp-keep:disabled { opacity: .35; cursor: not-allowed; }

/* CLIP 开关：展开后单独控制 clip 强度（固定宽度，避免点亮后挤动左边的权重框） */
.lp-clip-btn {
  position: relative;
  flex: 0 0 auto;
  width: 38px;
  height: 24px;
  padding: 0;
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: .2px;
  line-height: 1;
  color: #8f8f8f;
  background: #2a2a2a;
  border: 1px solid #484848;
  border-radius: 6px;
  cursor: pointer;
  transition: color .12s, background .12s, border-color .12s;
}
.lp-clip-btn:hover { color: #dedede; background: #343434; border-color: #5f5f5f; }
.lp-clip-btn.on {
  color: #b9e6da;
  background: #2f4440;
  border-color: #476b64;
  box-shadow: 0 0 0 1px rgba(127, 208, 192, .16);
}
.lp-clip-btn.on::after {
  content: '';
  position: absolute;
  top: 4px;
  right: 4px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #7fd0c0;
  box-shadow: 0 0 5px rgba(127, 208, 192, .8);
}

/* clip 展开行：[clip] 名称 ‹ 1.00 ›（右侧留出与上一行 clip/⇄ 等宽的空白，权重框右边缘对齐） */
.lp-clip {
  /* 卡片是「缩略图 + 内容」两列网格；展开区必须横跨两列，否则会掉进 44px 的缩略图列被挤扁 */
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 94px 7px 18px;
  background: #2c3533;
  border-top: 1px dashed #3f4f4b;
  cursor: default;
}
.lp-clip-tag {
  flex: 0 0 auto;
  font-family: var(--mono);
  font-size: 9.5px;
  color: #7fd0c0;
  letter-spacing: .2px;
}
.lp-clip-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: #9fb8b2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* [clip] 行里的名字跟主行保持同一状态色 */
.lp-row-wrap.on .lp-clip-name { color: #8fc7a6; }
.lp-row-wrap.bypassed .lp-clip-name { color: #c98a8a; }
/* 尺寸与主行权重框完全一致 */
.lp-clip-step { border-color: #47605b; }
.lp-clip-step input { color: #d6efe8; }
.lp-row-wrap.on .lp-clip-step input { color: #7bd39a; }
.lp-row-wrap.bypassed .lp-clip-step input { color: #e07070; }

/* 权重对比展开区 */
.lp-sweep {
  /* 同 .lp-clip：横跨缩略图列和内容列 */
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 8px 10px 10px;
  background: #2d3237;
  border-top: 1px dashed #444c54;
  cursor: default;
}
.lp-sweep-head { display: flex; align-items: center; gap: 8px; }
.lp-sweep-title {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  color: #bcd6ee;
  letter-spacing: .2px;
}
.lp-sweep-title::before { content: '⇄'; margin-right: 5px; color: #6fa8d8; }
.lp-sweep-sub {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 10px;
  color: #7f8b95;
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lp-sweep-off {
  flex: 0 0 auto;
  height: 20px;
  padding: 0 7px;
  font-size: 10px;
  color: #9a9a9a;
  background: #3a3a3a;
  border: 1px solid #505050;
  border-radius: 5px;
  cursor: pointer;
}
.lp-sweep-off:hover { color: #e2e2e2; background: #454545; }
.lp-sweep-vals { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.lp-sweep-val {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 2px 0 6px;
  background: #1f1f1f;
  border: 1px solid #4d5a66;
  border-radius: 6px;
}
.lp-sweep-val input {
  width: 42px;
  height: 20px;
  padding: 0;
  border: none;
  background: transparent;
  color: #d8ebff;
  font-family: var(--mono);
  font-size: 11px;
  text-align: center;
  outline: none;
  -moz-appearance: textfield;
  appearance: textfield;
}
.lp-sweep-val input::-webkit-outer-spin-button,
.lp-sweep-val input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  appearance: none;
  margin: 0;
}
.lp-sweep-del {
  width: 17px;
  height: 20px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  line-height: 1;
  color: #8f8f8f;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
.lp-sweep-del:hover { color: #ffd4d0; background: #5a3a37; }
.lp-sweep-add {
  height: 24px;
  padding: 0 8px;
  font-size: 11px;
  color: #cfe6fb;
  background: #33424f;
  border: 1px dashed #4d6a85;
  border-radius: 6px;
  cursor: pointer;
}
.lp-sweep-add:hover { background: #3b4d5c; border-color: #6f92b0; }
.lp-sweep-presets { display: flex; align-items: center; gap: 5px; font-size: 10px; color: #7f8b95; }
.lp-sweep-presets button {
  height: 18px;
  padding: 0 6px;
  font-family: var(--mono);
  font-size: 10px;
  color: #9fb8cc;
  background: #333b42;
  border: 1px solid #46525c;
  border-radius: 999px;
  cursor: pointer;
}
.lp-sweep-presets button:hover { color: #d8ebff; border-color: #5b7fa5; background: #3b4852; }

/* —— 底部 —— */
.lp-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px 11px;
}
.lp-hint {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 10.5px;
  color: #8a8a8a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lp-hint.warn { color: #a9c9e6; }
.lp-foot-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.lp-reset {
  flex: 0 0 auto;
  padding: 3px 9px;
  font-size: 11px;
  color: #c9c9c9;
  background: #3d3d3d;
  border: 1px solid #565656;
  border-radius: 6px;
  cursor: pointer;
}
.lp-reset:hover:not(:disabled) { background: #4a4a4a; border-color: #6b6b6b; }
.lp-reset:disabled { opacity: .4; cursor: not-allowed; }
.lp-reset.warn {
  color: #cfe6fb;
  background: #33424f;
  border-color: #4d6a85;
}
.lp-reset.warn:hover:not(:disabled) { background: #3b4d5c; border-color: #6f92b0; }

.lp-empty { padding: 18px 14px 20px; }
.lp-empty p { margin: 0 0 6px; font-size: 12px; color: #cfcfcf; }
.lp-empty-sub { color: #8f8f8f !important; font-size: 11px !important; line-height: 1.6; }

/* —— 右下角固定开关 —— */
.lora-fab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 13px;
  font-size: 12px;
  font-weight: 500;
  color: #e2e2e2;
  background: #3a3a3a;
  border: 1px solid #585858;
  border-radius: 999px;
  box-shadow: 0 12px 30px rgba(0, 0, 0, .45);
  cursor: pointer;
  transition: background .12s, border-color .12s, color .12s;
}
.lora-fab:hover { background: #454545; border-color: #6c6c6c; }
.lora-fab.on { border-color: #5b9bd5; color: #d6e9fb; }
.fab-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #8fce6b;
  box-shadow: 0 0 8px rgba(143, 206, 107, .7);
}
.fab-count {
  padding: 1px 6px;
  border-radius: 999px;
  background: #4a4a4a;
  color: #d0d0d0;
  font-size: 10.5px;
  font-weight: 600;
  font-family: var(--mono);
}
.fab-caret { color: #9a9a9a; font-size: 9px; line-height: 1; }
.fab-fast {
  padding: 1px 6px;
  border-radius: 999px;
  background: #4a3f1e;
  border: 1px solid #8a7330;
  color: #ffd24a;
  font-size: 10.5px;
  font-weight: 600;
  font-family: var(--mono);
}

/* 常用权重弹层：挂在 body 上，避免被列表滚动裁掉 */
.lp-weight-menu {
  position: fixed;
  z-index: 9999;
  width: 232px;
  padding: 8px;
  background: #262626;
  border: 1px solid #4a4a4a;
  border-radius: 8px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, .45);
}
.lp-weight-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px 6px;
  font-size: 10.5px;
  color: #9a9a9a;
}
.lp-weight-hint { color: #6f6f6f; }
.lp-weight-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 4px;
}
.lp-weight-val {
  height: 24px;
  padding: 0;
  font-family: var(--mono);
  font-size: 11px;
  color: #cfcfcf;
  background: #303030;
  border: 1px solid #454545;
  border-radius: 5px;
  cursor: pointer;
  transition: background .12s, color .12s, border-color .12s;
}
.lp-weight-val:hover { background: #3c3c3c; color: #fff; border-color: #5f5f5f; }
.lp-weight-val.on {
  color: #cfe6fb;
  background: #3d5468;
  border-color: #4d6a85;
}

@media (max-width: 640px) {
  .lora-dock { right: 10px; bottom: 10px; left: 10px; align-items: stretch; }
  .lp { width: auto; height: min(660px, calc(100vh - 90px)); }
  .lora-fab { align-self: flex-end; }
}
</style>
