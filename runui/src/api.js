const PREFIX_KEY = 'comfy-runui.prefix'
const DEFAULT_PREFIX = '/comfy'

export function getPrefix() {
  return localStorage.getItem(PREFIX_KEY) || DEFAULT_PREFIX
}

export function setPrefix(v) {
  const val = (v || '').trim()
  if (val) localStorage.setItem(PREFIX_KEY, val.replace(/\/+$/, ''))
  else localStorage.removeItem(PREFIX_KEY)
}

function base() {
  return getPrefix().replace(/\/+$/, '')
}

async function request(path, options = {}) {
  const res = await fetch(base() + path, options)
  if (!res.ok) {
    let data = null
    try {
      data = await res.json()
    } catch {
      /* 非 JSON 响应 */
    }
    const message = data?.error?.message || res.statusText
    const err = new Error(`HTTP ${res.status} · ${String(message).slice(0, 300)}`)
    // 把节点级校验详情带出来，由界面决定怎么展示
    err.status = res.status
    err.nodeErrors = data?.node_errors || null
    throw err
  }
  return res.json()
}

export const apiGet = (path) => request(path)
export const apiPost = (path, body) =>
  request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

// 这类接口成功时返回空 body，不能按 JSON 解析
async function postSilent(path, body = {}) {
  const res = await fetch(base() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

/** 中断当前正在执行的任务 */
export const interruptRun = () => postSilent('/interrupt')

/** 从队列里删掉还没开始的任务 */
export const deleteQueued = (ids) => postSilent('/queue', { delete: ids })

/** 图片直链（走同一个前缀，dev 下由 vite 代理） */
export function viewUrl(img) {
  const q = new URLSearchParams({
    filename: img.filename,
    subfolder: img.subfolder || '',
    type: img.type || 'output',
  })
  return `${base()}/view?${q.toString()}`
}

/** /queue 的一项 -> { promptId, nodes } */
export function nodesFromQueueItem(item) {
  // [number, prompt_id, prompt_tuple, extra_data, outputs]
  const tuple = Array.isArray(item) ? item[2] : null
  if (!Array.isArray(tuple) || !tuple[2]) return null
  return { promptId: item[1] || tuple[1], nodes: tuple[2] }
}

/** /history/{id} 的 entry -> nodes */
export function nodesFromHistoryEntry(entry) {
  const tuple = entry?.prompt
  if (!Array.isArray(tuple) || !tuple[2]) return null
  return { promptId: tuple[1], nodes: tuple[2] }
}

/**
 * 找「当前工作流」：正在执行的优先，其次排队中的，最后退回到最近一次执行过的。
 */
export async function fetchCurrentWorkflow() {
  const queue = await apiGet('/queue')
  const running = queue.queue_running || []
  const pending = queue.queue_pending || []

  for (const [list, label] of [
    [running, '正在执行'],
    [pending, '排队中'],
  ]) {
    for (const item of list) {
      const got = nodesFromQueueItem(item)
      if (got?.nodes) return { ...got, source: label }
    }
  }

  const jobs = (await apiGet('/api/jobs?limit=30')).jobs || []
  for (const job of jobs) {
    if (!['completed', 'failed', 'success', 'error'].includes(job.status)) continue
    const history = await apiGet(`/history/${job.id}`)
    const entry = history[job.id]
    const got = nodesFromHistoryEntry(entry)
    if (got?.nodes) return { ...got, source: `最近一次执行 · ${job.status}`, entry }
  }

  const history = await apiGet('/history?max_items=10')
  for (const pid of Object.keys(history)) {
    const got = nodesFromHistoryEntry(history[pid])
    if (got?.nodes) return { ...got, source: '历史记录', entry: history[pid] }
  }

  throw new Error('ComfyUI 里还没有任何执行记录，先在 ComfyUI 里跑一次工作流')
}

export const submitPrompt = (nodes, extra = {}) =>
  apiPost('/prompt', { prompt: nodes, client_id: `runui-${Date.now()}`, ...extra })

export const fetchHistory = (promptId) => apiGet(`/history/${promptId}`)

/** 从 history entry 的 outputs 里抽出图片 */
export function collectImages(entry, outNodeId) {
  const outputs = entry?.outputs || {}
  const ids = outNodeId ? [String(outNodeId)] : Object.keys(outputs)
  const images = []
  for (const id of ids) {
    const nodeOut = outputs[id]
    if (!nodeOut) continue
    for (const img of nodeOut.images || []) images.push({ ...img, nodeId: id })
  }
  return images
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------ 极速模式（本机文件） */
/**
 * /api/fastlora/* 由 runui 自己的本机服务提供（vite 中间件 / tools/serve.mjs），
 * 不走 ComfyUI 的 /comfy 前缀。相对 document.baseURI 解析，dist 放在子路径也能用。
 */
function fastUrl(path) {
  try {
    return new URL(`api/fastlora${path}`, document.baseURI).toString()
  } catch {
    return `/api/fastlora${path}`
  }
}

async function fastRequest(path, options = {}) {
  let res
  try {
    res = await fetch(fastUrl(path), { cache: 'no-store', ...options })
  } catch {
    throw new Error('本机服务没起来：极速模式要用 npm run dev 或 npm run serve 启动界面')
  }
  const type = res.headers.get('content-type') || ''
  if (!type.includes('application/json')) {
    throw new Error('本机服务没起来：极速模式要用 npm run dev 或 npm run serve 启动界面')
  }
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`)
    if (data?.job) err.job = data.job
    throw err
  }
  return data
}

/** 极速目录状态 + 已经在极速目录里的 LoRA 名字键 */
export const fastStatus = () => fastRequest('/status')

/** 把 LoRA 搬进极速目录（后台任务，返回 job 用于轮询） */
export const fastApply = (names) =>
  fastRequest('/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names }),
  })

/** 还原：names 为空 = 还原全部 */
export const fastRestore = (names = []) =>
  fastRequest('/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names }),
  })

export const fastJob = (id) => fastRequest(`/job?id=${encodeURIComponent(id)}`)

