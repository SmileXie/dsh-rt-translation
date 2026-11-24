# dsh-rt-translation 设计方案：系统声音实时翻译字幕

- 日期：2026-11-20
- 状态：已批准（2026-11-20）
- 目标平台：Windows 10/11 x64（v1），Linux x64（预留）
- 宿主：DeepSeek Harness（DSH）桌面版

## 1. 背景

用户需要在两类场景里看懂没有字幕的外语语音：

1. **在线会议**：听其他参会者说话，需要低延迟、短句、不遮挡共享屏幕。
2. **电影 / 网课**：连续对白，需要稳定、可读、长时间滚动。

共同点是 **音频来自电脑的系统输出，而不是麦克风**。用户希望这个能力以 DSH 插件的形式存在，复用 DSH 里已经配置好的 LLM API 做翻译，先交付 Windows 版本，并为 Linux 预留扩展点。

## 2. 目标与非目标

### 2.1 目标

- 采集 Windows 默认输出设备（以及可选的单个应用）的播放声音。
- 本地识别语音，语言范围：中文 `zh`、英文 `en`、日语 `ja`、韩语 `ko`、粤语 `yue`，源语言支持 `auto`。
- 源语言与目的语言均可选，五种语言两两互译。
- 用 DSH 已配置的 LLM provider/model 做流式翻译。
- 在屏幕上显示置顶、透明、点击穿透的字幕窗；字幕窗不进入任务栏与 Alt+Tab。
- 提供“会议”“影视”两套预设，并允许细调。
- 通过托盘图标与控制条按钮开始/停止、切换语言与模式，不必打开 DSH 窗口；热键与斜杠命令作为辅助入口。
- 音频与识别全程本地，不落盘；只有识别出的文本进入 LLM 请求。

### 2.2 非目标（v1）

- macOS 支持。
- 说话人分离（diarization）、说话人命名。
- 采集并翻译用户自己的麦克风（会议里“我说话给别人看”）。
- 保存字幕历史、导出 SRT、生成会议纪要。
- OBS / 直播软件叠加源、浏览器扩展、移动端。
- 独占全屏（exclusive fullscreen）游戏或播放器的覆盖保证。
- 保证粤语书面语的表达质量（依赖所选 LLM）。

### 2.3 反目标

- 不做“把整段音频上传到云端 ASR”。这会把会议内容送出本机，且与本地 SenseVoice 的能力重复。
- 不在 DSH 窗口内部渲染字幕。共享屏幕时会被观众看到，且最小化 DSH 后消失。
- 不引入需要 Rust / MSVC / Python 工具链的构建步骤。用户机器没有 C++ 编译器。

## 3. 约束与已确认决策

| 事项 | 结论 | 依据 |
| --- | --- | --- |
| 语言范围 | 中 / 英 / 日 / 韩 / 粤（含源语言 auto） | 用户确认；与 SenseVoice 支持集 `auto, zh, en, yue, ja, ko` 完全一致 |
| 语音识别 | DSH 自带 `ctx.speechToText` + `speech-to-text-sensevoice`（本地、离线） | 无需 Whisper、无需云端 STT、无需额外 key |
| 翻译 | `ctx.llm.stream()`，使用用户已配置的 provider/model | 用户要求复用 DSH 中配置的 LLM |
| 采集 | npm `loopback-capture@5`：Windows WASAPI loopback，自带 `win32-x64` 预编译 N-API 二进制 | 免编译；同一 JS API 在 Linux 走 PipeWire，直接成为 Linux 扩展点 |
| 字幕窗 | 独立进程：PowerShell + WPF，NDJSON over stdin | Windows 自带，零安装；置顶/透明/点击穿透可控；渲染层可替换 |
| 形态 | 单插件全链路（方案 A） | 用户选择 |
| 屏幕共享 | 字幕对观众可见，不启用 `WDA_EXCLUDEFROMCAPTURE` | 用户选择 a |
| 前台入口 | 托盘 + 控制条按钮为主；overlay 进程常驻，支持热键冷启动 | 用户要求 UI 启动 + 选择保留 |
| 源语言 auto | 启发性语言判定；命中目标语言则跳过翻译 | 用户选择 a |
| 临时原文 | 先上屏临时原文，译文到达后替换该行 | 用户选择 a |
| 插件宿主 | DSH Host 进程（Node/Electron，N-API 9+） | 与 SenseVoice worker 同一运行环境 |

## 4. 候选方案与选择

### A. 单插件全链路（已选）

一个 DSH 插件包负责采集、分段、识别、翻译与字幕状态；另起一个极轻的 WPF 子进程只负责画字。逻辑集中，安装物只有一个 npm 包加一个 `.ps1`，Linux 只需替换渲染适配器。

### B. 插件 + 伴生 Electron 字幕 App

字幕与设置界面由 Electron 承担，跨平台外观一致、样式能力强。代价是多约 200MB 运行时、一套 IPC 与进程生命周期管理，工程量约为 A 的 1.5–2 倍。v1 不需要这些能力。

### C. 拆成“识别服务 + 通用字幕客户端”

便于将来被 OBS 或浏览器复用，但要先定义公开协议与版本兼容，当前没有第二个消费者，属于提前抽象。

**选择 A**，并通过“渲染器接口 + 协议”保留向 B/C 演进的可能。

## 5. 总体架构

```text
┌───────────────────────────── DSH Host 进程 ─────────────────────────────┐
│                                                                         │
│  loopback-capture ──► 降混/重采样 ──► 分段器 ──► WAV(16k/mono/PCM16)    │
│   (WASAPI, 48k/2ch)    16k mono       VAD+强制切分          │           │
│                                                             ▼           │
│                                              ctx.speechToText            │
│                                              (SenseVoice, 本地)           │
│                                                             │           │
│                                                             ▼           │
│   ctx.commands ◄── 控制器 ──► 字幕状态机 ◄──────── ctx.llm.stream()      │
│   (斜杠命令)        │            │                    (流式翻译)          │
│                     │            │                                       │
└─────────────────────┼────────────┼───────────────────────────────────────┘
                      │            │ NDJSON (stdin/stdout)
                      │            ▼
                      │   ┌───────────────────────────────┐
                      │   │ overlay.ps1 (PowerShell + WPF)│
                      └──►│ 置顶 / 透明 / 点击穿透 / 热键  │
                          └───────────────────────────────┘
```

数据流是单向的：音频只在内存中流动，转成文本后就丢弃；翻译文本经字幕状态机推送渲染进程。控制器只接收用户意图（托盘/控制条按钮、热键、斜杠命令、模型工具），不参与数据通路。

## 6. 组件设计

### 6.1 音频采集

`loopback-capture` 输出 16-bit 小端 PCM、双声道、48 kHz，分块大小不固定（受内部 20ms 缓冲与队列影响）。

- 模式 `system`：`startSystemAudio(cb)`，采集默认播放设备上的全部声音。
- 模式 `system-exclude-self`：`startSystemAudio(cb, process.pid)`，排除 DSH 自身进程树的播放（避免把 DSH 的提示音、TTS 再翻一遍）。要求 Windows build 20348+。
- 模式 `app`：`start(cb, pid)`，只采集指定进程及其子进程。要求 Windows build 20348+，否则回退到 `system` 并在字幕里提示一次。

应用选择用命令 `/rt app <name>`；控制条与托盘菜单里提供应用下拉（见 6.9），两者走同一个控制器。

必须处理的两类运行时事件：

- `capture.lastError` 非空：设备失效（拔耳机、切默认设备、驱动重置）。停止后按 1s/2s/5s 退避重启；连续失败 3 次则停止并在控制条显示错误。
- 默认设备变化：`loopback-capture` 没有设备变更通知，切换默认输出后它会继续采旧端点且不报错。v1 不做轮询；提供 `/rt restart` 与托盘菜单「重新连接音频」。验收标准为「采集报错后 5s 内自动恢复；切换设备后手动重连一次即可」。

交付给下游的数据固定为 16 kHz 单声道 Int16，帧长 20 ms（320 个采样点）。`loopback-capture` 的队列是有界的（64 块），消费端必须同步轻量，耗时工作全部异步化到下游队列。

### 6.2 降混与重采样

48 kHz → 16 kHz，比例 3:1，用两级处理避免混叠：

1. 双声道求平均降为单声道。
2. 3 抽头低通（截止约 7.2 kHz）+ 3:1 抽取。

不追求录音级音质，只要求识别可懂；实现为纯函数，输入 `Int16Array`，输出 `Int16Array`，带跨块状态（保留上一块尾部采样）。

### 6.3 语音分段

目标：在“不切断词”和“够快出字幕”之间取平衡。

- 帧级判决：20 ms 一帧计算 RMS，与自适应噪声底比较。噪声底用静音段的指数滑动平均（时间常数 3s），阈值 = 噪声底 × 3 + 固定下限。连续 3 帧高于阈值判定为语音开始；连续 `silenceMs` 低于阈值判定为结束。
- 预留 200 ms 前置音频（pre-roll），避免吞掉首字。
- 强制切分：单段超过 `maxSegmentMs` 时，在最近 1.5s 内找能量最低的帧作为切点；切点保留 250 ms 重叠，下一段从重叠点开始。
- 丢弃规则：段长 < 300 ms 或平均能量低于阈值的段直接丢弃（键盘声、点击声）。
- 文本去重：由于 250 ms 重叠，相邻两段的识别文本可能重复。用“后段开头与前段结尾的最长公共子串（≥4 个字符）”裁掉重复前缀。

会议预设偏快（`silenceMs=280`），影视预设偏整句（`silenceMs=550`）。

### 6.4 语音识别

通过 `ctx.speechToText` 调用已注册的 SenseVoice provider：

```ts
const spec = ctx.speechToText.resolve({ audio: wav, language: sourceLanguage, providerId })
const { text, audioSeconds, inferenceSeconds } = await ctx.speechToText.transcribe(spec, signal)
```

- provider 默认 `sensevoice-local`；插件 patch 里声明 `speech-to-text` 与 `speech-to-text-sensevoice` 两行（使用与官方 voice-input bundle 相同的行 id，因此会“覆盖”而不是重复注册服务）。
- 启动时调用 `ctx.speechToText.prepare(providerId)`，并用 `ctx.speechToText.snapshot()` / `provider.preparation.subscribe()` 把下载/加载状态显示在控制条与托盘提示里（首次约 1GB 模型）。
- provider 内部是串行队列（`maxPending` 默认 4）。我们只允许 1 个“最终段”在途，外加最多 1 个“临时段”；超出时丢弃最旧的临时请求。
- `language` 直接透传用户选择的源语言；`auto` 交给 SenseVoice 自动判定。

**临时结果（live 模式）**：对当前未结束的语音段，每 `partialIntervalMs`（默认 900ms）把“段起点到当前时刻”的音频送一次识别，得到临时文本，用于先出字幕。段结束时发送最终版，覆盖临时文本。临时请求可被取消（`AbortSignal`），避免与最终段抢队列。

### 6.5 翻译

使用 `ctx.llm`，不经过 `ctx.translator`（后者对付费路由固定 `deepseek-flash`，且要求 Session）。

```ts
const stream = ctx.llm.stream({
  provider, model,
  system: buildSystemPrompt(source, target),
  messages: [{ role: 'user', content: [{ type: 'text', text: promptText }] }],
  maxTokens: 512,
  temperature: 0.2,
  signal,
})
```

- provider/model 解析顺序：配置里的显式值 → `/rt model` 持久化值 → `ctx.agentDefaultModel.currentSelection()`（跟随 DSH 当前默认模型，例如 `qwen-token-plan-cn / deepseek-v4.1-flash`）→ `listProviders()[0]` 及其 `listModels()` 首个模型。解析失败时控制条显示「未找到可用模型」，`/rt status` 列出可用 provider/model。
- system prompt 固定包含：源语言名、目的语言名、“只输出译文，不要引号、不要解释、不要 Markdown”、“保持人名/术语”、“字幕风格：简洁、口语化，不要合并或省略信息”。
- 上下文不伪造 assistant 消息：DSH 的 `Message` 需要 `id` 与 `source` 元数据，凭空构造会破坏语义。最近 2 组原文/译文以纯文本拼进同一条 user 消息（`[最近上下文] 原文: … 译文: … [本句] …`），提升术语与代词一致性；上下文不进入字幕。
- 流式渲染：`text-delta` 直接追加到当前字幕行；`finish` 后做一次清洗（去掉包裹引号、` ``` `、前缀“译文：”）。
- 若 `source === target`，跳过翻译直接显示原文；`source=auto` 时先用 `detectLanguage(text)`（见 6.10）判断，命中目标语言同样跳过。
- 临时结果只显示原文（`live` 标记），不触发翻译，避免每 900ms 一次 LLM 请求；只有最终段翻译。会议模式（`bilingual=false`）也先上屏临时原文，译文开始流式输出时把该行替换为译文（用户选择 a）；影视模式保留原文行，译文追加在下方。

这样会议场景“先看到原文、1 秒内看到译文”，电影场景“字幕随句子结束即时补齐”。

### 6.6 字幕状态机

一条“字幕条目”（cue）的生命周期：

```text
idle ──speech──► partial(仅有原文) ──segment end──► translating ──stream──► shown ──hold 到期──► fading ──► idle
```

- 同时最多保留 `maxLines` 条 cue；新 cue 从底部进入，旧的向上推移并降低不透明度。
- 同一段语音的临时文本与最终文本共用同一个 `id`，原地替换，不新增行。
- 会议模式（`bilingual=false`）：partial 阶段该行显示原文；收到第一个译文 token 时清空并改写为译文，避免原文与译文同时占两行。
- `holdMs` 内没有新 cue 则淡出；淡出时长 250ms。
- 队列上限 6 条，超出丢弃最旧的（会议里不需要追溯太久）。
- 状态机是纯函数 + 定时器，输出“渲染快照”，便于单测。

### 6.7 叠加窗（Windows）

独立 PowerShell 进程运行 `assets/overlay/overlay.ps1`，由 `ctx.subprocess.spawn()` 启动，参数为 Base64 编码的 JSON 样式配置。该进程**常驻**：`/rt stop` 只隐藏字幕与控制条，不退出进程，因此热键与托盘在任何时候都能冷启动翻译。进程随插件卸载或托盘「退出」结束。宿主与窗口之间用 UTF-8 NDJSON：

宿主 → 窗口：

```json
{"op":"style","fontSize":32,"maxLines":3,"position":"bottom","marginPercent":8,"widthPercent":78,"opacity":0.72,"background":true,"bilingual":true,"display":"primary","fontFamily":"Microsoft YaHei UI"}
{"op":"cue","id":"c17","lines":[{"kind":"source","text":"..."},{"kind":"target","text":"...","live":true}],"holdMs":4000}
{"op":"status","state":"listening","text":"正在收听 · 中 → 英"}
{"op":"state","running":true,"source":"auto","target":"en","preset":"meeting","error":null}
{"op":"clear"}
{"op":"shutdown"}
```

窗口 → 宿主：

```json
{"op":"ready"}
{"op":"hotkey","name":"toggle"}
{"op":"action","name":"toggle","value":null}
{"op":"error","text":"..."}
```

字幕窗属性（控制条与设置面板是同一进程内的另外两个窗口，见 6.9）：

- `WindowStyle=None`、`AllowsTransparency=true`、`Background=Transparent`、`ShowInTaskbar=false`、`Topmost=true`。
- 扩展样式 `WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`，实现点击穿透、不抢焦点、不出现于 Alt+Tab。
- `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`，避免高分屏模糊。
- 每 2s 重新 `SetWindowPos(HWND_TOPMOST)`，抵消其他置顶窗口的抢占。
- **不启用** `WDA_EXCLUDEFROMCAPTURE`（用户选择 a：可见）。共享整个桌面或录屏时字幕会出现在画面里，这是刻意行为。
- 位置：底边居中（`position=top` 时为顶边居中），宽度为工作区的 `widthPercent`，可指定显示器序号（0 = 主显示器）。
- 文本：目标语言用对应字体（zh/yue: Microsoft YaHei UI；ja: Yu Gothic UI；ko: Malgun Gothic；en: Segoe UI），白字 + 半透明黑底 + 轻微阴影；原文行字号为译文的 0.62 倍、透明度 0.75。
- 全局热键由窗口注册（`RegisterHotKey`）：`Ctrl+Alt+S` 开始/停止、`Ctrl+Alt+C` 清屏、`Ctrl+Alt+↑/↓` 字号、`Ctrl+Alt+B` 切换双语。热键通过 stdout 回报，宿主执行动作。

**已知限制**：独占全屏（DirectX exclusive）画面之上无法保证显示，文档与 `/rt status` 中提示改用“无边框全屏”。多显示器 DPI 不同时按目标显示器缩放。

### 6.8 控制面

三条入口共用同一个控制器：**托盘/控制条按钮（主入口）**、DSH 斜杠命令、模型可调用工具。斜杠命令用 `ctx.commands.register()` 注册，不产生模型消息：

| 命令 | 作用 |
| --- | --- |
| `/rt start` | 开始（必要时先准备模型、启动字幕窗） |
| `/rt stop` | 停止采集与翻译，隐藏字幕与控制条（overlay 进程常驻） |
| `/rt status` | 显示采集设备、STT 状态、provider/model、最近错误、延迟统计 |
| `/rt lang <src> <tgt>` | 设置语言；`src` 可为 `auto/zh/en/ja/ko/yue`，`tgt` 为 `zh/en/ja/ko/yue` |
| `/rt mode meeting\|media` | 切换预设 |
| `/rt app <name>` | 只采集指定进程；`/rt app off` 恢复系统声音 |
| `/rt model <provider> <model>` | 覆盖翻译模型 |
| `/rt restart` | 重新连接音频设备（切换默认输出后使用） |
| `/rt ui` | 显示/隐藏控制条 |
| `/rt test <text>` | 不采音频，直接翻译并上屏，用于调样式 |

同时注册一个模型可调用工具 `rt_translate`（参数：`action: start/stop/status`, `source?`, `target?`），方便用户直接对 agent 说“开始翻译”。工具只调用同一个控制器，不复制逻辑。

所有能在按钮上完成的操作都不要求记忆命令；命令是快捷方式与自动化入口。斜杠命令保留是因为它在 DSH 里可发现、可脚本化，而托盘/控制条是日常使用时的手。

### 6.9 控制面 UI：托盘 + 控制条

**为什么 v1 不做 DSH 客户端面板**：DSH 的 Web 客户端插件需要 `dsh.client` manifest、Typert remote、React 组件和 harness 的 tsdown 构建管线，并且必须作为 monorepo workspace 包构建。对当前需求来说，它的收益低于一个随字幕进程同生共死的本地面板。v1 用 WPF 自带能力实现同等操作，v2 若要嵌入 DSH 页面，控制器与协议不用改。

**托盘图标**（`System.Windows.Forms.NotifyIcon`，随 overlay 进程创建）：

- 左键：显示/隐藏控制条（同时是「随时能开始」的入口）。
- 菜单：开始翻译 / 停止；模式（会议、影视）；源语言（自动、中、英、日、韩、粤）；目的语言（中、英、日、韩、粤）；只采集指定应用…；重新连接音频；字号 +/−；清空字幕；退出。

**控制条**（约 420×44 的圆角浮条，吸附在字幕上方）：

- ▶ / ⏸ 主按钮（开始/停止），旁边是状态点：灰=空闲、绿=收听中、黄=翻译中或重连中、红=错误。
- 源语言下拉 → 目的语言下拉（五个语种 + 自动）。
- 会议 / 影视 分段按钮。
- 「⋯」打开设置面板：字号、行数、位置、双语、透明度、翻译模型。

交互规则：

- 控制条默认隐藏。鼠标移到屏幕底边中央热区、按 `Ctrl+Alt+H`、或点托盘图标时淡入；鼠标离开 3s 后淡出。
- 控制条是**独立窗口**（与字幕窗同进程），不做区域级穿透开关：字幕窗永久 `WS_EX_TRANSPARENT | WS_EX_NOACTIVATE`；控制条窗口需要可激活，否则下拉框展不开，但保留 `WS_EX_TOOLWINDOW`，仍不进 Alt+Tab 与任务栏。
- 所有按钮只发送 `{"op":"action","name":"...","value":...}`，由宿主控制器执行并回推 `{"op":"state",...}`；UI 不持有业务状态，避免与命令入口不一致。
- 首次使用（模型未下载）时，控制条显示下载进度与「准备模型」按钮；准备完成后自动开始，不需要再点一次。
- 设置面板的改动立即生效并持久化（同 `ctx.settings` 路径）。

**视觉**：深色半透明、圆角 8px、与字幕共用字体与缩放；跟随显示器 DPI；不进入任务栏与 Alt+Tab。

### 6.10 语言判定

`detectLanguage(text)` 是纯函数，返回 `zh | yue | ja | ko | en | unknown`：

- 谚文（U+AC00–D7AF）占非空白字符比例 > 0.2 → `ko`。
- 出现平假名/片假名 → `ja`（假名是最强信号，即使同时有大量汉字）。
- 汉字占比 > 0.3 且无假名：粤语特征字（嘅、咗、喺、唔、啲、佢、乜、嘢、噉、嚟）命中 ≥2 个 → `yue`，否则 `zh`。
- 拉丁字母占比 > 0.5 → `en`（语言集合里只有英语使用拉丁字母）。
- 其余 → `unknown`。

用途：`source=auto` 且判定结果等于目标语言时跳过翻译；`/rt status` 与设置面板显示最近一次判定；原文行在 auto 模式下带语言标记（可关）。判定失败不影响主流程，照常按配置翻译。

## 7. 配置

```yaml
- id: rt-translation
  name: dsh-rt-translation
  config:
    sourceLanguage: auto        # auto | zh | en | ja | ko | yue
    targetLanguage: zh          # zh | en | ja | ko | yue
    preset: meeting             # meeting | media
    capture:
      mode: system-exclude-self # system | system-exclude-self | app
      appName: ''               # mode=app 时的可执行文件名
    stt:
      providerId: sensevoice-local
      partials: true            # live 模式临时结果
      partialIntervalMs: 900
    translate:
      provider: ''              # 空 = 自动解析
      model: ''                 # 空 = 该 provider 的首个模型
      contextTurns: 2
      followAgentDefault: true  # 未显式指定 provider/model 时跟随 DSH 默认模型
      glossary: []              # ["Transformer=Transformer", ...]
    segment:
      silenceMs: 280
      maxSegmentMs: 5000
      preRollMs: 200
    subtitle:
      display: primary          # primary | all
      position: bottom          # bottom | top
      fontSize: 32
      maxLines: 3
      widthPercent: 78
      marginPercent: 8
      opacity: 0.72
      background: true
      bilingual: true
      fontFamily: ''            # 空 = 按目的语言自动
      holdMs: 4000
    meeting:
      autoPauseAfterMs: 120000   # 0 = 关闭静音自动暂停
    media:
      glossary: []              # 额外术语，如 ["Hermione=赫敏"]
    hotkeys:
      enabled: true
    debug:
      dumpAudioDir: ''          # 空 = 不落盘
    ui:
      tray: true
      controlBar: true
      controlBarHotkey: 'Ctrl+Alt+H'
      showStatusDot: true
```

插件用 `@deepseek-ai/schemastery` 声明 `Config`。运行期修改（`/rt lang`、`/rt mode`、`/rt model`）通过 `ctx.settings.update(entryId, patch)` 写回 profile 行；`settings` 不可用时退化为内存态，`/rt status` 标注“未持久化”。

## 8. 场景预设

| 参数 | meeting | media |
| --- | --- | --- |
| `silenceMs` | 280 | 550 |
| `maxSegmentMs` | 5000 | 7000 |
| `partials` | 开 | 开 |
| `maxLines` | 2 | 3 |
| `holdMs` | 3500 | 6000 |
| `bilingual` | 关（先临时原文，译文到达后替换） | 开（原文+译文） |
| `fontSize` | 30 | 34 |
| 字幕位置 | 底部居中 | 底部居中 |

预设只在用户没有显式覆盖对应字段时生效；`preset` 变更不重置用户已手改的字段（字段级“显式”标记来自配置是否出现在 profile 行中，运行期改动记为显式）。

### 8.1 行为差异（用户追加确认）

- **会议 · 长时间静音自动暂停**：连续 `meeting.autoPauseAfterMs`（默认 120s）没有语音时停止采集，控制条状态点转蓝并提示「已暂停 · Ctrl+Alt+S 恢复」；热键、托盘「开始翻译」或控制条 ▶ 恢复。设为 0 关闭。这样做是为了长时间没人说话时不再占用音频设备，也避免把系统提示音、环境声当成语音。
- **影视 · 按片名加载术语表**：`/rt title <name>` 读取 `$DSH_HOME/rt-translation/glossaries/<name>.json`（`[{"from":"Hermione","to":"赫敏"}]`），把条目作为额外术语注入翻译 prompt；`/rt title off` 清除。控制条设置面板显示当前术语表条数。

## 9. 时序与延迟预算

一句话结束（VAD 判定）到译文首字出现：

| 阶段 | 典型耗时 |
| --- | --- |
| VAD 静音判定 | 280–550 ms |
| WAV 封装 + 入队 | < 5 ms |
| SenseVoice（3s 音频，int8，2 线程） | 250–600 ms |
| 翻译首 token | 400–1200 ms |
| 上屏 | < 20 ms |
| **合计** | **约 0.9–2.4 s** |

临时原文的首字延迟约为 0.5–1.2 s。CPU 占用：SenseVoice 约 30–60% 单核（分段期间）；重采样与 VAD < 3% 单核。

## 10. 错误处理

| 失败 | 行为 |
| --- | --- |
| 模型未下载 / 下载失败 | 字幕窗显示进度或错误；`/rt status` 给出下载源与重试方法；不开始采集 |
| STT 超时 / worker 退出 | 丢弃当前段，provider 内部自动重启；连续 3 次失败则停止并报错 |
| 翻译失败（网络/额度） | 该条显示原文 + `⚠ 翻译失败`；下一条恢复；连续 3 次失败则降级为“只显示原文”并提示 |
| overlay 进程退出 | 1s 后重启一次；再失败则停止翻译并在 DSH 日志中报错 |
| 采集设备失效 | 退避重启采集（1s/2s/5s），字幕显示“正在重新连接音频设备” |
| 队列积压（> 3 段） | 丢弃最旧的未翻译段，避免字幕越来越滞后 |
| 用户停止 | 取消所有在途 STT/翻译请求，停止采集并隐藏字幕与控制条；overlay 进程常驻，模型 worker 由 provider 空闲回收 |

所有资源通过 `ctx.effect()` 注册清理，插件卸载时停止采集、终止子进程、取消请求。

## 11. 隐私与安全

- 音频只在内存中；默认不落盘。`debugDumpDir` 仅在显式配置时开启，且启动时在字幕窗提示。
- 只有识别文本（及最近 2 轮上下文）进入 LLM 请求，走用户自己配置的 provider。
- 叠加窗进程无网络访问、无文件写入，只读 stdin。
- `overlay.ps1` 不做字符串拼接执行、不调用 `Invoke-Expression`；样式参数按 JSON 解析并做类型/范围校验。
- 热键与字幕内容不写入 DSH 会话历史（斜杠命令本身会记入命令日志，这是 DSH 既有行为）。

## 12. Linux 扩展点

v1 就把平台差异收进三个接口，Linux 版本只需补实现：

| 接口 | Windows v1 | Linux 计划 |
| --- | --- | --- |
| `AudioSource` | `loopback-capture` WASAPI | 同一个包，PipeWire 后端（需 `libpipewire-0.3`） |
| `SubtitleRenderer` | `WindowsWpfRenderer`（spawn PowerShell） | `LinuxGtkRenderer`（GTK4 + layer-shell）或 Electron；NDJSON 协议不变 |
| `HotkeySource` | overlay 进程内 `RegisterHotKey` | v1 返回 `unsupported`，用控制条/托盘与斜杠命令；后续接 X11/Wayland 全局热键 |

工程约束：

- 所有路径用 `node:path`，不硬编码 `\` 与盘符。
- 子进程参数用数组传递，不拼命令行字符串。
- 不假设 PowerShell / `%LOCALAPPDATA%` 存在；平台模块通过 `platform.ts` 单点选择。
- 字体回退链在 Linux 用 `Noto Sans CJK SC/JP/KR`。

## 13. 工程结构与打包

仓库：`D:\my_code\dsh-rt-translation`（独立 npm 包，不修改 DSH monorepo）。

```text
dsh-rt-translation/
├── package.json              # dsh.bundle -> ./cordis.patch.yml
├── cordis.patch.yml          # 插入 stt 两行 + 本插件行
├── tsconfig.json
├── assets/overlay/overlay.ps1
├── src/
│   ├── index.ts              # apply(ctx, config)
│   ├── config.ts             # schemastery Config
│   ├── controller.ts         # start/stop/status，命令与工具共用
│   ├── pipeline.ts           # 采集→分段→识别→翻译→字幕 编排
│   ├── platform.ts           # 平台选择
│   ├── audio/{capture,resample,vad,wav}.ts
│   ├── stt.ts
│   ├── translate.ts
│   ├── subtitle/{state.ts,renderer.ts,windows-wpf.ts}
│   ├── commands.ts
│   ├── detect.ts             # detectLanguage 启发式
│   ├── ui.ts                 # 托盘/控制条状态同步
│   └── tool.ts
└── tests/                    # vitest
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: speech-to-text
      name: '@deepseek-ai/dsh-experimental-speech-to-text'
      config:
        defaultProvider: sensevoice-local
    - id: speech-to-text-sensevoice
      name: '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice'
      config:
        dataRoot: !!js dshHomePath('speech-to-text', 'sensevoice')
    - id: rt-translation
      name: dsh-rt-translation
```

加载方式：

- 开发：`pnpm dsh web --patch D:\my_code\dsh-rt-translation\cordis.patch.yml`
- 安装：`dsh plugin --profile <name> add D:\my_code\dsh-rt-translation`

依赖：

- `dependencies`：`loopback-capture@^5`、`@deepseek-ai/schemastery@^3`
- `peerDependencies`：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-experimental-speech-to-text`、`@deepseek-ai/dsh-commands`、`@deepseek-ai/dsh-subprocess`
- `devDependencies` 同 peer，用于类型检查；用 tsconfig `paths` 指向本地 `D:\my_code\deepseek-harness\packages\...\src`，保证类型与当前 checkout 一致。

`package.json` 必须声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 与 `engines.dsh`，否则 `dsh plugin add` 不会激活。

## 14. 测试与验收

### 14.1 自动化

- 纯函数单测：重采样比例与幅度、VAD 状态机、强制切分点、重叠去重、WAV 头、字幕状态机、翻译输出清洗。
- 集成测试：用 16k 单声道 WAV 夹具跑 `pipeline.processSegment()`，注入假 STT 与假 LLM 流，断言 cue 序列。
- 协议测试：NDJSON 编码/解码、样式字段校验、未知 `op` 忽略。
- 不做需要真实音频设备的 CI 测试；采集与 overlay 由人工验收。

### 14.2 人工验收

1. 播放中文视频，`zh → en`，1.5–2.5s 内出现英文译文，断句可读。
2. 会议软件共享整个屏幕：字幕会出现在共享画面里（刻意行为，用户选择可见）；字幕区点击穿透，Alt+Tab 看不到叠加窗与托盘以外的窗口。
3. 五种语言两两互译各跑一句；`auto` 源语言能正确识别中/英。
4. 电影连续对白 10 分钟，字幕不积压、不重叠、不残留。
5. 拔插耳机后采集报错，5s 内自动恢复；手动切换默认输出设备后，点「重新连接音频」或 `/rt restart` 一次即可恢复。
6. `/rt stop` 后 1s 内停止采集、CPU 回到 <1%，`powershell` 进程保留（常驻热键宿主），再次热键可在 1s 内开始。插件卸载/托盘退出后无残留进程。
7. 独占全屏播放器下确认已知限制并在状态点悬停提示中看到说明。
8. 全程不打开 DSH 窗口：从托盘菜单选「开始翻译」，用控制条切换语言/模式，热键暂停与恢复。
9. 模型首次下载时，控制条显示进度并能取消；下载中断后可重试。

## 15. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `loopback-capture` 预编译二进制在 DSH 的 Electron/Node ABI 上加载失败 | 阻断采集 | 实现第一步就做加载与 3s 采集 spike；失败则回退到 Chromium loopback（`setDisplayMediaRequestHandler`）方案 |
| PowerShell WPF 在部分机器被安全软件拦截 | 无字幕窗 | 脚本明文、无编码混淆、无网络；提供 `renderer: none`（只写日志）降级 |
| 控制条与字幕窗争抢焦点/误触 | 看电影时点到字幕 | 字幕区永久穿透；只有控制条可见时可点，且 3s 无操作淡出 |
| SenseVoice 在切成 16k 后准确率下降 | 字幕错字 | 24h 内用真实素材抽测；必要时提高 `maxSegmentMs` 或改用 48k 直送（provider 只接受 16k，需转回） |
| 强制切分切断词语 | 译文半句 | 重叠 + 文本去重；`maxSegmentMs` 可调；影视预设优先等静音 |
| LLM 首 token 慢（>2s） | 字幕滞后 | 允许 `/rt model` 换更快的模型；`/rt status` 显示 P50/P90 延迟 |
| 粤语书面语翻译质量不稳定 | 译文生硬 | 在 prompt 中要求“口语化粤语书面表达”，并把 glossary 暴露给用户 |

## 16. 留给实现者

- 具体低通滤波器系数与重采样实现（只需满足单测容差）。
- VAD 阈值常数在真实素材上的微调。
- 临时结果与最终结果替换时的视觉过渡细节。
- `/rt status` 的文本排版。
- overlay 脚本的模块划分（单文件或按窗格拆分）。

## 17. 实现顺序建议

1. 采集 spike：加载 `loopback-capture`，采 3s，写 WAV，确认能听到内容且不崩溃。
2. 纯函数层：重采样、VAD、WAV、去重 + 单测。
3. 识别接通：`ctx.speechToText` 准备 + 单段转写，控制台打印。
4. 翻译接通：`ctx.llm.stream` + prompt + 清洗。
5. overlay：样式、协议、热键，先用 `/rt test` 驱动。
6. 控制器与命令：start/stop/status/lang/mode/app/model/restart。
7. 托盘与控制条：状态同步、按钮、设置面板、热区显隐。
8. 错误恢复、统计、预设细化。
9. 打包与安装验证（`dsh plugin add`）。

## 18. 2026-11-24 修订：多行历史字幕与控制条入窗

以下内容覆盖前文对应章节；未提到的设计保持不变。

| 事项 | 原设计 | 现实现 |
| --- | --- | --- |
| 字幕形态 | 一次只显示最新一条（`display=primary`），译文轮到 `holdMs` 后淡出 | 显示 2–5 行滚动历史：最后一行为当前正在说的话，上方为最近几句；每行小字原文 + 大字译文 |
| 行数含义 | `maxLines` = 渲染的文本块上限 | `maxLines` = 句子行数（2–5），会议默认 3、影视默认 4 |
| 会议原文 | `bilingual=false`，译文到达后替换原文行 | `bilingual=true`，默认原文 + 译文双语 |
| 译文停留 | `holdMs` 内没有新 cue 才淡出，新 cue 可立即抢占 | `minReadMs`（会议 1.8 s / 影视 1.5 s）内译文不会滚出；流式中的译文不被切断；`holdMs` 改为静音清屏时间（6 s） |
| 控制面 | 独立 WPF 控制条 + 设置窗，鼠标热区与 `Ctrl+Alt+H` 唤出 | DSH 窗口 `shell.overlay` 内的控制条（`client.js`），通过 `/rt-translation` Connection RPC 驱动同一控制器；移除独立控制条、设置窗、鼠标热区、`Ctrl+Alt+H`、`/rt ui` 与 `ui.controlBar*`；托盘保留（左键开始/停止） |
| 子字幕协议 | `Cue{id,lines,holdMs}`；Host 下发 `state` / `panel` | `Cue` 增加 `finished`；`StylePayload` 增加 `minReadMs`；移除 `state` / `panel` 下发与 `display` |
| 预设 | 会议 hold 3.5 s、仅译文；影视 3 行、6 s | 会议 3 行、6 s、1.8 s；影视 4 行、6 s、1.5 s；两者默认双语 |

验收：`npm test` 74/74；`overlay.ps1 -SelfTestRows` 9/9；控制条的浏览器半需重启 DSH 后真机确认（见 `docs/handoff-2026-11-24.md`）。

### 18.1 同日二次修订

- 字幕窗**常驻**：静音不清屏、`/rt stop` 不清屏，保留最近几行历史；`holdMs` 仅兼容保留。
- 字幕窗**可拖动**：移除点击穿透，按住左键拖动；位置仅在当前会话内保持；移除 `position`（顶部/底部）配置，初始仍底部居中。
- 默认字号 20、行数 3（会议/影视一致）。
- 控制条新增背景透明度滑块（`subtitle.opacity`，20%–100%）。
- 行模型、`minReadMs` 滚动保护不变。




