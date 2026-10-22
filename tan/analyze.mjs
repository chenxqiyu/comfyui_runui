/**
 * 分析 object_info.json：找出 4 套 XY 方案的节点签名 + 确认模型名
 *   node analyze.mjs [关键字...]
 */
import fs from 'node:fs/promises'

const raw = await fs.readFile(new URL('./object_info.json', import.meta.url), 'utf8')
const all = JSON.parse(raw)
const names = Object.keys(all)

function sig(cls) {
  const info = all[cls]
  if (!info) return null
  const req = info.input?.required || {}
  const opt = info.input?.optional || {}
  const fmt = (obj) =>
    Object.keys(obj).map((k) => {
      const d = obj[k]
      const t = Array.isArray(d[0]) ? 'enum' : String(d[0])
      const dv = d[1] && d[1].default !== undefined ? '=' + JSON.stringify(d[1].default).slice(0, 18) : ''
      return `${k}:${t}${dv}`
    })
  return {
    cls,
    category: info.category,
    out: (info.output || []).join('|'),
    outName: (info.output_name || []).join('|'),
    req: fmt(req).join(', '),
    opt: fmt(opt).join(', '),
  }
}

const arg = process.argv[2]
if (arg === 'list') {
  const kw = new RegExp(process.argv[3] || 'xy', 'i')
  console.log(names.filter((n) => kw.test(n)).join('\n'))
} else if (arg === 'ckpt') {
  const list = all.CheckpointLoaderSimple.input.required.ckpt_name[0]
  const kw = new RegExp(process.argv[3] || 'chillout', 'i')
  console.log(list.filter((n) => kw.test(n)).join('\n') || '（没找到）')
} else if (arg === 'sig') {
  for (const cls of process.argv.slice(3)) {
    const s = sig(cls)
    if (!s) {
      console.log('❌ 未找到:', cls)
      continue
    }
    console.log(`\n### ${s.cls}   [${s.category}]`)
    console.log('  out  :', s.out, '->', s.outName)
    console.log('  req  :', s.req)
    if (s.opt) console.log('  opt  :', s.opt)
  }
} else {
  console.log('用法：node analyze.mjs list <正则> | ckpt <正则> | sig <节点名>...')
}
