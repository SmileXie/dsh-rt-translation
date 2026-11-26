# AGENTS.md

> 本文件写给在本仓库工作的 AI Agent 与开发者。先读这里，再读 [README](README.md) 和 [当前交接文档](docs/handoff-2026-11-24.md)。
> 以代码与实际命令输出为准；历史设计文档里已被取代的行为（会议/影视模式、片名术语表、独立悬浮控制条、顶部/底部位置等）不要作为实现依据。

## 1. 项目是什么

`dsh-rt-translation` 是 DeepSeek Harness（DSH）的本地实时字幕插件：

- 采集 Windows 系统回环音频（不含麦克风），本机 SenseVoice 识别中/英/日/韩/粤。
- 用 DSH 里已配置的 LLM 流式翻译。
- 字幕画在置顶、透明、**可用鼠标拖动**的 WPF 叠加窗；控制页在 **DSH 左侧导航（「插件」「自动化任务」同级）**，不浮在页面之上。
- 音频只在内存中；只有识别出的文本进入 LLM 请求。

硬约束：

- 仅 Windows（`src/index.ts` 在非 Windows 直接抛错）。
- 没有构建步骤：Host 直接跑 `src/*.ts`（Node 类型擦除，`>=20.19`），浏览器半是手写的 `client.js` 纯 JS bundle。
- 叠加窗是 Windows PowerShell 5.1 + WPF；`assets/overlay/overlay.ps1` **必须是 UTF-8 BOM + CRLF**（见第 7 节）。
- 不修改 DSH monorepo；插件以独立 bundle 安装（本机 desktop profile 里是 `link:D:/my_code/dsh-rt-translation`）。

## 2. 常用命令

| 命令 | 作用 | 备注 |
| --- | --- | --- |
| `npm install` | 安装插件自身依赖 | 链接安装不会自动装，缺了插件加载失败 |
| `dsh web --patch .\cordis.patch.yml` | 开发模式从本仓库加载 | 在 DSH 仓库用 `pnpm dsh ...`；必须用 `cordis.patch.yml`，不能传 bundle patch |
| `npm test` | 单元/集成测试（`node --test`，127 个） | 提交前必须通过 |
| `npm run test:overlay` | 行窗口 + 多屏位置 + 右键菜单自检（9 + 5 + 1 个断言，不弹窗） | 改 `overlay.ps1` 行选择/窗口定位/菜单后必跑 |
| `npm run test:icon` | 托盘图标生成自检（`PASS tray icon 32x32`） | 改 `assets/icon.jpeg` / 图标代码后跑 |
| `powershell ... overlay.ps1 -SelfTest` | 弹 1.5 秒字幕窗，验证 WPF 渲染 | 需要桌面会话 |
| `powershell ... overlay.ps1 -SelfTestMeeting` | 同上，双语文案 | 名字是历史遗留，仅“双语” |
| `npm run typecheck` | TypeScript 检查 | **当前已知失败**：`tsconfig.json` 的 `paths` 指向不存在的 `D:/my_code/deepseek-harness`。不要拿它当门禁；修复 checkout 路径后再启用 |

完整命令中的 `<path>` 指 `assets/overlay/overlay.ps1`。

## 3. 架构与数据流

```text
loopback-capture (48k/2ch)
  → DownmixResampler (16k mono)
  → Segmenter (能量 VAD + pre-roll + 强制切分)
  → SenseVoice (ctx.speechToText)
  → Translator (ctx.llm.stream)
  → SubtitleModel（cue 状态）
  → WindowsWpfRenderer（NDJSON over stdio）
  → assets/overlay/overlay.ps1（WPF 叠加窗 + 托盘）

client.js（侧边栏入口 sidebar.panellist + 主区页面 main[key]，同一个 id）
  ⇄ GET/POST /plugins/dsh-rt-translation/state|action（带 DSH 鉴权）
  ⇄ src/panel.ts → Controller

斜杠命令 / 模型工具 / 全局热键 / 托盘左键 → Controller（同一个入口）
```

**Controller 是唯一动作来源**：UI 不持有业务状态，所有入口都调用 `Controller`（`start/stop/quit/setLanguages/setSubtitle/setSegment/setAutoPause/...`），状态由控制器推给渲染器或由面板轮询。

## 4. 目录与关键文件

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | 插件入口：接线 STT/LLM/渲染器/控制器，注册面板路由，启动 overlay |
| `src/config.ts` | Schemastery `Config`、默认值、`resolveConfig`（**改默认值只改这里**） |
| `src/controller.ts` | 生命周期、设置变更、长静音自动暂停、start/stop/quit |
| `src/settings-store.ts` | `--patch` 开发模式下 Settings 无法写 profile 时的 profile 内 JSON 兜底 |
| `src/pipeline.ts` | 采集→分段→识别→翻译→字幕编排；延迟统计 |
| `src/capture.ts` | `loopback-capture` 封装（system / system-exclude-self / app） |
| `src/stt.ts` | SenseVoice provider 封装（准备、串行转写） |
| `src/translate.ts` | `ctx.llm.stream` 翻译、prompt、上下文、清洗 |
| `src/commands.ts` | `/rt` 斜杠命令 |
| `src/tool.ts` | 模型工具 `rt_translate` |
| `src/ui.ts` | 动作分发 + 设置补丁校验（`parseSubtitlePatch` / `parseSegmentPatch` / `parseAutoPause`） |
| `src/panel.ts` | 控制页的两个鉴权路由与快照 |
| `src/subtitle/state.ts` | `SubtitleModel`（纯状态，可单测） |
| `src/subtitle/protocol.ts` | NDJSON 协议、动作白名单、`toStylePayload` |
| `src/subtitle/renderer.ts` | `SubtitleRenderer` 接口（含可恢复的 `close()`） |
| `src/subtitle/windows-wpf.ts` | 子进程管理、重启、close/dispose |
| `assets/overlay/overlay.ps1` | WPF 叠加窗、托盘、热键、协议处理、行窗口、多屏定位、右键菜单与自检 |
| `client.js` | DSH 浏览器半：侧边栏入口、「实时翻译」页、fetch 轮询 |
| `locale/en.json`、`locale/zh.json` | 插件页的标题与说明文字（`meta.title` / `meta.description`）；改文案只改这里 |
| `package.json` | 包清单；`exports` 必须导出 `./package.json` 与 `./locale/*.json`，否则插件页读不到元数据 |
| `assets/icon.jpeg` | 托盘图标源图（缩放到 32×32） |
| `cordis.bundle.patch.yml` | 安装进 profile 后由 `dsh plugin add` / Desktop 插件页读取的 bundle patch；**不要**传给 `--patch` |
| `cordis.patch.yml` | 开发模式 `dsh web --patch` 用；入口 `./src/index.ts` 按此文件所在目录锚定 |
| `tests/*.test.ts` | `node --test`；与 `src` 同构 |
| `docs/handoff-2026-11-24.md` | 最新变更/决策/待办，改行为后同步更新 |
| `docs/superpowers/specs/2026-11-20-...md` | 设计文档（含 2026-11-24 多次修订节） |

## 5. 当前默认行为（重要）

只有一套配置（原会议模式参数），没有会议/影视之分：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `sourceLanguage` / `targetLanguage` | `auto` / `zh` | |
| `capture.mode` | `system-exclude-self` | 排除 DSH 自身播放 |
| `stt` | `sensevoice-local`，临时结果开，900 ms | |
| `translate` | 不指定 provider/model（跟随 DSH 默认），上下文 2 轮 | |
| `translate.background` / `translate.backgroundBrief` | `''` / `''` | 控制页「翻译背景」原始输入与提炼摘要（≤2000 / ≤300 字符）；摘要每句进 prompt |
| `translate.glossary` | `[]` | 术语表（≤1000 行 × 120 字符），可直接写 profile；每句只注入命中的 ≤12 条 |
| `segment.silenceMs` | 550 ms（100–3000） | 静音切分；短于正常分句停顿会把一句切成两半 |
| `segment.maxSegmentMs` | 8000 ms（1000–30000） | 单句最长 |
| `segment.preRollMs` | 400 ms（0–1000） | 句首缓冲，兜住轻声起句 |
| `autoPauseAfterMs` | 120000 ms（0 = 关闭） | 长静音自动暂停 |
| `subtitle.fontSize` | 20 | |
| `subtitle.maxLines` | 3（2–5） | **句子行数**，不是文本块数 |
| `subtitle.bilingual` | true | 小字原文 + 大字译文 |
| `subtitle.opacity` | 0.72 | 叠加窗背景不透明度，文字保持不透明 |
| `subtitle.minReadMs` | 1800 | 译文最短可读时间，防被新句子过早滚出 |
| `subtitle.holdMs` | 6000 | **仅兼容保留**，已不再静音清屏 |
| `ui.tray` / `hotkeys.enabled` | true / true | |

行为要点：

- 字幕窗显示最近 `maxLines` 句：最后一行是当前句，上方是历史；历史行透明度 0.7。
- 翻译 prompt 依次是 `[Background]`（摘要）、`[Glossary]`（本句命中的词条）、`[Recent context]`、`[Current]`；任一为空时整段省略。词条按大小写不敏感子串匹配本句原文，最多 12 条，所以词表可以很长而不拖慢每句请求。
- 「提炼背景并生成词表」要求先选定源语言：`sourceLanguage: auto` 时控制器直接拒绝（不调用模型），面板显示「请先选择源语言」；背景为空时同样不调用模型，按钮仍可点击并在按钮右侧立即提示先填背景。重新点击时面板会先收起上一次的 `glossaryError`（不等待模型返回），问题仍在（例如源语言仍是 `auto`）再由本次校验结果重新显示。
- 静音时保留历史，不自动关闭；**停止翻译**（⏸ / `/rt stop` / dispose）会清空并关闭字幕窗；`/rt restart` 不清屏。
- 新译文出现后至少保留 `minReadMs` 才允许滚出，必要时短暂多显示一行（`maxLines + 1`）。
- 字幕窗可鼠标拖动；拖动位置只在当前会话保持，初始位置底部居中。拖到任意显示器后都留在该屏幕，不会被主屏工作区钳回。没有顶部/底部配置。
- 右键字幕窗弹出「停止翻译并关闭字幕」：等同 `/rt stop`（停止采集、清空并隐藏字幕），托盘与控制页仍在，可从 ▶ / `Ctrl+Alt+S` 再次开始。
- 托盘：**左键**开始/停止；**右键只有「退出」**。退出只关闭 overlay/托盘，之后从控制页 ▶、`Ctrl+Alt+S` 或 `/rt start` 可重新拉起，无需重启 DSH。
- 全局热键：`Ctrl+Alt+S`（开始/停止）、`Ctrl+Alt+C`（清屏）、`Ctrl+Alt+↑/↓`（字号）、`Ctrl+Alt+B`（双语）。
- 已移除、不要无意加回：会议/影视模式与 `/rt mode`、片名术语表与 `/rt title`、独立 WPF 控制条与设置窗、鼠标热区、`Ctrl+Alt+H`、`/rt ui`、`ui.controlBar*`/`showStatusDot`、`subtitle.position`、`subtitle.display`。
- 控制页（左侧导航「实时翻译」，不覆盖对话）：语言、**翻译背景**（背景输入 → 提炼背景并生成词表 → 背景摘要与术语表，可改可清空）、静音切分（ms）、单句最长（显示 s，存 ms）、自动暂停（关闭/1/2/5/10 分钟）、字号、行数、透明度、显示原文、阅读时间、清屏/重连音频/准备模型/**默认配置**（`resetDefaults`：恢复切分、自动暂停与字幕默认值，并清空翻译背景/摘要/术语，语言与模型路由不动，播放中重连采集）。

## 6. 控制页接口

- `GET /plugins/dsh-rt-translation/state`：返回 `{ ok, value: { state, subtitle, segment, autoPauseAfterMs, capture, translate, stt } }`。
- `POST /plugins/dsh-rt-translation/action`：body `{ action, value? }`，动作白名单见 `src/subtitle/protocol.ts` 的 `PANEL_ACTIONS`；背景相关动作是 `setBackground`、`setBrief`、`setGlossary`、`prepareGlossary`。
- 鉴权：`webServer.register({ kind: 'exact', path, auth: 'required', handler })`；`webserver/authorize` 瀑布由 Connection 统一做 Host/Origin 栅栏 + DSH 会话校验，handler 只在准入后运行。**不要在 handler 里调用 `connection.requestRejection`**：当前 DSH 已移除该 API（v0.2.2-rc.2 起改用 `admit` / `connection.authentication`），调用会让已登录请求也返回 400。Connection 未就绪时 webServer 返回 503。
- 路由用 `webServer.register` 注册，并监听 `internal/service` 事件在 `webServer` 晚绑定时重试（只等 `webServer`，不必等 `connection`）。**不要改用 `ctx.connection.rpc.handle` 自定义通道**：在本机 Desktop 组合里该通道不会落到 HTTP 路由（曾导致 405）。

新增一个面板动作的完整路径：

1. `protocol.ts`：`ActionName`、`ACTIONS`、`PANEL_ACTIONS` 加名字。
2. `ui.ts`：写校验/钳制函数，并在 `dispatchAction` 加 case。
3. `controller.ts`：加真正执行的方法（需要时 `patchSettings` + 重启采集）。
4. `panel.ts`：如面板要显示新值，扩展 `PanelSnapshot` 与 `panelSnapshot`。
5. `client.js`：加控件调用 `act('newAction', value)`。
6. `tests/`：覆盖校验、分发、快照。

## 7. 开发约定与坑

### overlay.ps1 编码（最容易踩）

- 必须保持 **UTF-8 BOM（`EF BB BF`）+ CRLF**；Windows PowerShell 5.1 按 ANSI 读取无 BOM 脚本，中文会变乱码甚至语法错误。
- 编辑工具可能去掉 BOM。改完后检查：
  ```powershell
  $p = 'assets/overlay/overlay.ps1'
  ([System.IO.File]::ReadAllBytes((Resolve-Path $p))[0..2]) -join ','
  ```
  期望 `239,187,191`。必要时用 `[System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding $true))` 重写。
- 写完先做语法解析，再跑自检：
  ```powershell
  [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $p), [ref]$tokens, [ref]$errors)
  ```

### Host 代码的 ESM 缓存

- 在 DSH 插件页「停用/启用」只会重新执行 **旧模块**（Node ESM 已缓存），不会加载新 Host 代码。
- 改 `src/**` 或 `assets/overlay/**` 后，验证必须**完全退出 DSH（含托盘）再重开**。
- 只改 `client.js` 时通常刷新页面（`Ctrl+R`）即可；client HMR 生效时会自动更新。

### 设置持久化

- 正常安装：`patchSettings` 调 `ctx.settings.update(entryId, patch)`，写进 DSH profile；这是首选路径。
- `dsh web --patch`：命令行覆盖层（overlay）的 `config` 优先级高于 profile 补丁，`settings.update` 必然报 “overridden by ... command-line overlay”。`patchSettings` 捕获后写入 `<profile>/.dsh-rt-translation/settings.json`，文件带写入时的原始 Config 快照，只在该配置未变时恢复；之后某次 profile 写入成功会删除该文件。
- 不要在控制页恢复「设置未写入 profile（仅内存）」提示；持久化失败只写日志（`%TEMP%\dsh-rt-translation.log` 也有 `settings ... failed` 行）。

### 类型检查

- `tsconfig.json` 的 `paths` 指向不存在的源码 checkout，`npm run typecheck` 目前失败；不要为此改业务逻辑。
- 与 DSH 服务交互处使用**本地结构化接口**（如 `panel.ts` 的 `PanelWebServer`）或 `as never`，不要直接 import 未声明依赖的运行时包。

### 浏览器半（client.js）

- 必须是普通 bundle：`window.__ModuleLoader__.load({ id: 'dsh-rt-translation', factory(require) { ... } })`。
- 只能从模块表 `require('react')`；没有 JSX、没有构建、不要新增依赖。
- 全局页用**两个槽位、一个 id**：左侧入口 `sidebar.panellist`（`{ id, order, label: () => '…' }` + 图标组件，图标接收 `size`/`active`，用 `currentColor` 画 SVG）与主区页面 `main`（`{ key: 同一个 id }` + 页面组件）。侧边栏点击时由宿主调用 `ctx.layout.selectPanel(id)`，两个 key 必须一致。
- **不要注册 `shell.overlay`**：它浮在三栏之上，会盖住页面内容（本轮就是因此把右下角悬浮条迁走的）。
- 页面组件从 `main` 槽位拿到的是运行时 props（`renderSlot`、`useSlotStore` 等）；本插件的页面不依赖它们，自己用 `useState`/轮询即可。页面只在被选中时挂载，所以轮询天然随页面开关。
- 参考实现（随发行版一起装）：`dsh-client-ui-plugin-manager/src/client/index.ts` 的 `main` + `sidebar.panellist` 注册，以及 `PluginsPanelIcon.tsx` 的图标写法。
- 不要 `require('@deepseek-ai/dsh-client-ui-primitives')` 或其它 Harness Client 包；控件自己写，样式只引用 `--dsw-alias-*`。
- 主题色用 `--dsw-alias-*` 变量（如 `--dsw-alias-bg-layer-1`、`--dsw-alias-label-primary`）；页面留白与排版参考同类的管理页（标题 20px、卡片 12px 圆角、`maxWidth` 880）。

### 插件页标题与说明（locale 元数据）

- 插件页行内的标题/说明来自 `locale/*.json` 的 `meta.title` / `meta.description`，不是 `client.js` 的侧栏标签。
- DSH 通过包 `exports` 读取 `<包名>/locale/en.json` 与 `<包名>/package.json`；缺任一导出时元数据为空，行内只剩名字（`packageText` 对 description 没有兜底）。所以 `./package.json` 和 `./locale/*.json` 必须保留在 `exports`，`locale` 必须留在 `files` 里。
- 改中文文案改 `locale/zh.json`，英文改 `locale/en.json`（`en.json` 还负责让 DSH 发现 locale 目录，不能删）；`package.json` 的 `description` 是英文兜底。
- 首次新增/修改 `exports` 后要完全退出 DSH（含托盘）再打开一次：Node 会缓存 `package.json` 的 exports，运行中的进程读不到新子路径。之后只改 `locale/*.json` 文案时刷新插件页（`Ctrl+R`）即可。link 安装不需要重装。
- 图标可选，提供时导出 `./icon`，否则用默认图标。

### 分段器（src/audio/vad.ts）

- `finalize()` **保留整段音频**（含句尾轻声）。不要恢复「最后一个过门限帧 + 100ms」式裁剪：会议里句尾降调、语气词常比句首低十几 dB，被裁掉时屏幕上就是「只有前半句」。
- 起段门限 `max(噪声底*2.5, 320)`，断段门限 `min(max(噪声底*1.5,140), 起段*0.7)`：滞回，句内轻声字不算静音。
- 噪声底**只在 idle 且低于起段门限时**更新：否则一句话的头几个音节会抬高本次语音期间的门限，把句尾判成静音。
- `preRollMs`（默认 400）兜住轻声起句；`silenceMs` 低于约 300 ms 会把一句话按换气切碎，控制页提示也以此为准。
- 改这里必须补 `tests/vad.test.ts` 的回归用例（轻声句尾/句首、句中轻声字、停顿阈值、强制切分）。

### 部分识别（partial）

- `Pipeline.accept` 在新的 partial 或 final 到来时，只丢弃**尚未开始**的 partial；**不要 abort 正在识别的 active partial**。当前 SenseVoice provider 在识别请求被取消时会停掉本地 worker；abort active partial 会让下一次识别冷启动，逐词字幕永远追不上，最后只剩 final 一次上屏（用户看到的就是「整句说完才一下打印出来」）。
- 队列里最多保留一个待识别 partial，新的 partial 会替换旧的；final 会清掉待识别 partial，但等 active partial 完成后再开始，所以 final 的文本最终会覆盖临时文本。
- 改这里必须跑 `tests/pipeline.test.ts` 的两条回归用例：慢 partial 不被新 partial 取消并先上屏；final 等它完成后再覆盖。

### 协议与状态

- `src/subtitle/protocol.ts` 是 Host ↔ overlay 的唯一协议：`{op:'style'|'ui'|'cue'|'clear'|'shutdown'}`；overlay 回报 `ready/action/error/log`。改字段两边同步，并跑 `tests/protocol.test.ts`。
- `SubtitleModel` 是纯状态；overlay 的行选择 `Select-VisibleCues` 也是纯函数，用 `-SelfTestRows` 覆盖。改行数/停留/`minReadMs` 时两处都要想清楚（Host 只增量发最新 cue，历史在 overlay 里累积，上限 12 条）。
- 隐私约束：不要新增音频落盘或把音频发给云端；默认只有文本进入 LLM。

### 提交与文档

- 分支 `main`；提交信息用 `feat:` / `fix:` / `style:` / `docs:` 前缀，英文短句。
- 每次改行为同步更新 `README.md`、`AGENTS.md`、`docs/handoff-2026-11-24.md`，必要时补设计文档的修订节。
- Windows PowerShell 传多行 commit message 容易因引号拆参数，建议写临时文件后 `git commit -F <file>`。

## 8. 测试与人工验收

自动化（提交前）：

```powershell
npm test
npm run test:overlay
npm run test:icon
```

人工（改 Host/overlay 后）：

1. 完全退出 DSH 并重开；打开 DSH 页面。
2. 左侧导航应出现「实时翻译」；点开页面应显示「已停止」，点 ▶ → 准备模型 → 收听中。页面不覆盖对话内容。
3. 播一段带语音的音频：最后一行是当前句，上方是历史；停止说话后历史保留。
4. 拖动字幕窗到别处（多显示器下拖到副屏），继续说话/等新字幕时窗口应留在原处，不跳回主屏；调透明度、字号、行数、静音切分、单句最长、自动暂停应即时生效；重启 DSH 后这些设置应保留（`dsh web --patch` 开发模式也一样）。
5. ⏸ / `/rt stop` 应关闭字幕窗；再次 ▶ 应重新打开。
6. 托盘左键开始/停止；右键只有「退出」；退出后从控制页再开始应能重新拉起托盘。
7. 在字幕窗上点右键 → 选「停止翻译并关闭字幕」：采集停止、字幕消失，托盘和控制页仍在；点 ▶ 应能重新开始。
8. 若控制页报错，先看 `%TEMP%\dsh-rt-translation.log`（`src/index.ts` 仍有临时诊断日志，验证稳定后可删）。

## 9. 隐私与安全

- 音频只在内存中流动，不落盘；不新增云端 ASR。
- 只有识别文本（及最近两轮上下文）进入用户自己的 LLM。
- 面板路由必须走 Connection 鉴权，不要注册无鉴权的裸 webServer 路由。
- 不要提交 `.credentials.yaml`、模型缓存、profile 目录、`node_modules`、临时日志。

## 10. 不要做

- 不要引入构建步骤或把 `client.js` 改成 TS/JSX 源码（DSH 直接加载它）。
- 不要重新加回会议/影视模式、片名术语表、独立悬浮控制条、`Ctrl+Alt+H` 等已删除功能，除非用户明确要求。
- 不要在 `overlay.ps1` 里拼接字符串执行命令或新增网络/文件写入。
- 不要用未重启的 DSH 结果宣称 Host/overlay 改动已验证；不要用 `npm run typecheck` 的失败否决业务改动。
- 不要把 `holdMs` 的“静音清屏”旧语义加回来（现在只做兼容字段；静音保留历史，停止才关闭）。

## 11. 更多上下文

- 用户安装与使用：[README.md](README.md)
- 最新变更、验证记录、待办：[docs/handoff-2026-11-24.md](docs/handoff-2026-11-24.md)
- 设计与历次修订：[docs/superpowers/specs/2026-11-20-realtime-voice-translation-design.md](docs/superpowers/specs/2026-11-20-realtime-voice-translation-design.md)
- 早期实现计划（历史参考，可能过时）：[docs/superpowers/plans/2026-11-20-realtime-voice-translation.md](docs/superpowers/plans/2026-11-20-realtime-voice-translation.md)
