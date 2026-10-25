# 会话引导栏（Session Rail）

![dsh-session-rail](https://raw.githubusercontent.com/zengxiaolou/dsh-session-rail/main/docs/images/promo.png)

<p>
<a href="https://www.npmjs.com/package/dsh-session-rail"><img alt="npm" src="https://img.shields.io/npm/v/dsh-session-rail?color=2f81f7&label=npm"></a>
<a href="https://www.npmjs.com/package/dsh-session-rail"><img alt="downloads" src="https://img.shields.io/npm/dw/dsh-session-rail?color=3fb950"></a>
<a href="https://github.com/zengxiaolou/dsh-session-rail/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/dsh-session-rail?color=bf8700"></a>
<img alt="dsh plugin" src="https://img.shields.io/badge/DSH-plugin-7aa2ff">
<a href="https://github.com/zengxiaolou/dsh-session-rail/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/zengxiaolou/dsh-session-rail?color=8250df"></a>
</p>


## 它解决什么

同时开着七八个工作区的时候，「哪里在跑、哪里在等我」是最难一眼看出来的：

| 场景 | 没有它 | 有它 |
| --- | --- | --- |
| 想知道别的会话是不是跑完了 | 逐个展开工作区、点进去看 | 顶部一行 `●3 运行 ●5 未读`，左栏文件夹行尾 `●2` |
| 有会话停下来问你问题 | 翻半天才发现它在等 | `询问` 单独一段，橙色（宿主 warning 同色） |
| 某个会话崩了 / 被打断 | 只能回想 | `出错` 红、`中断` 灰，一眼分开 |
| 想直接跳到那个会话 | 先找再点 | 点计数钉住浮层，浮层里点行直达 |

## 截图

> 下列图为**按应用包内真实主题色值渲染的示意图**（不是真机截图），用于说明形态与配色；深浅色各自成立。

| 顶部五态计数（深色） | 左栏工作区徽标（深色） |
| --- | --- |
| ![顶部五态计数](https://raw.githubusercontent.com/zengxiaolou/dsh-session-rail/main/docs/header-counter-5tone.png) | ![左栏工作区徽标](https://raw.githubusercontent.com/zengxiaolou/dsh-session-rail/main/docs/workspace-badge.png) |


给 DSH 右侧栏加一个常驻视图：**进度**，和已有的 `PR` 标签并排。显隐、宽度、`+` 新标签菜单全部沿用宿主原生右栏，本插件不另起一列。

0.1.10 起，同一份数据再往两层：**对话面板顶部标题条**常驻五段计数（运行 / 询问 / 出错 / 中断 / 未读），**左侧工作区行**再各带一个 `● N` 徽标——不用点开右栏、也不用逐个展开文件夹。

> 0.1.5 起移除了「变更」「来源」两个 tab（右侧栏太挤、日常用不上）。宿主侧的 `/changes`、`/sources` 只读接口保留下来当诊断口，客户端不再注册标签。

## 一个 tab

| Tab | 显示什么 | 数据来源 | badge |
| --- | --- | --- | --- |
| 进度 | ① 本会话运行状态：运行中/空闲、第几轮、本轮已用时长、工具调用数、最近一个工具、**上下文占用（已用/窗口，按 65%/85% 变色）**；② 长任务列表：状态、百分比、最新消息、相对时间 | ① 会话事件流里的 `turn/start`、`turn/end`、`tool/call`；② `<cwd>/.dsh-progress/<session-id>/*.jsonl`（`dsh-task-progress` 协议） | 运行中的长任务数 |

进度 tab 的第一张卡不依赖任何 producer：只要会话在跑，就有「第 N 轮 · 1 分 45 秒 · 15 次工具调用 · bash」。

## 顶部会话计数

![顶部会话计数](https://raw.githubusercontent.com/zengxiaolou/dsh-session-rail/main/docs/header-counts-light.png)

插在 `conversation.session.header.utilities`（宿主声明为 “右对齐的会话工具区”）里，`order: -10` 排在所有工具控件之前——也就是**标题右侧、右侧图标按钮左侧那段空白**。这段由 shell 的 `ConversationSessionHeader` 渲染，所以对话 / 轨迹 / 上下文 / 画廊等所有视图页共用同一处，切换页面不掉。

| 段 | 含义 | 数据来源 |
| --- | --- | --- |
| ● N 运行（蓝） | 有活跃回合、且真的在干活的根会话数 | 客户端 `sessions.list` 的 `running` + `/turns` 排除“等你回答” |
| ● N 询问（橙） | 回合停在 `ask_user_question` 上，等你回答 | 宿主 `/turns` 看**当前回合**内有无未 `tool/result` 的 `ask_user_question` 调用 |
| ● N 出错（红） | 上一个回合以 `blocked` / `error` 结束、且还没看过的 | 宿主 `/turns` 读会话日志尾部的 `turn/end.data.reason.kind` |
| ● N 中断（灰） | 回合以 `aborted` / `interrupted` 结束（没做完就停了） | 同上 |
| ● N 未读（绿） | 已正常结束（`completed` / `max-tokens`）、但本浏览器还没看过的 | `updatedAt` 对比已读水位 + `/turns` 判定 |

- **没有现成字段**：DSH 不记录“某个会话是否已读”，所以已读水位由客户端持有——首次加载把当时的全部会话记为已读（否则一上来就是几十条未读），之后“看着的会话”按 `updatedAt` 前进水位，**离开时正在跑、回来已经结束**的会话由 running→false 这次跃迁直接记成未读。
- **颜色来自会话自己的结局**：`turn/end` 的 `reason.kind` 决定色调——`completed`/`max-tokens` 绿、`aborted`/`interrupted` 中性灰、`blocked`/`error` 红。查不到（会话已离开内存）返回 `unknown`，落回绿色“未读”，不猜成别的颜色。
- **“在跑”与“等你回答”分开算**：回合开着不等于在干活。当前回合里有 `ask_user_question` 调用、且它的 `tool/result` 还没出现 → `question`，从蓝色里扣掉，进橙色那段（官方 warning 色，和侧栏“等待回答”一致）。判定只看**开着的那个回合**：结果事件的 call id 在 `data.message.toolCallId`（不在 `data.callId`），答完之后同一回合继续干活就该回到“运行”，历史回合里没结果的调用也不能把后面的回合算成在等你。
- **只轮询结局**：运行数订阅 `sessions.list`，状态真变才算；结局每 15s 向宿主批量问一次（单次最多 24 个），页面不可见时不发。
- **弱干扰**：11px 三级文字色；数字为 0 的那段整段隐藏，五段都为 0 时退化成一颗很淡的点（`data-idle` 0.45 透明度，hover 回到 0.95）。
- **hover 预览，点击钉住**：hover / 键盘 focus 只是“看一眼”，移开就收起；点一下 chip 把它钉住（`data-pinned`），鼠标走进浮层不会掉，再点一次 / 点外面 / Esc 才关。浮层里的行才是跳转入口。
- 文案进的是插件自己的 locale 命名空间（`locale.register('session-rail', {zh, en})`），跟随 GUI 语言切换；颜色走 `--dsw-alias-*` 别名 token（浮层用 `bg-layer-3` 实心面，不用会透出正文字色的 `bg-overlay`）。中断用中性灰而不是黄色：主题没有第五个状态色，橙色已经让给“等你回答”，黄色会和它撞。

| 深色 | 深色 + hover |
| --- | --- |
| ![深色](https://raw.githubusercontent.com/zengxiaolou/dsh-session-rail/main/docs/header-counts-dark.png) | ![深色浮层](https://raw.githubusercontent.com/zengxiaolou/dsh-session-rail/main/docs/header-counts-dark-panel.png) |

## 左栏工作区徽标

工作区行是宿主的闭合组件（`ProjectRowItem`），**没有可注入的座位**，所以徽标用原生 DOM 画在
`[data-row-key^="workspace:"]` 上，并由一个常驻在 `sidebar.footer.action` 的空组件每 1.5s 重画一次
（React 会替换行子节点，插件不持有行内的 React 树）。

- **口径**：`启迪 /api/session-rail/workspaces` 返回 `工作区 → sessionIds`（注册表自己的投影，已按 canonical cwd 过滤），
  再对每个会话取 `/turns` 判定。`running` 计数不含停在提问上的会话；`question` 单独计。
- **只显示有事的工作区**：`running + question = 0` 的行不画徽标，徽标里的颜色：有 `question` 用橙，否则用蓝。
- **开关**：`localStorage["dsh-session-rail:workspace-badge:v1"] = "off"` 关掉，`removeItem` 恢复默认开。
- **已知缺口**：注册表 `sessionIds` 未按归档集过滤，归档会话若仍在跑会被算进来；自动化会话（本机 69/230）目前**计入**，
  若发现“运维行长期亮灯”，按 `origin`/会话名前缀再过滤。

> ⚠️ 未在真实 GUI 验证：徽标定位依赖 `data-row-key` 锚点与 sidebar footer 座位，两者都需要重启后手验（拖拽/展开后有无重影、关闭开关有无残留）。

## 交互

- **手动刷新**：每张卡片标题右侧 `↻`；后台轮询只在标签可见时进行（会话状态 4s、进度 3s）。
- **不假成功**：没有 `cwd` 或没有长任务上报时如实说明，不退回到宿主进程目录去猜。

## 宿主路由

前缀路由 `/api/session-rail`：

```
GET /api/session-rail/turn?sessionId=<会话 id>
GET /api/session-rail/turns?ids=<逗号分隔，最多 24 个>   # 批量：每会话最后一个回合的结局
GET /api/session-rail/workspaces                          # 工作区 → sessionIds（左栏徽标用）
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
- `test/client.test.cjs`：stub React 渲染进度 tab 与顶部计数，覆盖描述符（只有一个）、badge、运行状态卡、空态，以及已读水位的基线 / 跃迁 / 跳转清理与“空闲只剩一颗点”的渲染。

两个测试都不碰真实工作区、不联网。

## 已知边界

- 依赖 `dsh-better-sidebar` 的 `ctx.betterSidebar.registerTab`：服务未出现时标签不注册，8s 后向控制台输出一条诊断（不静默失败）。
- 进度目录上限 64 个任务文件，单文件只读尾部 512KB（追加写文件的正常形态）。
- `/changes` 接口（无客户端使用）文件清单最多 60 条，超出标注“仅显示前 N 项”。
- `/turn` 只看尾部 400 条事件：超长单轮（>400 个事件）时工具计数会偏小，运行状态与时长的判定不受影响。
- `/sources` 接口（无客户端使用）：`gh` 未安装或未登录时返回首行原因，不伪造“已登录”。
- 会话的工作目录已不存在时，命令在宿主进程目录下执行：坏 `cwd` 的 `ENOENT` 不会被误报成“gh CLI not found”。
- 顶部计数在**新会话首屏**不显示：那页 shell 会把整条标题行收掉（`hideChrome`），只留最右角；这是宿主布局行为，插件未越权改 DOM。
- 已读水位是按浏览器存的（`localStorage`），换浏览器 / 清站点数据会重新基线一次；子代理会话与空会话不计入两个数字。

## 多语言

同一份文案走两条路，跟随 GUI 语言切换（无需刷新）：

| 位置 | 文件 | 覆盖 |
| --- | --- | --- |
| 插件元信息（插件列表里的标题/描述） | `locale/zh.json`、`locale/en.json` | 中文 / English |
| 计数、浮层、徽标的运行时文案 | `client.js` 的 `HEADER_TEXT`（`locale.register('session-rail', …)`） | `zh` / `en` |

新增语言：在 `locale/` 加一份同名 JSON，并在 `HEADER_TEXT` 里加同键字典；缺键时回落到 `zh`，不会显示 key。

## 市场与发布

- npm：`npm publish --registry=https://registry.npmjs.org`（默认 registry 若是镜像站，必须显式指定）。
- 市场收录：条目在 [`market/dsh-session-rail.yml`](market/dsh-session-rail.yml)，格式即 awesome-dsh-plugin 的
  `data/plugins/<owner>__<repo>.yml`（一个文件就是全部投稿）。合并后由其脚本生成列表，`dshmarket.com/index.json` 再抓取它。
  `category: session`，`description.en` 必填、`zh` 可选；图标省略时回退到作者头像。
- 版本策略：只递增补丁位（`0.1.9 → 0.1.10`），只有大改才动 middle 位。
