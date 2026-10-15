<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'

/* ---------------------------------------------------- 后端状态 */
const status = ref({ ready: false, error: null, model: '', device: '' })
const backendMissing = ref(false)
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

onMounted(() => {
  refreshStatus()
  timer = setInterval(() => {
    if (status.value.ready) {
      clearInterval(timer)
      timer = null
      return
    }
    refreshStatus()
  }, 2500)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

/* ------------------------------------------------------ 计算 */
const reference = ref('girl')
const wordsText = ref(['woman', '1girl', 'dog', 'cat', 'masterpiece', 'asdkjhqwezxc'].join('\n'))
const loading = ref(false)
const errorMsg = ref('')
const result = ref(null)

const PRESETS = [
  { label: '默认对照', reference: 'girl', words: ['woman', '1girl', 'dog', 'cat', 'masterpiece', 'asdkjhqwezxc'] },
  { label: '画质词', reference: 'high quality', words: ['best quality', 'masterpiece', 'low quality', 'blurry', 'ugly', 'detailed'] },
  { label: '同义词', reference: 'outdoors', words: ['indoor', 'forest', 'street', 'sky', 'beach', 'bedroom'] },
]

const parsedWords = computed(() =>
  wordsText.value
    .split(/[\n,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean)
)

function usePreset(p) {
  reference.value = p.reference
  wordsText.value = p.words.join('\n')
}

async function compute() {
  if (!reference.value.trim()) {
    ElMessage.warning('请填写参照词')
    return
  }
  if (!parsedWords.value.length) {
    ElMessage.warning('请填写至少一个待测词')
    return
  }

  loading.value = true
  errorMsg.value = ''
  try {
    const res = await fetch('./api/similarity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: reference.value.trim(), words: parsedWords.value }),
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
  const base = result.value.baseline ?? 0
  const maxAbs = Math.max(...result.value.items.map((i) => Math.abs(i.sim - base)), 1e-6)
  return result.value.items.map((i) => {
    const delta = i.sim - base
    return {
      ...i,
      delta,
      barWidth: Math.max(2, (Math.abs(delta) / maxAbs) * 100),
      positive: delta >= 0,
    }
  })
})
</script>

<template>
  <div class="sim">
    <!-- 后端未启动 -->
    <el-alert
      v-if="backendMissing"
      type="warning"
      :closable="false"
      show-icon
      title="未检测到本地服务，词义相似度需要它来跑 CLIP 模型"
      class="mb"
    >
      <template #default>
        <div class="tip">
          在 <code class="mono">F:\ai\onetest\uitest</code> 目录执行
          <code class="mono">python server.py</code>（或用 <code class="mono">start.bat</code>），
          再回到本页面。
        </div>
      </template>
    </el-alert>

    <el-alert
      v-else-if="!status.ready"
      type="info"
      :closable="false"
      show-icon
      title="CLIP 文本塔正在加载，首次约 10~30 秒…"
      class="mb"
    >
      <template #default>
        <div class="tip mono">{{ status.model || 'openai/clip-vit-large-patch14' }}</div>
      </template>
    </el-alert>

    <!-- 输入 -->
    <div class="row">
      <div class="field">
        <div class="label">参照词（已知“有效”的锚点）</div>
        <el-input v-model="reference" placeholder="如 girl" @keyup.enter="compute" />
      </div>
      <div class="field grow">
        <div class="label">待测词（每行一个，或用逗号分隔）</div>
        <el-input
          v-model="wordsText"
          type="textarea"
          :rows="3"
          resize="vertical"
          placeholder="woman&#10;dog&#10;asdkjhqwezxc"
        />
      </div>
    </div>

    <div class="toolbar">
      <el-button type="primary" :loading="loading" :disabled="!status.ready" @click="compute">
        计算相似度
      </el-button>
      <span class="toolbar-label">预设</span>
      <el-tag v-for="p in PRESETS" :key="p.label" class="chip" effect="plain" @click="usePreset(p)">
        {{ p.label }}
      </el-tag>
    </div>

    <el-alert v-if="errorMsg" type="error" :closable="false" :title="errorMsg" class="mt" />

    <!-- 结果 -->
    <template v-if="result">
      <div class="summary">
        <div class="sum-item">
          <span class="k">参照词</span><span class="v mono">{{ result.reference }}</span>
        </div>
        <div class="sum-item">
          <span class="k">乱码基线</span><span class="v mono">{{ (result.baseline ?? 0).toFixed(4) }}</span>
        </div>
        <div class="sum-item">
          <span class="k">模型</span><span class="v mono">{{ result.model }}</span>
        </div>
        <div class="sum-item">
          <span class="k">设备</span><span class="v mono">{{ result.device }}</span>
        </div>
      </div>

      <el-table :data="rows" size="small" stripe max-height="420" class="mt">
        <el-table-column label="待测词" min-width="150">
          <template #default="{ row }">
            <span class="mono word">{{ row.word }}</span>
          </template>
        </el-table-column>
        <el-table-column label="相似度" width="110" align="right">
          <template #default="{ row }">
            <span class="mono sim">{{ row.sim.toFixed(4) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="相对乱码基线（← 低于  |  高于 →）" min-width="300">
          <template #default="{ row }">
            <div class="bar-wrap">
              <div class="bar-track">
                <div class="bar-mid"></div>
                <div
                  class="bar"
                  :class="row.positive ? 'pos' : 'neg'"
                  :style="{ width: `${row.barWidth / 2}%` }"
                ></div>
              </div>
              <span class="bar-val mono" :class="row.positive ? 'pos-t' : 'neg-t'">
                {{ row.delta >= 0 ? '+' : '' }}{{ row.delta.toFixed(4) }}
              </span>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <div class="note">
        <b>怎么读：</b>CLIP 的文本嵌入整体偏“挤”，任意两个短词都容易得到 0.75~0.95 的相似度，
        乱码甚至可能比真实词更高（基线约 {{ ((result.baseline ?? 0)).toFixed(2) }}）。
        所以<b>不要看绝对值</b>，看它相对基线是高还是低，以及在一批候选词里的排序。
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

.row {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.field {
  width: 240px;
}

.field.grow {
  flex: 1;
  width: auto;
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
  margin-top: 14px;
}

.toolbar-label {
  font-size: 12px;
  color: #98a5b8;
  margin-left: 4px;
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

.word {
  color: #2f3b4f;
}

.sim {
  font-weight: 700;
  color: var(--brand);
  font-variant-numeric: tabular-nums;
}

/* 双向条 */
.bar-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}

.bar-track {
  position: relative;
  flex: 1;
  height: 14px;
  background: #f3f6fc;
  border-radius: 4px;
  overflow: hidden;
}

.bar-mid {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 1px;
  background: #d8e1f0;
}

.bar {
  position: absolute;
  top: 2px;
  bottom: 2px;
  border-radius: 3px;
}

.bar.pos {
  left: 50%;
  background: linear-gradient(90deg, #8fb6ff, #4b6bfb);
}

.bar.neg {
  right: 50%;
  background: linear-gradient(270deg, #ffd08a, #eda63f);
}

.bar-val {
  width: 76px;
  text-align: right;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.pos-t {
  color: #3b62e0;
}

.neg-t {
  color: #c07a19;
}

.note {
  margin-top: 14px;
  padding: 12px 16px;
  border-radius: 10px;
  background: #fffdf5;
  border: 1px solid #f6eccd;
  font-size: 13px;
  line-height: 1.75;
  color: #6b5a2e;
}

@media (max-width: 640px) {
  .row {
    flex-direction: column;
  }

  .field {
    width: 100%;
  }
}
</style>
