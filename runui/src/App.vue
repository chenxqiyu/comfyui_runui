<script setup>
import { computed, onMounted, reactive, watch } from 'vue'
import {
  apiGet,
  collectImages,
  fetchCurrentWorkflow,
  fetchHistory,
  getPrefix,
  nodesFromHistoryEntry,
  setPrefix,
  sleep,
  submitPrompt,
  viewUrl,
} from './api'

const state = reactive({
  prefix: getPrefix(),
  showSettings: false,
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
  text: '',
  randomSeed: true,
  submitting: false,
  running: false,
  runPromptId: '',
  elapsed: 0,
  images: [],
  warnings: [],
  showWarnings: false,
  failed: false,
  extraData: null,
})

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

const nodeList = computed(() =>
  Object.entries(state.nodes || {}).map(([id, node]) => {
    const cls = String(node?.class_type || '')
    const fields = stringFields(node)
    return {
      id,
      cls,
      title: node?._meta?.title || '',
      fields,
      isSaver: /SaveImage|PreviewImage|SaveAnimatedWEBP|SaveVideo/i.test(cls),
      imageCount: (state.entry?.outputs?.[id]?.images || []).length,
    }
  })
)

const textNodes = computed(() => nodeList.value.filter((n) => n.fields.length))
const outNodes = computed(() => nodeList.value.filter((n) => n.isSaver || n.imageCount))

const inNode = computed(() => state.nodes?.[state.inId] || null)
const inFields = computed(() => (inNode.value ? stringFields(inNode.value) : []))
const inValue = computed(() =>
  inNode.value && state.inField ? inNode.value.inputs?.[state.inField] : ''
)

const statusText = computed(() => {
  if (state.status === 'loading') return '读取中'
  if (state.status === 'error') return '未连接'
  if (state.status === 'ready') return '已连接'
  return '待连接'
})

const canSend = computed(
  () => !!state.inId && !!state.inField && !!state.text.trim() && !state.submitting
)

watch(
  () => state.inId,
  (id) => {
    const node = state.nodes?.[id]
    if (!node) {
      state.inField = ''
      return
    }
    const fields = [...stringFields(node)].sort((a, b) => scoreField(b) - scoreField(a))
    state.inField = fields[0] || ''
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

  const preferred = pickInputNode(textNodes.value)
  state.inId = preferred ? preferred.id : ''
  const lastOut = outNodes.value[outNodes.value.length - 1]
  state.outId = lastOut ? lastOut.id : ''

  // 带上这个作业已经出过的图，进来就能看到上次的结果
  const all = picked.entry ? collectImages(picked.entry, '') : []
  const mine = all.filter((img) => img.nodeId === state.outId)
  state.images = mine.length ? mine : all
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

function applyPrefix() {
  setPrefix(state.prefix)
  state.prefix = getPrefix()
  refreshAll()
}

async function send() {
  if (!canSend.value) return
  const nodes = JSON.parse(JSON.stringify(state.nodes))
  const node = nodes[state.inId]
  if (!node) {
    state.message = `节点 ${state.inId} 不存在于当前工作流`
    return
  }
  node.inputs[state.inField] = state.text
  if (state.randomSeed) randomizeSeeds(nodes)
  wrapListWidgets(nodes)

  state.submitting = true
  state.running = false
  state.elapsed = 0
  state.warnings = []
  state.showWarnings = false
  state.failed = false
  state.message = '正在提交…'
  try {
    const resp = await submitPrompt(nodes, state.extraData ? { extra_data: state.extraData } : {})
    state.runPromptId = resp.prompt_id
    const warnings = parseNodeErrors(resp.node_errors, nodes, state.outId)
    state.warnings = warnings
    const blocking = warnings.filter((w) => w.blocking)
    if (blocking.length) {
      state.failed = true
      state.message =
        `已入队，但节点 ${blocking.map((w) => w.node).join(' / ')} 挡住了输出 ` +
        `${state.outId} —— ComfyUI 会把该输出整个忽略，本次不会出图（日志里是 "Output will be ignored"）`
    } else if (warnings.length) {
      state.message = `已入队 · ${warnings.length} 条校验警告（不影响绑定输出）`
    } else {
      state.message = '已入队，等待执行…'
    }
    await waitResult(resp.prompt_id)
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

async function waitResult(promptId) {
  state.running = true
  const started = Date.now()
  const timer = setInterval(() => {
    state.elapsed = Math.round((Date.now() - started) / 1000)
  }, 1000)
  try {
    while (Date.now() - started < 15 * 60 * 1000) {
      const history = await fetchHistory(promptId)
      const entry = history[promptId]
      if (entry) {
        const images = collectImages(entry, state.outId)
        if (images.length) {
          state.images = images
          state.entry = entry
          state.message = `完成 · 用时 ${Math.round((Date.now() - started) / 1000)} 秒 · ${images.length} 张图`
          return
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
          return
        }
      }
      await sleep(800)
    }
    state.message = '等待超时（15 分钟）'
  } finally {
    clearInterval(timer)
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

function openImage(img) {
  window.open(viewUrl(img), '_blank')
}

onMounted(refreshAll)
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="dot" :class="state.status"></span>
        <strong>ComfyUI RunUI</strong>
        <span class="hint">绑定节点 · 改提示词 · 收图</span>
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
                <button v-if="n.fields.length" @click="state.inId = n.id">入</button>
                <button v-if="n.isSaver || n.imageCount" @click="state.outId = n.id">出</button>
              </span>
            </div>
            <p v-if="!nodeList.length" class="hint">还没有载入工作流</p>
          </div>
        </div>
      </section>

      <section class="card col">
        <div class="card-head"><span>② 绑定输入 · 改提示词</span></div>
        <div class="card-body">
          <label class="label">输入节点 ID</label>
          <input v-model="state.inId" class="mono" type="text" placeholder="例如 6" />

          <label class="label" style="margin-top: 12px">写入字段</label>
          <select v-model="state.inField" :disabled="!inFields.length">
            <option v-if="!inFields.length" value="">该节点没有文本字段</option>
            <option v-for="f in inFields" :key="f" :value="f">{{ f }}</option>
          </select>

          <p class="hint current" v-if="inValue">
            当前值：<span>{{ String(inValue).slice(0, 160) }}</span>
          </p>

          <label class="label" style="margin-top: 12px">新提示词</label>
          <textarea v-model="state.text" placeholder="输入要替换进去的提示词…"></textarea>

          <label class="check">
            <input v-model="state.randomSeed" type="checkbox" />
            <span>同时随机化所有 seed / noise_seed</span>
          </label>

          <div class="send-row">
            <button class="primary" :disabled="!canSend" @click="send">
              {{ state.submitting ? '发送中…' : '发送到 ComfyUI' }}
            </button>
            <span class="hint" v-if="state.running">执行中 · {{ state.elapsed }}s</span>
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
              典型原因是 Lora Stacker (LoraManager) 把 <code>loras</code> 声明成
              <code>("LORAS", {})</code> 连接类型，前端却把它做成了 widget，提交时进的是 LoRA
              对象数组，被 ComfyUI 核心校验判成非法连接。它一旦落在输出节点的依赖链上，那个输出
              就会被直接忽略（日志：<code>Output will be ignored</code>），于是一张图都不出。
              解决办法：把该节点的 <code>loras</code> 输入真正连到一个输出 LORAS 的节点，或者把
              Lora Stacker 换成 Lora Loader (LoraManager)。
            </p>
          </div>
        </div>
      </section>

      <section class="card col">
        <div class="card-head">
          <span>③ 绑定输出 · 收图</span>
          <span class="mono small" v-if="state.runPromptId">{{ shortId(state.runPromptId) }}</span>
        </div>
        <div class="card-body">
          <label class="label">输出节点 ID</label>
          <div class="row">
            <input v-model="state.outId" class="mono" type="text" placeholder="例如 9" />
            <button v-if="outNodes.length" @click="state.outId = outNodes[0].id">用首选</button>
          </div>
          <div class="chips" v-if="outNodes.length">
            <button
              v-for="n in outNodes.slice(0, 8)"
              :key="n.id"
              class="chip"
              :class="{ on: n.id === state.outId }"
              @click="state.outId = n.id"
            >
              {{ n.id }} · {{ n.cls }}
            </button>
          </div>

          <div class="images">
            <figure v-for="(img, i) in state.images" :key="i" class="shot">
              <img :src="viewUrl(img)" :alt="img.filename" @click="openImage(img)" />
              <figcaption class="mono small">
                {{ img.nodeId }} · {{ img.filename }}
              </figcaption>
            </figure>
            <p v-if="!state.images.length" class="hint empty">
              还没有图片。提交后会显示绑定节点输出的图。
            </p>
          </div>
        </div>
      </section>
    </main>
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
  background: #fff;
  border-bottom: 1px solid var(--line);
}

.brand { display: flex; align-items: center; gap: 8px; }
.brand strong { font-weight: 500; font-size: 14px; }

.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-3); }
.dot.ready { background: var(--ok); }
.dot.error { background: var(--bad); }
.dot.loading { background: var(--warn); }

.top-right { display: flex; align-items: center; gap: 8px; }

.settings {
  padding: 12px 16px;
  background: #fff;
  border-bottom: 1px solid var(--line);
}
.settings .row { display: flex; gap: 8px; }
.settings code { font-family: var(--mono); background: #f3f4f6; padding: 1px 4px; border-radius: 4px; }

.grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 320px minmax(300px, 1fr) minmax(340px, 1.15fr);
  gap: 12px;
  padding: 12px;
}

.col { display: flex; flex-direction: column; min-height: 0; }
.card-body.tight { padding: 12px; }

.meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  background: #f9fafb;
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
  border-bottom: 1px solid #f3f4f6;
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

.send-row { display: flex; align-items: center; gap: 10px; }

.msg {
  margin: 12px 0 0;
  padding: 8px 10px;
  background: #f9fafb;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--ink-2);
  font-size: 12px;
  word-break: break-word;
}
.msg.bad {
  background: #fef2f2;
  border-color: #fecaca;
  color: #991b1b;
}

.warnbox {
  margin-top: 10px;
  padding: 8px 10px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 8px;
}
.warnhead {
  border: none;
  background: transparent;
  padding: 0;
  color: #92400e;
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
.warnlist code { font-family: var(--mono); background: #fef3c7; padding: 1px 4px; border-radius: 4px; }
.wtype { font-family: var(--mono); color: var(--ink-3); margin-left: 6px; }

.row { display: flex; gap: 8px; }

.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.chip {
  padding: 3px 8px;
  font-size: 11px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: #fff;
  color: var(--ink-2);
}
.chip.on { border-color: var(--brand); color: var(--brand); background: var(--brand-soft); }

.images {
  margin-top: 14px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
  overflow-y: auto;
}
.empty { grid-column: 1 / -1; }

.shot { margin: 0; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: #fff; }
.shot img { display: block; width: 100%; cursor: zoom-in; }
.shot figcaption { padding: 6px 8px; color: var(--ink-3); border-top: 1px solid var(--line); }
</style>
