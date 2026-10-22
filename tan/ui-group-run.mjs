/**
 * 端到端：在「一组提示词」里填 3 组 → 读按钮文案 → 点发送 → 看实际出几张
 *   node ui-group-run.mjs
 */
import { spawn } from 'node:child_process'

const URL = process.env.PAGE || 'http://127.0.0.1:5199/'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9335
const PROF = 'F:\\ai\\onetest\\tan\\.cprof-r'
const SHOT = process.env.SHOT || 'F:\\ai\\onetest\\tan\\shot-run.png'
const SAMPLE = 'a cat, best quality; a dog, best quality; a red apple'
const XY = process.env.XY === '1'

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
    } catch {}
  }
  const page = targets?.find((t) => t.type === 'page')
  if (!page) throw new Error('没有 page target')

  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('ws fail'))
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
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
  for (let i = 0; i < 40; i++) {
    await sleep(700)
    const ready = await evaluate(`(() => {
      if (document.querySelector('.prompt-group')) return 'ready'
      const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('刷新工作流'))
      if (btn) { btn.click(); return 'retry' }
      return 'wait'
    })()`)
    if (ready === 'ready') break
  }

  // 填 3 组
  await evaluate(`(() => {
    const ta = document.querySelector('.prompt-group textarea')
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, ${JSON.stringify(SAMPLE)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return 1
  })()`)
  await sleep(600)

  // 可选：关掉「全部画完」
  if (process.env.WAITALL === '0') {
    const r = await evaluate(`(() => {
      const lb = [...document.querySelectorAll('.send-row label.check')].find(l => l.textContent.includes('全部画完'))
      if (!lb) return 'no checkbox'
      const cb = lb.querySelector('input')
      const before = cb.checked
      if (before) cb.click()
      return { before, after: cb.checked }
    })()`)
    console.log('全部画完开关:', JSON.stringify(r))
    await sleep(400)
  }

  // 可选：打开 ⚡ 一次出多张
  if (XY) {
    await evaluate(`(() => {
      const sw = document.querySelector('.xy-switch input') || document.querySelector('.xy-switch')
      if (sw) { sw.click(); return 'clicked' }
      return 'no switch'
    })()`)
    await sleep(500)
    console.log('XY 开关:', await evaluate(`(() => {
      const s = document.querySelector('.xy-switch')
      return { html: s ? s.className : null, bar: document.querySelector('.xy-bar')?.textContent.replace(/\\s+/g,' ').trim() || null }
    })()`))
  }

  const info = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')].map(b => b.textContent.replace(/\\s+/g,' ').trim())
    const sendBtn = [...document.querySelectorAll('button')].find(b => /^(发送|对比|⚡)/.test(b.textContent.trim()))
    return {
      count: document.querySelector('.pg-count')?.textContent.trim(),
      sendLabel: sendBtn ? sendBtn.textContent.replace(/\\s+/g,' ').trim() : null,
      matching: btns.filter(t => /对比|发送|⚡/.test(t)),
    }
  })()`)
  console.log('发送前:', JSON.stringify(info, null, 1))

  // 点发送
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^(发送到 ComfyUI|发送第一组|对比 |⚡)/.test(x.textContent.trim()))
    if (b) b.click()
    return 1
  })()`)

  // 等结果
  let msg = ''
  const t0 = Date.now()
  const timeline = []
  let last = -1
  for (;;) {
    await sleep(400)
    const snap = await evaluate(`({
      imgs: document.querySelectorAll('.images .shot img').length,
      msg: document.querySelector('.msg')?.innerText || '',
    })`)
    msg = snap.msg
    if (snap.imgs !== last) {
      timeline.push(`${((Date.now() - t0) / 1000).toFixed(1)}s -> ${snap.imgs} 张`)
      last = snap.imgs
    }
    if (snap.imgs >= 3 && /完成/.test(msg)) break
    if (/失败|停止|回退/.test(msg)) break
    if (Date.now() - t0 > 150000) {
      msg = '（超时）' + msg
      break
    }
  }
  console.log('出图时间线:', timeline.join(' | '))
  console.log('结果:', JSON.stringify(await evaluate(`({
    imgs: document.querySelectorAll('.images .shot img').length,
    caps: [...document.querySelectorAll('.images figcaption')].map(x => x.textContent.replace(/\\s+/g,' ').trim()).slice(0, 6),
    msg: document.querySelector('.msg')?.innerText || '',
  })`), null, 1))

  await sleep(1500)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await import('node:fs/promises').then((fs) => fs.writeFile(SHOT, Buffer.from(shot.result.data, 'base64')))
  console.log('截图:', SHOT)
} catch (err) {
  console.error('ERR', err.message)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch {}
  chrome.kill()
}
