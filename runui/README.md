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
3. **③ 绑定输出** — 填输出节点 ID（`SaveImage` / `PreviewImage` 之类），点「用首选」自动挑一个。
4. 点 **发送到 ComfyUI**，轮询执行结果，图会显示在右侧。

勾选「同时随机化所有 seed / noise_seed」的话，每次提交都会换随机种子。

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
