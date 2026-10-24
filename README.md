# 会话引导栏（Session Rail）

给 DSH 右侧栏加一个常驻视图：**进度**，和已有的 `PR` 标签并排。显隐、宽度、`+` 新标签菜单全部沿用宿主原生右栏，本插件不另起一列。

> 0.1.5 起移除了「变更」「来源」两个 tab（右侧栏太挤、日常用不上）。宿主侧的 `/changes`、`/sources` 只读接口保留下来当诊断口，客户端不再注册标签。

## 一个 tab

| Tab | 显示什么 | 数据来源 | badge |
| --- | --- | --- | --- |
| 进度 | ① 本会话运行状态：运行中/空闲、第几轮、本轮已用时长、工具调用数、最近一个工具、**上下文占用（已用/窗口，按 65%/85% 变色）**；② 长任务列表：状态、百分比、最新消息、相对时间 | ① 会话事件流里的 `turn/start`、`turn/end`、`tool/call`；② `<cwd>/.dsh-progress/<session-id>/*.jsonl`（`dsh-task-progress` 协议） | 运行中的长任务数 |

进度 tab 的第一张卡不依赖任何 producer：只要会话在跑，就有「第 N 轮 · 1 分 45 秒 · 15 次工具调用 · bash」。

## 交互

- **手动刷新**：每张卡片标题右侧 `↻`；后台轮询只在标签可见时进行（会话状态 4s、进度 3s）。
- **不假成功**：没有 `cwd` 或没有长任务上报时如实说明，不退回到宿主进程目录去猜。

## 宿主路由

前缀路由 `/api/session-rail`：

```
GET /api/session-rail/turn?sessionId=<会话 id>
GET /api/session-rail/progress?cwd=<绝对路径>&sessionId=<会话 id>
GET /api/session-rail/changes?cwd=<绝对路径>        # 0.1.5 起无客户端使用，保留为只读诊断口
GET /api/session-rail/sources?cwd=<绝对路径>        # 同上
GET /api/session-rail/report?boot=&stage=&service=&tabs=   # 客户端启动信标
GET /api/session-rail/state                                 # 版本 + 信标记录
```

- 同源校验：带 `Origin` / `Referer` 且 host 与请求 `Host` 不一致 → 403；缺 `Host` → 403；非 GET → 405；未知路径 → 404。
- 除 `/report`（写一行内存诊断记录）外全部只读：不写工作区、不写会话日志、不改仓库。
- `/turn` 只读会话事件流尾部最多 400 条，不落盘。
- 上下文占用 = `inputTokens + cacheReadTokens + cacheWriteTokens`。**不要只看 `inputTokens`**：它只含未命中缓存的部分，长会话会算出 0%。

`turn` 响应：

```json
{ "ok": true, "live": true, "running": true, "turn": 5,
  "startedAt": 1792632091266, "elapsedMs": 122300,
  "toolCalls": 19, "lastTool": "bash",
  "lastEventType": "job/registered", "lastEventAt": 1792632191436, "seq": 949,
  "usage": { "inputTokens": 227, "outputTokens": 188, "cacheReadTokens": 318464, "contextTokens": 318691 },
  "contextWindow": 1048576, "fillPercent": 30 }
```

## 诊断：客户端到底加载了没有

Web 页面无法从宿主侧直接检查，所以客户端半边启动时会打两个信标（`stage=apply`、`stage=registered`，后者带注册到的 tab id）。刷新页面后：

```bash
curl -s localhost:60606/api/session-rail/state | python3 -m json.tool
```

- `clientReports` 为空 → 页面没加载到本插件的客户端模块（旧页面没刷新，或 `dsh.client` 未被扫描）。
- 有 `stage=apply` 且 `service: false` → 加载了，但没等到 `betterSidebar` 服务（`dsh-better-sidebar` 未启用）。
- 有 `stage=registered` 且 `tabs` 里是 `session-rail:progress` → 标签已交给注册表，标签条里应该能看到。

`/state` 同时返回 `clientGraph`：`ours` 表示本插件的客户端模块在不在宿主的启动图里、`clientPath` 指向哪个文件。`ours: true` + `clientReports: []` = 打包没问题，只是页面还没重载。

## 安装 / 卸载

```bash
dsh plugin --profile desktop add /path/to/session-rail   # 本地目录，链接安装
```

装完**硬刷新浏览器**（Cmd/Ctrl+Shift+R）；宿主侧改动需重载插件行（关闭再打开）或重启 DSH。

## 测试

```bash
npm test     # = node test/host.test.mjs && node test/client.test.cjs
```

- `test/host.test.mjs`：自建临时 git 仓库与进度目录，覆盖 13 组断言（含 `/turn` 运行/闭合/未知会话、`/changes`、`/sources`、信标与 `/state`、传输守卫）。
- `test/client.test.cjs`：stub React 渲染进度 tab，覆盖描述符（只有一个）、badge、运行状态卡、空态。

两个测试都不碰真实工作区、不联网。

## 已知边界

- 依赖 `dsh-better-sidebar` 的 `ctx.betterSidebar.registerTab`：服务未出现时标签不注册，8s 后向控制台输出一条诊断（不静默失败）。
- 进度目录上限 64 个任务文件，单文件只读尾部 512KB（追加写文件的正常形态）。
- `/changes` 接口（无客户端使用）文件清单最多 60 条，超出标注“仅显示前 N 项”。
- `/turn` 只看尾部 400 条事件：超长单轮（>400 个事件）时工具计数会偏小，运行状态与时长的判定不受影响。
- `/sources` 接口（无客户端使用）：`gh` 未安装或未登录时返回首行原因，不伪造“已登录”。
- 会话的工作目录已不存在时，命令在宿主进程目录下执行：坏 `cwd` 的 `ENOENT` 不会被误报成“gh CLI not found”。
