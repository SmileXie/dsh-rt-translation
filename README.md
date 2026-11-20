# dsh-rt-translation

DeepSeek Harness 的实时系统声音翻译字幕插件：监听电脑正在播放的声音，用本机 SenseVoice 识别中/英/日/韩/粤，再用 DSH 已配置的 LLM 流式翻译，最后把字幕画在置顶、点击穿透的透明窗口里。

## 能做什么

- 源语言：自动、中文、English、日本語、한국어、粤语；目的语言：中/英/日/韩/粤。
- 会议与影视两套预设，行数、双语、停留时间、静音切分和自动暂停策略不同。
- 托盘菜单、悬浮控制条、全局热键、斜杠命令、模型工具五种入口共用同一个控制器。
- 字幕对屏幕共享**可见**（刻意不启用 `WDA_EXCLUDEFROMCAPTURE`），共享整个桌面或录屏时会出现在画面里。
- 字幕窗永久点击穿透、不抢焦点、不出现在 Alt+Tab；控制条是独立可点击窗口，默认隐藏。
- overlay 进程常驻，`/rt stop` 只停止采集并隐藏字幕，热键和托盘随时能再次开始。

## 环境要求

- Windows 10 20348+ 或 Windows 11。指定应用 / 排除自身的采集依赖 Windows 进程回环（build 20348+）。
- Node.js 24（DSH 自带 CLI 运行方式即可）。
- 首次开始翻译时会下载 SenseVoiceSmall INT8 模型（约 1 GB），之后离线可用。
- 需要一个可用的 DSH LLM 路由；默认跟随 DSH 当前默认模型。

## 安装

### 开发模式（直接用当前目录）

```powershell
cd D:\my_code\deepseek-harness
pnpm dsh web --patch D:\my_code\dsh-rt-translation\cordis.patch.yml
```

`cordis.patch.yml` 会同时挂载 `speech-to-text`、`speech-to-text-sensevoice` 和本插件。移动目录后需要同步修改里面的绝对路径。

### 作为 bundle 安装

```powershell
dsh --profile rt --from-default-profile web --dump-config
dsh plugin --profile rt add D:\my_code\dsh-rt-translation
dsh plugin --profile rt --dump-config
dsh --profile rt
```

`cordis.bundle.patch.yml` 使用包名 `dsh-rt-translation`，由 profile 内的插件目录解析。

## 第一次使用

1. 启动 DSH 后托盘会出现「DSH 实时字幕」图标，`powershell` overlay 进程常驻。
2. 点托盘图标或按 `Ctrl+Alt+H` 打开控制条，点 ▶（或托盘「开始翻译」）。
3. 首次会准备 SenseVoice：控制条状态点为黄色，`/rt status` 显示下载/加载进度；完成后自动开始收听。
4. 播放一段视频，字幕出现在屏幕底部。会议模式先显示临时原文，译文首个 token 到达后原地替换。

不采音频也可以先调样式：

```text
/rt test 你好世界
```

## 会议模式与影视模式

| 行为 | 会议 meeting | 影视 media |
| --- | --- | --- |
| 字幕行数 | 2 行 | 3 行 |
| 原文 | 只显示译文 | 原文 + 译文双语 |
| 字幕停留 | 3.5 s | 6 s |
| 静音切分 | 280 ms，偏快 | 550 ms，偏稳 |
| 长静音 | 120 s 无语音自动暂停 | 不自动暂停 |
| 术语表 | 不使用片名术语表 | 支持 `/rt title <name>` |

切换模式会立即把预设写入字幕样式；正在收听时会重连一次采集，让切分参数生效。

## 热键

| 热键 | 作用 |
| --- | --- |
| `Ctrl+Alt+S` | 开始 / 停止 |
| `Ctrl+Alt+C` | 清空字幕 |
| `Ctrl+Alt+H` | 显示 / 隐藏控制条 |
| `Ctrl+Alt+↑` / `Ctrl+Alt+↓` | 字号 +2 / -2 |
| `Ctrl+Alt+B` | 切换双语原文 |

## 斜杠命令

| 命令 | 作用 |
| --- | --- |
| `/rt start` / `/rt stop` | 开始 / 停止 |
| `/rt status` | 状态、识别器、翻译路由、P50/P90 延迟、最近错误 |
| `/rt lang <src> <tgt>` | 设置语言，如 `/rt lang auto en` |
| `/rt mode meeting|media` | 切换预设 |
| `/rt app <name>` / `/rt app off` | 只采集指定进程 / 恢复系统声音 |
| `/rt model <provider> <model>` | 覆盖翻译模型 |
| `/rt restart` | 重新连接默认音频设备 |
| `/rt ui` | 显示 / 隐藏控制条 |
| `/rt test <text>` | 不采音频，直接翻译并上屏 |
| `/rt title <name>` / `/rt title off` | 加载 / 清除影视术语表 |

模型也可以直接调用工具 `rt_translate`（`action=start|stop|status`，可选 `source`、`target`）。

## 术语表

文件路径：`$DSH_HOME/rt-translation/glossaries/<name>.json`

```json
[
  { "from": "Transformer", "to": "Transformer" },
  { "from": "注意力机制", "to": "attention mechanism" }
]
```

加载后每一条翻译请求都会带上术语表；`/rt title off` 清空。

## 已知限制

- 独占全屏（DirectX exclusive）游戏之上无法保证显示；请改为无边框全屏。
- 切换默认输出设备后 `loopback-capture` 不会自动迁移端点；用 `/rt restart` 或托盘「重新连接音频」。
- 多显示器 DPI 不同时按主显示器缩放。
- 指定应用模式取该进程名下的第一个 PID；同名多实例暂不区分。
- v1 只支持 Windows；Linux 的扩展点见下节。

## 自检与排障

只验证 WPF 叠加窗（1.5 s 示例字幕，退出码 0）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File assets/overlay/overlay.ps1 -SelfTest
```

检查 overlay 是否在运行：

```powershell
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*overlay.ps1*' } |
  Select-Object ProcessId, CommandLine
```

常见问题：

- 看不到托盘：先跑上面的 `-SelfTest`；若自检正常，检查 DSH 启动日志里是否有 `[rt-translation] overlay start failed`。
- 没有译文：`/rt status` 看「翻译」路由；没有默认模型时用 `/rt model <provider> <model>`。
- 没有声音：确认播放设备是默认输出；指定应用模式确认进程名（如 `chrome.exe`）。

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
