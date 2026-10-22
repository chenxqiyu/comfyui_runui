/** 一次性 dump 探测需要的枚举取值（只打印前几个） */
import fs from 'node:fs/promises'

const all = JSON.parse(await fs.readFile(new URL('./object_info.json', import.meta.url), 'utf8'))

const want = {
  'ttN KSampler_v2': [
    'lora_name',
    'upscale_method',
    'upscale_model_name',
    'rescale',
    'crop',
    'image_output',
    'file_type',
    'sampler_name',
    'scheduler',
  ],
  'easy fullkSampler': ['image_output', 'sampler_name', 'scheduler'],
  'easy fullLoader': [
    'config_name',
    'lora_name',
    'resolution',
    'positive_token_normalization',
    'positive_weight_interpretation',
    'negative_token_normalization',
    'negative_weight_interpretation',
  ],
  'KSampler (Efficient)': ['sampler_name', 'scheduler', 'preview_method', 'vae_decode'],
  'ttN pipeLoader_v2': ['config_name', 'vae_name'],
}

for (const [cls, inputs] of Object.entries(want)) {
  const info = all[cls]
  console.log('\n### ' + cls)
  if (!info) {
    console.log('  未安装')
    continue
  }
  for (const k of inputs) {
    const def = (info.input?.required || {})[k] || (info.input?.optional || {})[k]
    if (!def) {
      console.log('  ' + k + ' : (无此输入)')
      continue
    }
    if (Array.isArray(def[0])) {
      const vals = def[0].filter((v) => !/^-+$/.test(String(v)))
      console.log('  ' + k + ' : enum(' + def[0].length + ') 例: ' + JSON.stringify(vals.slice(0, 5)))
    } else {
      console.log(
        '  ' + k + ' : ' + def[0] + ' default=' + JSON.stringify(def[1]?.default)
      )
    }
  }
}
