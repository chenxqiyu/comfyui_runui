<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { createClipTokenizer, MAX_LENGTH, START_TOKEN, END_TOKEN } from './lib/clipTokenizer.js'
import SimilarityPanel from './components/SimilarityPanel.vue'
import NearestPanel from './components/NearestPanel.vue'
import ModelBar from './components/ModelBar.vue'

const tk = ref(null)
const ready = ref(false)
const loadError = ref('')
const loadMs = ref(0)
const activeTab = ref('encode')

onMounted(async () => {
  const t0 = performance.now()
  try {
    tk.value = await createClipTokenizer(`${import.meta.env.BASE_URL}data/`)
    loadMs.value = Math.round(performance.now() - t0)
    ready.value = true
  } catch (e) {
    loadError.value = e?.message || String(e)
  }
})

/* ======================================================= 文本 -> Token */
const text = ref('1girl, blue eyes, outdoor, (masterpiece:1.2)')
const parseWeights = ref(true)

const SAMPLES = [
  'girl',
  '1girl, blue eyes, outdoor, masterpiece',
  'masterpiece, best quality, ultra detailed, 8k',
  '(masterpiece:1.3) detailed face',
  'cyberpunk city at night, neon',
  'photorealistic portrait',
  '中文提示词',
  'emoji 😀 test',
]

const encodeResult = computed(() => {
  if (!tk.value) return null
  try {
    const list = tk.value.encodeWithWeights(text.value, { disableWeights: !parseWeights.value })
    const rows = list.map((t, i) => {
      const tokenStr = tk.value.idToToken(t.id) ?? ''
      return {
        i: i + 1,
        id: t.id,
        token: tokenStr,
        text: tk.value.tokenToText(tokenStr),
        weight: t.weight,
      }
    })
    const ids = list.map((t) => t.id)
    return {
      rows,
      count: ids.length,
      withSpecial: ids.length + 2,
      batches: Math.max(1, Math.ceil((ids.length + 2) / MAX_LENGTH)),
      decoded: tk.value.decode(ids),
      overLimit: ids.length > MAX_LENGTH - 2,
    }
  } catch (e) {
    return { error: e?.message || String(e), rows: [] }
  }
})

const hasByteFragment = computed(() =>
  Boolean(encodeResult.value?.rows?.some((r) => String(r.text).startsWith('\\x')))
)

/* ================================================== ID / 词表查询 */
const query = ref('')
const isNumericQuery = computed(() => /^\s*\d+\s*$/.test(query.value))

const idLookup = computed(() => {
  if (!tk.value || !isNumericQuery.value) return null
  const id = Number(query.value.trim())
  const token = tk.value.idToToken(id)
  const isSpecial = id === START_TOKEN || id === END_TOKEN
  return {
    id,
    found: token !== undefined,
    token: token ?? '',
    text: token ? tk.value.tokenToText(token) : '',
    isSpecial,
    label: isSpecial ? (id === START_TOKEN ? '<|startoftext|>' : '<|endoftext|>').trim() : '',
  }
})

const searchList = computed(() => {
  if (!tk.value || isNumericQuery.value) return []
  const kw = query.value.trim()
  if (!kw) return []
  return tk.value.search(kw, 60)
})

const randomList = ref([])
function rollRandom(n = 20) {
  if (!tk.value) return
  const out = []
  for (let i = 0; i < n; i++) {
    let id = START_TOKEN
    while (id === START_TOKEN || id === END_TOKEN) {
      id = Math.floor(Math.random() * 49408)
    }
    const token = tk.value.idToToken(id)
    out.push({ id, token, text: tk.value.tokenToText(token) })
  }
  randomList.value = out
}

/* ============================================================ 小工具 */
function useSample(s) {
  text.value = s
  activeTab.value = 'encode'
}

async function copyValue(v) {
  try {
    await navigator.clipboard.writeText(String(v))
    ElMessage.success(`已复制 ${v}`)
  } catch {
    ElMessage.warning('复制失败，请手动选择')
  }
}
</script>

<template>
  <div class="page">
    <header class="hero">
      <div class="hero-badge">CLIP · Stable Diffusion 1.x</div>
      <h1>Token 查询器</h1>
      <p class="sub">
        纯前端复刻 ComfyUI 的分词逻辑 —— 输入单词或提示词，看它被切成了哪些 token
      </p>
    </header>

    <ModelBar />

    <el-card v-if="loadError" shadow="never" class="panel">
      <el-alert type="error" :closable="false" title="词表加载失败" :description="loadError" />
    </el-card>

    <el-skeleton v-else-if="!ready" :rows="6" animated class="panel-skeleton" />

    <el-card v-else shadow="never" class="panel">
      <el-tabs v-model="activeTab">
        <!-- ============================================ 文本 -> Token -->
        <el-tab-pane label="文本 → Token" name="encode">
          <el-input
            v-model="text"
            type="textarea"
            :rows="3"
            resize="vertical"
            placeholder="输入单词或提示词，例如：1girl, blue eyes, outdoor"
          />

          <div class="toolbar">
            <span class="toolbar-label">示例</span>
            <el-tag
              v-for="s in SAMPLES"
              :key="s"
              class="chip"
              effect="plain"
              @click="useSample(s)"
            >
              {{ s }}
            </el-tag>
          </div>

          <div class="toolbar">
            <el-switch v-model="parseWeights" />
            <span class="switch-text">解析 <code class="mono">(词:权重)</code> 语法</span>
          </div>

          <template v-if="encodeResult && !encodeResult.error">
            <div class="stats">
              <div class="stat">
                <div class="num">{{ encodeResult.count }}</div>
                <div class="cap">有效 Token</div>
              </div>
              <div class="stat">
                <div class="num">{{ encodeResult.withSpecial }}</div>
                <div class="cap">含首尾特殊 Token</div>
              </div>
              <div class="stat">
                <div class="num">{{ encodeResult.batches }}</div>
                <div class="cap">CLIP 分段数</div>
              </div>
              <div class="stat-wide">
                <el-alert
                  v-if="encodeResult.overLimit"
                  type="warning"
                  :closable="false"
                  show-icon
                  :title="`有效 Token 超过 ${MAX_LENGTH - 2} 个`"
                  description="CLIP 单段上限 77（含首尾特殊 token），ComfyUI 会把文本切成多段送入。"
                />
                <el-alert
                  v-else
                  type="success"
                  :closable="false"
                  show-icon
                  title="长度在 CLIP 单段上限内"
                />
              </div>
            </div>

            <div v-if="hasByteFragment" class="byte-tip">
              提示：像 <code class="mono">\xE5</code> 这样的是 <b>UTF-8 字节片段</b> ——
              CLIP 会把汉字 / emoji 拆成若干“字节级 token”，单个 token 无法独立成字，所以改用十六进制显示。
              完整文本请看下面的「分词还原」。
            </div>

            <el-table :data="encodeResult.rows" size="small" stripe max-height="440" class="table">
              <el-table-column prop="i" label="#" width="56" align="center" />
              <el-table-column label="Token ID" width="130">
                <template #default="{ row }">
                  <span class="mono token-id" title="点击复制" @click="copyValue(row.id)">
                    {{ row.id }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column label="BPE 片段" min-width="160">
                <template #default="{ row }">
                  <span class="mono token-raw">{{ row.token }}</span>
                </template>
              </el-table-column>
              <el-table-column label="字面文本" min-width="140">
                <template #default="{ row }">
                  <span class="mono token-text">{{ row.text || '—' }}</span>
                </template>
              </el-table-column>
              <el-table-column label="权重" width="96" align="center">
                <template #default="{ row }">
                  <el-tag v-if="Math.abs(row.weight - 1) > 1e-6" size="small" type="warning">
                    {{ row.weight.toFixed(3) }}
                  </el-tag>
                  <span v-else class="weight-plain">1.0</span>
                </template>
              </el-table-column>
              <template #empty>没有 token（输入为空）</template>
            </el-table>

            <div class="decode">
              <div class="decode-label">分词还原（把 token 序列解码回去）</div>
              <div class="mono decode-body">{{ encodeResult.decoded || '（空）' }}</div>
            </div>
          </template>

          <el-alert
            v-else-if="encodeResult && encodeResult.error"
            type="error"
            :closable="false"
            :title="encodeResult.error"
          />
        </el-tab-pane>

        <!-- ============================================ ID / 词表查询 -->
        <el-tab-pane label="ID / 词表查询" name="lookup">
          <el-input
            v-model="query"
            size="large"
            clearable
            placeholder="输入 Token ID（如 1746），或关键词（如 girl）"
          />

          <template v-if="idLookup">
            <div class="id-card">
              <div class="id-num mono">{{ idLookup.id }}</div>
              <div class="id-detail">
                <template v-if="idLookup.found">
                  <div class="id-row">
                    <span class="k">BPE 片段</span>
                    <span class="mono token-raw">{{ idLookup.token }}</span>
                  </div>
                  <div class="id-row">
                    <span class="k">字面文本</span>
                    <span class="mono token-text">{{ idLookup.text || '—' }}</span>
                  </div>
                  <el-tag v-if="idLookup.isSpecial" type="info" size="small" class="id-tag">
                    特殊 token {{ idLookup.label }}
                  </el-tag>
                </template>
                <el-text v-else type="danger">词表中不存在该 ID</el-text>
              </div>
            </div>
          </template>

          <template v-else-if="query.trim()">
            <div class="result-head">
              命中 <b>{{ searchList.length }}</b> 条（最多显示 60 条）
            </div>
            <el-table :data="searchList" size="small" stripe max-height="440">
              <el-table-column label="Token ID" width="130">
                <template #default="{ row }">
                  <span class="mono token-id">{{ row.id }}</span>
                </template>
              </el-table-column>
              <el-table-column label="BPE 片段" min-width="180" prop="token">
                <template #default="{ row }">
                  <span class="mono token-raw">{{ row.token }}</span>
                </template>
              </el-table-column>
              <el-table-column label="字面文本" min-width="140">
                <template #default="{ row }">
                  <span class="mono token-text">{{ row.text || '—' }}</span>
                </template>
              </el-table-column>
              <template #empty>词表中没有匹配的片段</template>
            </el-table>
          </template>

          <template v-else>
            <div class="random-head">
              <span>随机抽查词表</span>
              <el-button size="small" type="primary" plain @click="rollRandom(20)">
                随机抽 20 个 ID
              </el-button>
            </div>
            <el-table v-if="randomList.length" :data="randomList" size="small" stripe max-height="420">
              <el-table-column label="Token ID" width="130">
                <template #default="{ row }">
                  <span class="mono token-id">{{ row.id }}</span>
                </template>
              </el-table-column>
              <el-table-column label="BPE 片段" min-width="180">
                <template #default="{ row }">
                  <span class="mono token-raw">{{ row.token }}</span>
                </template>
              </el-table-column>
              <el-table-column label="字面文本" min-width="140">
                <template #default="{ row }">
                  <span class="mono token-text">{{ row.text || '—' }}</span>
                </template>
              </el-table-column>
            </el-table>
            <el-empty v-else description="点按钮随机抽一批 token 看看" :image-size="90" />
          </template>
        </el-tab-pane>

        <!-- ============================================ 词义相似度 -->
        <el-tab-pane label="词义相似度" name="similarity">
          <SimilarityPanel />
        </el-tab-pane>

        <!-- ============================================ 相似词 Top-K -->
        <el-tab-pane label="相似词 Top-K" name="nearest">
          <NearestPanel :tokenizer="tk" />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <footer class="foot">
      <span>词表 49,408 · merges 48,894 · 数据取自本机 ComfyUI 的 <code class="mono">sd1_tokenizer</code></span>
      <span v-if="ready">已加载，用时 {{ loadMs }} ms · 分词结果与 ComfyUI / transformers 逐 token 一致</span>
    </footer>
  </div>
</template>

<style scoped>
.page {
  max-width: 1040px;
  margin: 0 auto;
  padding: 40px 24px 56px;
}

/* ---------------------------------------------------------- header */
.hero {
  text-align: center;
  margin-bottom: 26px;
}

.hero-badge {
  display: inline-block;
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 12px;
  letter-spacing: 0.06em;
  color: #5566cc;
  background: #eef1ff;
  border: 1px solid #dfe5ff;
}

.hero h1 {
  margin: 14px 0 8px;
  font-size: 30px;
  letter-spacing: -0.01em;
  background: linear-gradient(92deg, #4b6bfb 0%, #8b5cf6 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.hero .sub {
  margin: 0;
  color: var(--ink-soft);
  font-size: 14px;
}

/* ----------------------------------------------------------- panel */
.panel,
.panel-skeleton {
  border: 1px solid #e8eef8;
  border-radius: var(--card-radius);
  background: #fff;
}

.panel :deep(.el-card__body) {
  padding: 18px 22px 22px;
}

.panel :deep(.el-tabs__header) {
  margin-bottom: 18px;
}

/* --------------------------------------------------------- toolbar */
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
  margin-right: 2px;
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

.switch-text {
  font-size: 13px;
  color: var(--ink-soft);
}

.switch-text code {
  background: #f2f5fb;
  padding: 1px 6px;
  border-radius: 5px;
  font-size: 12px;
  color: #5b6b86;
}

/* ----------------------------------------------------------- stats */
.stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 18px 0 14px;
}

.stat {
  background: #f8faff;
  border: 1px solid #e9effa;
  border-radius: 10px;
  padding: 12px 14px;
}

.stat .num {
  font-size: 22px;
  font-weight: 700;
  color: var(--brand);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.stat .cap {
  font-size: 12px;
  color: #8d9bb0;
  margin-top: 2px;
}

.stat-wide {
  grid-column: 1 / -1;
}

/* ----------------------------------------------------------- table */
.table {
  border-radius: 10px;
  overflow: hidden;
}

.byte-tip {
  margin: 14px 0 10px;
  padding: 10px 14px;
  border-radius: 9px;
  background: #f6f9ff;
  border: 1px solid #e4ecfb;
  font-size: 12.5px;
  line-height: 1.7;
  color: #5b6b86;
}

.byte-tip code {
  background: #eaf0fc;
  padding: 1px 5px;
  border-radius: 4px;
}

.token-id {
  cursor: pointer;
  font-weight: 700;
  color: var(--brand);
  font-variant-numeric: tabular-nums;
  padding: 1px 6px;
  border-radius: 5px;
  transition: background 0.15s;
}

.token-id:hover {
  background: #eef2ff;
}

.token-raw {
  color: #7c5cf0;
  word-break: break-all;
}

.token-text {
  color: #2f7d5e;
  word-break: break-all;
}

.weight-plain {
  color: #b6c0ce;
  font-size: 12px;
}

/* ---------------------------------------------------------- decode */
.decode {
  margin-top: 14px;
  border: 1px dashed #dde5f2;
  border-radius: 10px;
  padding: 12px 14px;
  background: #fbfcff;
}

.decode-label {
  font-size: 12px;
  color: #98a5b8;
  margin-bottom: 6px;
}

.decode-body {
  font-size: 13px;
  color: #38455c;
  word-break: break-all;
  line-height: 1.6;
}

/* -------------------------------------------------------- id 查询 */
.id-card {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-top: 16px;
  padding: 18px 20px;
  border: 1px solid #e9effa;
  border-radius: 12px;
  background: linear-gradient(180deg, #fafcff, #f5f8ff);
}

.id-num {
  font-size: 30px;
  font-weight: 700;
  color: var(--brand);
  font-variant-numeric: tabular-nums;
  min-width: 120px;
}

.id-detail {
  flex: 1;
}

.id-row {
  display: flex;
  gap: 10px;
  align-items: baseline;
  margin-bottom: 6px;
}

.id-row .k {
  font-size: 12px;
  color: #98a5b8;
  min-width: 62px;
}

.id-tag {
  margin-top: 4px;
}

.result-head,
.random-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 18px 0 10px;
  font-size: 13px;
  color: var(--ink-soft);
}

/* ----------------------------------------------------------- foot */
.foot {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
  text-align: center;
  margin-top: 20px;
  font-size: 12px;
  color: #9aa7b8;
}

.foot code {
  background: #eef2fa;
  padding: 1px 5px;
  border-radius: 4px;
}

@media (max-width: 640px) {
  .page {
    padding: 24px 14px 40px;
  }

  .stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .id-card {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
}
</style>
