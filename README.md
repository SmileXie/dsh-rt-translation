# dsh-rt-translation

> **2026-11-25 更新**：控制面板从 DSH 窗口右下角的悬浮条改为**左侧导航里的「实时翻译」页**（与「插件」「自动化任务」同级），不再覆盖任何页面内容；播放在页内 ▶/⏸、托盘左键、`Ctrl+Alt+S` 都能控制。字幕支持 2–5 行历史，最后一行为当前句；字幕窗**在收听时持续显示、静音时保留最近几行**，可用鼠标拖动，停止翻译后自动关闭；默认字号 20、行数 3，透明度可在控制页里调。已移除会议/影视模式与片名术语表（`/rt mode`、`/rt title`），静音切分、单句最长、自动暂停改为控制页直接设置。旧的 `/rt ui`、`Ctrl+Alt+H`、`ui.controlBar*` 与顶部/底部位置配置也已移除。同日新增控制页「翻译背景」：填一段背景（如「看《哈利·波特与魔法石》」），点「提炼背景并生成词表」由当前翻译模型生成**背景摘要**与**术语表**，都可手改或清空；摘要每句进 prompt，词条只注入本句命中的（≤12 条），数据写入 profile。提炼前需在「语言」里选定源语言：源语言为「自动」时不会调用模型，面板会提示先选源语言。进度与续作事项见 [`docs/handoff-2026-11-24.md`](docs/handoff-2026-11-24.md)。

DeepSeek Harness 的实时系统声音翻译字幕插件：监听电脑正在播放的声音，用本机 SenseVoice 识别中/英/日/韩/粤，再用 DSH 已配置的 LLM 流式翻译，最后把字幕画在置顶、可拖动的透明窗口里。

## 能做什么

- 源语言：自动、中文、English、日本語、한국어、粤语；目的语言：中/英/日/韩/粤。
- 字幕支持 2–5 行滚动历史：最后一行为当前正在说的话，上方几行为最近几句话，每行都带原文与译文。
- 字幕窗在收听时持续显示：静音时保留最近几行历史，不会自动消失；停止翻译后关闭。
- 单一配置（默认取原会议参数）：静音切分、单句最长、自动暂停，以及行数、双语、阅读时间都可在左侧「实时翻译」页调整。
- 左侧「实时翻译」页、托盘左键、全局热键、斜杠命令、模型工具五种入口共用同一个控制器；托盘右键只有「退出」。
- 字幕对屏幕共享**可见**（刻意不启用 `WDA_EXCLUDEFROMCAPTURE`），共享整个桌面或录屏时会出现在画面里。
- 字幕窗置顶、可用鼠标拖动；控制页是 DSH 页面的一部分，不额外占用桌面窗口、不覆盖对话。
- overlay 进程常驻，`/rt stop` 只停止采集并隐藏字幕，热键、托盘和左侧控制页随时能再次开始。

## 依赖

| 依赖 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows 11，或 Windows 10 build 20348+ | 指定应用 / 排除自身采集依赖 Windows 进程回环；v1 只支持 Windows |
| DSH | 可正常启动的 DeepSeek Harness | 用 DSH 自带的 Node 24 CLI 即可，不需要单独安装 Node |
| 插件依赖 | 仓库根目录执行一次 `npm install` | 提供 `@deepseek-ai/schemastery` 与 `loopback-capture`；链接安装不会自动安装它们，缺了插件会加载失败、`/rt` 不出现 |
| LLM 路由 | 任一可用 provider + model | 默认跟随 DSH 当前默认模型；也可 `/rt model <provider> <model>` 覆盖 |
| 语音识别 | 无需单独安装 | bundle 已挂载 `speech-to-text` 与 SenseVoice provider；可用 `/rt prepare` 提前下载约 240 MB 模型 |
| PowerShell | Windows 自带的 Windows PowerShell 5.1 | 字幕窗是 WPF overlay；脚本必须以 UTF-8 BOM 保存 |
| 音频设备 | 默认输出设备能正常播放 | 采集系统回环，不需要麦克风，也不依赖虚拟声卡 |
| 网络 | 首次 `/rt prepare` 或 `/rt start` 准备模型时需要 | 模型缓存后识别可离线；翻译仍需要 LLM 可用 |

## 安装

### 准备工作

- Windows 11，或 Windows 10 build 20348 以上。
- 已安装 DeepSeek Harness Desktop（推荐），或已安装带 `dsh` 命令的 DSH CLI／源码仓库。没有全局 `dsh` 时，可以在 DSH 仓库里使用 `pnpm dsh`。
- DSH 中有可用的 LLM provider 与 model，供翻译调用。
- 第一次使用前需要约 240 MB 的 SenseVoice 模型，安装后可执行 `/rt prepare` 提前下载。

### 方式一：在 DeepSeek Harness Desktop 中安装（推荐桌面用户）

Desktop 的「插件」页会直接管理 Desktop 自己的 `desktop` profile，安装后不需要再运行 `dsh --profile rt`，也不需要另外启动 Web 版。以下步骤以 Windows 为例。

1. 获取项目，并记下仓库根目录的绝对路径，安装插件自身的依赖。

```powershell
git clone https://github.com/SmileXie/dsh-rt-translation.git
cd dsh-rt-translation
npm install
```

2. 打开 DeepSeek Harness Desktop 并进入工作区，在左侧边栏选择「插件」。

3. 点击「添加插件」。在「包名或地址」中选择仓库根目录的绝对路径，然后点击「安装」。

安装完成后点击「立即启用」。如果页面提示需要重启，请完全退出 DeepSeek Harness（不只是关闭窗口）后再重新打开，让插件由 Desktop profile 重新加载。

4. 回到「插件」页确认已出现 `dsh-rt-translation`，并且包含 `speech-to-text`、`speech-to-text-sensevoice`、`rt-translation` 三个条目。

Desktop 安装会沿用当前 Desktop profile 已配置的 LLM，不需要复制 CLI `rt` profile 的模型配置。若翻译路由仍未准备好，请先在 Desktop 的模型设置中配置一个可用模型。

本地目录会以链接方式安装，克隆目录需要保留。如果移动或删除了目录，请先在「插件」页卸载插件，再从新路径重新安装。

### 方式二：通过 CLI 作为 bundle 安装

把插件装进独立的 `rt` profile，之后用 `dsh --profile rt` 启动，不影响默认 profile。

1. 获取项目。克隆仓库，或从 GitHub 下载 ZIP 后解压，再进入项目根目录。

```powershell
git clone https://github.com/SmileXie/dsh-rt-translation.git
cd dsh-rt-translation
```

2. 安装插件自身的依赖。链接安装不会安装仓库的 `dependencies`，跳过这一步插件会加载失败，`/rt` 不会出现。

```powershell
npm install
```

3. 创建 `rt` profile。`--dump-config` 只生成并打印配置，不启动 DSH。

```powershell
dsh --profile rt --from-default-profile web --dump-config
```

4. 把当前目录安装为该 profile 的插件。

```powershell
dsh plugin --profile rt add .
```

5. 确认 `speech-to-text`、`speech-to-text-sensevoice`、`rt-translation` 三个条目都已挂载。

```powershell
dsh --profile rt --dump-config
```

安装使用 `cordis.bundle.patch.yml`，其中以包名 `dsh-rt-translation` 引用插件，由 profile 内的插件目录解析。`dsh plugin add` 以链接方式引用本地仓库，安装后请保留克隆目录。移动或删除目录后，需要在新位置重新执行安装。

如果终端提示找不到 `dsh`，在 DSH 仓库根目录把命令里的 `dsh` 换成 `pnpm dsh`，例如 `pnpm dsh --profile rt --dump-config`。同一个目录下也可以改用仓库自带的 Node 运行时，把 `dsh` 换成 `node apps\cli\lib\bin.js`。

#### 配置翻译模型

新 profile 不会自动继承默认 profile 的模型配置。如果启动后模型选择器显示「暂无可用模型」，或 `/rt status` 的「翻译」为空，把默认 profile 的 provider 条目复制到 `$env:DSH_HOME\profiles\rt\cordis.patch.yml`。没有设置 `DSH_HOME` 时，该文件位于 `$env:USERPROFILE\.dsh\profiles\rt\cordis.patch.yml`。

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      qwen-token-plan-cn:
        apiKeyEnv: QWEN_TOKEN_PLAN_CN_API_KEY
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: qwen-token-plan-cn
    model: deepseek-v4.1-flash
    reasoningEffort: high
```

provider 名称、模型名和密钥环境变量按你自己的 DSH 配置替换。

### 方式三：开发模式（从源码加载）

修改插件代码时可以直接加载本仓库，不必安装到 profile。同样需要先在仓库根目录执行一次 `npm install`，否则入口加载时会因为找不到 `@deepseek-ai/schemastery` 而失败，`/rt` 也不会出现。然后在项目根目录执行以下命令。

```powershell
dsh web --patch .\cordis.patch.yml
```

`cordis.patch.yml` 会同时挂载 `speech-to-text`、`speech-to-text-sensevoice` 和本插件。插件入口 `./src/index.ts` 相对该文件解析，项目目录可以放在任意位置。

如果 `dsh` 不在 `PATH` 中，在 DSH 仓库根目录改用 pnpm 转发，并传入配置文件的路径。

```powershell
pnpm dsh web --patch <插件目录的绝对路径>\cordis.patch.yml
```

### 安装后预下载模型（推荐）

安装完成后先启动一次 DSH：

- Desktop 安装：从托盘完全退出后重新打开 DeepSeek Harness Desktop。
- CLI bundle 安装：运行下面的命令。`dsh --profile rt`
- 开发模式：把下面的命令换成 `dsh web --patch .\cordis.patch.yml`。

在 DeepSeek Harness Desktop 或 DSH Web 的任意会话中发送：

```text
/rt prepare
```

命令会下载并校验 SenseVoice 权重、词表和 VAD，然后加载识别器。这个过程不会开始字幕采集，也不会弹出字幕窗。用 `/rt status` 查看进度，例如：

```text
识别: 下载中 42%（99.8 MB / 228.1 MB）
```

如果模型已经缓存，`/rt prepare` 会直接完成，不会重复下载。「识别」变成「待机」或「就绪」后，`/rt start` 会直接开始收听。模型默认保存在 `$env:USERPROFILE\.dsh\speech-to-text\sensevoice`。跳过这一步时，首次 `/rt start` 也会下载，只是开始收听需要等待下载完成。

## 启动

```powershell
# 启动并自动打开 DSH Web
dsh --profile rt

# 或者只启动服务，不打开浏览器
dsh --profile rt --no-open
```

启动成功后：

- 任务栏托盘显示插件图标（`assets/icon.jpeg` 缩放到 32×32），`powershell` overlay 进程开始常驻。
- 托盘右键「退出」会关闭托盘与字幕窗；之后在左侧「实时翻译」页点 ▶、按 `Ctrl+Alt+S` 或发 `/rt start` 会重新拉起 overlay 和托盘，不需要重启 DSH。
- 字幕窗默认隐藏；DSH 左侧导航会出现「实时翻译」入口（没有出现时刷新页面，或完全退出 DSH 后重开）。
- 托盘右键只有「退出」；语言、字号、行数、透明度、切分参数等都在左侧「实时翻译」页或命令里。
- 托盘与全局热键不依赖 DSH 网页窗口；控制页在 DSH 页面内，斜杠命令需要 DSH 会话。

## 使用

### 第一次开始

1. 在左侧导航点「实时翻译」打开控制页；不需要唤出额外窗口，也不会盖住对话。
2. 选择源语言与目的语言（例如 `自动 → English`）。
3. 点 ▶，或左键点托盘图标，或按 `Ctrl+Alt+S`，或发送 `/rt start`。
4. 如果还没有执行过 `/rt prepare`，这里会下载 SenseVoice 模型：状态点变黄，下载/加载完成后自动进入收听。
5. 播放视频或加入会议，字幕出现在屏幕底部（默认字号 20、3 行）。

默认显示 3 行（可 2–5）：最下面一行是当前正在说的话（先出原文，译文流式补上），上面几行是最近几句话，旧行逐渐变暗并在超出设定行数后滚出。默认显示「小字原文 + 大字译文」。字幕窗可以用鼠标直接拖动到你习惯的位置（多显示器下拖到哪个屏幕就留在哪个屏幕）；停止说话后历史行会保留，停止翻译（⏸ / `/rt stop`）时字幕窗关闭。

### 日常操作

| 想做什么 | 操作 |
| --- | --- |
| 开始 / 停止 | 左侧「实时翻译」页 ▶/⏸、托盘左键、`Ctrl+Alt+S`、`/rt start` / `/rt stop` |
| 切换语言 | 控制页两个下拉框、`/rt lang auto en` |
| 静音切分 | 控制页「分段 → 静音切分」 |
| 单句最长 | 控制页「分段 → 单句最长」 |
| 自动暂停 | 控制页「自动暂停」 |
| 调字号 | `Ctrl+Alt+↑` / `Ctrl+Alt+↓`，或控制页「字幕 → 字号」 |
| 显示几行 | 控制页「行数」2–5 |
| 移动字幕窗 | 直接用鼠标拖动，可拖到任意显示器 |
| 调透明度 | 控制页「透明度」滑块（20%–100%） |
| 原文/双语 | `Ctrl+Alt+B`，或控制页「显示原文」勾选 |
| 清屏 | `Ctrl+Alt+C`，或控制页「清屏」 |
| 恢复默认配置 | 控制页「默认配置」（重置切分、自动暂停与字幕，语言保持不变） |
| 重新连接音频 | 控制页「重连音频」、`/rt restart` |
| 只看某个应用的声音 | `/rt app chrome.exe`，`/rt app off` 恢复系统声音 |

`/rt stop` 停止采集并关闭字幕窗，左侧「实时翻译」页仍可随时打开，overlay 与托盘继续常驻，随时可以再次开始。再次开始后从空历史重新累积。

### 不采音频先调样式

```text
/rt test 你好世界
```

`/rt test` 要等翻译完成后才上屏；该行会一直保留，直到下一次清屏或被新句子顶掉。

### 验证安装

```text
/rt status
```

应看到 `状态: idle`、`识别: 待机`，且「翻译」显示可用的 provider / model。播放一段语音后，`延迟` 的样本数会增加。

## 卸载

```powershell
dsh plugin --profile rt remove dsh-rt-translation
```

如需同时删除模型缓存，删除 `$env:USERPROFILE\.dsh\speech-to-text\sensevoice`。运行期设置保存在 `rt` profile 的 `cordis.patch.yml`，默认是 `$env:USERPROFILE\.dsh\profiles\rt\cordis.patch.yml`。

## 分段与自动暂停

不再区分「会议/影视」模式；默认值取原会议参数。以下参数都能在左侧「实时翻译」页里直接调，改动会持久化到 profile：

| 设置 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| 静音切分 `silenceMs` | 550 ms | 100–3000 ms | 停顿多久认为一句话结束。低于正常换气/分句停顿（约 300–500 ms）会把一句话切成两半，只显示前半句或后半句 |
| 单句最长 `maxSegmentMs` | 8000 ms | 1000–30000 ms | 连续说话时强制切分的最长时长；太短会在词中间切断 |
| 自动暂停 `autoPauseAfterMs` | 120 s | 0–3600 s（0 = 关闭） | 连续这么久没有语音就停止采集，按开始恢复 |

字幕行数（3，可 2–5）、字号（20）、透明度、阅读时间和双语开关同样在控制页里。收听中修改切分会自动重连一次采集，立即生效。

分段器还保留 400 ms 的句首缓冲（`segment.preRollMs`），并把整段音频（含句尾轻声）原样送识别：会议里句尾降调、语气词常常比句首轻十几 dB，按电平裁剪会把它们当静音丢掉。如果仍觉得句子被切碎，优先把静音切分调到 600–800 ms，而不是调低它。

调乱了也不用记默认值：控制页「操作 → 默认配置」会立刻把切分、自动暂停与字幕恢复默认值，播放中会顺带重连一次采集，并写回 profile。「默认配置」不会改语言——语言描述的是你在听什么，不算调参。

## UI 与热键配置

以下配置写在 profile 的 `cordis.patch.yml` 中，修改后重启 DSH：

```yaml
- id: rt-translation
  name: dsh-rt-translation
  config:
    ui:
      tray: true                 # 是否创建托盘图标
    hotkeys:
      enabled: true              # 是否注册全局热键
    segment:
      silenceMs: 550             # 静音切分（ms）
      maxSegmentMs: 8000         # 单句最长（ms）
      preRollMs: 400             # 句首缓冲（ms），保留轻声起句
    autoPauseAfterMs: 120000     # 长静音自动暂停；0 = 关闭
    subtitle:
      maxLines: 3                # 显示几句（2–5）：最后一行为当前句
      fontSize: 20               # 字号
      opacity: 0.72              # 字幕窗不透明度（0.1–1）
      minReadMs: 1800            # 译文至少可读多久才允许滚出
```

字幕位置不再需要配置：字幕窗默认在屏幕底部居中，直接拖动即可，拖到副屏后会留在副屏；静音时保留最近几行，不会自动清空（`holdMs` 仅为兼容保留）。

## 热键

| 热键 | 作用 |
| --- | --- |
| `Ctrl+Alt+S` | 开始 / 停止 |
| `Ctrl+Alt+C` | 清空字幕 |
| `Ctrl+Alt+↑` / `Ctrl+Alt+↓` | 字号 +2 / -2 |
| `Ctrl+Alt+B` | 切换双语原文 |

## 斜杠命令

| 命令 | 作用 |
| --- | --- |
| `/rt prepare` | 预下载并加载 SenseVoice 模型，不开始字幕采集 |
| `/rt start` / `/rt stop` | 开始 / 停止；stop 同时隐藏字幕（控制页仍可打开） |
| `/rt status` | 状态、识别器、翻译路由、P50/P90 延迟、最近错误 |
| `/rt lang <src> <tgt>` | 设置语言，如 `/rt lang auto en` |
| `/rt app <name>` / `/rt app off` | 只采集指定进程 / 恢复系统声音 |
| `/rt model <provider> <model>` | 覆盖翻译模型 |
| `/rt restart` | 重新连接默认音频设备 |
| `/rt test <text>` | 不采音频，直接翻译并上屏 |

模型也可以直接调用工具 `rt_translate`（`action=prepare|start|stop|status`，可选 `source`、`target`）。

## 已知限制

- 独占全屏（DirectX exclusive）游戏之上无法保证显示；请改为无边框全屏。
- 切换默认输出设备后 `loopback-capture` 不会自动迁移端点；用 `/rt restart` 或控制页「重连音频」。
- 多显示器 DPI 不同时按主显示器缩放。
- 指定应用模式取该进程名下的第一个 PID；同名多实例暂不区分。
- v1 只支持 Windows；Linux 的扩展点见下节。
- 首次准备语音模型时控制页只显示「准备模型…」，暂时没有细粒度下载进度条和中途取消按钮。
- 控制页暂时没有「翻译模型」选择；请用 `/rt model <provider> <model>`。
- 强制切分长句后，重叠部分的文本去重尚未实现。
- 字体默认使用统一字体，尚未按目的语言自动选择字体；多显示器只按主显示器定位。
- `debug.dumpAudioDir` 尚未接入，不会把音频落盘。
- 托盘图标使用 `assets/icon.jpeg`（自动缩放为 32×32）；替换该文件后重启 DSH 即可换图标。
- 控制页在左侧导航里，不会覆盖对话；侧边栏收起时只显示图标。

## 自检与排障

验证托盘图标能从 `assets/icon.jpeg` 生成（输出 `PASS tray icon 32x32`，退出码 0）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File assets/overlay/overlay.ps1 -SelfTestIcon
```

只验证多行滚动窗口与多屏定位（不弹窗，9 + 5 个断言，退出码 0）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File assets/overlay/overlay.ps1 -SelfTestRows
powershell -NoProfile -ExecutionPolicy Bypass -File assets/overlay/overlay.ps1 -SelfTestPosition
```

只验证 WPF 叠加窗（1.5 s 示例字幕，退出码 0）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File assets/overlay/overlay.ps1 -SelfTest
```

验证双语文案也能显示：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File assets/overlay/overlay.ps1 -SelfTestMeeting
```

检查 overlay 是否在运行：

```powershell
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*overlay.ps1*' } |
  Select-Object ProcessId, CommandLine
```

常见问题：

- 输入框里没有 `/rt`、或发了命令没有反应：插件入口没有加载成功，不是命令没注册。先确认仓库根目录执行过 `npm install`，且 `node_modules\@deepseek-ai\schemastery`、`node_modules\loopback-capture` 都存在；再在 Desktop「插件」页把 `dsh-rt-translation` 停用后重新启用（或完全退出 DSH 后重开），让入口重新加载。恢复后托盘和 overlay 进程也会一起出现。
- 看不到托盘：先跑上面的 `-SelfTest`；若自检正常，检查 DSH 启动日志里是否有 `[rt-translation] overlay start failed`。
- 没有译文：`/rt status` 看「翻译」路由；没有默认模型时用 `/rt model <provider> <model>`。
- 没有声音：确认播放设备是默认输出；指定应用模式确认进程名（如 `chrome.exe`）。
- 模型选择器显示「暂无可用模型」：当前 profile 缺少 LLM provider 配置，按「作为 bundle 安装」一节的 YAML 补到 profile 的 `cordis.patch.yml` 后重启。
- 首次 `/rt start` 长时间停在「准备中」：正在下载约 240 MB 的 SenseVoice 模型。安装后先执行 `/rt prepare` 可以避免这段等待，`/rt status` 会显示下载百分比；模型缓存后不会再下载。

## 架构与 Linux 扩展点

```text
loopback-capture (PCM 48k stereo)
  → DownmixResampler (16k mono)
  → Segmenter (能量 VAD + pre-roll)
  → SenseVoice (ctx.speechToText)
  → Translator (ctx.llm.stream)
  → SubtitleModel
  → WindowsWpfRenderer (NDJSON over stdio) → overlay.ps1 (WPF)
```

与平台相关的只有两处：

- `src/capture.ts` 的 `createLoopbackCapture(platform)`：`loopback-capture` 本身已支持 Linux PipeWire，只需补应用名到 PID 的解析和权限处理。
- `src/subtitle/windows-wpf.ts` + `assets/overlay/overlay.ps1`：实现 `SubtitleRenderer` 接口即可换成 GTK/Qt/其他叠加窗；协议、控制器、命令和翻译链路不需要改。

`src/index.ts` 在非 Windows 平台会明确报错，避免半可用状态。

## 已验证

### 自动化回归（2026-11-24）

- `npm test`：77/77 通过（含面板路由与快照/动作测试）。
- `overlay.ps1 -SelfTestRows`：9/9 通过（行窗口、当前句在最后一行、译文最短阅读、静音后保留历史行）。
- `overlay.ps1 -SelfTestIcon`：`PASS tray icon 32x32`，退出码 0。
- `overlay.ps1 -SelfTest`、`-SelfTestMeeting` 均输出 `selftest window visible=True`，退出码 0。
- NDJSON 冒烟（`style` / `ui` / `cue` / `clear` / `shutdown`）正常退出。
- `npm run typecheck` 仍受本地 checkout 路径缺失影响，见交接文档。

### 多显示器拖动回归（2026-11-25）

- `overlay.ps1 -SelfTestPosition`：5/5 通过（初始底部居中、右侧/负坐标副屏保持、副屏下缘不被主屏钳制、非法坐标回退）。
- `-SelfTestRows` 9/9、`-SelfTestIcon` 1/1、`-SelfTest` 退出码 0，无回归。
- 单元测试 91/91（本机沙箱内用 `node --test --test-isolation=none "tests/**/*.test.ts"` 等价运行）。
- 真机多屏拖动仍需人工确认：拖到副屏后继续出字幕应留在副屏。

### 真机验收（Windows 11 + DSH Web + `qwen-token-plan-cn / deepseek-v4.1-flash`）

- 系统回环采集（`system-exclude-self`）→ SenseVoice → LLM 翻译 → WPF 字幕全链路可用。
- 中文语音 → 英文：4 个样本，P50 975 ms / P90 1417 ms；分段队列 0 ms、识别 73 ms、首字 834 ms。
- 英译中：先显示实时原文，译文到达后同一行补上译文；上方几行保留最近几句，最后一行为当前句。
- 默认显示小字原文 + 大字译文；行数 3（可 2–5）。左侧「实时翻译」页含状态、播放、源/目的语言、静音切分、单句最长、自动暂停、字号、行数、透明度与阅读时间。
- overlay 窗口置顶、透明、不进任务栏；可用鼠标直接拖动，拖动后会保持当前位置。
- `/rt stop` 后 5 秒：DSH Node 进程 CPU 约 0.28%、overlay 约 0.11%（20 核占比）；overlay 进程保留，热键可再次开始。
- 全局热键：`Ctrl+Alt+S` 从停止态到 `preparing → listening` 约 40 ms；`Ctrl+Alt+C` 清屏；`Ctrl+Alt+B` 切换双语。
- `/rt lang`、`/rt model`、控制页里的切分/字幕设置都会持久化到 profile，重启 DSH 后保持。

`/rt test <text>` 在翻译完成后才上屏，并常驻到下一次清屏。截图验证时请使用 DPI-aware 工具，否则在 200% 缩放下会截到字幕上方区域。

### 尚未人工验收

- 左侧「实时翻译」入口与页面在重启/刷新后的实际加载（`dsh.client` 浏览器半）。
- 多显示器：把字幕窗拖到副屏后，继续出字幕是否稳定留在副屏（2026-11-25 修复）。
- 真实会议软件共享整个屏幕时的字幕可见性。
- 2–5 行历史在连续对白下的滚动与遮挡效果（10 分钟压测）。
- 拔插耳机或切换默认输出设备后的自动恢复与 `/rt restart`。
- 独占全屏播放器上的置顶限制提示（控制页状态行）。
- 托盘左键开始/停止、右键退出；托盘退出后可从控制页或 `/rt start` 重新拉起。
- 中/英/日/韩/粤五语种音频两两互译矩阵（当前系统 TTS 只覆盖中/英）。
- 首次模型下载的进度显示与中途取消。
