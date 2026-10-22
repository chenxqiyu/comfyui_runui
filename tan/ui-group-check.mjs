/**
 * 验证「一组提示词」自动拆组：
 *   打开面板 → 粘入带 ; 和换行的多组文本 → 读「识别到 N 组」/ 标签数 / 主框是否停用 → 截图
 *   node ui-group-check.mjs
 */
import { spawn } from 'node:child_process'

const URL = process.env.PAGE || 'http://127.0.0.1:5199/'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9334
const PROF = 'F:\\ai\\onetest\\tan\\.cprof-g'
const SHOT = process.env.SHOT || 'F:\\ai\\onetest\\tan\\shot-group.png'
const SAMPLE = process.env.SAMPLE || 'a cat, best quality; a dog, best quality;\na red apple;\n'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROF}`,
    '--window-size=1440,900',
    URL,
  ],
  { stdio: 'ignore' }
)

let ws = null
try {
  let targets = null
  for (let i = 0; i < 40; i++) {
    await sleep(400)
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`)
      targets = await r.json()
      if (targets.some((t) => t.type === 'page')) break
    } catch {
      /* 等 */
    }
  }
  const page = targets?.find((t) => t.type === 'page')
  if (!page) throw new Error('没有找到 page target')

  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('ws 连接失败'))
  })

  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id
      pending.set(mid, res)
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return r.result?.result?.value
  }

  await send('Runtime.enable')

  // 等页面读到工作流
  for (let i = 0; i < 40; i++) {
    await sleep(700)
    const ready = await evaluate(`(() => {
      if (document.querySelector('.prow')) return 'ready'
      const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('刷新工作流'))
      if (btn) { btn.click(); return 'retry' }
      return 'wait'
    })()`)
    if (ready === 'ready') break
  }

  const before = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('一组提示词'))
    return { hasBtn: !!btn, text: btn ? btn.textContent.trim() : null, groupOpen: !!document.querySelector('.prompt-group') }
  })()`)
  console.log('初始:', JSON.stringify(before))

  // 不再需要开关：组框应常驻
  const resident = await evaluate(`(() => ({
    hasButton: !![...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('一组提示词')),
    groupVisible: !!document.querySelector('.prompt-group'),
    off: document.querySelector('.prompt-group')?.classList.contains('off'),
    head: document.querySelector('.pg-head')?.textContent.replace(/\s+/g, ' ').trim(),
  }))()`)
  console.log('常驻检查:', JSON.stringify(resident))

  // 粘入样例文本（Vue v-model 要派发 input 事件）
  await evaluate(`(() => {
    const ta = document.querySelector('.prompt-group textarea')
    if (!ta) return 'no textarea'
    ta.focus()
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, ${JSON.stringify(SAMPLE)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await sleep(500)

  const after = await evaluate(`(() => {
    const main = document.querySelector('.card-body > textarea')
    return {
      count: document.querySelector('.pg-count')?.textContent.trim() || null,
      tags: [...document.querySelectorAll('.pg-tag')].map(t => t.textContent.trim()),
      mainHidden: !main,
      pgTitle: document.querySelector('.pg-title')?.textContent.trim() || null,
      extraBtnHidden: !([...document.querySelectorAll('button')].find(x => (x.textContent||'').includes('加一个提示词'))),
      extraBtnDisabled: (() => {
        const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').includes('加一个提示词'))
        return b ? b.disabled : null
      })(),
      tip: document.querySelector('.pg-tip')?.textContent.trim() || null,
      strayBoolCheck: !!document.querySelector('.field-check'),
      footHint: [...document.querySelectorAll('.prompt-more-foot .hint')].map(x => x.textContent.trim()),
    }
  })()`)
  console.log('粘入后:', JSON.stringify(after, null, 1))

  // 再来一次只有换行、没有分号的输入
  await evaluate(`(() => {
    const ta = document.querySelector('.prompt-group textarea')
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, 'one\\ntwo\\nthree\\n')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return 1
  })()`)
  await sleep(400)
  const newlineOnly = await evaluate(`document.querySelector('.pg-count')?.textContent.trim()`)
  console.log('纯换行输入:', newlineOnly)

  // 单组时应回到普通单次
  await evaluate(`(() => {
    const ta = document.querySelector('.prompt-group textarea')
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, 'only one prompt')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return 1
  })()`)
  await sleep(400)
  const single = await evaluate(`(() => ({
    count: document.querySelector('.pg-count')?.textContent.trim(),
    hint: [...document.querySelectorAll('.prompt-more-foot .hint')].map(x => x.textContent.trim()),
    mainHidden: !document.querySelector('.card-body > textarea'),
  }))()`)
  console.log('单组:', JSON.stringify(single))

  // 恢复成 3 组再截图
  await evaluate(`(() => {
    const ta = document.querySelector('.prompt-group textarea')
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, ${JSON.stringify(SAMPLE)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    const sw = document.querySelector('.xy-switch input')
    return 1
  })()`)
  // 刷新后组内容应该还在（localStorage 持久化）
  await evaluate('location.reload(); 1')
  for (let i = 0; i < 40; i++) {
    await sleep(700)
    const ready = await evaluate(`document.querySelector('.prompt-group') ? 'y' : 'n'`)
    if (ready === 'y') break
  }
  const afterReload = await evaluate(`(() => ({
    value: document.querySelector('.prompt-group textarea')?.value || '',
    count: document.querySelector('.pg-count')?.textContent.trim() || null,
    off: document.querySelector('.prompt-group')?.classList.contains('off'),
  }))()`)
  console.log('刷新后:', JSON.stringify(afterReload))

  if (process.env.THEME) {
    const th = await evaluate(`(() => {
      document.documentElement.dataset.theme = ${JSON.stringify(process.env.THEME)}
      return {
        theme: document.documentElement.dataset.theme,
        bg: getComputedStyle(document.body).backgroundColor,
        card: getComputedStyle(document.querySelector('.prompt-group') || document.body).backgroundColor,
      }
    })()`)
    console.log('主题:', JSON.stringify(th))
  }
  await sleep(1200)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await import('node:fs/promises').then((fs) => fs.writeFile(SHOT, Buffer.from(shot.result.data, 'base64')))
  console.log('截图:', SHOT)
} catch (err) {
  console.error('ERR', err.message)
  process.exitCode = 1
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  chrome.kill()
}
