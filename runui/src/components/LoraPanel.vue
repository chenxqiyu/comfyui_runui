<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fastApply, fastJob, fastRestore, fastStatus, sleep } from '../api'

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
})

const emit = defineEmits(['toggle', 'close', 'select-node', 'change', 'reset', 'sweep', 'clear-sweeps'])

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
const previewEnabled = computed(() => previewItems.value.filter(isActive).length)
const previewLabel = computed(() => (chainOfNode.value?.chained ? '串联启用预览' : 'lora堆栈'))

function readName(item) {
  if (item && typeof item === 'object') return String(item.name ?? item.lora ?? '')
  return String(item ?? '')
}

function readStrength(item) {
  const n = Number(item?.strength)
  return Number.isFinite(n) ? n : 1
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

/** 只列启用中的，生成 <lora:name:0.70> 预览 */
const promptText = computed(() =>
  previewItems.value
    .filter((x) => isActive(x) && readName(x))
    .map((x) => `<lora:${cleanName(readName(x))}:${readStrength(x).toFixed(2)}>`)
    .join('')
)

function cleanName(name) {
  return String(name)
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.(safetensors|ckpt|pt|bin)$/i, '')
}

const fmtStrength = (item) => readStrength(item).toFixed(2)

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
  if (!list[index]) return
  list[index].strength = Math.round(n * 100) / 100
  commit(list)
}

/** 输入框清空/非法时回填原值，不要把强度误写成 0 */
function onStrengthChange(index, event) {
  const raw = event.target.value
  if (raw === '' || !Number.isFinite(Number(raw))) {
    event.target.value = fmtStrength(items.value[index])
    return
  }
  setStrength(index, raw)
}

function nudgeStrength(index, delta) {
  setStrength(index, readStrength(items.value[index]) + delta)
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

/** 手动添加：识别 <lora:名称:权重>，一条输入里可以贴多个 */
const addText = ref('')
const addError = ref('')

function parseLoraTags(text) {
  const out = []
  const re = /<\s*lora\s*:\s*([^:>]+?)\s*(?::\s*(-?\d*\.?\d+)\s*)?>/gi
  let m
  while ((m = re.exec(text))) {
    const name = m[1].trim()
    if (!name) continue
    const n = m[2] === undefined ? 1 : Number(m[2])
    out.push({ name, strength: Number.isFinite(n) ? n : 1 })
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
  for (const { name, strength } of parsed) {
    const weight = Math.round(strength * 100) / 100
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
    } else {
      list.push({ name, strength: weight, active: true })
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

onMounted(refreshFast)
watch(
  () => props.open,
  (open) => {
    if (open) refreshFast()
  }
)
onBeforeUnmount(() => {
  pollToken++
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
          <div class="lp-rows">
            <div
              v-for="({ item, index: i }) in visibleRows"
              :key="i"
              class="lp-row-wrap"
              :class="{ off: !isActive(item), sweeping: hasSweep(i) }"
            >
              <div
                class="lp-row"
                :title="isActive(item) ? '点击停用这条 LoRA' : '点击启用这条 LoRA'"
                @click="setActive(i, !isActive(item))"
              >
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
                <span class="lp-name" :title="readName(item)">{{ readName(item) || '（未命名）' }}</span>
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
                    :value="fmtStrength(item)"
                    title="强度（0.05 步进，可直接输入）"
                    :disabled="hasSweep(i)"
                    @change="onStrengthChange(i, $event)"
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
                  class="lp-cmp"
                  :class="{ on: hasSweep(i) }"
                  :disabled="!isActive(item)"
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
  width: 380px;
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

.lp-row-wrap { border-bottom: 1px solid #3d3d3d; }
.lp-row-wrap:last-child { border-bottom: none; }
.lp-row-wrap.off .lp-name { color: #858585; }
.lp-row-wrap.sweeping { background: #2f3438; }

.lp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  transition: background .12s;
}
.lp-row:hover { background: #3b3b3b; }
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
  font-size: 12px;
  color: #d6d6d6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  min-width: 28px;
  height: 24px;
  padding: 0 6px;
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

/* 权重对比展开区 */
.lp-sweep {
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

@media (max-width: 640px) {
  .lora-dock { right: 10px; bottom: 10px; left: 10px; align-items: stretch; }
  .lp { width: auto; height: min(660px, calc(100vh - 90px)); }
  .lora-fab { align-self: flex-end; }
}
</style>
