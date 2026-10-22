/**
 * 用 headless Chrome + CDP 验证 runui 的「⚡ 一次出多张」UI：
 *   启动 → 等页面加载工作流 → 给 cfg 加两个值 → 打开开关 → 读完 DOM 状态 → 截图
 *
 *   node ui-shot.mjs                # 截图到 ../../shot-xy.png
 *   node ui-shot.mjs --dump         # 只打印 cfg 行的 HTML
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'

const URL = process.env.PAGE || 'http://127.0.0.1:5199/'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9333
const PROF = 'F:\\ai\\onetest\\tan\\.cprof'
const SHOT = process.env.SHOT || 'F:\\ai\\onetest\\tan\\shot-xy.png'
const DUMP = process.argv.includes('--dump')

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
    // 等 devtools 端口起来
    let targets = null
    for (let i = 0; i < 40; i++) {
        await sleep(400)
        try {
            const r = await fetch(`http://127.0.0.1:${PORT}/json`)
            targets = await r.json()
            if (targets.some((t) => t.type === 'page')) break
        } catch {
            /* 还没起来 */
        }
    }
    const page = targets.find((t) => t.type === 'page')
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
        const r = await send('Runtime.evaluate', {
            expression: expr,
            returnByValue: true,
            awaitPromise: true,
        })
        if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
        return r.result?.result?.value
    }

    await send('Runtime.enable')
    // vite 冷启动第一次请求容易失败（页面会显示"未连接"），等一会儿 + 反复点「刷新工作流」兜底
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

    const rowInfo = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.prow')]
    const row = rows.find(r => (r.querySelector('.pkey')?.textContent || '').trim() === 'cfg')
    if (!row) return { ok: false, keys: rows.map(r => (r.querySelector('.pkey')?.textContent||'').trim()) }
    return { ok: true, html: row.innerHTML.slice(0, 1500), buttons: [...row.querySelectorAll('button')].map(b => b.outerHTML.slice(0, 120)) }
  })()`)

    if (DUMP || !rowInfo.ok) {
        console.log('cfg 行:', JSON.stringify(rowInfo, null, 1))
    }

    // 点 cfg 行里的 + 两次
    const clicked = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.prow')]
    const row = rows.find(r => (r.querySelector('.pkey')?.textContent || '').trim() === 'cfg')
    if (!row) return 'no-row'
    const plus = [...row.querySelectorAll('button')].find(b => (b.textContent || '').includes('+'))
    if (!plus) return 'no-plus'
    plus.click(); plus.click()
    return 'clicked-2'
  })()`)
    await sleep(500)

    // 打开 ⚡ 开关
    const sw = await evaluate(`(() => {
    const el = document.querySelector('.xy-switch input')
    if (!el) return 'no-switch'
    if (!el.checked) el.click()
    return el.checked ? 'on' : 'off'
  })()`)
    await sleep(700)

    const state = await evaluate(`(() => {
    const bar = document.querySelector('.xy-bar')
    const btn = document.querySelector('.compare-btn')
    const sw = document.querySelector('.xy-switch')
    return {
      switchClass: sw ? sw.className : null,
      switchChecked: sw ? !!sw.querySelector('input')?.checked : null,
      bar: bar ? bar.innerText.replace(/\\n/g, ' | ') : null,
      chips: [...document.querySelectorAll('.xy-bar .chip')].map(c => c.innerText.trim()),
      compareBtn: btn ? btn.innerText.trim() : null,
      warn: document.querySelector('.xy-warn')?.innerText || null,
      hint: bar && !bar.querySelector('.chip') ? bar.innerText.trim() : null,
    }
  })()`)

    console.log('点击 + :', clicked, ' · 开关:', sw)
    console.log('UI 状态:', JSON.stringify(state, null, 1))

    // --run：把 cfg 改成 7/3/1，点「⚡ 一次出 3 张」，等结果
    if (process.argv.includes('--run')) {
        const set = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.prow')]
      const row = rows.find(r => (r.querySelector('.pkey')?.textContent || '').trim() === 'cfg')
      if (!row) return 'no-row'
      const inputs = [...row.querySelectorAll('input[type=number]')]
      const want = ['7', '3', '1']
      const before = inputs.map(i => i.value)
      inputs.forEach((inp, i) => {
        if (want[i] === undefined) return
        inp.value = want[i]
        inp.dispatchEvent(new Event('input', { bubbles: true }))
      })
      return { before, n: inputs.length }
    })()`)
        console.log('设置 cfg 值:', JSON.stringify(set))
        await sleep(400)

        const bar2 = await evaluate(
            `document.querySelector('.xy-bar')?.innerText.replace(/\\n/g,' | ') || null`
        )
        console.log('改值后扫描轴条:', bar2)

        const fired = await evaluate(`(() => {
      const btn = document.querySelector('.compare-btn')
      if (!btn) return 'no-btn'
      if (btn.disabled) return 'disabled'
      btn.click()
      return btn.innerText.trim()
    })()`)
        console.log('点击按钮:', fired)

        const t0 = Date.now()
        let msg = ''
        for (; ;) {
            await sleep(800)
            msg = await evaluate(`document.querySelector('.msg')?.innerText || ''`)
            if (/一次请求完成|失败|停止|回退/.test(msg)) break
            if (Date.now() - t0 > 180000) {
                msg = '（超时）' + msg
                break
            }
        }
        const result = await evaluate(`(() => {
      const shots = [...document.querySelectorAll('.images .shot')]
      return {
        count: shots.length,
        captions: shots.map(s => (s.querySelector('figcaption')?.innerText || '').replace(/\\n/g, ' ')),
        msg: document.querySelector('.msg')?.innerText || '',
      }
    })()`)
        console.log('结果:', JSON.stringify(result, null, 1))
        console.log('耗时:', ((Date.now() - t0) / 1000).toFixed(1), 's')
    }

    const shot = await send('Page.captureScreenshot', { format: 'png' })
    if (shot.result?.data) {
        await fs.writeFile(SHOT, Buffer.from(shot.result.data, 'base64'))
        console.log('截图:', SHOT)
    }
} finally {
    try {
        ws?.close()
    } catch { }
    chrome.kill()
    await sleep(600)
    // 清理临时 profile
    const walk = async (dir) => {
        let entries = []
        try {
            entries = await fs.readdir(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const e of entries) {
            const p = dir + '\\' + e.name
            if (e.isDirectory()) await walk(p)
            else await fs.unlink(p).catch(() => { })
        }
    }
    await walk(PROF)
    await fs.rmdir(PROF).catch(() => { })
}
