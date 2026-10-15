<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'

const props = defineProps({
  tokenizer: { type: Object, default: null },
})

/* ---------------------------------------------------- 后端状态 */
const status = ref({ ready: false, matrix: null, model: '', device: '' })
const backendMissing = ref(false)
const limit = ref(10000)
const building = ref(false)
let timer = null

async function refreshStatus() {
  try {
    const res = await fetch('./api/status')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    status.value = await res.json()
    backendMissing.value = false
  } catch {
    backendMissing.value = true
  }
}

function ensurePolling() {
  if (timer) return
  timer = setInterval(async () => {
    await refreshStatus()
    const st = status.value
    if (backendMissing.value) return
    if (st.ready && st.matrix?.ready && !st.matrix?.building) {
      clearInterval(timer)
      timer = null
    }
  }, 1500)
}

function onModelChanged() {
  // 模型换了 -> 词表矩阵作废，重新拉状态并继续轮询
  refreshStatus()
  ensurePolling()
}

onMounted(() => {
  refreshStatus()
  ensurePolling()
  window.addEventListener('clip-model-changed', onModelChanged)
})

onBeforeUnmount(() => {
  window.removeEventListener('clip-model-changed', onModelChanged)
  if (timer) clearInterval(timer)
})

const matrixProgress = computed(() => {
  const m = status.value?.matrix
  if (!m || !m.total) return 0
  return Math.round((m.progress / m.total) * 100)
})

const canQuery = computed(() => status.value.ready && status.value.matrix?.ready)

const vocabSize = computed(() => status.value.matrix?.vocabSize || 49408)
const matrixBuilding = computed(() => Boolean(status.value.matrix?.building))

async function startBuild(force) {
  building.value = true
  try {
    const res = await fetch('./api/matrix/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: limit.value, force }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || data.reason || `HTTP ${res.status}`)
    ElMessage.success(
      `开始预计算前 ${Number(data.limit).toLocaleString()} 个 token（${force ? '强制重建' : '优先用缓存'}）`
    )
    refreshStatus()
    ensurePolling()
  } catch (e) {
    ElMessage.error(e?.message || String(e))
  } finally {
    building.value = false
  }
}

/* ------------------------------------------------------ 查询 */
const word = ref('street')
const topK = ref(20)
const loading = ref(false)
const errorMsg = ref('')
const result = ref(null)

const PRESETS = ['street', 'girl', 'cyberpunk', 'sunset', 'masterpiece']

async function compute() {
  const w = word.value.trim()
  if (!w) {
    ElMessage.warning('请输入一个词')
    return
  }

  loading.value = true
  errorMsg.value = ''
  try {
    const res = await fetch('./api/nearest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word: w, topK: topK.value }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    result.value = data
    refreshStatus()
  } catch (e) {
    errorMsg.value = e?.message || String(e)
    result.value = null
  } finally {
    loading.value = false
  }
}

/* ------------------------------------------------------ 展示 */
const rows = computed(() => {
  if (!result.value?.items?.length) return []
  const tk = props.tokenizer
  const items = result.value.items
  const max = items[0].sim
  const min = items[items.length - 1].sim
  const span = Math.max(max - min, 1e-6)

  return items.map((it, i) => ({
    rank: i + 1,
    id: it.id,
    token: it.token,
    text: tk ? tk.tokenToText(it.token) : '',
    sim: it.sim,
    barWidth: 8 + ((it.sim - min) / span) * 92,
  }))
})

const sourceTokens = computed(() => {
  if (!result.value?.sourceIds || !props.tokenizer) return []
  return result.value.sourceIds.map((id) => ({
    id,
    raw: props.tokenizer.idToToken(id) ?? '',
    text: props.tokenizer.tokenToText(props.tokenizer.idToToken(id) ?? ''),
  }))
})
</script>

<template>
  <div class="near">
    <el-alert
      v-if="backendMissing"
      type="warning"
      :closable="false"
      show-icon
      title="未检测到本地服务，Top-K 检索需要它来跑 CLIP 模型"
      class="mb"
    >
      <template #default>
        <div class="tip">
          在 <code class="mono">F:\ai\onetest\uitest</code> 目录执行
          <code class="mono">python server.py</code>（或双击 <code class="mono">start.bat</code>）。
        </div>
      </template>
    </el-alert>

    <el-alert
      v-else-if="!status.ready"
      type="warning"
      :closable="false"
      show-icon
      title="还没有加载模型 —— 请在上方「自定义模型路径」里选择后点「重载」"
      class="mb"
    />

    <!-- 预计算范围设置 -->
    <div v-else class="matrix-box">
      <div class="mb-row">
        <div class="mb-info">
          <span class="k">检索范围</span>
          <template v-if="status.matrix?.ready">
            <span class="v mono">
              词表前 {{ Number(status.matrix.limit || 0).toLocaleString() }} /
              {{ Number(vocabSize).toLocaleString() }} 个 token
            </span>
            <el-tag
              size="small"
              effect="plain"
              :type="status.matrix.source === 'cache' ? 'info' : 'success'"
            >
              {{
                status.matrix.source === 'cache'
                  ? '磁盘缓存'
                  : status.matrix.source === 'cuda'
                    ? 'CUDA 计算'
                    : 'CPU 计算'
              }}
            </el-tag>
          </template>
          <span v-else class="v">尚未就绪</span>
        </div>

        <div class="mb-actions">
          <el-input-number
            v-model="limit"
            :min="100"
            :max="vocabSize"
            :step="1000"
            size="small"
            controls-position="right"
            style="width: 158px"
          />
          <el-button
            size="small"
            type="primary"
            :loading="building"
            :disabled="!status.ready || matrixBuilding"
            @click="startBuild(false)"
          >
            预计算
          </el-button>
          <el-button
            size="small"
            plain
            :loading="building"
            :disabled="!status.ready || matrixBuilding"
            @click="startBuild(true)"
          >
            强制重建
          </el-button>
        </div>
      </div>

      <el-progress
        v-if="matrixBuilding"
        :percentage="matrixProgress"
        :stroke-width="8"
        :format="() => `${Number(status.matrix?.progress || 0).toLocaleString()} / ${Number(status.matrix?.total || 0).toLocaleString()}`"
        class="prog"
      />

      <div class="mb-hint">
        <template v-if="!status.matrix?.ready">
          <b>启动时不会自动预计算。</b>选好范围后点「预计算」开始 —— 首次会现算（已有缓存则秒开），之后一直可用。
        </template>
        <template v-else>
          只预计算词表<b>前 N 个</b> token（id 越小越常用）：1 万 ≈ 日常词汇、算得快；全量 49,408 最完整但更慢。
          Top-K 只在该范围内检索，范围越大越完整。显存不够时会自动改用 CPU 计算。
        </template>
      </div>
    </div>

    <!-- 输入 -->
    <div class="row">
      <div class="field grow">
        <div class="label">想找哪个词的“近邻”</div>
        <el-input
          v-model="word"
          size="large"
          placeholder="如 street"
          @keyup.enter="compute"
        />
      </div>
      <div class="field">
        <div class="label">返回条数</div>
        <el-select v-model="topK" size="large" style="width: 120px">
          <el-option :value="10" label="Top 10" />
          <el-option :value="20" label="Top 20" />
          <el-option :value="50" label="Top 50" />
          <el-option :value="100" label="Top 100" />
        </el-select>
      </div>
      <div class="field btn-field">
        <el-button type="primary" size="large" :loading="loading" :disabled="!canQuery" @click="compute">
          查近邻
        </el-button>
      </div>
    </div>

    <div class="toolbar">
      <span class="toolbar-label">预设</span>
      <el-tag
        v-for="p in PRESETS"
        :key="p"
        class="chip"
        effect="plain"
        @click="word = p"
      >
        {{ p }}
      </el-tag>
    </div>

    <el-alert v-if="errorMsg" type="error" :closable="false" :title="errorMsg" class="mt" />

    <!-- 结果 -->
    <template v-if="result">
      <div class="summary">
        <div class="sum-item">
          <span class="k">查询词</span><span class="v mono">{{ result.word }}</span>
        </div>
        <div class="sum-item">
          <span class="k">扫描 token</span><span class="v mono">{{ result.scanned.toLocaleString() }}</span>
        </div>
        <div class="sum-item">
          <span class="k">模型</span><span class="v mono">{{ result.model }}</span>
        </div>
        <div class="sum-item">
          <span class="k">设备</span><span class="v mono">{{ result.device }}</span>
        </div>
      </div>

      <div v-if="sourceTokens.length" class="src">
        <span class="src-label">该词实际被编码为</span>
        <span v-for="(t, i) in sourceTokens" :key="i" class="src-token mono">
          {{ t.text || '—' }}
          <em>#{{ t.id }}</em>
        </span>
      </div>

      <el-table :data="rows" size="small" stripe max-height="460" class="mt">
        <el-table-column label="#" width="58" align="center">
          <template #default="{ row }">
            <span class="rank" :class="{ top3: row.rank <= 3 }">{{ row.rank }}</span>
          </template>
        </el-table-column>
        <el-table-column label="近邻词" min-width="220">
          <template #default="{ row }">
            <div class="w-text mono">{{ row.text || '—' }}</div>
            <div class="w-meta mono">id {{ row.id }} · {{ row.token }}</div>
          </template>
        </el-table-column>
        <el-table-column label="余弦相似度" min-width="240">
          <template #default="{ row }">
            <div class="sim-wrap">
              <div class="sim-bar">
                <div class="sim-fill" :style="{ width: `${row.barWidth}%` }"></div>
              </div>
              <span class="sim-val mono">{{ row.sim.toFixed(4) }}</span>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <div class="note">
        <b>原理：</b>后端预先把词表里每个 token 单独送进 CLIP 文本塔，得到一张 49,408 × 768 的特征矩阵；
        查近邻 = 目标词向量与整张矩阵做一次余弦相似度矩阵乘法（这正是你那段循环的加速版，一次算完而不是逐条 forward）。
        <br />
        <b>怎么读：</b>相似度的<u>绝对值</u>意义不大（CLIP 文本嵌入很“挤”，普遍偏高），
        真正有信息量的是<u>排序</u>——排在前面的确实是与目标词共现/同义的高频词。
      </div>
    </template>
  </div>
</template>

<style scoped>
.mb {
  margin-bottom: 16px;
}

.mt {
  margin-top: 16px;
}

.tip {
  font-size: 13px;
  margin-top: 4px;
  line-height: 1.7;
}

.tip code {
  background: #f2f5fb;
  padding: 1px 6px;
  border-radius: 5px;
}

.prog {
  margin-top: 10px;
}

.matrix-box {
  margin-bottom: 16px;
  padding: 12px 16px;
  border-radius: 10px;
  background: #f8faff;
  border: 1px solid #e9effa;
}

.mb-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}

.mb-info {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.mb-info .k {
  color: #98a5b8;
  font-size: 12px;
}

.mb-info .v {
  color: #38455c;
}

.mb-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mb-hint {
  margin-top: 8px;
  font-size: 12px;
  color: #8d9bb0;
  line-height: 1.7;
}

.row {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.field {
  width: 140px;
}

.field.grow {
  flex: 1;
  width: auto;
}

.field.btn-field {
  width: auto;
  padding-top: 26px;
}

.label {
  font-size: 12px;
  color: #8d9bb0;
  margin-bottom: 6px;
}

.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.toolbar-label {
  font-size: 12px;
  color: #98a5b8;
}

.chip {
  cursor: pointer;
  transition: all 0.15s;
}

.chip:hover {
  color: #fff;
  background: var(--brand);
  border-color: var(--brand);
}

.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 22px;
  margin-top: 18px;
  padding: 12px 16px;
  border-radius: 10px;
  background: #f8faff;
  border: 1px solid #e9effa;
}

.sum-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}

.sum-item .k {
  color: #98a5b8;
  font-size: 12px;
}

.sum-item .v {
  color: #38455c;
}

.src {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.src-label {
  font-size: 12px;
  color: #98a5b8;
}

.src-token {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 6px;
  font-size: 12px;
  color: #7c5cf0;
  background: #f5f2ff;
  border: 1px solid #e7e0ff;
}

.src-token em {
  font-style: normal;
  color: #a99ad6;
  font-size: 11px;
}

.rank {
  display: inline-block;
  min-width: 22px;
  color: #9aa7b8;
  font-variant-numeric: tabular-nums;
}

.rank.top3 {
  color: var(--brand);
  font-weight: 700;
}

.w-text {
  color: #2f7d5e;
  font-size: 13px;
  word-break: break-all;
}

.w-meta {
  color: #a9b4c4;
  font-size: 11px;
  margin-top: 2px;
  word-break: break-all;
}

.sim-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sim-bar {
  flex: 1;
  height: 8px;
  border-radius: 999px;
  background: #eef2f9;
  overflow: hidden;
}

.sim-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #9db9ff, #4b6bfb);
}

.sim-val {
  width: 62px;
  text-align: right;
  font-size: 12px;
  color: #3b62e0;
  font-variant-numeric: tabular-nums;
}

.note {
  margin-top: 14px;
  padding: 12px 16px;
  border-radius: 10px;
  background: #fffdf5;
  border: 1px solid #f6eccd;
  font-size: 13px;
  line-height: 1.8;
  color: #6b5a2e;
}

@media (max-width: 640px) {
  .row {
    flex-direction: column;
  }

  .field,
  .field.btn-field {
    width: 100%;
    padding-top: 0;
  }
}
</style>
