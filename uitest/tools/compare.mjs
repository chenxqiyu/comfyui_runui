/**
 * 一致性校验：JS 复刻版分词器 vs Python(transformers + ftfy + ComfyUI) 的基准结果。
 *
 *   node tools/compare.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ClipTokenizer } from '../src/lib/clipTokenizer.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA = path.join(ROOT, 'public', 'data')

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'))

const tokenizer = new ClipTokenizer({
  vocab: readJson('vocab.json'),
  mergesText: fs.readFileSync(path.join(DATA, 'merges.txt'), 'utf8'),
  entities: readJson('html_entities.json'),
  ligatures: readJson('ligatures.json'),
  widthMap: readJson('width_map.json'),
  c1Map: readJson('c1_map.json'),
})

const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'expected.json'), 'utf8'))

let pass = 0
let fail = 0
let weightFail = 0
const failures = []

for (const item of expected) {
  const encoded = tokenizer.encodeWithWeights(item.text)
  const got = encoded.map((t) => t.id)
  const want = item.ids
  const same = got.length === want.length && got.every((v, i) => v === want[i])
  if (same) {
    pass++
  } else {
    fail++
    failures.push({ text: item.text, want, got })
  }

  // 权重解析（token_weights）也要一致
  if (same && item.weights && item.weights.length === encoded.length) {
    const wOk = encoded.every((t, i) => Math.abs(t.weight - item.weights[i]) < 1e-6)
    if (!wOk) {
      weightFail++
      console.log('WEIGHT MISMATCH:', JSON.stringify(item.text))
      console.log('   python:', item.weights.join(', '))
      console.log('   js    :', encoded.map((t) => t.weight).join(', '))
    }
  }
}

for (const f of failures.slice(0, 12)) {
  console.log('MISMATCH:', JSON.stringify(f.text))
  console.log('   python:', f.want.join(', '))
  console.log('   js    :', f.got.join(', '))
}

console.log(`\n结果: pass ${pass} / fail ${fail} / weight-fail ${weightFail} / total ${expected.length}`)
console.log(`词表大小: ${tokenizer.vocabSize}, BPE merges: ${tokenizer.bpeRanks.size}`)
process.exit(fail === 0 && weightFail === 0 ? 0 : 1)
