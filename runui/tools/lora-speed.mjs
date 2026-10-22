/**
 * 极速模式（fast LoRA）本机文件服务
 * ------------------------------------------------------------------
 * 背景：ComfyUI 的 models/loras 通常软链到慢盘（本机是 I:\loras）。
 * 「极速模式」把 LoRA 的实体文件搬到快盘 FAST_DIR（默认 F:\ai\fastlora），
 * 再在原位置留一个同名软连接 → ComfyUI 仍然能从原路径加载，但真正读的是快盘。
 *
 * 落地的东西：
 *   FAST_DIR\<相对路径>.safetensors   实体文件（保留子目录结构，避免同名冲突）
 *   原位置\xxx.safetensors            软连接，指向上面那个实体文件
 *   FAST_DIR\_fastlora-manifest.json  还原信息（原路径 / 现在路径 / 大小 / 时间）
 *   FAST_DIR\还原-fastlora.ps1        离线一键还原脚本（不依赖 runui，可直接双击）
 *
 * 挂载：vite.config.js 的 dev 中间件 + tools/serve.mjs（生产）共用本文件。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const FAST_DIR = path.resolve(process.env.FASTLORA_DIR || 'F:\\ai\\fastlora')
const MANIFEST_NAME = '_fastlora-manifest.json'
const PS1_NAME = '还原-fastlora.ps1'
const MODEL_EXTS = ['.safetensors', '.sft', '.pt', '.pth', '.ckpt', '.bin']
const INDEX_TTL = 300_000
const JOB_TTL = 30 * 60_000

const manifestFile = path.join(FAST_DIR, MANIFEST_NAME)
const ps1File = path.join(FAST_DIR, PS1_NAME)

const isModelFile = (f) => MODEL_EXTS.includes(path.extname(f).toLowerCase())
const stripExt = (f) => String(f).replace(/\.(safetensors|sft|pt|pth|ckpt|bin)$/i, '')
const toPosix = (p) => String(p).split(path.sep).join('/')
const samePath = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const mb = (n) => `${(Number(n || 0) / 1048576).toFixed(1)} MB`

async function exists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}
async function statOf(p) {
  try {
    return await fsp.stat(p)
  } catch {
    return null
  }
}
async function lstatOf(p) {
  try {
    return await fsp.lstat(p)
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------- 目录配置 */

function loraRoots() {
  const raw = process.env.LORA_ROOTS || 'I:\\loras'
  const out = []
  for (const piece of raw.split(/[;\n]/)) {
    const t = piece.trim()
    if (!t) continue
    let real = t
    try {
      real = fs.realpathSync.native(t)
    } catch {
      /* 不存在就按原样记着 */
    }
    if (!out.some((x) => samePath(x, real))) out.push(real)
  }
  return out
}

/* ------------------------------------------------------------ LoRA 文件索引 */

let indexCache = null // { at, map: Map<basenameLower, [{root, abs, rel}]> }
let indexPromise = null

/**
 * 递归遍历目录，**跟随软连接目录**。
 * I:\loras 里就有一堆这种：sd15 -> F:\aidraw\models\Lora，不跟进去会漏掉整棵子树
 * （表现就是「名字带中文的搬不了」——其实是在软链目录里，压根没进索引）。
 * 用 realpath 去重，软链成环也不会死循环。
 */
async function walk(root, onFile) {
  const stack = [root]
  const visited = new Set()
  while (stack.length) {
    const dir = stack.pop()
    let real = dir
    try {
      real = await fsp.realpath(dir)
    } catch {
      continue
    }
    const mark = real.toLowerCase()
    if (visited.has(mark)) continue
    visited.add(mark)

    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name)
      let isDir = ent.isDirectory()
      let isFile = ent.isFile()
      if (ent.isSymbolicLink()) {
        // Dirent 对软连接的 isDirectory/isFile 都是 false，必须 stat 跟进去看
        try {
          const st = await fsp.stat(abs)
          isDir = st.isDirectory()
          isFile = st.isFile()
        } catch {
          continue // 断链
        }
      }
      if (isDir) stack.push(abs)
      else if (isFile) onFile(abs)
    }
  }
}

async function getIndex() {
  const now = Date.now()
  if (indexCache && now - indexCache.at < INDEX_TTL) return indexCache.map
  if (indexPromise) return indexPromise
  indexPromise = (async () => {
    const map = new Map()
    for (const root of loraRoots()) {
      // eslint-disable-next-line no-await-in-loop
      await walk(root, (abs) => {
        if (!isModelFile(abs)) return
        const key = stripExt(path.basename(abs)).toLowerCase()
        const list = map.get(key) || []
        list.push({ root, abs, rel: toPosix(path.relative(root, abs)) })
        map.set(key, list)
      })
    }
    indexCache = { at: Date.now(), map }
    return map
  })()
  try {
    return await indexPromise
  } finally {
    indexPromise = null
  }
}

function invalidateIndex() {
  indexCache = null
}

/**
 * 名字 → 文件。
 * 1) 带子目录（Flux.1 D/tool/xxx）按相对路径直接拼；
 * 2) 只有文件名就去全量索引里按 basename 找，多个同名取路径最短的。
 */
async function resolveLora(name) {
  const norm = String(name || '').replace(/\\/g, '/').trim()
  if (!norm) return null
  const hasExt = /\.(safetensors|sft|pt|pth|ckpt|bin)$/i.test(norm)
  const rels = hasExt ? [norm] : MODEL_EXTS.map((e) => norm + e)

  for (const root of loraRoots()) {
    for (const rel of rels) {
      const abs = path.join(root, ...rel.split('/'))
      const st = await statOf(abs)
      if (st?.isFile()) {
        return { root, abs, rel: toPosix(path.relative(root, abs)), ambiguous: false }
      }
    }
  }

  const map = await getIndex()
  const key = stripExt(path.basename(norm)).toLowerCase()
  const hits = map.get(key) || []
  if (!hits.length) return null
  const sameRel = hits.find((h) => h.rel.toLowerCase() === (hasExt ? norm : stripExt(norm)).toLowerCase())
  const picked = sameRel || [...hits].sort((a, b) => a.rel.length - b.rel.length)[0]
  return { ...picked, ambiguous: hits.length > 1 }
}

/* --------------------------------------------------------------- 还原清单 */

function emptyManifest() {
  return { version: 1, fastDir: FAST_DIR, updatedAt: null, items: [] }
}

async function readManifest() {
  try {
    const txt = await fsp.readFile(manifestFile, 'utf8')
    const json = JSON.parse(txt.replace(/^\uFEFF/, ''))
    if (Array.isArray(json.items)) return { ...emptyManifest(), ...json, items: json.items }
  } catch {
    /* 没有或者坏了，当作空清单 */
  }
  return emptyManifest()
}

async function writeManifest(m) {
  await fsp.mkdir(FAST_DIR, { recursive: true })
  m.fastDir = FAST_DIR
  m.version = 1
  m.updatedAt = new Date().toISOString()
  const tmp = `${manifestFile}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(m, null, 2), 'utf8')
  await fsp.rename(tmp, manifestFile)
  await writeRestoreScript(m)
  return m
}

/** 清单里的名字键：相对路径（去扩展名）+ 纯文件名，供前端点亮闪电图标 */
function manifestKeys(items) {
  const keys = new Set()
  for (const it of items || []) {
    const rel = String(it.rel || '').replace(/\.(safetensors|sft|pt|pth|ckpt|bin)$/i, '')
    if (rel) keys.add(rel.toLowerCase())
    const base = stripExt(path.basename(String(it.src || it.rel || ''))).toLowerCase()
    if (base) keys.add(base)
    if (it.name) keys.add(String(it.name).replace(/\\/g, '/').toLowerCase())
  }
  return [...keys]
}

/* -------------------------------------------------------- 离线还原 ps1 脚本 */

function restoreScript() {
  return String.raw`<#
  fastlora 离线一键还原
  ---------------------------------------------------------------
  把快盘极速目录里的 LoRA 搬回原目录，并删掉原目录里留下的软连接。
  不依赖 runui：双击就能跑，或者
      powershell -ExecutionPolicy Bypass -File .\还原-fastlora.ps1

  参数：
      -DryRun    只看会做什么，不动文件
      -NoPause   跑完不等待按键（给计划任务用）
      -FastDir   极速目录，默认取本脚本所在目录
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$NoPause,
  [string]$FastDir = ''
)

$ErrorActionPreference = 'Continue'

# 输出统一成 UTF-8，避免在中文控制台里出现乱码
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

if (-not $FastDir) { $FastDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$manifest = Join-Path $FastDir '_fastlora-manifest.json'

function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color }

Say ''
Say '=== fastlora 离线还原 ===' 'Cyan'
Say "极速目录：$FastDir"
if ($DryRun) { Say '（DryRun：只列出动作，不改文件）' 'Yellow' }
Say ''

if (-not (Test-Path -LiteralPath $manifest)) {
  Say '没有找到还原清单 _fastlora-manifest.json' 'Yellow'
  Say '说明当前没有需要通过本脚本还原的 LoRA（可能已经还原过了）。' 'Yellow'
  if (-not $NoPause) { Read-Host '按回车关闭' | Out-Null }
  exit 0
}

try {
  $data = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  Say "还原清单解析失败：$($_.Exception.Message)" 'Red'
  if (-not $NoPause) { Read-Host '按回车关闭' | Out-Null }
  exit 1
}

$items = @($data.items)
if ($items.Count -eq 0) {
  Say '清单里没有条目，无需还原。' 'Yellow'
  if (-not $NoPause) { Read-Host '按回车关闭' | Out-Null }
  exit 0
}

Say "共 $($items.Count) 个 LoRA 需要还原。"
Say ''

$ok = 0
$skip = 0
$fail = 0
$failed = @()

foreach ($it in $items) {
  $src = [string]$it.src
  if (-not $src) { $skip++; continue }

  $dst = [string]$it.dst
  if (-not $dst -and $it.rel) {
    $dst = Join-Path $FastDir ([string]$it.rel).Replace('/', [IO.Path]::DirectorySeparatorChar)
  }
  $leaf = Split-Path -Leaf $src
  $dir = Split-Path -Parent $src

  # 1) 原位置现在是什么
  $cur = Get-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue
  if ($cur -and $cur.LinkType) {
    # 是软连接 → 删掉（只删链接，不动目标）
    if ($DryRun) {
      Say "  [DryRun] 删除软连接  $src"
    } else {
      try { Remove-Item -LiteralPath $src -Force -ErrorAction Stop }
      catch {
        Say "  [失败] 删不掉软连接：$leaf · $($_.Exception.Message)" 'Red'
        $fail++; $failed += $leaf
        continue
      }
    }
  } elseif ($cur) {
    # 已经是真实文件了
    if ($dst -and (Test-Path -LiteralPath $dst)) {
      Say "  [跳过] 原位置已是真实文件，且极速目录里还有一份：$leaf" 'Yellow'
      Say "         确认无误后可以手动删掉 $dst" 'DarkGray'
      $skip++
    } else {
      Say "  [已还原] $leaf" 'DarkGray'
      $ok++
    }
    continue
  }

  # 2) 极速目录里的实体文件还在不在
  if (-not $dst -or -not (Test-Path -LiteralPath $dst)) {
    Say "  [跳过] 极速目录里找不到实体文件：$leaf" 'Yellow'
    $skip++
    continue
  }

  if ($DryRun) {
    Say "  [DryRun] 移回  $dst  ->  $src"
    $ok++
    continue
  }

  # 3) 建目录 + 搬回去
  try {
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    try {
      Move-Item -LiteralPath $dst -Destination $src -Force -ErrorAction Stop
    } catch {
      Copy-Item -LiteralPath $dst -Destination $src -Force -ErrorAction Stop
      Remove-Item -LiteralPath $dst -Force -ErrorAction Stop
    }
    $len = (Get-Item -LiteralPath $src -Force).Length
    Say "  [还原] $leaf  ($([math]::Round($len / 1MB, 1)) MB)" 'Green'
    $ok++
  } catch {
    Say "  [失败] $leaf · $($_.Exception.Message)" 'Red'
    $fail++; $failed += $leaf
  }
}

# 4) 顺手清掉空目录
if (-not $DryRun -and (Test-Path -LiteralPath $FastDir)) {
  $dirs = Get-ChildItem -LiteralPath $FastDir -Directory -Recurse -Force -ErrorAction SilentlyContinue |
    Sort-Object { $_.FullName.Length } -Descending
  foreach ($d in $dirs) {
    try {
      if (-not (Get-ChildItem -LiteralPath $d.FullName -Force -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $d.FullName -Force -Recurse -ErrorAction SilentlyContinue
      }
    } catch { }
  }
}

Say ''
Say ("完成：还原 {0}，跳过 {1}，失败 {2}" -f $ok, $skip, $fail) $(if ($fail -gt 0) { 'Yellow' } else { 'Green' })

if ($fail -eq 0 -and $skip -eq 0 -and -not $DryRun) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $done = Join-Path $FastDir "_fastlora-manifest.restored-$stamp.json"
  try {
    Move-Item -LiteralPath $manifest -Destination $done -Force -ErrorAction SilentlyContinue
    Say "清单已归档：$done" 'DarkGray'
  } catch { }
} elseif (-not $DryRun) {
  Say '还有没处理完的条目，清单保留原样，修好问题后再跑一次本脚本即可。' 'Yellow'
}

if ($failed.Count -gt 0) {
  Say ''
  Say '失败清单：' 'Red'
  $failed | ForEach-Object { Say "  - $_" 'Red' }
}

if (-not $NoPause) { Read-Host '按回车关闭' | Out-Null }
`
}

async function writeRestoreScript(m) {
  await fsp.mkdir(FAST_DIR, { recursive: true })
  // UTF-8 BOM：PowerShell 5.1 只有看到 BOM 才按 UTF-8 读，否则中文全是乱码
  await fsp.writeFile(ps1File, '\uFEFF' + restoreScript(), 'utf8')
}

/* ------------------------------------------------------------ 文件搬运工具 */

/**
 * 搬文件：同盘直接 rename（瞬时，1GB 也不用几秒），跨盘才 copy + 校验 + 删源。
 * 跨盘复制先写到 .fastlora-part 再改名，避免中断后留下半个同名文件。
 */
async function moveFile(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true })
  const srcStat = await statOf(src)
  if (!srcStat) throw new Error('源文件不存在')

  // 用 realpath 判卷：I:\loras\sd15 这种软链目录实际可能在 F:\，同卷就能直接 rename
  let realSrc = src
  try {
    realSrc = await fsp.realpath(src)
  } catch {
    /* 拿不到就按原路径判断 */
  }
  const sameVolume =
    path.parse(realSrc).root.toLowerCase() === path.parse(dst).root.toLowerCase()
  if (sameVolume) {
    try {
      await fsp.rename(src, dst)
      return srcStat.size
    } catch {
      /* EXDEV / 权限之类，退回复制 */
    }
  }

  const part = `${dst}.fastlora-part`
  await fsp.copyFile(src, part)
  await fsp.rename(part, dst)
  const [a, b] = [await statOf(src), await statOf(dst)]
  if (!a || !b || a.size !== b.size) {
    await fsp.unlink(dst).catch(() => {})
    throw new Error('复制后大小不一致，已放弃')
  }
  await fsp.unlink(src)
  return b.size
}

async function pruneEmptyDirs(startDir) {
  let dir = startDir
  while (dir && !samePath(dir, FAST_DIR) && String(dir).toLowerCase().startsWith(FAST_DIR.toLowerCase())) {
    let entries = null
    try {
      entries = await fsp.readdir(dir)
    } catch {
      return
    }
    if (entries.length) return
    try {
      await fsp.rmdir(dir)
    } catch {
      return
    }
    dir = path.dirname(dir)
  }
}

/* ---------------------------------------------------------------- 任务队列 */

const jobs = new Map()

function newJob(kind, total, names) {
  const job = {
    id: randomUUID(),
    kind,
    state: 'running',
    total,
    done: 0,
    failed: 0,
    current: '',
    log: [],
    errors: [],
    startedAt: Date.now(),
    endedAt: null,
    moved: [],
  }
  job.names = names
  jobs.set(job.id, job)
  // 顺手清理过期任务
  for (const [id, j] of jobs) {
    if (j.state !== 'running' && Date.now() - j.startedAt > JOB_TTL) jobs.delete(id)
  }
  return job
}

function logOf(job, msg, level = 'info') {
  job.log.push({ t: Date.now(), level, msg })
  if (job.log.length > 300) job.log.splice(0, job.log.length - 300)
}

/* ------------------------------------------------------------ 打开 / 还原 */

/** 同一时间只允许一个搬运任务，避免两边抢同一份清单 */
function busyJob() {
  for (const job of jobs.values()) if (job.state === 'running') return job
  return null
}

async function runApplyJob(job, names) {
  const manifest = await readManifest()
  const fastList = names.filter(Boolean)

  // LoRA 名字一般只有文件名，必须靠索引反查路径（要跟软链目录，慢盘上可能几秒）
  if (!indexCache) {
    const t0 = Date.now()
    logOf(job, '正在扫描 LoRA 目录…')
    const map = await getIndex()
    let total = 0
    for (const list of map.values()) total += list.length
    logOf(job, `扫描完成：${total} 个模型文件 · ${Date.now() - t0}ms`)
  }

  for (const rawName of fastList) {
    const name = String(rawName || '').trim()
    if (!name) continue
    job.current = name
    try {
      const hit = await resolveLora(name)
      if (!hit) {
        job.failed++
        job.errors.push(`${name}：在 ${loraRoots().join(' / ')} 里找不到这个 LoRA 文件`)
        logOf(job, `找不到 ${name}`, 'error')
        continue
      }
      const hitManifest = manifest.items.find((it) => samePath(it.src, hit.abs))
      if (hitManifest) {
        logOf(job, `${name} 已经在极速目录里，跳过`)
        job.done++
        continue
      }
      const st = await lstatOf(hit.abs)
      if (!st) {
        job.failed++
        job.errors.push(`${name}：文件读不到（${hit.abs}）`)
        continue
      }
      if (st.isSymbolicLink()) {
        job.failed++
        job.errors.push(`${name}：它本身就是一个软连接，先手动确认一下（${hit.abs}）`)
        logOf(job, `${name} 是软连接，跳过`, 'warn')
        continue
      }

      const dst = path.join(FAST_DIR, ...hit.rel.split('/'))
      if (await exists(dst)) {
        job.failed++
        job.errors.push(`${name}：极速目录里已经存在同名文件 ${dst}（先手动处理再试）`)
        logOf(job, `目标已存在 ${dst}`, 'error')
        continue
      }

      logOf(job, `搬运 ${name} → ${dst}（${mb(st.size)}）`)
      await moveFile(hit.abs, dst)

      try {
        await fsp.symlink(dst, hit.abs, 'file')
      } catch (err) {
        // 软连接建不出来就把文件搬回去，别留下「文件被搬走但原位置空着」的坑
        await moveFile(dst, hit.abs).catch(() => {})
        throw new Error(`创建软连接失败（${err.code || err.message}）。需要管理员权限或打开 Windows 开发者模式`)
      }

      manifest.items.push({
        name,
        rel: hit.rel,
        src: hit.abs,
        dst,
        size: st.size,
        root: hit.root,
        movedAt: new Date().toISOString(),
      })
      await writeManifest(manifest).catch(() => {})
      job.done++
      job.moved.push(name)
      logOf(job, `完成 ${name}`, 'ok')
      if (hit.ambiguous) logOf(job, `${name} 有多个同名文件，用的是 ${hit.rel}`, 'warn')
    } catch (err) {
      job.failed++
      job.errors.push(`${name}：${err?.message || String(err)}`)
      logOf(job, `失败 ${name} · ${err?.message || err}`, 'error')
    }
  }

  // 索引只在整批结束后失效一次：循环里失效会让每个名字都重扫一遍目录（慢盘上等于卡死）
  invalidateIndex()
  await writeManifest(manifest).catch(() => {})
  finishJob(job)
  return job
}

async function runRestoreJob(job, names) {
  const manifest = await readManifest()
  const wants = (names || []).map((n) => String(n || '').replace(/\\/g, '/').toLowerCase()).filter(Boolean)
  const targets = wants.length
    ? manifest.items.filter((it) => {
        const rel = String(it.rel || '').replace(/\.(safetensors|sft|pt|pth|ckpt|bin)$/i, '').toLowerCase()
        const base = stripExt(path.basename(String(it.src || ''))).toLowerCase()
        const nm = String(it.name || '').replace(/\\/g, '/').toLowerCase()
        return wants.includes(rel) || wants.includes(base) || wants.includes(nm)
      })
    : [...manifest.items]

  job.total = targets.length

  for (const it of targets) {
    const leaf = path.basename(String(it.src || ''))
    job.current = leaf
    try {
      const src = String(it.src || '')
      const dst = String(it.dst || path.join(FAST_DIR, ...String(it.rel || '').split('/')))
      if (!src) continue

      const cur = await lstatOf(src)
      if (cur?.isSymbolicLink()) {
        await fsp.unlink(src)
        logOf(job, `删掉软连接 ${src}`)
      } else if (cur) {
        if (await exists(dst)) {
          job.failed++
          job.errors.push(`${leaf}：原位置已是真实文件，极速目录里也还有一份，先手动确认`)
          logOf(job, `${leaf} 两侧都有文件，跳过`, 'warn')
          continue
        }
        logOf(job, `${leaf} 已经还原过了，跳过`)
        manifest.items = manifest.items.filter((x) => x !== it)
        job.done++
        continue
      }

      if (!(await exists(dst))) {
        job.failed++
        job.errors.push(`${leaf}：极速目录里找不到实体文件 ${dst}`)
        logOf(job, `${leaf} 实体文件不存在`, 'error')
        continue
      }

      await moveFile(dst, src)
      await pruneEmptyDirs(path.dirname(dst))
      manifest.items = manifest.items.filter((x) => x !== it)
      await writeManifest(manifest).catch(() => {})
      job.done++
      logOf(job, `已还原 ${leaf} → ${src}`, 'ok')
    } catch (err) {
      job.failed++
      job.errors.push(`${leaf}：${err?.message || String(err)}`)
      logOf(job, `还原失败 ${leaf} · ${err?.message || err}`, 'error')
    }
  }

  invalidateIndex()
  await writeManifest(manifest).catch(() => {})
  finishJob(job)
  return job
}

function finishJob(job) {
  job.state = job.failed ? 'partial' : 'done'
  job.current = ''
  job.endedAt = Date.now()
}

/* 后台起任务：立刻把 job 交给前端，前端再轮询 /job 拿进度 */
function startJob(kind, names, runner) {
  const job = newJob(kind, names.length, names)
  runner(job)
    .catch((err) => {
      job.failed++
      job.errors.push(err?.message || String(err))
      logOf(job, `任务异常 · ${err?.message || err}`, 'error')
      finishJob(job)
    })
    .finally(() => {
      if (job.state === 'running') finishJob(job)
    })
  return job
}

/* ------------------------------------------------------------------ HTTP */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1 << 20) raw = raw.slice(0, 1 << 20)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

async function statusPayload() {
  const manifest = await readManifest()
  const items = manifest.items || []
  return {
    ok: true,
    fastDir: FAST_DIR,
    roots: loraRoots(),
    manifestFile,
    scriptFile: ps1File,
    count: items.length,
    sizeTotal: items.reduce((n, it) => n + Number(it.size || 0), 0),
    keys: manifestKeys(items),
    items: items.map((it) => ({
      name: it.name || '',
      rel: it.rel || '',
      src: it.src || '',
      dst: it.dst || '',
      size: it.size || 0,
      movedAt: it.movedAt || '',
    })),
  }
}

/**
 * 处理 /api/fastlora/*；返回 true 表示这个请求已经被接管。
 * 注意：这里只服务本机文件搬运，不做任何鉴权（本来也只监听 127.0.0.1）。
 */
export async function loraApi(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (!url.pathname.startsWith('/api/fastlora')) return false

  const route = url.pathname.slice('/api/fastlora'.length).replace(/\/+$/, '') || '/'
  try {
    if (route === '/status' && req.method === 'GET') {
      sendJson(res, 200, await statusPayload())
      return true
    }

    if (route === '/apply' && req.method === 'POST') {
      const body = await readBody(req)
      const names = Array.isArray(body.names) ? body.names.map((x) => String(x)) : []
      if (!names.length) {
        sendJson(res, 400, { ok: false, error: '没有要搬运的 LoRA' })
        return true
      }
      const running = busyJob()
      if (running) {
        sendJson(res, 409, { ok: false, error: '上一个搬运任务还没跑完', job: running })
        return true
      }
      const job = startJob('apply', names, (j) => runApplyJob(j, names))
      sendJson(res, 200, { ok: true, job })
      return true
    }

    if (route === '/restore' && req.method === 'POST') {
      const body = await readBody(req)
      const names = Array.isArray(body.names) ? body.names.map((x) => String(x)) : []
      const running = busyJob()
      if (running) {
        sendJson(res, 409, { ok: false, error: '上一个搬运任务还没跑完', job: running })
        return true
      }
      const job = startJob('restore', names, (j) => runRestoreJob(j, names))
      sendJson(res, 200, { ok: true, job })
      return true
    }

    if (route === '/job' && req.method === 'GET') {
      const id = url.searchParams.get('id') || ''
      const job = jobs.get(id)
      if (!job) {
        sendJson(res, 404, { ok: false, error: '任务不存在或已过期' })
        return true
      }
      sendJson(res, 200, { ok: true, job })
      return true
    }

    // 前端用这个判断「本机服务在不在」
    if (route === '/' || route === '/ping') {
      sendJson(res, 200, { ok: true, fastDir: FAST_DIR, roots: loraRoots() })
      return true
    }

    sendJson(res, 404, { ok: false, error: `未知接口 ${route}` })
    return true
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err?.message || String(err) })
    return true
  }
}

/** 启动时把清单和脚本刷一遍，保证 ps1 永远是最新的 */
export async function ensureFastLoraFiles() {
  try {
    const manifest = await readManifest()
    await writeManifest(manifest)
  } catch (err) {
    console.warn('[fastlora] 初始化失败：', err?.message || err)
  }
}

export const fastLoraConfig = { FAST_DIR, MANIFEST_NAME, PS1_NAME }
