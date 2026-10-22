/**
 * 打印某个节点某个输入的枚举取值（取 action=enum）
 *   node analyze.mjs enum "easy XYPlot" x_axis
 *   node analyze.mjs enum "XY Input: Manual XY Entry" plot_type
 */
import fs from 'node:fs/promises'

const raw = await fs.readFile(new URL('./object_info.json', import.meta.url), 'utf8')
const all = JSON.parse(raw)

const [, , cls, input] = process.argv
const info = all[cls]
if (!info) {
  console.log('❌ 未找到节点:', cls)
  process.exit(1)
}
const def = (info.input?.required || {})[input] || (info.input?.optional || {})[input]
if (!def) {
  console.log('❌ 未找到输入:', input)
  process.exit(1)
}
if (Array.isArray(def[0])) {
  console.log(`${cls}.${input} 共 ${def[0].length} 个取值：`)
  for (const v of def[0]) console.log('  - ' + JSON.stringify(v))
} else {
  console.log(`${cls}.${input} 不是枚举，类型 ${def[0]}，默认 ${JSON.stringify(def[1]?.default)}`)
}
