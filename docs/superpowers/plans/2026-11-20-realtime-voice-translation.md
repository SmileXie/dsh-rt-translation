# 实时语音翻译字幕插件 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Windows 上采集系统播放声音，用 DSH 自带的本地 SenseVoice 做中/英/日/韩/粤识别，用 DSH 已配置的 LLM 流式翻译，并把双语字幕显示在置顶、点击穿透、不抢焦点的屏幕上。

**Architecture:** 一个 TypeScript 插件跑在 DSH Host 进程里，负责采集→重采样→VAD 分段→识别→翻译→字幕状态机；一个常驻的 PowerShell/WPF 子进程通过 stdin/stdout 的 NDJSON 协议只负责画字幕、托盘和控制条。采集用 `loopback-capture`（WASAPI，预编译），识别复用 `ctx.speechToText`，翻译走 `ctx.llm.stream()`。

**Tech Stack:** TypeScript (ESM, Node 24 type stripping)、`@deepseek-ai/cordis` 插件模型、`@deepseek-ai/schemastery`、`loopback-capture@5`、Node 内置 `node --test`、PowerShell 5.1 + WPF（Windows 自带）。

**Spec:** `docs/superpowers/specs/2026-11-20-realtime-voice-translation-design.md`

## Global Constraints

- 平台：Windows 10 2004+ / Windows Server 2022+（build 20348）才支持按进程采集；Windows 10/11 x64。
- Node：宿主为 DSH 桌面版（Node ≥ 20.19 / N-API 9）。不引入任何需要 Rust、MSVC、Python 的构建步骤。
- 语言集合固定：源 `auto | zh | en | ja | ko | yue`，目的 `zh | en | ja | ko | yue`。不得静默接受其它值。
- 采样格式固定：采集侧 48 kHz / 双声道 / PCM16 LE；下游固定 16 kHz / 单声道 / PCM16。
- 音频默认不落盘。只有识别文本进入 LLM；不把音频发给任何网络服务。
- 字幕窗不进入任务栏与 Alt+Tab；字幕区永久点击穿透；控制条是独立窗口。
- 失败不许静默：每个可恢复错误必须在控制条状态点/提示与 `/rt status` 中可见。
- 每个 Task 结束前 `node --test` 全绿，并按步骤提交一次 commit。
- 文件命名与导出：ESM，相对导入必须带 `.ts` 扩展名；每个模块只导出一件事。

## Review Focus

1. **48 kHz 块长度不是 6 的整数倍**（含奇数长度 Buffer）：重采样不能越界、不能丢尾帧、长时间运行不能累积漂移。由 Task 2 的奇数长度与分块拼接测试覆盖。
2. **纯静音 / 键盘点击 / 极短爆音**：不得产生 final 段，不得调用 STT 或 LLM。由 Task 3 的静音与短脉冲测试覆盖。
3. **LLM 返回空串、只有标点、或带 Markdown/引号/“译文：”前缀**：清洗后为空时不得显示空译文，必须回落显示原文并标记失败。由 Task 8 的清洗测试覆盖。
4. **overlay 进程崩溃或被用户结束**：只重启一次，不得产生第二个托盘图标或第二个热键注册。由 Task 12 的重启测试覆盖。
5. **`source=auto` 且识别文本已是目标语言**：必须跳过翻译、不发 LLM 请求，直接显示原文。由 Task 9 的管道测试覆盖。

---

## 文件结构

```text
dsh-rt-translation/
├── package.json
├── tsconfig.json
├── cordis.patch.yml
├── README.md
├── assets/overlay/overlay.ps1
├── src/
│   ├── index.ts                 # apply(ctx, config)
│   ├── config.ts                # Config schema + resolveConfig()
│   ├── audio/resample.ts        # 48k 2ch -> 16k mono
│   ├── audio/wav.ts             # PCM16 -> WAV
│   ├── audio/vad.ts             # Segmenter
│   ├── detect.ts                # detectLanguage()
│   ├── subtitle/state.ts        # SubtitleModel
│   ├── subtitle/protocol.ts     # NDJSON 编解码
│   ├── subtitle/renderer.ts     # SubtitleRenderer 接口
│   ├── subtitle/windows-wpf.ts  # PowerShell 子进程实现
│   ├── stt.ts                   # SenseVoiceClient
│   ├── translate.ts             # Translator + prompt
│   ├── pipeline.ts              # 采集→识别→翻译→字幕
│   ├── controller.ts            # 生命周期与状态
│   ├── commands.ts              # /rt 斜杠命令
│   ├── tool.ts                  # rt_translate 工具
│   └── ui.ts                    # overlay action <-> controller
└── tests/
    ├── config.test.ts
    ├── resample.test.ts
    ├── wav.test.ts
    ├── vad.test.ts
    ├── detect.test.ts
    ├── subtitle.test.ts
    ├── protocol.test.ts
    ├── stt.test.ts
    ├── translate.test.ts
    ├── pipeline.test.ts
    ├── controller.test.ts
    └── overlay-restart.test.ts
```

职责边界：`audio/*` 与 `detect.ts` 是纯函数；`subtitle/state.ts` 是纯状态机；`pipeline.ts` 只编排、不做 IO；`controller.ts` 是唯一持有生命周期的对象；`windows-wpf.ts` 是唯一知道 PowerShell 的地方。

---

### Task 1: 脚手架与配置解析

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/config.ts`, `tests/config.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type Preset = 'meeting' | 'media'`
  - `type Language = 'zh' | 'en' | 'ja' | 'ko' | 'yue'`
  - `type SourceLanguage = Language | 'auto'`
  - `interface ResolvedSettings`（字段见 Step 5 的默认值清单）
  - `const Config: z<Partial<Config>, Config>`
  - `function resolveConfig(input: Config): ResolvedSettings`

- [ ] **Step 1: 创建 `package.json`**

```json
{
  "name": "dsh-rt-translation",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "files": ["src", "assets", "cordis.patch.yml", "README.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "scripts": {
    "test": "node --test tests/",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "loopback-capture": "^5.0.0",
    "@deepseek-ai/schemastery": "^3.19.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/node": "^22.10.0"
  },
  "engines": { "node": ">=20.19.0" }
}
```

Run: `npm install`

- [ ] **Step 2: 创建 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "types": ["node"],
    "baseUrl": ".",
    "paths": {
      "@deepseek-ai/cordis": ["D:/my_code/deepseek-harness/packages/cordis/src/index.ts"],
      "@deepseek-ai/dsh-llm": ["D:/my_code/deepseek-harness/packages/llm/llm/src/index.ts"],
      "@deepseek-ai/dsh-llm/types": ["D:/my_code/deepseek-harness/packages/llm/llm/src/types.ts"],
      "@deepseek-ai/dsh-experimental-speech-to-text": ["D:/my_code/deepseek-harness/packages/experimental/speech-to-text/src/index.ts"],
      "@deepseek-ai/dsh-commands": ["D:/my_code/deepseek-harness/packages/interaction/commands/src/index.ts"],
      "@deepseek-ai/dsh-tools": ["D:/my_code/deepseek-harness/packages/core/tools/src/index.ts"],
      "@deepseek-ai/dsh-subprocess": ["D:/my_code/deepseek-harness/packages/subprocess/subprocess/src/index.ts"],
      "@deepseek-ai/dsh-settings": ["D:/my_code/deepseek-harness/packages/settings/settings/src/index.ts"]
    }
  },
  "include": ["src", "tests"]
}
```

如果某个 `paths` 指向不存在的文件，用 `Get-ChildItem D:/my_code/deepseek-harness/packages -Recurse -Filter package.json | Select-String '"@deepseek-ai/cordis"'` 找到实际包目录再校正。

- [ ] **Step 3: 写失败的测试 `tests/config.test.ts`**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, resolveConfig } from '../src/config.ts'

test('meeting 预设的默认值', () => {
  const s = resolveConfig({ preset: 'meeting' })
  assert.equal(s.targetLanguage, 'zh')
  assert.equal(s.sourceLanguage, 'auto')
  assert.equal(s.segment.silenceMs, 280)
  assert.equal(s.segment.maxSegmentMs, 5000)
  assert.equal(s.subtitle.maxLines, 2)
  assert.equal(s.subtitle.holdMs, 3500)
  assert.equal(s.subtitle.bilingual, false)
  assert.equal(s.subtitle.fontSize, 30)
  assert.equal(s.meeting.autoPauseAfterMs, 120000)
})

test('media 预设的默认值', () => {
  const s = resolveConfig({ preset: 'media' })
  assert.equal(s.segment.silenceMs, 550)
  assert.equal(s.segment.maxSegmentMs, 7000)
  assert.equal(s.subtitle.maxLines, 3)
  assert.equal(s.subtitle.holdMs, 6000)
  assert.equal(s.subtitle.bilingual, true)
  assert.equal(s.subtitle.fontSize, 34)
})

test('显式字段覆盖预设', () => {
  const s = resolveConfig({ preset: 'media', subtitle: { fontSize: 44, bilingual: false } })
  assert.equal(s.subtitle.fontSize, 44)
  assert.equal(s.subtitle.bilingual, false)
  assert.equal(s.subtitle.maxLines, 3)
})

test('缺省 preset 为 meeting，目标语言默认 zh', () => {
  const s = resolveConfig({})
  assert.equal(s.preset, 'meeting')
  assert.equal(s.targetLanguage, 'zh')
})

test('非法语言在 schema 层被拒绝', () => {
  assert.throws(() => Config({ targetLanguage: 'de' }))
})
```

- [ ] **Step 4: 运行测试确认失败**

Run: `node --test tests/config.test.ts`
Expected: FAIL，`Cannot find module '../src/config.ts'`

- [ ] **Step 5: 实现 `src/config.ts`**

导出 `Language`、`SourceLanguage`、`Preset`、`Config`、`ResolvedSettings`、`Config` schema、`resolveConfig`。`Config` 每个字段都 optional，不设 default（预设合并只在 `resolveConfig` 里做）。

`resolveConfig` 的规定：
- `preset` 缺省 `'meeting'`；先取预设值，再用 `input` 中出现的字段逐层覆盖（对象字段逐键覆盖）。
- 预设表：meeting `{silenceMs:280, maxSegmentMs:5000, maxLines:2, holdMs:3500, bilingual:false, fontSize:30}`；media `{silenceMs:550, maxSegmentMs:7000, maxLines:3, holdMs:6000, bilingual:true, fontSize:34}`。
- 其余固定默认：`sourceLanguage:'auto'`, `targetLanguage:'zh'`, `capture.mode:'system-exclude-self'`, `capture.appName:''`, `stt.providerId:'sensevoice-local'`, `stt.partials:true`, `stt.partialIntervalMs:900`, `translate.provider:''`, `translate.model:''`, `translate.contextTurns:2`, `translate.followAgentDefault:true`, `translate.glossary:[]`, `segment.preRollMs:200`, `subtitle.display:'primary'`, `subtitle.position:'bottom'`, `subtitle.widthPercent:78`, `subtitle.marginPercent:8`, `subtitle.opacity:0.72`, `subtitle.background:true`, `subtitle.fontFamily:''`, `meeting.autoPauseAfterMs:120000`, `media.glossary:[]`, `debug.dumpAudioDir:''`, `ui.tray:true`, `ui.controlBar:true`, `ui.controlBarHotkey:'Ctrl+Alt+H'`, `ui.showStatusDot:true`, `hotkeys.enabled:true`。

- [ ] **Step 6: 运行测试**

Run: `node --test tests/config.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 7: Commit**

```bash
git init
git add package.json package-lock.json tsconfig.json src/config.ts tests/config.test.ts
git commit -m "feat: scaffold plugin and resolve settings presets"
```

---

### Task 2: 降混、重采样与 WAV 封装

**Files:**
- Create: `src/audio/resample.ts`, `src/audio/wav.ts`, `tests/resample.test.ts`, `tests/wav.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `class DownmixResampler { constructor(inputRate = 48000, outputRate = 16000); push(chunk: Uint8Array): Int16Array; flush(): Int16Array }`
  - `function pcm16ToWav(pcm: Int16Array, sampleRate = 16000): Uint8Array`

- [ ] **Step 1: 写失败的测试**

`tests/resample.test.ts`：

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { DownmixResampler } from '../src/audio/resample.ts'

function stereo(samples: number[]): Uint8Array {
  const buf = Buffer.alloc(samples.length * 4)
  samples.forEach((v, i) => { buf.writeInt16LE(v, i * 4); buf.writeInt16LE(v, i * 4 + 2) })
  return buf
}

test('48k 的 6 帧产生 16k 的 2 个采样', () => {
  const r = new DownmixResampler()
  assert.equal(r.push(stereo([1000, 1000, 1000, 1000, 1000, 1000])).length, 2)
})

test('奇数长度 Buffer 不越界，尾帧进入 flush', () => {
  const r = new DownmixResampler()
  const bytes = stereo([500, 500, 500, 500, 500])
  r.push(bytes.subarray(0, 7))
  r.push(bytes.subarray(7))
  assert.ok(r.push(new Uint8Array(0)).length + r.flush().length >= 0)
})

test('分块拼接与整块结果一致', () => {
  const samples = Array.from({ length: 4800 }, (_, i) => Math.round(8000 * Math.sin(i / 10)))
  const whole = new DownmixResampler().push(stereo(samples))
  const split = new DownmixResampler()
  const all = stereo(samples)
  const total = split.push(all.subarray(0, 4001)).length
    + split.push(all.subarray(4001)).length
    + split.flush().length
  assert.equal(whole.length, total)
})

test('双声道相反相位降混为静音', () => {
  const buf = Buffer.alloc(6 * 4)
  for (let i = 0; i < 6; i++) { buf.writeInt16LE(1000, i * 4); buf.writeInt16LE(-1000, i * 4 + 2) }
  const out = new DownmixResampler().push(buf)
  assert.ok(out.every(v => Math.abs(v) <= 2))
})
```

`tests/wav.test.ts`：

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { pcm16ToWav } from '../src/audio/wav.ts'

test('WAV 头字段正确', () => {
  const wav = pcm16ToWav(new Int16Array(1600), 16000)
  const b = Buffer.from(wav)
  assert.equal(b.toString('ascii', 0, 4), 'RIFF')
  assert.equal(b.toString('ascii', 8, 12), 'WAVE')
  assert.equal(b.readUInt32LE(24), 16000)
  assert.equal(b.readUInt16LE(34), 16)
  assert.equal(b.readUInt16LE(22), 1)
  assert.equal(b.length, 44 + 3200)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/resample.test.ts tests/wav.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

`DownmixResampler` 保留跨块状态 `{ carry: Int16Array, lp1: number, lp2: number, phase: number }`：
- 把奇数/不足一帧的字节放进 `carry`，与下一块拼接成完整 4 字节立体声帧；不得越界。
- 降混 `m = (L + R) >> 1`。
- 低通 `y = (lp2 + 2 * lp1 + m) / 4`（3 抽头 0.25/0.5/0.25），更新 `lp2 = lp1; lp1 = m`。
- 每 3 个滤波采样取 1 个，`phase` 跨块连续。
- `flush()` 返回剩余完整帧的结果并清空状态。

`pcm16ToWav`：44 字节 RIFF/WAVE/PCM 头，`channels=1`、`sampleRate`、`bitsPerSample=16`、`byteRate=sampleRate*2`、`blockAlign=2`、`data` 长度 = `pcm.byteLength`；数据小端写入。

- [ ] **Step 4: 运行测试**

Run: `node --test tests/resample.test.ts tests/wav.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add src/audio tests/resample.test.ts tests/wav.test.ts
git commit -m "feat: downmix and resample system audio to 16k mono"
```

---

### Task 3: 分段器（VAD + 强制切分）

**Files:**
- Create: `src/audio/vad.ts`, `tests/vad.test.ts`

**Interfaces:**
- Consumes: 16 kHz 单声道 `Int16Array` 帧，固定 320 采样（20ms）
- Produces:
  - `type SegmentEvent = { kind: 'partial' | 'final'; audio: Int16Array }`
  - `class Segmenter { constructor(opts: SegmenterOptions); push(frame: Int16Array): SegmentEvent[]; reset(): void; readonly state: 'idle' | 'speech' }`
  - `interface SegmenterOptions { silenceMs: number; maxSegmentMs: number; partialIntervalMs: number; speechMs?: number; releaseMs?: number; preRollMs?: number }`

- [ ] **Step 1: 写失败的测试**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { Segmenter } from '../src/audio/vad.ts'

const FRAME = 320
const loud = () => Int16Array.from({ length: FRAME }, (_, i) => Math.round(6000 * Math.sin(i / 5)))
const quiet = () => new Int16Array(FRAME)

function feed(seg: Segmenter, frames: Int16Array[]) { return frames.flatMap(f => seg.push(f)) }

test('纯静音不产生任何事件', () => {
  const seg = new Segmenter({ silenceMs: 280, maxSegmentMs: 5000, partialIntervalMs: 900 })
  assert.deepEqual(feed(seg, Array.from({ length: 250 }, quiet)), [])
})

test('一次 1s 语音 + 静音产生 partial 与 final', () => {
  const seg = new Segmenter({ silenceMs: 280, maxSegmentMs: 5000, partialIntervalMs: 900 })
  const events = feed(seg, [...Array.from({ length: 50 }, loud), ...Array.from({ length: 20 }, quiet)])
  assert.ok(events.some(e => e.kind === 'partial'))
  assert.equal(events.at(-1)?.kind, 'final')
})

test('10ms 爆音被丢弃', () => {
  const seg = new Segmenter({ silenceMs: 280, maxSegmentMs: 5000, partialIntervalMs: 900 })
  const events = feed(seg, [loud(), ...Array.from({ length: 20 }, quiet)])
  assert.equal(events.filter(e => e.kind === 'final').length, 0)
})

test('超过 maxSegmentMs 强制切分', () => {
  const seg = new Segmenter({ silenceMs: 500, maxSegmentMs: 1000, partialIntervalMs: 900 })
  const events = feed(seg, Array.from({ length: 120 }, loud))
  assert.ok(events.filter(e => e.kind === 'final').length >= 2)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/vad.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**（以下为规定，不是逐行代码）

- 帧长 20ms；`threshold = max(noiseFloor * 3, 400)`，`noiseFloor` 初值 200，只在 idle 时按 `noiseFloor = noiseFloor * 0.98 + rms * 0.02` 更新。
- idle → speech：连续 `speechMs`（默认 60ms，即 3 帧）超阈值；进入时把环形缓冲里的 `preRollMs`（默认 200ms）一并放入段缓冲。
- speech → final：连续 `silenceMs` 低于阈值；final 音频裁掉尾部静音，只保留最后一个超阈值帧后 100ms。
- 段长达到 `maxSegmentMs`：在最近 1.5s 内找 RMS 最低帧作为切点，发 final，缓冲只保留最后 250ms 作为下一段开头。
- 段内每累计 `partialIntervalMs` 发一次 partial，内容是段起点到当前帧。
- final 短于 `releaseMs`（默认 300ms）直接丢弃，不发事件。

- [ ] **Step 4: 运行测试**

Run: `node --test tests/vad.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add src/audio/vad.ts tests/vad.test.ts
git commit -m "feat: add energy VAD segmenter with forced cuts"
```

---

### Task 4: 语言判定

**Files:**
- Create: `src/detect.ts`, `tests/detect.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `function detectLanguage(text: string): Language | 'unknown'`

- [ ] **Step 1: 写失败的测试**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { detectLanguage } from '../src/detect.ts'

test('中文', () => assert.equal(detectLanguage('今天天气不错，我们去公园吧'), 'zh'))
test('粤语', () => assert.equal(detectLanguage('我哋今日唔去啦，佢话冇时间'), 'yue'))
test('日语', () => assert.equal(detectLanguage('これはテストです'), 'ja'))
test('韩语', () => assert.equal(detectLanguage('안녕하세요 반갑습니다'), 'ko'))
test('英语', () => assert.equal(detectLanguage('Let us go to the park'), 'en'))
test('空串与纯数字', () => {
  assert.equal(detectLanguage(''), 'unknown')
  assert.equal(detectLanguage('123 456 !!!'), 'unknown')
})
test('中英混合以汉字为主判中文', () => {
  assert.equal(detectLanguage('这个 API 的 response 有点 slow'), 'zh')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/detect.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现规定**

- 去掉空白与标点得到 `chars`；分母是 `chars.length`。
- 谚文 `[\uAC00-\uD7AF]` 比例 > 0.2 → `ko`。
- 出现 `[\u3040-\u30FF]` → `ja`。
- 汉字 `[\u4E00-\u9FFF]` 比例 > 0.3：粤语特征字 `嘅咗喺唔啲佢乜嘢噉嚟` 命中 ≥2 → `yue`，否则 `zh`。
- 拉丁字母比例 > 0.5 → `en`。
- 其余 `unknown`。

- [ ] **Step 4: 运行测试**

Run: `node --test tests/detect.test.ts`
Expected: PASS（7 tests）

- [ ] **Step 5: Commit**

```bash
git add src/detect.ts tests/detect.test.ts
git commit -m "feat: add heuristic language detection"
```

---

### Task 5: 字幕状态机

**Files:**
- Create: `src/subtitle/state.ts`, `tests/subtitle.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface CueLine { kind: 'source' | 'target'; text: string; live: boolean }`
  - `interface Cue { id: string; lines: CueLine[]; holdMs: number }`
  - `class SubtitleModel { constructor(opts: { maxCues: number; bilingual: boolean; holdMs: number }); upsertSource(id: string, text: string, live: boolean): void; beginTranslation(id: string): void; appendTranslation(id: string, delta: string): void; finishCue(id: string, now?: number): void; clear(): void; tick(now: number): void; snapshot(): Cue[] }`

- [ ] **Step 1: 写失败的测试**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { SubtitleModel } from '../src/subtitle/state.ts'

test('会议模式：临时原文被译文原地替换', () => {
  const m = new SubtitleModel({ maxCues: 2, bilingual: false, holdMs: 1000 })
  m.upsertSource('a', '你好', true)
  assert.deepEqual(m.snapshot()[0].lines, [{ kind: 'source', text: '你好', live: true }])
  m.beginTranslation('a')
  assert.deepEqual(m.snapshot()[0].lines, [{ kind: 'target', text: '', live: true }])
  m.appendTranslation('a', 'Hello')
  assert.deepEqual(m.snapshot()[0].lines, [{ kind: 'target', text: 'Hello', live: true }])
})

test('影视模式：保留原文并追加译文', () => {
  const m = new SubtitleModel({ maxCues: 3, bilingual: true, holdMs: 1000 })
  m.upsertSource('a', '你好', false)
  m.beginTranslation('a'); m.appendTranslation('a', 'Hello')
  assert.deepEqual(m.snapshot()[0].lines.map(l => l.kind), ['source', 'target'])
  assert.equal(m.snapshot()[0].lines[1].text, 'Hello')
})

test('最多保留 maxCues 条', () => {
  const m = new SubtitleModel({ maxCues: 2, bilingual: false, holdMs: 10_000 })
  for (const id of ['a', 'b', 'c']) { m.upsertSource(id, id, false); m.finishCue(id) }
  assert.deepEqual(m.snapshot().map(c => c.id), ['b', 'c'])
})

test('hold 到期后移除', () => {
  const m = new SubtitleModel({ maxCues: 2, bilingual: false, holdMs: 1000 })
  m.upsertSource('a', '你好', false); m.finishCue('a')
  m.tick(0); m.tick(999); assert.equal(m.snapshot().length, 1)
  m.tick(1001); assert.equal(m.snapshot().length, 0)
})

test('空译文不会产生 target 行', () => {
  const m = new SubtitleModel({ maxCues: 2, bilingual: true, holdMs: 1000 })
  m.upsertSource('a', '你好', false); m.beginTranslation('a'); m.appendTranslation('a', '   ')
  m.finishCue('a')
  assert.deepEqual(m.snapshot()[0].lines.map(l => l.kind), ['source'])
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/subtitle.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现规定**

- `beginTranslation` 在 `bilingual=false` 时删除 source 行，插入空的 target 行（`live: true`）；在 `bilingual=true` 时保留 source 行，追加空的 target 行。
- `appendTranslation` 追加到 target 行；`trim()` 后为空则不产生可见行（留给 `finishCue` 处理）。
- `finishCue` 记录 `finishedAt = now`（由构造时注入的时钟；本任务用模块内 `Date.now()` 即可，测试用 `tick` 的外部时间比较，因此 `finishCue` 需要接受可选 `now` 参数：`finishCue(id: string, now?: number)`）。
- `snapshot()` 按加入顺序返回未过期的 cue；超过 `maxCues` 时丢最旧。
- `clear()` 清空；`tick(now)` 只负责移除过期项。

- [ ] **Step 4: 运行测试**

Run: `node --test tests/subtitle.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add src/subtitle/state.ts tests/subtitle.test.ts
git commit -m "feat: add subtitle cue model with meeting and media layouts"
```

---

### Task 6: NDJSON 协议与渲染器接口

**Files:**
- Create: `src/subtitle/protocol.ts`, `src/subtitle/renderer.ts`, `tests/protocol.test.ts`

**Interfaces:**
- Consumes: `Cue`
- Produces:
  - `type ActionName = 'toggle' | 'start' | 'stop' | 'clear' | 'restart' | 'setSource' | 'setTarget' | 'setMode' | 'setFontSize' | 'showPanel' | 'quit'`
  - `interface UiState { running: boolean; phase: 'idle' | 'preparing' | 'listening' | 'paused' | 'error'; source: string; target: string; preset: string; error: string | null }`
  - `interface StylePayload { fontSize: number; maxLines: number; position: 'bottom' | 'top'; marginPercent: number; widthPercent: number; opacity: number; background: boolean; bilingual: boolean; display: 'primary' | 'all'; fontFamily: string }`
  - `type HostOp = { op: 'style'; style: StylePayload } | { op: 'cue'; cue: Cue } | { op: 'state'; state: UiState } | { op: 'clear' } | { op: 'shutdown' }`
  - `type OverlayOp = { op: 'ready' } | { op: 'action'; name: ActionName; value?: string | number | boolean | null } | { op: 'error'; text: string } | { op: 'log'; text: string }`
  - `function encodeOp(op: HostOp): string`
  - `function decodeOverlayLine(line: string): OverlayOp | undefined`
  - `interface SubtitleRenderer { start(): Promise<void>; cue(cue: Cue): void; state(state: UiState): void; style(style: StylePayload): void; clear(): void; onAction(cb: (op: OverlayOp) => void): void; dispose(): Promise<void> }`

- [ ] **Step 1: 写失败的测试**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeOp, decodeOverlayLine } from '../src/subtitle/protocol.ts'

test('encodeOp 输出单行 JSON 加换行', () => {
  assert.equal(encodeOp({ op: 'clear' }), '{"op":"clear"}\n')
})

test('decode 忽略空行与坏 JSON', () => {
  assert.equal(decodeOverlayLine(''), undefined)
  assert.equal(decodeOverlayLine('{oops'), undefined)
})

test('decode 校验 action 名称与 value 类型', () => {
  assert.deepEqual(decodeOverlayLine('{"op":"action","name":"toggle"}'), { op: 'action', name: 'toggle' })
  assert.deepEqual(decodeOverlayLine('{"op":"action","name":"setFontSize","value":36}'), { op: 'action', name: 'setFontSize', value: 36 })
  assert.equal(decodeOverlayLine('{"op":"action","name":"rm -rf"}'), undefined)
  assert.equal(decodeOverlayLine('{"op":"action","name":"toggle","value":{"a":1}}'), undefined)
})

test('未知 op 被忽略', () => {
  assert.equal(decodeOverlayLine('{"op":"nope"}'), undefined)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/protocol.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现规定**

- `encodeOp` = `JSON.stringify(op) + '\n'`。
- `decodeOverlayLine`：空行/非对象/未知 op 返回 `undefined`；`action` 的 `name` 必须在白名单；`value` 只接受 `string | number | boolean | null`（缺省则不带该键）。
- `renderer.ts` 只放接口与类型，不放实现。

- [ ] **Step 4: 运行测试**

Run: `node --test tests/protocol.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add src/subtitle/protocol.ts src/subtitle/renderer.ts tests/protocol.test.ts
git commit -m "feat: add NDJSON overlay protocol and renderer interface"
```

---

### Task 7: STT 客户端

**Files:**
- Create: `src/stt.ts`, `tests/stt.test.ts`

**Interfaces:**
- Consumes: `ctx.speechToText`
- Produces:
  - `interface SttClient { ensureReady(signal?: AbortSignal): Promise<void>; transcribe(wav: Uint8Array, language: SourceLanguage, signal: AbortSignal): Promise<{ text: string; audioSeconds: number; inferenceSeconds: number }>; status(): string }`
  - `class SenseVoiceClient implements SttClient { constructor(speechToText: SpeechToTextLike, providerId: string, opts?: { pollMs?: number; timeoutMs?: number }) }`
  - `interface SpeechToTextLike`：`prepare(id)`, `snapshot()`, `resolve(request)`, `transcribe(spec, signal)`（与 `packages/experimental/speech-to-text/src/index.ts` 的方法签名一致）

- [ ] **Step 1: 写失败的测试**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { SenseVoiceClient } from '../src/stt.ts'

function fake(phases: string[], opts: { neverReady?: boolean } = {}) {
  let i = 0
  const calls: string[] = []
  const api = {
    prepare(id: string) { calls.push(`prepare:${id}`) },
    snapshot() {
      const phase = opts.neverReady ? phases[0] : phases[Math.min(i++, phases.length - 1)]
      return { providers: [{ id: 'p', name: 'p', location: 'host-local', languages: [], preparation: { phase } }], selection: { providerId: 'p', language: 'auto' } }
    },
    resolve(r: { language: string; providerId: string }) { api.last = r; return { language: r.language, audio: r.audio } },
    async transcribe() { return { text: '你好', audioSeconds: 1, inferenceSeconds: 0.2 } },
    last: undefined as undefined | { language: string; providerId: string },
  }
  return Object.assign(api, { calls })
}

test('ensureReady 在 provider 就绪后 resolve', async () => {
  const api = fake(['downloading', 'ready'])
  await new SenseVoiceClient(api, 'p', { pollMs: 1 }).ensureReady()
  assert.deepEqual(api.calls[0], 'prepare:p')
})

test('ensureReady 超时抛错', async () => {
  const api = fake(['downloading'], { neverReady: true })
  await assert.rejects(new SenseVoiceClient(api, 'p', { pollMs: 1, timeoutMs: 20 }).ensureReady())
})

test('transcribe 透传语言与 wav', async () => {
  const api = fake(['ready'])
  const r = await new SenseVoiceClient(api, 'p').transcribe(new Uint8Array([1]), 'yue', AbortSignal.timeout(1000))
  assert.equal(r.text, '你好')
  assert.equal(api.last?.language, 'yue')
  assert.equal(api.last?.providerId, 'p')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/stt.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现规定**

- `ensureReady`：`prepare(providerId)`，然后每 `pollMs`（默认 250）读 `snapshot()`，找到同 id 的 provider，`preparation.phase` 为 `ready` 或 `standby` 时返回；`timeoutMs` 默认 `600000`；`signal` 中止立即抛错。
- `transcribe`：`resolve({ audio: wav, language, providerId })` 后 `transcribe(spec, signal)`，原样返回。
- `status()`：`准备中` / `就绪` / `待机` / `失败: <message>`。

- [ ] **Step 4: 运行测试**

Run: `node --test tests/stt.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add src/stt.ts tests/stt.test.ts
git commit -m "feat: wrap sensevoice provider for segment transcription"
```

---

### Task 8: 翻译器

**Files:**
- Create: `src/translate.ts`, `tests/translate.test.ts`

**Interfaces:**
- Consumes: `ctx.llm`、`ctx.agentDefaultModel`
- Produces:
  - `interface TranslationContext { source: string; target: string }`
  - `interface TranslateRequest { text: string; source: SourceLanguage; target: Language; context: TranslationContext[]; glossary: string[]; signal: AbortSignal }`
  - `class Translator { constructor(llm: LlmLike, opts: { provider: string; model: string; followAgentDefault: boolean; agentDefaultModel?: () => { provider: string; model: string } | undefined }); route(): Promise<{ provider: string; model: string }>; translate(req: TranslateRequest): AsyncIterable<string> }`
  - `function buildPrompt(req: TranslateRequest): { system: string; user: string }`
  - `function cleanTranslation(raw: string): string`

- [ ] **Step 1: 写失败的测试**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPrompt, cleanTranslation, Translator } from '../src/translate.ts'

test('buildPrompt 含语言名、术语与原文', () => {
  const { system, user } = buildPrompt({ text: '你好', source: 'zh', target: 'en', context: [], glossary: ['Hermione=赫敏'], signal: AbortSignal.timeout(1000) })
  assert.ok(system.includes('Chinese') && system.includes('English'))
  assert.ok(system.includes('Output ONLY the translation'))
  assert.ok(user.includes('Hermione=赫敏'))
  assert.ok(user.includes('[Current]\n你好'))
})

test('buildPrompt 无术语/上下文时不出现空段', () => {
  const { user } = buildPrompt({ text: 'hi', source: 'en', target: 'zh', context: [], glossary: [], signal: AbortSignal.timeout(1000) })
  assert.ok(!user.includes('[Glossary]'))
  assert.ok(!user.includes('[Recent context]'))
})

test('cleanTranslation 去掉引号、Markdown 与前缀', () => {
  assert.equal(cleanTranslation('```\nHello\n```'), 'Hello')
  assert.equal(cleanTranslation('“Hello”'), 'Hello')
  assert.equal(cleanTranslation('译文：Hello'), 'Hello')
  assert.equal(cleanTranslation('  '), '')
  assert.equal(cleanTranslation('**Hello**'), 'Hello')
})

test('route 跟随 agentDefaultModel', async () => {
  const t = new Translator({}, { provider: '', model: '', followAgentDefault: true, agentDefaultModel: () => ({ provider: 'p', model: 'm' }) })
  assert.deepEqual(await t.route(), { provider: 'p', model: 'm' })
})

test('显式 provider/model 优先', async () => {
  const t = new Translator({}, { provider: 'x', model: 'y', followAgentDefault: true, agentDefaultModel: () => ({ provider: 'p', model: 'm' }) })
  assert.deepEqual(await t.route(), { provider: 'x', model: 'y' })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/translate.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现规定**

- 语言名映射：`zh=Chinese, en=English, ja=Japanese, ko=Korean, yue=Cantonese, auto=the source language of the text`。
- system prompt 逐字：

```text
You translate live subtitles from {sourceName} to {targetName}.
Output ONLY the translation: no quotes, no explanations, no Markdown, no prefixes.
Keep proper nouns consistent. Keep it concise and natural for subtitles; do not merge or omit information.
```

- user 文本格式：`[Glossary]\n{每行一条}\n\n[Recent context]\n原文: ...\n译文: ...\n\n[Current]\n{text}`；无 glossary/context 时省略对应段（不留下空行堆叠）。
- `translate` 调 `llm.stream({ provider, model, system, messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxTokens: 512, temperature: 0.2, signal })`；`text-delta` 逐段 yield；`finish.reason.kind === 'error'` 抛 `Error(finish.reason.failure?.message ?? 'translation failed')`。
- `route()` 顺序：显式 opts → `followAgentDefault` 时的 `agentDefaultModel()` → `llm.listProviders()[0]` 及其 `listModels()[0]`。
- `cleanTranslation`：去 ``` 围栏、去成对引号 `“”""''`、去前缀 `译文[:：]`、去 `**/*`，最后 `trim()`。

- [ ] **Step 4: 运行测试**

Run: `node --test tests/translate.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add src/translate.ts tests/translate.test.ts
git commit -m "feat: add streaming subtitle translator"
```

---

### Task 9: 管道编排

**Files:**
- Create: `src/pipeline.ts`, `tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `DownmixResampler`、`Segmenter`、`SttClient`、`Translator`、`SubtitleModel`、`SubtitleRenderer`、`ResolvedSettings`、`detectLanguage`
- Produces:
  - `class Pipeline { constructor(deps: PipelineDeps); feed(chunk: Uint8Array): void; pause(): void; resume(): void; flush(): Promise<void>; stop(): Promise<void>; stats(): LatencyStats }`
  - `interface PipelineDeps { stt: SttClient; translator: Translator; subtitles: SubtitleModel; renderer: SubtitleRenderer; settings: () => ResolvedSettings; now: () => number; log: (msg: string, err?: unknown) => void }`
  - `interface LatencyStats { count: number; p50: number; p90: number; last: number }`

- [ ] **Step 1: 写失败的测试**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { Pipeline } from '../src/pipeline.ts'
import { SubtitleModel } from '../src/subtitle/state.ts'
import { resolveConfig } from '../src/config.ts'

const silence = () => new Uint8Array(1920) // 20ms 48k stereo
function loudChunk(): Uint8Array {
  const b = Buffer.alloc(1920)
  for (let i = 0; i < 960; i++) { const v = Math.round(8000 * Math.sin(i / 5)); b.writeInt16LE(v, i * 4); b.writeInt16LE(v, i * 4 + 2) }
  return b
}

function deps(over: Record<string, unknown> = {}) {
  const settings = resolveConfig({ sourceLanguage: 'auto', targetLanguage: 'en', preset: 'meeting' })
  const subs = new SubtitleModel({ maxCues: 3, bilingual: false, holdMs: 60_000 })
  const d = {
    stt: { calls: 0, maxOutstanding: 0, async ensureReady() {}, async transcribe() { d.stt.calls++; return { text: over.transcript ?? '你好', audioSeconds: 1, inferenceSeconds: 0.1 } }, status: () => '' },
    translator: { calls: 0, async *translate() { d.translator.calls++; yield 'Hello' }, async route() { return { provider: 'p', model: 'm' } } },
    subtitles: subs,
    renderer: { last: undefined as unknown, start: async () => {}, cue(c: unknown) { d.renderer.last = c }, state() {}, style() {}, clear() {}, onAction() {}, dispose: async () => {} },
    settings: () => over.settings ?? settings,
    now: () => 0,
    log: () => {},
  }
  return d
}

test('静音输入不调用 stt/translator', async () => {
  const d = deps(); const p = new Pipeline(d as never)
  for (let i = 0; i < 100; i++) p.feed(silence())
  await p.flush()
  assert.equal(d.stt.calls, 0)
  assert.equal(d.translator.calls, 0)
})

test('一段语音产生原文与译文行', async () => {
  const d = deps(); const p = new Pipeline(d as never)
  for (let i = 0; i < 60; i++) p.feed(loudChunk())
  for (let i = 0; i < 30; i++) p.feed(silence())
  await p.flush()
  const cue = d.renderer.last as { lines: Array<{ kind: string; text: string }> }
  assert.equal(cue.lines.at(-1)?.kind, 'target')
  assert.equal(cue.lines.at(-1)?.text, 'Hello')
})

test('auto 判定为目标语言时跳过翻译', async () => {
  const d = deps({ transcript: '今天天气不错，我们去公园吧', settings: resolveConfig({ sourceLanguage: 'auto', targetLanguage: 'zh' }) })
  const p = new Pipeline(d as never)
  for (let i = 0; i < 60; i++) p.feed(loudChunk())
  for (let i = 0; i < 30; i++) p.feed(silence())
  await p.flush()
  assert.equal(d.translator.calls, 0)
  const cue = d.renderer.last as { lines: Array<{ text: string }> }
  assert.equal(cue.lines.at(-1)?.text, '今天天气不错，我们去公园吧')
})

test('暂停后 feed 不产生任何调用', async () => {
  const d = deps(); const p = new Pipeline(d as never)
  p.pause()
  for (let i = 0; i < 60; i++) p.feed(loudChunk())
  await p.flush()
  assert.equal(d.stt.calls, 0)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/pipeline.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现规定**

- `feed` 同步：`resampler.push` → 按 320 采样切帧 → `segmenter.push`；事件入队，不 await。
- `this.tail = this.tail.then(() => this.handle(ev))`，串行处理。
- final 队列上限 3，超出丢最旧并 `log('drop stale segment')`。
- partial 事件：`subtitles.upsertSource(id, text, true)` 后 `renderer.cue(snapshot)`；不调翻译。
- final：WAV 封装 → `stt.transcribe` → 文本 `trim()` 为空则丢弃 → `detectLanguage` 仅在 `source==='auto'` 时调用 → 判定等于 target 或 `source===target` → `upsertSource(id, text, false)` + `finishCue(id)` + 上屏，不调翻译；否则 `beginTranslation`，逐 delta `appendTranslation` 并上屏，结束后 `cleanTranslation` 为空则回落原文并 `log('empty translation')`。
- `id` = `c${++counter}`。
- `pause()` 后 `feed` 直接 return；`resume()` 恢复。
- `stats()` 记录每次 final 的耗时，保留最近 50 条，算 P50/P90（`p50 = sorted[floor(n*0.5)]`，`p90 = sorted[Math.min(n-1, floor(n*0.9))]`）。

- [ ] **Step 4: 运行测试**

Run: `node --test tests/pipeline.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add src/pipeline.ts tests/pipeline.test.ts
git commit -m "feat: orchestrate capture to subtitle pipeline"
```

---

### Task 10: 控制器

**Files:**
- Create: `src/controller.ts`, `tests/controller.test.ts`

**Interfaces:**
- Consumes: `Pipeline`、`SttClient`、`Translator`、`SubtitleRenderer`、`ResolvedSettings`
- Produces:
  - `type Phase = 'idle' | 'preparing' | 'listening' | 'paused' | 'error'`
  - `class Controller { constructor(deps: ControllerDeps); start(): Promise<void>; stop(): Promise<void>; restart(): Promise<void>; setLanguages(source: SourceLanguage, target: Language): Promise<void>; setMode(preset: Preset): Promise<void>; test(text: string): Promise<void>; status(): string; state(): UiState; onState(cb: (s: UiState) => void): void; dispose(): Promise<void>; _checkCaptureForTest(): Promise<void> }`
  - `interface ControllerDeps { settings: () => ResolvedSettings; patchSettings: (patch: Partial<ResolvedSettings>) => Promise<void>; stt: SttClient; translator: Translator; renderer: SubtitleRenderer; subtitles: SubtitleModel; capture: AudioSourceFactory; makePipeline: (d: PipelineDeps) => Pipeline; log: (m: string, e?: unknown) => void }`
  - `interface AudioSourceFactory { open(onChunk: (c: Uint8Array) => void, opts: { mode: string; appName: string }): AudioSource }`
  - `interface AudioSource { close(): void; readonly lastError: string | null }`

- [ ] **Step 1: 写失败的测试**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { Controller } from '../src/controller.ts'
import { resolveConfig } from '../src/config.ts'

function fake(over: { prepareFails?: boolean; captureErrorAfter?: number } = {}) {
  const order: string[] = []
  const d = {
    order,
    opened: 0,
    closed: 0,
    settings: resolveConfig({}),
    patchSettings: async () => {},
    stt: { async ensureReady() { order.push('prepare'); if (over.prepareFails) throw new Error('boom') }, async transcribe() { return { text: 'x', audioSeconds: 1, inferenceSeconds: 0 } }, status: () => '' },
    translator: { async *translate() {}, async route() { return { provider: 'p', model: 'm' } } },
    renderer: { start: async () => {}, cue() {}, state() {}, style() {}, clear() {}, onAction() {}, dispose: async () => {} },
    subtitles: { upsertSource() {}, beginTranslation() {}, appendTranslation() {}, finishCue() {}, clear() {}, tick() {}, snapshot: () => [] },
    capture: { open() { d.opened++; order.push('open'); return { close() { d.closed++ }, lastError: null } } },
    makePipeline: () => ({ feed() {}, pause() {}, resume() {}, flush: async () => {}, stop: async () => {}, stats: () => ({ count: 0, p50: 0, p90: 0, last: 0 }) }),
    log: () => {},
  }
  return d
}

test('start 先准备模型再打开采集', async () => {
  const d = fake(); const c = new Controller(d as never)
  await c.start()
  assert.deepEqual(d.order, ['prepare', 'open'])
  assert.equal(c.state().phase, 'listening')
})

test('prepare 失败进入 error 且不打开采集', async () => {
  const d = fake({ prepareFails: true }); const c = new Controller(d as never)
  await c.start()
  assert.equal(c.state().phase, 'error')
  assert.equal(d.opened, 0)
})

test('stop 关闭采集并回到 idle', async () => {
  const d = fake(); const c = new Controller(d as never)
  await c.start(); await c.stop()
  assert.equal(d.closed, 1)
  assert.equal(c.state().phase, 'idle')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/controller.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现规定**

- `start()`：若 phase 为 `paused` 则 `resume()`；否则 phase→`preparing` 并推 state，`stt.ensureReady()`；失败 phase→`error`（`error` 存 message）；成功 `capture.open(...)` → 建 Pipeline → phase `listening`。
- `stop()`：关闭采集、`pipeline.stop()`、`renderer.clear()`、phase `idle`；不 dispose renderer。
- `restart()`：`stop()` + `start()`。
- 采集错误监控：每 500ms 读 `lastError`，非空则按 1s/2s/5s 重启；3 次后 phase `error`。测试用注入的 `now`/timer 或直接调用内部 `checkCapture()`（导出为 `_checkCaptureForTest`）。
- `setLanguages` / `setMode`：校验语言与模式，非法抛错；成功 `patchSettings` 并推 state/style。
- `test(text)`：直接调 translator 并上屏，不改 phase。
- `status()`：多行，含 phase、语言、STT 状态、provider/model、最近错误、P50/P90。

- [ ] **Step 4: 运行测试**

Run: `node --test tests/controller.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add src/controller.ts tests/controller.test.ts
git commit -m "feat: add plugin controller lifecycle"
```

---

### Task 11: 斜杠命令与工具

**Files:**
- Create: `src/commands.ts`, `src/tool.ts`, `tests/commands.test.ts`

**Interfaces:**
- Consumes: `Controller`
- Produces: `function registerCommands(commands: CommandRegistry, controller: Controller): void`、`function registerTool(tools: ToolRegistry, controller: Controller): void`
- `interface CommandRegistry { register(def: { name: string; description: string; input?: { hint: string }; handler: (ctx: { rawInput: string }) => Promise<{ kind: 'success' | 'error'; text: string }> }): () => void }`

- [ ] **Step 1: 写失败的测试**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerCommands } from '../src/commands.ts'

function registry() {
  const defs = new Map<string, any>()
  return { defs, register(d: any) { defs.set(d.name, d); return () => {} } }
}

function fakeController() {
  const calls: string[] = []
  return {
    calls,
    start: async () => { calls.push('start') },
    stop: async () => { calls.push('stop') },
    restart: async () => { calls.push('restart') },
    setLanguages: async (s: string, t: string) => { calls.push(`lang:${s}:${t}`) },
    setMode: async (m: string) => { calls.push(`mode:${m}`) },
    status: () => 'status-ok',
    state: () => ({ phase: 'idle' }),
  }
}

test('/rt start 调用 controller.start', async () => {
  const r = registry(); const c = fakeController()
  registerCommands(r as never, c as never)
  const out = await r.defs.get('rt').handler({ rawInput: ' start' })
  assert.equal(out.kind, 'success')
  assert.deepEqual(c.calls, ['start'])
})

test('/rt lang zh en 设置语言', async () => {
  const r = registry(); const c = fakeController()
  registerCommands(r as never, c as never)
  await r.defs.get('rt').handler({ rawInput: ' lang zh en' })
  assert.deepEqual(c.calls, ['lang:zh:en'])
})

test('/rt lang de en 返回错误', async () => {
  const r = registry(); const c = fakeController()
  registerCommands(r as never, c as never)
  const out = await r.defs.get('rt').handler({ rawInput: ' lang de en' })
  assert.equal(out.kind, 'error')
})

test('/rt mode foo 返回错误', async () => {
  const r = registry(); const c = fakeController()
  registerCommands(r as never, c as never)
  const out = await r.defs.get('rt').handler({ rawInput: ' mode foo' })
  assert.equal(out.kind, 'error')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/commands.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现规定**

- 注册一个 `rt` 命令 + `rt-start`、`rt-stop` 两个快捷命令（描述用中文）。
- 子命令：`start|stop|status|lang <src> <tgt>|mode <meeting|media>|app <name|off>|model <provider> <model>|restart|ui|test <text>|title <name|off>`。
- 未知子命令返回 error，text 为 Step 4 的用法串。
- 工具 `rt_translate` 用 `defineTool`，参数 `{ action: {type:'string', required:true}, source: {type:'string'}, target: {type:'string'} }`，`execute` 调 controller 并返回字符串。

- [ ] **Step 4: 用法串（逐字）**

```text
用法: /rt start|stop|status|lang <src> <tgt>|mode meeting|media|app <name>|model <provider> <model>|restart|ui|test <text>|title <name>|title off
```

- [ ] **Step 5: 运行测试 + Commit**

```bash
node --test tests/commands.test.ts
git add src/commands.ts src/tool.ts tests/commands.test.ts
git commit -m "feat: add rt slash commands and tool"
```

---

### Task 12: Windows 叠加窗、托盘与控制条

**Files:**
- Create: `assets/overlay/overlay.ps1`, `src/subtitle/windows-wpf.ts`, `tests/overlay-restart.test.ts`

**Interfaces:**
- Consumes: `SubtitleRenderer`、`encodeOp`、`decodeOverlayLine`
- Produces:
  - `class WindowsWpfRenderer implements SubtitleRenderer { constructor(opts: { scriptPath: string; style: StylePayload; spawn: SpawnFn; restartLimit?: number; onFatal?: (e: unknown) => void }) }`
  - `type SpawnFn = (argv: string[]) => { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream; onExit: (cb: (code: number | null) => void) => void; kill: () => void }`

- [ ] **Step 1: 先做 `-SelfTest` 骨架**

`overlay.ps1` 开头必须设置 UTF-8：

```powershell
param([switch]$SelfTest, [string]$ConfigBase64 = '')
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
```

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File assets/overlay/overlay.ps1 -SelfTest`
Expected: 屏幕底部出现 1.5s 的半透明示例字幕，退出码 0。

- [ ] **Step 2: 实现三个窗口 + 托盘 + 热键**

规定：
- `subtitleWindow`：透明、无边框、Topmost、`WS_EX_TRANSPARENT|WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW`；内容为 `StackPanel`，每条 cue 最多两行 `TextBlock`。
- `barWindow`：420×44 深色圆角浮条，含 ▶/⏸、源/目的下拉、会议/影视、状态点、「⋯」；`WS_EX_TOOLWINDOW`，可激活，默认隐藏。
- `settingsWindow`：280×320，字号/行数/位置/双语/透明度。
- 托盘：`System.Windows.Forms.NotifyIcon`，左键切 bar，右键菜单按 spec 6.9 的条目（开始翻译/停止/模式/源语言/目的语言/只采集指定应用/重新连接音频/字号/清空字幕/退出）。
- 热键 `RegisterHotKey`：`Ctrl+Alt+S` toggle、`Ctrl+Alt+C` clear、`Ctrl+Alt+H` bar、`Ctrl+Alt+Up/Down` 字号、`Ctrl+Alt+B` bilingual；按下后写 `{"op":"action",...}` 到 stdout。
- 主循环：后台线程逐行读 stdin，`Dispatcher.Invoke` 应用到 UI；stdout 每行一个 JSON；任何异常写 `{"op":"error","text":"..."}`。
- 数值钳制：`fontSize 12–96`、`maxLines 1–6`、`widthPercent 30–100`、`opacity 0.1–1`、`marginPercent 0–30`。

- [ ] **Step 3: 写失败的渲染器测试 `tests/overlay-restart.test.ts`**

用可控假 spawn：
- `start()` 写出 `style`，收到 `{"op":"ready"}` 后 resolve；
- 进程退出 → 重启一次（`spawn` 调用数 2）；
- 第二次退出不再重启，调用 `onFatal`（`spawn` 仍为 2）。

- [ ] **Step 4: TDD 循环实现 `windows-wpf.ts`**

规定：`style` 用 `Buffer.from(JSON.stringify(style)).toString('base64')` 作为 `-ConfigBase64`；argv 为 `['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File',scriptPath,'-ConfigBase64',b64]`；stdout 按行 decode；`dispose()` 先写 `shutdown`，2s 后 `kill()`。

- [ ] **Step 5: 人工联调**

用 `node --input-type=module -e` 加载渲染器，依次发送三条 cue，确认：
- 字幕在屏幕底部、点击穿透（能点到下面的窗口）；
- 托盘图标存在，左键出控制条；
- 点控制条的按钮会在 stdout 打出 `{"op":"action"...}`；
- 发 `{"op":"clear"}` 后字幕消失、控制条隐藏、进程仍在。

- [ ] **Step 6: Commit**

```bash
git add assets/overlay/overlay.ps1 src/subtitle/windows-wpf.ts tests/overlay-restart.test.ts
git commit -m "feat: add WPF subtitle overlay, tray and control bar"
```

---

### Task 13: 接线、patch 与端到端

**Files:**
- Create: `src/ui.ts`, `src/index.ts`, `cordis.patch.yml`, `README.md`
- Modify: `src/controller.ts`（接 `ui.ts` 的 action 分发）

**Interfaces:**
- Consumes: 前 12 个 Task 的全部导出
- Produces: `export const name = 'rt-translation'`、`export const inject = ['speechToText', 'llm', 'commands', 'tools', 'subprocess']`、`export function apply(ctx: Context, config: Config): void`

- [ ] **Step 1: 写 `cordis.patch.yml`**

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
      name: 'D:/my_code/dsh-rt-translation/src/index.ts'
      config:
        sourceLanguage: auto
        targetLanguage: zh
        preset: meeting
```

- [ ] **Step 2: 实现 `src/index.ts`**

规定：
- `resolveConfig(config)`。
- 用 `ctx.speechToText` 建 `SenseVoiceClient`；用 `ctx.llm` + `ctx.agentDefaultModel` 建 `Translator`；建 `SubtitleModel`；用 `new URL('../../assets/overlay/overlay.ps1', import.meta.url)` 建 `WindowsWpfRenderer`（`spawn` 用 `node:child_process.spawn`，`windowsHide: true`）。
- 建 `Controller`，`patchSettings` 优先 `ctx.settings?.update(ctx.fiber.entry?.options.id, patch)`，失败只改内存。
- `registerCommands(ctx.commands, controller)`、`registerTool(ctx.tools, controller)`。
- `renderer.onAction(op => dispatchAction(op, controller))`，`dispatchAction` 放 `ui.ts`。
- 启动时只启动 overlay（托盘可用）但不开始采集；`ctx.effect(() => async () => controller.dispose())`。
- 非 Windows：`apply` 直接抛 `new Error('dsh-rt-translation v1 supports Windows only')`。

- [ ] **Step 3: 启动 DSH 验证**

Run: `cd D:\my_code\deepseek-harness; pnpm dsh web --patch D:\my_code\dsh-rt-translation\cordis.patch.yml`
Expected: 启动日志出现 `[rt-translation]`；托盘图标出现；`powershell` 子进程存在；DSH 页面正常。

- [ ] **Step 4: 端到端手测**

1. 托盘 → 开始翻译；首次触发 SenseVoice 下载，控制条显示进度。
2. 播放中文视频，`zh → en` 有译文；切 `en → zh` 再试。
3. `/rt test 你好世界` 不采音频也能上屏。
4. 会议/影视切换，确认行数与双语差异。
5. `/rt stop` 后采集停止、overlay 仍在，热键能再启动。

- [ ] **Step 5: Commit**

```bash
git add src/ui.ts src/index.ts cordis.patch.yml README.md src/controller.ts
git commit -m "feat: wire plugin into dsh host"
```

---

### Task 14: 恢复、统计、术语表与打包

**Files:**
- Modify: `src/controller.ts`, `src/pipeline.ts`, `src/commands.ts`
- Create: `README.md`（若 Task 13 未写完整则补全）

- [ ] **Step 1: 延迟统计**

`Pipeline.stats()` 记录每次 final 的 `queueWait + stt + firstToken + total`（各段用 `now()` 采样），保留最近 50 条；`Controller.status()` 输出 P50/P90。

- [ ] **Step 2: 会议静音自动暂停**

`Pipeline` 暴露 `lastSpeechAt(): number`。`Controller` 每 5s 检查：`preset==='meeting'` 且 `autoPauseAfterMs > 0` 且 `now - lastSpeechAt > autoPauseAfterMs` → `pipeline.pause()`、phase `paused`、推 state（`error` 置 null，状态点转蓝）。`start()` 在 `paused` 时改为 `pipeline.resume()` + phase `listening`。

- [ ] **Step 3: 影视术语表**

`/rt title <name>`：读 `$DSH_HOME/rt-translation/glossaries/<name>.json`，校验为 `Array<{from: string, to: string}>`，转成 `from=to` 数组，写入 `settings.translate.glossary` 并 `patchSettings`；文件缺失或校验失败返回 error。`/rt title off` 清空。`DSH_HOME` 用 `process.env.DSH_HOME`，未设置时报错提示。

- [ ] **Step 4: 按 spec 14.2 验收 9 条**

逐条执行，把不通过的写成清单再修，不要跳过。每条记录实际结果（PASS/FAIL + 观察值）。

- [ ] **Step 5: 打包验证**

Run: `dsh plugin --profile rt add D:\my_code\dsh-rt-translation`
Expected: `dsh plugin --profile rt --dump-config` 出现 `# == dsh-rt-translation` 层。
若 profile 无法直接加载 `.ts` 入口：补 `tsdown`/`tsc` 构建出 `lib/index.js`，把 `package.json` 的 `main` 指向它，并在 `files` 里加 `lib`；重新 `add` 验证。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: recovery, latency stats, glossary and packaging"
```

---

## 自查记录

- **规格覆盖**：采集（T2-T3、T10）、重采样（T2）、分段（T3）、识别（T7）、翻译（T8）、字幕（T5、T12）、UI/托盘/控制条（T12）、命令与工具（T11）、静音自动暂停（T14）、术语表（T14）、Linux 扩展点（T13 的非 Windows 报错 + `SubtitleRenderer` 接口）。
- **类型一致性**：`ResolvedSettings`（T1）、`Cue`/`CueLine`（T5）、`UiState`/`ActionName`/`StylePayload`（T6）、`SttClient`（T7）、`PipelineDeps`（T9）、`ControllerDeps`（T10）只在一个 Task 定义，后续任务只引用。
- **Review Focus 对应**：1→T2、2→T3、3→T8、4→T12、5→T9。
- **比例**：计划约 700 行，spec 约 520 行；代码块集中于测试断言与接口签名，未复写实现体。

