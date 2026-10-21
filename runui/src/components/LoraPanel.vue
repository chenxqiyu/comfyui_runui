<script setup>
import { computed } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  nodes: { type: Array, default: () => [] }, // [{ id, cls, title, count, activeCount, loras }]
  chains: { type: Array, default: () => [] }, // [{ ids, nodes, chained, connected, end, enabled, total }]
  nodeId: { type: String, default: '' },
  loras: { type: Array, default: () => [] },
  baseline: { type: Array, default: null },
})

const emit = defineEmits(['toggle', 'close', 'select-node', 'change', 'reset'])

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

      <div v-if="!items.length" class="lp-empty">
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
        </div>

        <div class="lp-list">
          <div class="lp-list-head">
            <label class="lp-check lp-toggle-all">
              <input type="checkbox" :checked="allActive" @change="toggleAll" />
              <span>Toggle All</span>
            </label>
            <span class="lp-strength-title">节点 {{ nodeId }} · 强度 ↔</span>
          </div>
          <div class="lp-rows">
            <div
              v-for="(item, i) in items"
              :key="i"
              class="lp-row"
              :class="{ off: !isActive(item) }"
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
              <span class="lp-name" :title="readName(item)">{{ readName(item) || '（未命名）' }}</span>
              <div class="lp-step" @click.stop>
                <button type="button" class="lp-arrow" title="减少 0.05" @click="nudgeStrength(i, -0.05)">
                  ‹
                </button>
                <input
                  type="number"
                  step="0.05"
                  :value="fmtStrength(item)"
                  title="强度（0.05 步进，可直接输入）"
                  @change="onStrengthChange(i, $event)"
                  @keyup.enter="$event.target.blur()"
                />
                <button type="button" class="lp-arrow" title="增加 0.05" @click="nudgeStrength(i, 0.05)">
                  ›
                </button>
              </div>
            </div>
          </div>
        </div>

        <footer class="lp-foot">
          <span class="lp-hint">改动会写回当前工作流，下次「发送」生效</span>
          <button type="button" class="lp-reset" :disabled="!baseline" @click="emit('reset')">
            恢复原值
          </button>
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
  height: min(660px, calc(100vh - 120px));
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
.lp-strength-title { font-size: 11.5px; color: #a3a3a3; }
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

.lp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid #3d3d3d;
  cursor: pointer;
  transition: background .12s;
}
.lp-row:last-child { border-bottom: none; }
.lp-row:hover { background: #3b3b3b; }
.lp-row.off .lp-name { color: #858585; }
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
.lp-arrow:hover { background: #404040; color: #e6e6e6; }
.lp-arrow:active { background: #4a4a4a; }

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
  font-size: 10.5px;
  color: #8a8a8a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
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

@media (max-width: 640px) {
  .lora-dock { right: 10px; bottom: 10px; left: 10px; align-items: stretch; }
  .lp { width: auto; height: min(660px, calc(100vh - 90px)); }
  .lora-fab { align-self: flex-end; }
}
</style>
