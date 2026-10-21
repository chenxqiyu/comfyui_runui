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
5. **发送第一组** 只跑第一组；参数有多个值时会出现 **对比 N 组**，按组合顺序**串行**执行，结果横排成网格，每格标注这一组在变的维度（`sampler euler`、`sched beta`）和耗时。点任意一张进大图预览：底部显示该组的参数、文件名、耗时和序号，**← →** 翻页、**Esc** 或点图片关闭，两侧也各有一块可点击的翻页区。过程中可以「停止」。

**批量对比为什么要固定 seed**：如果每组都换随机种子，图之间的差异就混进了种子噪声，比不出 cfg / sampler 的真实区别。所以批量模式下忽略「随机 seed」，所有组共用同一个 seed，只变你加多值的那些维度。

单次提交时勾选「随机 seed」会换一个随机种子（会覆盖 ③ 里手动填的 seed）。

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
vite.config.js        /comfy -> http://127.0.0.1:8189 代理
src/api.js            读当前工作流 / 提交 / 轮询 / 收图
src/App.vue           三栏界面
tools/serve.mjs       静态托管 dist + 反向代理（生产用）
```

## 限制

- 只改**已有节点**的值，不新增/删除节点。
- 工作流来自 ComfyUI 的执行记录，所以 ComfyUI 里至少要跑过一次；刚启动的 ComfyUI 没有记录，会提示「还没有任何执行记录」。
- 提交的永远是提交时刻的那份节点图，ComfyUI 前端后来改了但没跑的改动不会被带上。
