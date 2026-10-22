# tan · ComfyUI「一次请求连续出多张」探测

问题：ComfyUI 能不能**一次 `/prompt` 请求**就把 `cfg = 1 / 3 / 7` 连着画完，
而不是像 runui 现在那样串行发 3 次请求。

## 结论

| 方案 | 一次请求出多张 | 实测（chilloutmix fp32, 512², steps=6, cfg 1/3/7） |
|---|---|---|
| **Efficiency Nodes** · `XY Input: CFG Scale` → `XY Plot` → `KSampler (Efficient).script` | ✅ | 3 张 512×512 · **2.2s** · 只能 first→last 线性插值 |
| **Efficiency Nodes** · `XY Input: Manual XY Entry`（`plot_value` 分号分隔） | ✅ | 3 张 512×512 · **4.6s** · 任意值 |
| **Easy-Use** · `easy XYPlot`（`x_axis="preSampling: cfg"`, `x_values` 分号+空格分隔） | ✅ | 3 张 512×512 · **7.0s** |
| **tinyterra (ttN)** · `ttN advanced xyPlot` → `ttN KSampler_v2.adv_xyPlot` | ✅ | 3 张 512×512 + **1 张拼图** 1536×608 · **40.6s** · 最慢 |
| **ComfyRoll** · `CR XY List` | ❌ | 只产参数文本，没有自循环，得外部把 `index` 递增重复提交 |

原生 `/prompt` **不支持**一次提交多组：body 传数组直接 `400 no_prompt`；
`EmptyLatentImage.batch_size` 只是同参数出多张，不是参数扫描。

## 脚本

```bash
# 主探测：4 套各构造一个工作流，各发 1 次 /prompt，数落盘的图
node probe-xy.mjs                 # 跑全部，跑完自动删掉生成的图和 history
node probe-xy.mjs --keep          # 保留生成的图（output/tan_*.png）
node probe-xy.mjs --only easy     # 只跑某个：efficiency-linear|efficiency-manual|easyuse|ttn
COMFY=http://127.0.0.1:8188 node probe-xy.mjs
CKPT="sd15\\其他模型.safetensors" CFG_LIST="2; 5; 9" STEPS=20 node probe-xy.mjs
```

环境变量：`COMFY`（默认 `http://127.0.0.1:8189`）、`COMFY_OUTPUT`（默认 `F:\ai\fastai\output`）、
`CKPT`、`CFG_LIST`（默认 `1; 3; 7`）、`STEPS`（默认 6）、`SEED`、`TIMEOUT_MS`。

结果写入 `report.json`。

辅助脚本：

```bash
node dump-object-info.mjs                 # 把 /object_info 存成 object_info.json（209MB，能删，删了重跑即可）
node analyze.mjs list xy                  # 按正则找节点名
node analyze.mjs ckpt chillout            # 找模型名
node analyze.mjs sig "XY Plot" ...        # 打节点输入/输出签名
node enum.mjs "easy XYPlot" x_axis        # 打某个输入的枚举取值
node enums.mjs                            # 一次性 dump 探测要用到的枚举
```

## 四套的接线要点

### Efficiency
```
XY Input: CFG Scale {batch_count, first_cfg, last_cfg}   → XY
  → XY Plot {ksampler_output_image:'Images', cache_models:'True', X:['5',0]}  → SCRIPT
  → KSampler (Efficient) {..., script:['6',0], vae_decode:'true', optional_vae:['1',2]}
  → SaveImage {images:[KSampler, 5]}      # 第 6 个输出是 IMAGE
```
`script` 在 **optional** 里（只看 required 会以为不支持）。
任意值改用 `XY Input: Manual XY Entry {plot_type:'CFG Scale', plot_value:'1;3;7'}`。

### Easy-Use
```
easy fullLoader {ckpt_name, vae_name:'Baked VAE', resolution:'512 x 512', positive, negative, ...} → pipe
  → easy XYPlot {x_axis:'preSampling: cfg', x_values:'1; 3; 7', output_individuals:'True', pipe} → pipe
  → easy fullkSampler {pipe, steps, cfg, sampler_name:'euler', scheduler:'simple', denoise, image_output:'Hide', seed}
  → easy imageSave {images:[sampler,1]}
```
`x_values` 切分是 `split("; ")` —— **分号后面必须带空格**，否则 `"1;3;7"` 会被当成一个值。

### ttN
```
ttN advanced xyPlot {save_individuals:true, x_plot:"<1:v_label>[5:cfg='1']\n<2:v_label>[5:cfg='3']\n..."} → ADV_XYPLOT
  → ttN KSampler_v2 {..., adv_xyPlot:['6',0], image_output:'Save', save_prefix:'tan_ttn'}
```
- plot 文本语法：**每个点一行**，`<轴号:label>[节点id:输入='值']`。轴号只是编号，
  同一个轴号写多行会互相覆盖 —— 多值必须写成多段（踩过，只出 1 组）。
- `ttN KSampler_v2` 自己也存图，不经过 SaveImage，所以要数磁盘文件而不是看 history.outputs。
- 会额外拼一张网格图（`save_individuals:true` 时单图 + 网格都有）。

### ComfyRoll
`CR XY List` 只输出 X/Y 参数文本（按 `index` 取第 N 组），要出多张得外部循环改 `index`，不是一回事。

## 三个坑

1. **提交必须带 `extra_data.extra_pnginfo`**：ttN 的 xy executor 会拿它跑子 prompt，
   不带的话 ComfyUI 注入的 `extra_pnginfo` 是 `None`，ttN 里 `.get` 直接抛
   `'NoneType' object has no attribute 'get'`（前端提交总带，所以手写 API 才踩到）。
2. **ComfyUI 会按输入 hash 复用缓存**：seed 不变、参数不变时第二次提交直接命中缓存，
   1 秒「完成」但一张图都不画。探测脚本每次用不同 seed。
3. 枚举大小写敏感：`vae_decode` 要 `'true'`、`preview_method` 要 `'none'`，写成 `'True'/'None'` 会 400。

## 速度上值得注意的

`ttN` 是**每张都重新执行一遍子 prompt**（不走 ComfyUI 的执行缓存），3 张要 40 秒；
Efficiency / Easy-Use 是引擎内循环 + 模型复用，3 张 2~7 秒。要接进 runui 的话优先 Efficiency。
