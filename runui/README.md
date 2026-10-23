# runui

针对 **ComfyUI 当前工作流** 的一个小前端：绑定一个输入节点改提示词，提交，再从绑定的输出节点把图收回来。

不用在 ComfyUI 里拖节点，适合「同一个工作流、反复换提示词出图」的场景。

## 启动

```bash
# 开发（热更新，端口 5187）
npm install
npm run dev

# 打包 + 用自带静态服务器跑（带 /comfy 反向代理）
npm run build
npm run serve
```

打开 http://127.0.0.1:5187

ComfyUI 默认地址是 `http://127.0.0.1:8189`，要改就设环境变量：

```bash
set COMFY=http://127.0.0.1:8188 && npm run serve
```

## 用法

1. **① 当前工作流** — 打开就自动读 ComfyUI 里正在跑 / 最近一次跑过的那个工作流（拿的是提交时那份 API 格式节点图，改完能直接回灌）。顶部下拉可以切到别的历史作业。
2. **② 绑定输入** — 点节点列表右侧的「入」，或直接填节点 ID。字段会自动选 `text`；不是文本节点的字段会被过滤掉（`sampler_name`、`ckpt_name` 这类不算）。输入新提示词。
3. **③ 采样参数 · KSampler** — 自动认出工作流里的 KSampler（也支持 `SamplerCustom`），把 `steps / cfg / sampler_name / scheduler / denoise / seed / noise_seed / start_at_step ...` 这些可编辑参数列出来直接改。**每个参数都能填多个值**：数字框右侧 `+` 再加一个，枚举用下拉追加、已选项变成可删除的 chip。界面实时算出笛卡尔积并显示「组合 N 组」。
4. **④ 对比结果** — 填输出节点 ID（`SaveImage` / `PreviewImage` 之类）。
5. **有多个组合时，主按钮就是「对比 N 组」**，按组合顺序执行（默认串行），结果横排成网格，每格标注这一组在变的维度（`sampler euler`、`sched beta`）和耗时；想先看一眼效果就点旁边的 **只发第 1 组**。点任意一张进大图预览：底部显示该组的参数、文件名、耗时和序号，**← →** 翻页、**Esc** 或点图片关闭，两侧也各有一块可点击的翻页区。过程中可以「停止」。

右上角 **⬇ 打包 N 张** 会把当前这些图打成一个 zip 下载，文件名按参数命名（、），非法字符会替换成下划线，zip 本身带时间戳。

**批量对比的 seed 策略**：同一批里所有组共用**一个** seed —— 如果每组都换随机种子，图之间的差异就混进了种子噪声，比不出 cfg / sampler 的真实区别。

但「一批」不等于「永远」：勾了「随机 seed」时，**每点一次发送会重新抽一颗**，整批共用这一颗。所以同样的参数连点两次，出来的是新种子下的新图，不会一模一样复制一遍。

单次提交时勾选「随机 seed」同样是换一个随机种子（会覆盖 ③ 里手动填的 seed）。

## 参数收藏

③ 右上角 **★ 收藏** 能把当前一整套参数（含多值）存下来：

- **点名字** → 立刻替换成这套参数
- **点左边的 ★** → 变成橙色 = 默认收藏，下次载入工作流时自动套用
- **点 ×** → 弹出确认框「确定删除收藏「xxx」吗？」，点红色「删除」才真正删除；点「取消」、按 Esc 或点遮罩都能放弃
- **恢复原始** → 一键回到这个工作流刚载入时的参数

收藏存在 （key ），纯本地，不落服务端。应用收藏时是**以工作流原始参数为底再叠加**，所以收藏里缺哪个字段，那个字段就保持原值、控件不会消失。

## LoRA 堆叠器 · 极速模式

右下角「LoRA 堆叠」浮层除了改权重/勾选，还有一个 **极速模式** 开关（⚡）。背景是本机 `models/loras` 被软链到了慢盘：

```
F:\ai\fastai\models        -> I:\aidraw\ComfyUI-Nunchaku-ver\ComfyUI\models
F:\ai\fastai\models\loras  -> I:\loras          ← LoRA 实体都在 I: 慢盘
```

打开开关会把**当前堆叠里已勾选**的 LoRA 实体文件搬到快盘 `F:\ai\fastlora`，再在原位置留一个软连接：

```
I:\loras\xxx\yyy.safetensors            软连接 -> F:\ai\fastlora\xxx\yyy.safetensors
F:\ai\fastlora\xxx\yyy.safetensors      实体文件（保留子目录结构，避开同名冲突）
F:\ai\fastlora\_fastlora-manifest.json  还原信息：原路径 / 现路径 / 大小 / 时间
F:\ai\fastlora\还原-fastlora.ps1        离线一键还原脚本
```

ComfyUI 请求的路径没变（还是 `I:\loras\...`），真正读的却是快盘，所以首次加载明显快一截；已经在显存里的 LoRA 本来就不受影响。

- 搬运是**后台任务**，浮层顶部有进度条和当前文件名，跑完自动刷新。
- 列表每条 LoRA 前面有个 ⚡：**已在快盘的点亮成黄色**，没搬的还是灰的；`极速` 筛选只列已在快盘的；右下角按钮上也会挂一个 ⚡N。
- 开关已经开着时再点，会给出「搬新的（把新勾选但还没加速的追加进去）」/「全部还原」/「取消」。
- 关闭开关 = 把快盘里的东西全部搬回原路径（先删软连接，再移回实体文件），顺手清掉空目录。

### 离线还原

`F:\ai\fastlora\还原-fastlora.ps1` 不依赖 runui，双击即可（或 `powershell -ExecutionPolicy Bypass -File .\还原-fastlora.ps1`）：

- 幂等：已经还原过的条目会跳过，重复跑没有副作用；
- `-DryRun` 只列出会做什么；`-NoPause` 跑完不等按键（给计划任务用）；
- 全部成功时把清单归档成 `_fastlora-manifest.restored-<时间>.json`；有失败就保留清单，修好再跑一次。

### 配置 / 依赖

- 环境变量：`FASTLORA_DIR`（默认 `F:\ai\fastlora`）、`LORA_ROOTS`（默认 `I:\loras`，多个用 `;` 分隔，会先 realpath 归一）。
- **必须用 `npm run dev` 或 `npm run serve` 起界面**：搬文件是本机服务做的（`/api/fastlora/*`，dev 下由 vite 中间件提供，生产由 `tools/serve.mjs` 提供）。直接打开 `dist/index.html` 或换别的静态服务器，极速模式会显示「本机服务不可用」。
- 建**软连接**在 Windows 上需要权限：管理员运行，或系统设置里打开「开发者模式」。没权限时任务会报错并把文件搬回原位，不会留下半截状态。
- 改完 `vite.config.js` 要重启一次 `npm run dev`，新增的中间件才生效。
- **改完 `tools/lora-speed.mjs` 也要重启 dev**：它是服务端代码，vite 的 HMR 只热更前端，不会重载它。
- LoRA 名字一般只是文件名，所以第一次搬之前要扫一遍 `LORA_ROOTS` 建索引（跟软链目录走，慢盘上约 5 秒，浮层里会显示「正在扫描 LoRA 目录…」）。索引缓存 5 分钟。

## LoRA 权重对比

浮层里每条**已勾选**的 LoRA 右侧有个 **⇄** 按钮：点开后给它填多个权重，生成时每个权重各出一张。默认围绕当前值给 `-0.2 / 当前 / +0.2` 三档，也可以点「快速加 0.4 / 0.6 / 0.8 / 1.0」，或直接改 chip 里的数字、用 `＋` 再加一档。

- 只影响**本次提交**：写入的是提交副本里 LoraManager 的 `strength` / `clipStrength`，堆叠里的原值不变；「收起」或删到只剩一个值就退出对比。
- 可以和提示词组、cfg / steps / denoise 等维度叠加：组合数是各维度相乘，结果图标签直接写 `LoRA短名 0.60`。
- 同一批仍共用一个 seed，权重差异不会被种子噪声盖掉。
- **只能逐组提交**：Efficiency 的 XY 轴改不了 `CR Apply LoRA Stack` 这类堆叠节点，所以有权重对比时 ⚡ 一次请求暂不生效（界面会提示）；「全部画完」仍然会全部跑完再统一收图。
- 停用某条 LoRA 会自动清掉它的权重对比；面板底部的「清除对比」清空所有项。

## 极速对比：一次请求出 N 张（Efficiency XY）

默认的「对比 N 组」是**串行**：一组一提交，跑完再跑下一组。装了 Efficiency Nodes 之后，
可以改成**一次请求连画 N 张** —— 引擎内部循环参数，模型只加载一次。

③ 采样参数卡片头右侧有个 **⚡ 一次出多张** 开关：

- 打开后卡片顶部出现「扫描轴」，列出当前填了多值的参数（**cfg / steps / denoise / sampler_name / scheduler**）。
  点一下切换扫哪个；如果同时有好几个参数填了多值，其它几个在 XY 模式下只取第一个值（会有黄色提示）。
- 发送区的按钮从 `对比 N 组` 变成 **`⚡ 一次出 N 张`**，点它只发**一次** `/prompt`。
- 结果区和串行一样横排，每张标着对应的取值。

> **提示词多值**：Loader 支持时会变成 X 轴（Prompt S/R），和数值轴拼成 2D 网格一次出；
> 分离加载（`UNETLoader` 等）扫不了提示词。ComfyUI 要等整轮跑完才把图一次性交出来
> （WebSocket 的 `executed` 最后只推一次，带一整批图），所以提示词组的结果是整批一起到，
> 不会「画完一张显示一张」——想边画边看就关掉 ⚡ 和「全部画完」走串行。

### 怎么适配「任意工作流」

不用手工加节点 —— 提交前在副本上自动改造（`src/xy.js`）：

1. 目标采样节点 `KSampler` / `KSamplerAdvanced` **原地换成** `KSampler (Efficient)`
   （保留同名输入；丢掉 `add_noise` / `start_at_step` 这些 Efficient 没有的）；
2. 把下游 `VAEDecode` 的 `vae` 连接复制一份到 `optional_vae`
   —— **不传的话 Efficiency 在 XY 模式下会 fallback 成单张**，而且拼图那步算出的字号是 0，
   直接报 `font size must be greater than 0`；
3. `KSampler` 的 LATENT 在 slot 0，Efficient 在 slot 3 —— 把所有引用 `[id,0]` 的地方改写成 `[id,3]`，
   下游 `VAEDecode` 一行都不用改；
4. 注入 `XY Input: Manual XY Entry` + `XY Plot`，接到 `script`。

`vae_decode` 必须设 `'true'`（设 `false` 时 XY 分支产不出图，同样崩在拼图那步）。

### 输入字段（提示词）多值 · 2D 一次出

② 栏「新提示词」下面有两种加提示词的入口：

- `＋ 加一个提示词（对比用）` —— 一次加一个独立文本框（带 × 删除）；
- **一组提示词**（常驻输入框）—— 一个框里粘一整串，**自动拆组**：`;` 和换行都算分隔，
  组内逗号照常，末尾多一个分号不影响。实时显示 `识别到 3 组` 和每组的预览标签。

这个框不需要开关：**只要不为空就自动生效**（边框从虚线变实线，标题显示「已生效」），
第 1 组就是主提示词，主输入框和额外框会自动收起；清空后回到单框输入。
组内容按字段各存一份，切走再切回来还在。

发送区「随机 seed」旁边有 **全部画完**（默认关）控制出图时机：

- **开**：**优先合并成一次 XY 请求**（cfg / steps / denoise / sampler_name / scheduler 当数值轴，提示词组当 X 轴拼成 2D，
  即使 ⚡ 没开也会合并），生成期间不取图，**全部跑完再统一收图显示**；
- 提示词扫不了时（`UNETLoader` 等分离加载）：**每组提示词各发一次请求**，组内数值轴仍然合并扫描，
  同样等全部跑完再统一出图；只有连数值轴都合不了才逐组发送；
- **关**（默认）：按当前方式即时出图 —— ⚡ 模式合并成一次请求，串行模式画完一张显示一张
  （实测 3 组：2.0s / 4.0s / 6.1s 各出一张）。

多个提示词和多个数值参数会摆成 **2D 网格，一次请求出完**：

```
X 轴 = 提示词（Prompt S/R）   3 个
Y 轴 = cfg（也可以是 steps / denoise / sampler_name / scheduler）  3 档
→ 9 张 / 1 次请求
```

按钮直接写 `⚡ 一次出 9 张`，扫描轴栏显示 `提示词 ×3 × cfg·3`。结果标签是 `提示词#2 cfg5`。

**为什么要把 Loader 换掉**：提示词走的是 Efficiency 的 `XY Input: Prompt S/R`，而 XY Plot 一旦
用到这类轴，就强制要求 `dependencies`（类型 `DEPENDENCIES`），这个输出**只有 Efficiency 自己的
Loader 才有**。所以扫提示词时会顺手把 `CheckpointLoaderSimple` 换成 `Efficient Loader`：

- 输出槽位跟着变：CLIP `1 → 5`、VAE `2 → 4`，MODEL 仍在 0，所有引用自动改写；
- 第一个提示词直接写进文本节点，其余交给 `Prompt S/R`（它第一项是「不替换」，正好等于第一个提示词，
  所以 N 个提示词就是 N 张，不会多出来一张原图）。

**边界**：模型是 `UNETLoader` 之类**分离加载**的工作流没有 `DEPENDENCIES`，提示词不能当 X 轴：
开着「全部画完」时改为**每组提示词各发一次请求、组内数值轴合并**，仍然最后统一收图；
关着时退回逐组串行（UI 会写明原因）。采样节点不是 `KSampler` / `KSamplerAdvanced` 时同理。

顺带记两个走不通的路，别再试：

- 不换 Loader 直接用 `Prompt S/R`：XY Plot 静默返回 `None`，一张都不扫（不报错，最难查）；
- 核心 `ConditioningCombine` 串多个 prompt：那是「条件混合」不是 batch，还是只出 1 张。

### 兼容边界

| 采样节点 | 能不能用 |
|---|---|
| `KSampler` / `KSamplerAdvanced` | ✅ 自动改造 |
| `KSampler (Efficient)` | ✅ 直接用（只补 XY 节点） |
| `SamplerCustom` / `KSampler //Inspire` / pipe 类 | ❌ 开关禁用并提示原因（它们没有 `script` 插槽） |

改造只发生在提交副本上，不动工作流本身；失败了会自动**回退串行**并在提示里说明。

### 实测

chilloutmix fp32 · 512² · steps 6 · cfg 7/3/1：一次请求 **6.5 秒出 3 张**；
串行同样 3 组要 3 次排队，且每次都等上一次完全跑完。

## 提交时为什么要包 `__value__`

ComfyUI 里**数组默认代表节点连接**（`[node_id, slot_index]`），所以「值本身是 list 的 widget」提交时必须包一层：

```json
{"__value__": [{...}, {...}]}
```

依据在 `execution.py`：

```python
# Unwraps values wrapped in __value__ key or typed wrapper.
# This is used to pass list widget values to execution,
# as by default list value is reserved to represent the
# connection between nodes.
if isinstance(val, dict) and "__value__" in val:
    val = val["__value__"]
    inputs[x] = val
```

典型场景是 `Lora Stacker (LoraManager)` 的 `loras`（几十个 LoRA 对象的数组）。

**坑**：`/history` 里保存的是**解包之后**的裸数组（因为服务端执行前把 `inputs[x]` 换成了裸值）。如果直接把 history 里的节点图重新提交，就会退化成非法连接，ComfyUI 报 `bad_linked_input`，依赖它的输出被 `Output will be ignored` 丢掉 —— 表现就是秒完成、一张图都没有，但 ComfyUI 自带界面却“能跑”。

所以 `send()` 提交前会调 `wrapListWidgets(nodes)`：凡是「是数组、但不像合法连接」的输入，自动包成 `{"__value__": ...}`；`["58", 0]` 这种真连接原样保留。

## 一个坑：403 Forbidden

ComfyUI 有一层来源校验：请求的 `Host` 和 `Origin` 的 `host:port` 必须一致，否则直接返回 403（防别的网页偷偷往你本机队列塞任务）。

所以代理**必须保留浏览器原始的 Host**：

- `vite.config.js` 里 `changeOrigin: false`
- `tools/serve.mjs` 里不覆盖 `host` 头

如果改成 `changeOrigin: true`，Host 变成 `127.0.0.1:8189`、Origin 还是 `127.0.0.1:5187`，就会稳定 403。

绕开代理直连 ComfyUI 的话，需要 ComfyUI 启动时加 `--enable-cors-header`，并且把「连接设置」里的前缀改成完整地址。

## 结构

```
index.html
vite.config.js        /comfy -> http://127.0.0.1:8189 代理；/api/fastlora 中间件
src/xy.js             极速对比：把任意 KSampler 改造成 KSampler (Efficient) + XY Plot
src/api.js            读当前工作流 / 提交 / 轮询 / 收图；极速模式的接口封装
src/App.vue           三栏界面
src/components/LoraPanel.vue   LoRA 堆叠浮层（权重对比 / 极速模式 / ⚡ 标记）
tools/serve.mjs       静态托管 dist + 反向代理 + /api/fastlora（生产用）
tools/lora-speed.mjs  极速模式的本机文件服务：搬文件、建软连接、清单、还原 ps1
```

## 限制

- 只改**已有节点**的值，不新增/删除节点。
- 工作流来自 ComfyUI 的执行记录，所以 ComfyUI 里至少要跑过一次；刚启动的 ComfyUI 没有记录，会提示「还没有任何执行记录」。
- 提交的永远是提交时刻的那份节点图，ComfyUI 前端后来改了但没跑的改动不会被带上。
