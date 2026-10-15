<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'

const status = ref({ ready: false, model: '', modelSource: '', modelBuiltin: '', device: '' })
const backendMissing = ref(false)
const open = ref(false)
const clipPath = ref('')
const sdPath = ref('')
const sdWhich = ref('auto')
const comfyType = ref('')
const reloading = ref(false)
const message = ref('')
let timer = null

const clipPlaceholder = '本地目录或 HF 名称，如 D:\\models\\my-clip'
const sdPlaceholder = '如 F:\\aidraw\\models\\Stable-diffusion\\chilloutmix_NiPrunedFp32Fix.safetensors'

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
  timer = setInterval(refreshStatus, 3000)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

async function reload() {
  reloading.value = true
  message.value = ''
  try {
    const res = await fetch('./api/model/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clipPath: clipPath.value.trim(),
        sdPath: sdPath.value.trim(),
        sdWhich: sdWhich.value,
        comfyType: comfyType.value.trim(),
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)

    const routeLabel =
      data.source === 'sd-ckpt'
        ? 'SD ckpt text encoder'
        : data.source === 'sd-ckpt-g'
          ? 'SDXL CLIP-G'
          : data.source === 'clip-path'
            ? '自定义 CLIP'
            : data.source === 'comfy'
              ? 'ComfyUI 加载栈'
              : '内置'
    message.value = data.changed
      ? `已切换为：${data.label}（${routeLabel} · ${data.device}）` +
        (data.detected ? `\n自动判断：${data.detected.reason}` : '')
      : data.reason || '未发生变化'
    ElMessage.success(data.changed ? '模型已重载' : '已就绪')
    await refreshStatus()
    // 通知其他面板：词表矩阵已失效，需要重新预计算
    window.dispatchEvent(new CustomEvent('clip-model-changed'))
  } catch (e) {
    message.value = e?.message || String(e)
    ElMessage.error(message.value)
  } finally {
    reloading.value = false
  }
}

/* ---------------------------- 从 ComfyUI 读取可用 CLIP 列表 ---------------------------- */
const listing = ref(false)
const comfyList = ref(null)
const pickedClip = ref('')

async function loadComfyList() {
  listing.value = true
  try {
    const res = await fetch('./api/comfy/list')
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    comfyList.value = data
    ElMessage.success(
      `读到 ${data.clipNames.length} 个 CLIP 文件（${data.found} 个已定位）、${data.types.length} 个类型`
    )
  } catch (e) {
    ElMessage.error(e?.message || String(e))
  } finally {
    listing.value = false
  }
}

function onPickClip(name) {
  const hit = comfyList.value?.items?.find((x) => x.name === name)
  if (hit?.path) sdPath.value = hit.path
}

const loadingCurrent = ref(false)

async function loadCurrentClip() {
  loadingCurrent.value = true
  try {
    const res = await fetch('./api/comfy/current')
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)

    if (data.path) {
      sdPath.value = data.path
      pickedClip.value = data.name
    }
    if (data.type) comfyType.value = data.type

    if (!data.path) {
      ElMessage.warning(
        `ComfyUI 当前用的是 ${data.name}（type=${data.type}），但本地按模型目录没找到这个文件，请手动确认路径`
      )
      return
    }

    ElMessage.success(`读到 ComfyUI 当前在用的 CLIP：${data.name}（type=${data.type}），正在加载…`)
    await reload()
  } catch (e) {
    ElMessage.error(e?.message || String(e))
  } finally {
    loadingCurrent.value = false
  }
}

function useBuiltin() {
  clipPath.value = ''
  sdPath.value = ''
  reload()
}
</script>

<template>
  <div class="model-bar">
    <div class="bar-row">
      <span class="dot" :class="{ ok: status.ready, bad: backendMissing }"></span>
      <span class="k">模型</span>
      <span class="v mono">{{ status.model || '—' }}</span>

      <el-tag
        v-if="status.modelSource && status.modelSource !== 'builtin'"
        size="small"
        type="warning"
        effect="plain"
      >
        {{ status.modelSource === 'sd-ckpt' ? 'SD ckpt 文本塔' : '自定义 CLIP' }}
      </el-tag>
      <el-tag v-if="status.device" size="small" :type="status.device === 'cuda' ? 'success' : 'info'" effect="plain">
        {{ status.device }}
      </el-tag>

      <span class="spacer"></span>
      <el-button link type="primary" @click="open = !open">
        {{ open ? '收起' : '自定义模型路径' }}
      </el-button>
    </div>

    <div v-if="open" class="bar-body">
      <el-alert
        v-if="backendMissing"
        type="warning"
        :closable="false"
        show-icon
        title="未检测到本地服务，模型切换需要它"
        class="mb12"
      />

      <div class="field">
        <div class="label">
          自定义 CLIP 模型路径（留空 = 内置
          <code class="mono">{{ status.modelBuiltin || 'openai/clip-vit-large-patch14' }}</code>）
        </div>
        <el-input v-model="clipPath" clearable :placeholder="clipPlaceholder" />
      </div>

      <div class="field">
        <div class="label">
          SD 模型路径（.safetensors，留空 = 不使用；会从 ckpt 中提取 CLIP text encoder，
          支持 SD1.x / SDXL / ComfyUI 量化格式）
        </div>
        <div class="path-row">
          <el-input v-model="sdPath" clearable :placeholder="sdPlaceholder" />
          <el-button :loading="listing" @click="loadComfyList">从 ComfyUI 读取</el-button>
        </div>

        <div v-if="comfyList" class="picker">
          <el-select
            v-model="pickedClip"
            filterable
            clearable
            placeholder="选一个 ComfyUI 里可用的 CLIP 文件（自动填入路径）"
            style="width: 100%"
            @change="onPickClip"
          >
            <el-option
              v-for="it in comfyList.items"
              :key="it.name"
              :label="it.name"
              :value="it.name"
              :disabled="!it.exists"
            />
          </el-select>
          <div class="hint mt6">
            来自 {{ comfyList.api }} · 已定位 {{ comfyList.found }}/{{ comfyList.clipNames.length }} 个文件 ·
            根目录 <span class="mono">{{ comfyList.modelsRoot }}</span>
          </div>
        </div>
      </div>

      <div class="field">
        <div class="label">取哪个文本塔（SDXL 有 CLIP-L 与 CLIP-G 两个；SD1.x 只有一个）</div>
        <el-radio-group v-model="sdWhich" size="small">
          <el-radio-button value="auto">自动（优先 CLIP-L）</el-radio-button>
          <el-radio-button value="l">CLIP-L（768）</el-radio-button>
          <el-radio-button value="g">CLIP-G / bigG（1280）</el-radio-button>
        </el-radio-group>
      </div>

      <div class="field">
        <div class="label">
          ComfyUI 类型（可选）—— <b>留空会自动嗅探文件格式</b>：若是 ComfyUI 私有量化格式
          （convrot_w4a4 / fp8_scaled）或 LLM 文本塔，就自动切到 ComfyUI 的加载栈；否则用 transformers
          解析。需要指定具体用途时再填 ComfyUI「加载CLIP」节点里那个下拉值，例如
          <code class="mono">krea2</code> / <code class="mono">qwen_image</code> / <code class="mono">flux</code>。
        </div>
        <el-input
          v-model="comfyType"
          clearable
          placeholder="留空 = 自动判断；也可填 krea2 / qwen_image / flux …"
        />
        <div class="hint mt6">
          注意：LLM 系文本塔（Qwen 等）逐词套 chat 模板，结果与 CLIP 系不可直接比较，
          且不支持「相似词 Top-K」整表检索。
        </div>
      </div>

      <div class="actions">
        <el-button type="primary" :loading="reloading" :disabled="backendMissing" @click="reload">
          重载
        </el-button>
        <el-button :disabled="reloading || backendMissing" @click="useBuiltin">内置 CLIP</el-button>
        <el-button
          :loading="loadingCurrent"
          :disabled="reloading || backendMissing"
          @click="loadCurrentClip"
        >
          读取当前已加载
        </el-button>
        <span class="hint">
          两个都填时优先用 SD 路径。切换模型后词表矩阵会失效，需在「相似词 Top-K」页重新预计算。
        </span>
      </div>

      <el-alert v-if="message" type="info" :closable="false" :title="message" class="mt12" />
    </div>
  </div>
</template>

<style scoped>
.model-bar {
  border: 1px solid #e8eef8;
  border-radius: var(--card-radius);
  background: #fff;
  padding: 10px 18px;
  margin-bottom: 14px;
}

.bar-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #d3dbe8;
}

.dot.ok {
  background: #3ecf8e;
  box-shadow: 0 0 0 3px rgba(62, 207, 142, 0.16);
}

.dot.bad {
  background: #f0a94a;
  box-shadow: 0 0 0 3px rgba(240, 169, 74, 0.16);
}

.bar-row .k {
  color: #98a5b8;
  font-size: 12px;
}

.bar-row .v {
  color: #38455c;
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.spacer {
  flex: 1;
}

.bar-body {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px dashed #e6ecf6;
}

.field {
  margin-bottom: 12px;
}

.label {
  font-size: 12px;
  color: #8d9bb0;
  margin-bottom: 6px;
  line-height: 1.6;
}

.label code {
  background: #f2f5fb;
  padding: 1px 6px;
  border-radius: 5px;
}

.actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.hint {
  font-size: 12px;
  color: #9aa7b8;
  line-height: 1.6;
}

.hint.mt6 {
  margin-top: 6px;
}

.path-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.path-row .el-input {
  flex: 1;
}

.picker {
  margin-top: 10px;
}

.mb12 {
  margin-bottom: 12px;
}

.mt12 {
  margin-top: 12px;
}

@media (max-width: 640px) {
  .bar-row .v {
    max-width: 100%;
    white-space: normal;
    word-break: break-all;
  }
}
</style>
