# 翻译背景（摘要 + 术语表）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在控制页输入一段背景，由一次模型调用产出可编辑的背景摘要与术语表，摘要每句注入、词条按句过滤后注入，从而让实时字幕里的人名与术语稳定。

**Architecture:** 三个纯函数管线（`parseModelPrep`、`selectGlossary`、`buildPrompt`）+ 一个 `Translator.prepareGlossary()` 方法 + 控制器上的四个动作，数据全部落在现有 `translate.*` 配置里并经 `patchSettings` 写 profile；`pipeline` 每段重读 `settings`，所以改词表下一句生效。浏览器半只加一张卡，无构建。

**Tech Stack:** Node ≥ 20.19 类型擦除直接跑 TS、`node --test`、`@deepseek-ai/schemastery`、手写 `client.js`（React 无 JSX）、WPF overlay（本计划不改）。

**Spec:** `docs/superpowers/specs/2026-11-25-background-glossary-design.md`

## Global Constraints

- 仅 Windows；无构建步骤；`src/*.ts` 由 Host 直接跑，测试用 `node --test "tests/**/*.test.ts"`。
- 不改 `assets/overlay/overlay.ps1`，不改 NDJSON 协议形状。
- `client.js` 是普通 bundle：无 JSX、无新依赖、只 `require('react')`；可用的 hook 只有 `useState/useEffect/useRef/useCallback`（测试 stub 只实现这四个）。
- 数值上限：`background` ≤ 2000 字符、`backgroundBrief` ≤ 300、存储词表 ≤ 200 行、每行 ≤ 120 字符、模型输出 ≤ 60 条、解析上限 80 条、每句注入 ≤ 12 条。
- 摘要与词条只经用户自己的 LLM；不新增音频落盘或云端 ASR。
- 每个任务结束跑 `node --test tests/<file>.test.ts`（或 `npm test`）并提交，提交信息用 `feat:` / `fix:` / `docs:` 前缀。
- 不要用 `npm run typecheck` 做门禁（`tsconfig.json` 的 `paths` 指向不存在的 checkout，已知失败）。

## Review Focus

- **句子没命中任何词条**：不出现 `[Glossary]` 段，也不能留下空段或空标题（用户会以为功能坏了，其实只是没命中）。
- **超长/畸形词表**：200 行、单行 200 字符、译文里带 `=`、大小写混合 —— 注入仍 ≤ 12 条、按小写子串匹配、不崩。
- **模型输出不守格式**：无 `[摘要]/[术语]` 标记、带编号/项目符号/代码围栏/CRLF/空结果 —— 能退化解析；空结果保留旧值并给提示。
- **面板输入越界**：非字符串、2500 字符背景、250 行词表、空字符串 —— 忽略或截断，不抛 500。
- **播放中改词表/摘要**：下一句生效，不重启采集、不断流。
- **准备失败/超时**：旧摘要与旧词表保留、`glossaryError` 可见、播放不中断。

---

### Task 1: 配置字段 `translate.background` / `translate.backgroundBrief`

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `ResolvedSettings['translate']` 增加 `background: string` 与 `backgroundBrief: string`；`Config['translate']` 增加同名可选字段；默认值 `''`。

- [ ] **Step 1: 写失败测试**

在 `tests/config.test.ts` 末尾加：

```ts
test('翻译背景与摘要默认空，且可显式覆盖', () => {
  const defaults = resolveConfig({})
  assert.equal(defaults.translate.background, '')
  assert.equal(defaults.translate.backgroundBrief, '')
  assert.deepEqual(defaults.translate.glossary, [])

  const explicit = resolveConfig({ translate: { background: '看《哈利·波特与魔法石》', backgroundBrief: '魔法学校观影场景' } })
  assert.equal(explicit.translate.background, '看《哈利·波特与魔法石》')
  assert.equal(explicit.translate.backgroundBrief, '魔法学校观影场景')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/config.test.ts`
Expected: FAIL，`defaults.translate.background` 为 `undefined`（`assert.equal` 失败）。

- [ ] **Step 3: 实现**

`src/config.ts` 三处：

1. `Config` 接口的 `translate?` 加 `background?: string; backgroundBrief?: string`（放在 `glossary` 前）。
2. `ResolvedSettings` 的 `translate` 加 `background: string; backgroundBrief: string`。
3. schema 的 `translate` 对象里加 `background: z.string().max(2000)`、`backgroundBrief: z.string().max(300)`（Schemastery 的 `z.string().max(n)` 已确认可用，超长会在 schema 层报错）。
4. `resolveConfig` 的 `translate` 里加 `background: input.translate?.background ?? ''`、`backgroundBrief: input.translate?.backgroundBrief ?? ''`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/config.test.ts`
Expected: PASS（3 个用例）。

- [ ] **Step 5: 提交**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add translation background config fields"
```

---

### Task 2: `selectGlossary` + `buildPrompt` 注入 `[Background]`

**Files:**
- Modify: `src/translate.ts`
- Test: `tests/translate.test.ts`

**Interfaces:**
- Consumes: `TranslateRequest.glossary`（已有）、Task 1 无依赖。
- Produces:
  - `TranslateRequest` 新增可选 `brief?: string`。
  - `export function selectGlossary(text: string, glossary: string[], limit = 12): string[]` —— 返回 `text` 中命中的词条（原文保持传入形式）。
  - `buildPrompt(req)` 在 `[Glossary]` 之前输出 `[Background]` 段（摘要为空则省略），`[Glossary]` 只含 `selectGlossary(req.text, req.glossary)` 结果，空则省略。

- [ ] **Step 1: 写失败测试**

替换 `tests/translate.test.ts` 里第一个用例（`buildPrompt 含语言名、术语与原文`），并在文件末尾加：

```ts
test('buildPrompt 只注入本句命中的词条', () => {
  const { user } = buildPrompt({
    text: 'Hermione 走进了大厅', source: 'zh', target: 'en', context: [],
    glossary: ['Hermione=赫敏', 'Quidditch=魁地奇'], signal: AbortSignal.timeout(1000),
  })
  assert.ok(user.includes('Hermione=赫敏'))
  assert.ok(!user.includes('Quidditch=魁地奇'))
})

test('selectGlossary 大小写不敏感、保留译文里的等号、限 12 条', () => {
  assert.deepEqual(selectGlossary('hermione 和 HERMIONE', ['Hermione=赫敏']), ['Hermione=赫敏'])
  assert.deepEqual(selectGlossary('用 C++ 写', ['C++=C++（编程语言）']), ['C++=C++（编程语言）'])
  assert.deepEqual(selectGlossary('聊魁地奇', ['魁地奇=Quidditch']), ['魁地奇=Quidditch'])
  const many = Array.from({ length: 20 }, (_, i) => `term${i}=词${i}`)
  assert.equal(selectGlossary(many.join(' '), many).length, 12)
})

test('selectGlossary 未命中返回空数组，纯词条按整行匹配', () => {
  assert.deepEqual(selectGlossary('今天天气不错', ['Hermione=赫敏']), [])
  assert.deepEqual(selectGlossary('用 Transformer 做微调', ['Transformer']), ['Transformer'])
})

test('buildPrompt 有摘要时加 [Background]，空摘要不留段', () => {
  const base = { text: 'hi', source: 'en' as const, target: 'zh' as const, context: [], glossary: [], signal: AbortSignal.timeout(1000) }
  const withBrief = buildPrompt({ ...base, brief: '一段魔法学校观影场景' })
  assert.ok(withBrief.user.includes('[Background]\n一段魔法学校观影场景'))
  assert.ok(withBrief.user.indexOf('[Background]') < withBrief.user.indexOf('[Current]'))
  assert.ok(!buildPrompt({ ...base, brief: '   ' }).user.includes('[Background]'))
})
```

同时改原第一个用例的 `text` 为 `'Hermione 来了'`（否则过滤后不再包含 `Hermione=赫敏`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/translate.test.ts`
Expected: FAIL —— `SyntaxError: ... does not provide an export named 'selectGlossary'`（或断言失败）。

- [ ] **Step 3: 实现**

`src/translate.ts`：

```ts
export interface TranslateRequest {
  text: string
  source: SourceLanguage
  target: Language
  context: TranslationContext[]
  glossary: string[]
  brief?: string
  signal: AbortSignal
}

/** Keep only glossary entries whose source form occurs in the sentence. */
export function selectGlossary(text: string, glossary: string[], limit = 12): string[] {
  const haystack = text.toLowerCase()
  const picked: string[] = []
  const seen = new Set<string>()
  for (const entry of glossary) {
    if (entry.trim() === '' || seen.has(entry)) continue
    const from = (entry.split('=')[0] ?? '').trim().toLowerCase()
    if (from === '' || !haystack.includes(from)) continue
    seen.add(entry)
    picked.push(entry)
    if (picked.length >= limit) break
  }
  return picked
}
```

`buildPrompt` 改为：先 `const brief = req.brief?.trim() ?? ''`，`if (brief !== '') parts.push(\`[Background]\n${brief}\`)`，再 `const matched = selectGlossary(req.text, req.glossary)`，`if (matched.length > 0) parts.push(...)`。其余不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/translate.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/translate.ts tests/translate.test.ts
git commit -m "feat: inject background brief and per-sentence glossary into prompt"
```

---

### Task 3: 准备调用 `buildPreparePrompt` / `parseModelPrep` / `Translator.prepareGlossary`

**Files:**
- Modify: `src/translate.ts`
- Test: `tests/translate.test.ts`

**Interfaces:**
- Consumes: `Translator.route()`（已有）、`NAMES`、`LlmLike`。
- Produces:
  - `export function buildPreparePrompt(req: { background: string; source: SourceLanguage; target: Language }): { system: string; user: string }`
  - `export function parseModelPrep(raw: string): { brief: string; glossary: string[] }`
  - `Translator.prepareGlossary(req: { background: string; source: SourceLanguage; target: Language; signal: AbortSignal }): Promise<{ brief: string; glossary: string[] }>`

- [ ] **Step 1: 写失败测试**

在 `tests/translate.test.ts` 末尾加：

```ts
test('buildPreparePrompt 要求摘要与原文=译文格式，并带目标语言', () => {
  const { system, user } = buildPreparePrompt({ background: '看《哈利·波特与魔法石》', source: 'auto', target: 'zh' })
  assert.ok(system.includes('Chinese'))
  assert.ok(system.includes('[摘要]') && system.includes('[术语]'))
  assert.ok(system.includes('='))
  assert.ok(user.includes('看《哈利·波特与魔法石》'))
})

test('parseModelPrep 解析标记、列表符号与代码围栏', () => {
  const raw = '```\n[摘要]\n哈利·波特观影场景，涉及魔法学校一年级。\n\n[术语]\n- Hermione=赫敏\n2. Quidditch=魁地奇\nQuidditch=魁地奇\n```'
  assert.deepEqual(parseModelPrep(raw), {
    brief: '哈利·波特观影场景，涉及魔法学校一年级。',
    glossary: ['Hermione=赫敏', 'Quidditch=魁地奇'],
  })
})

test('parseModelPrep 容忍 CRLF 与缺少标记的退化输出', () => {
  const crlf = '[摘要]\r\n魔法学校\r\n\r\n[术语]\r\nHermione=赫敏'
  assert.deepEqual(parseModelPrep(crlf), { brief: '魔法学校', glossary: ['Hermione=赫敏'] })
  assert.deepEqual(parseModelPrep('魔法学校一年级\nHermione=赫敏\nQuidditch=魁地奇'), {
    brief: '魔法学校一年级',
    glossary: ['Hermione=赫敏', 'Quidditch=魁地奇'],
  })
})

test('parseModelPrep 压缩摘要为一行并截断，词表上限 80', () => {
  const brief = parseModelPrep('[摘要]\n第一行\n第二行\n[术语]').brief
  assert.equal(brief, '第一行 第二行')
  const long = parseModelPrep(`[摘要]\n${'摘'.repeat(400)}`).brief
  assert.equal(long.length, 300)
  const lines = Array.from({ length: 90 }, (_, i) => `t${i}=词${i}`).join('\n')
  assert.equal(parseModelPrep(`[术语]\n${lines}`).glossary.length, 80)
})

test('prepareGlossary 走翻译路由并解析模型输出', async () => {
  const calls: Array<Record<string, unknown>> = []
  const llm = {
    stream(options: Record<string, unknown>) {
      calls.push(options)
      return (async function* () {
        yield { type: 'text-delta', text: '[摘要]\n魔法学校\n\n[术语]\nHermione=赫敏' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const t = new Translator(llm as never, { provider: 'p', model: 'm', followAgentDefault: false })
  const result = await t.prepareGlossary({ background: '看《哈利·波特与魔法石》', source: 'auto', target: 'zh', signal: AbortSignal.timeout(1000) })
  assert.deepEqual(result, { brief: '魔法学校', glossary: ['Hermione=赫敏'] })
  assert.equal(calls[0].provider, 'p')
  assert.equal(calls[0].model, 'm')
  assert.equal((calls[0].system as string).includes('Chinese'), true)
})

test('prepareGlossary 在模型报错时抛出', async () => {
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'down' } } }
      })()
    },
  }
  const t = new Translator(llm as never, { provider: 'p', model: 'm', followAgentDefault: false })
  await assert.rejects(
    t.prepareGlossary({ background: '背景', source: 'auto', target: 'zh', signal: AbortSignal.timeout(1000) }),
    /down/,
  )
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/translate.test.ts`
Expected: FAIL，`does not provide an export named 'buildPreparePrompt'`。

- [ ] **Step 3: 实现**

在 `src/translate.ts` 加（`NAMES` 已有，复用）：

```ts
export interface PrepareRequest {
  background: string
  source: SourceLanguage
  target: Language
  signal: AbortSignal
}

export function buildPreparePrompt(req: Omit<PrepareRequest, 'signal'>): { system: string; user: string } {
  const system = [
    `You prepare context for live subtitle translation from ${NAMES[req.source]} to ${NAMES[req.target]}.`,
    'The user describes what is being translated (a film, a talk, a topic). Output exactly these two sections and nothing else:',
    '',
    '[摘要]',
    `At most three sentences, at most 120 characters, in ${NAMES[req.target]}: what is being discussed, which people/works/concepts are involved, and the setting.`,
    '',
    '[术语]',
    'Only proper nouns and domain terms whose rendering matters, one per line as original=translation, at most 60 entries.',
    'No numbering, no bullets, no explanations, no Markdown. If the background only names a work, you may add key characters and settings you are confident about; never invent uncertain details.',
    'If nothing useful can be extracted, output an empty [摘要] section and no entries.',
  ].join('\n')
  return { system, user: `[Background]\n${req.background}` }
}
```

解析（保持纯函数，便于单测）：

```ts
const SECTION = /^[\s[【（(]*(摘要|背景摘要|术语表?|词表|glossary)[\s\]】）):：]*$/i
const INLINE = /^[\s[【（(]*(摘要|背景摘要|术语表?|词表|glossary)[\s\]】）):：]*(.+)$/i

function stripLine(line: string): string {
  return line.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
}

function cleanEntries(lines: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of lines) {
    const line = stripLine(raw).replace(/^[-*•]\s*/, '').replace(/^\d+[.)、]\s*/, '').trim()
    if (line === '' || !line.includes('=')) continue
    const at = line.indexOf('=')
    const from = line.slice(0, at).trim()
    const to = line.slice(at + 1).trim()
    if (from === '' || to === '') continue
    const key = from.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(`${from}=${to}`)
    if (out.length >= 80) break
  }
  return out
}

export function parseModelPrep(raw: string): { brief: string; glossary: string[] } {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').filter(line => !line.trim().startsWith('```'))
  const hasMarker = lines.some(line => SECTION.test(line) || INLINE.test(line) !== null)
  const briefLines: string[] = []
  const entryLines: string[] = []
  let section: 'brief' | 'glossary' = 'brief'
  for (const line of lines) {
    if (SECTION.test(line)) { section = /术语|词表|glossary/i.test(line) ? 'glossary' : 'brief'; continue }
    const inline = INLINE.exec(line)
    if (inline !== null) {
      section = /术语|词表|glossary/i.test(inline[1]) ? 'glossary' : 'brief'
      if (inline[2].trim() !== '') (section === 'glossary' ? entryLines : briefLines).push(inline[2])
      continue
    }
    if (line.trim() === '') continue
    // No section markers at all: treat term-like lines as entries, the rest as the brief.
    if (!hasMarker && line.includes('=')) { entryLines.push(line); continue }
    if (section === 'glossary') entryLines.push(line)
    else briefLines.push(line)
  }
  const brief = briefLines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300)
  return { brief, glossary: cleanEntries(entryLines) }
}
```

`Translator` 加方法：`route()` 后 `buildPreparePrompt`，`llm.stream({ provider, model, system, messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxTokens: 2000, temperature: 0.2, signal: req.signal })`，累积 `text-delta`；`finish` 的 `kind === 'error'` 抛 `failure.message ?? 'glossary preparation failed'`，`kind === 'aborted'` 抛 `new Error('准备词汇超时或已取消')`；返回 `parseModelPrep(raw)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/translate.test.ts`
Expected: PASS（原有用例 + 新增 6 个）。

- [ ] **Step 5: 提交**

```bash
git add src/translate.ts tests/translate.test.ts
git commit -m "feat: prepare background brief and glossary through the translation route"
```

---

### Task 4: 面板校验函数与动作分发

**Files:**
- Modify: `src/ui.ts`、`src/subtitle/protocol.ts`
- Test: `tests/ui.test.ts`

**Interfaces:**
- Consumes: Task 1 的上限值、`Controller` 的四个新方法（Task 5 定义，这里只按签名调用）。
- Produces:
  - `export function parseBackground(value: unknown): string | undefined`
  - `export function parseBrief(value: unknown): string | undefined`
  - `export function parseGlossaryPatch(value: unknown): string[] | undefined`
  - `ActionName` / `PANEL_ACTIONS` 增加 `'setBackground' | 'setBrief' | 'setGlossary' | 'prepareGlossary'`（overlay 的 `ACTIONS` 不变）。
  - `dispatchAction` 四个 case：`setBackground(text)`、`setBrief(text)`、`setGlossary(lines)`、`prepareGlossary()`。

- [ ] **Step 1: 写失败测试**

`tests/ui.test.ts` 顶部 import 增加 `parseBackground, parseBrief, parseGlossaryPatch`，文件末尾加：

```ts
test('parseBackground 截断超长输入，非字符串忽略', () => {
  assert.equal(parseBackground('  电影  '), '电影')
  assert.equal(parseBackground('a'.repeat(2500))?.length, 2000)
  assert.equal(parseBackground(42), undefined)
  assert.equal(parseBackground(null), undefined)
})

test('parseBrief 压成一行并截断 300', () => {
  assert.equal(parseBrief('第一行\n第二行'), '第一行 第二行')
  assert.equal(parseBrief('x'.repeat(400))?.length, 300)
  assert.equal(parseBrief(''), '')
  assert.equal(parseBrief(42), undefined)
})

test('parseGlossaryPatch 去空、去重、限 200 行与 120 字符', () => {
  assert.deepEqual(parseGlossaryPatch([' a ', '', 'a', 'b']), ['a', 'b'])
  assert.deepEqual(parseGlossaryPatch('a\nb'), ['a', 'b'])
  assert.deepEqual(parseGlossaryPatch(''), [])
  assert.equal(parseGlossaryPatch(42), undefined)
  assert.equal(parseGlossaryPatch(Array.from({ length: 250 }, (_, i) => `t${i}`))?.length, 200)
  assert.equal(parseGlossaryPatch(['x'.repeat(200)])?.[0].length, 120)
})

test('dispatchAction 把背景/摘要/词表动作转成控制器调用', async () => {
  const calls: unknown[] = []
  const controller = {
    async setBackground(text: string) { calls.push(['background', text]) },
    async setBrief(text: string) { calls.push(['brief', text]) },
    async setGlossary(lines: string[]) { calls.push(['glossary', lines]) },
    async prepareGlossary() { calls.push(['prepare', undefined]) },
  }
  await dispatchAction({ op: 'action', name: 'setBackground', value: ' 电影 ' }, controller as never)
  await dispatchAction({ op: 'action', name: 'setBrief', value: '摘要' }, controller as never)
  await dispatchAction({ op: 'action', name: 'setGlossary', value: ['Hermione=赫敏'] } as never, controller as never)
  await dispatchAction({ op: 'action', name: 'prepareGlossary' }, controller as never)
  assert.deepEqual(calls, [['background', '电影'], ['brief', '摘要'], ['glossary', ['Hermione=赫敏']], ['prepare', undefined]])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/ui.test.ts`
Expected: FAIL，`does not provide an export named 'parseBackground'`。

- [ ] **Step 3: 实现**

`src/ui.ts` 顶部加上限常量与三个函数；`dispatchAction` 加四个 case（参考现有 case 写法；`setGlossary` 用 `parseGlossaryPatch`，`glossary` 为空数组是合法清空，必须 `!== undefined` 才调用）。

`src/subtitle/protocol.ts`：`ActionName` 联合类型与 `PANEL_ACTIONS` 集合各加四项；`ACTIONS`（overlay 入参白名单）不加。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/ui.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/ui.ts src/subtitle/protocol.ts tests/ui.test.ts
git commit -m "feat: validate background and glossary panel actions"
```

---

### Task 5: 控制器 `setBackground` / `setBrief` / `setGlossary` / `prepareGlossary`

**Files:**
- Modify: `src/controller.ts`
- Test: `tests/controller.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `settings.translate.background/backgroundBrief/glossary`、Task 3 的 `Translator.prepareGlossary`。
- Produces: 控制器公开方法 `setBackground(text: string): Promise<void>`、`setBrief(text: string): Promise<void>`、`setGlossary(lines: string[]): Promise<void>`、`prepareGlossary(): Promise<void>`、`glossaryError(): string | null`。错误语义：不抛给调用方，写入运行时 `glossaryError`。

- [ ] **Step 1: 写失败测试**

`tests/controller.test.ts` 的 `fake()` 里给 `translator` 加：

```ts
prepareCalls: 0,
prepareResult: { brief: '', glossary: [] as string[] },
prepareError: undefined as Error | undefined,
async prepareGlossary() {
  d.translator.prepareCalls += 1
  if (d.translator.prepareError !== undefined) throw d.translator.prepareError
  return d.translator.prepareResult
},
```

文件末尾加：

```ts
function withPatch(d: ReturnType<typeof fake>) {
  d.patchSettings = (async (patch: Partial<typeof d.settingsValue>) => {
    d.settingsValue = { ...d.settingsValue, ...patch }
  }) as never
  return d
}

test('setBackground / setBrief / setGlossary 写 profile 并互不影响', async () => {
  const d = withPatch(fake())
  const c = new Controller(d as never)

  await c.setBackground('看《哈利·波特与魔法石》')
  assert.equal(d.settingsValue.translate.background, '看《哈利·波特与魔法石》')
  assert.deepEqual(d.settingsValue.translate.glossary, [])

  await c.setBrief('魔法学校观影场景')
  assert.equal(d.settingsValue.translate.backgroundBrief, '魔法学校观影场景')

  await c.setGlossary(['Hermione=赫敏'])
  assert.deepEqual(d.settingsValue.translate.glossary, ['Hermione=赫敏'])
  assert.equal(d.settingsValue.translate.background, '看《哈利·波特与魔法石》')
})

test('prepareGlossary 写入摘要与词表并清空错误', async () => {
  const d = withPatch(fake())
  d.settingsValue = resolveConfig({ translate: { background: '看《哈利·波特与魔法石》' } })
  d.translator.prepareResult = { brief: '魔法学校观影场景', glossary: ['Hermione=赫敏'] }
  const c = new Controller(d as never)

  await c.prepareGlossary()

  assert.equal(d.translator.prepareCalls, 1)
  assert.equal(d.settingsValue.translate.backgroundBrief, '魔法学校观影场景')
  assert.deepEqual(d.settingsValue.translate.glossary, ['Hermione=赫敏'])
  assert.equal(c.glossaryError(), null)
})

test('prepareGlossary 背景为空时不调用模型', async () => {
  const d = withPatch(fake())
  const c = new Controller(d as never)

  await c.prepareGlossary()

  assert.equal(d.translator.prepareCalls, 0)
  assert.equal(c.glossaryError(), '先填写翻译背景')
})

test('prepareGlossary 失败保留旧值并记录错误', async () => {
  const d = withPatch(fake())
  d.settingsValue = resolveConfig({ translate: { background: '电影', backgroundBrief: '旧摘要', glossary: ['旧=旧词'] } })
  d.translator.prepareError = new Error('down')
  const c = new Controller(d as never)

  await c.prepareGlossary()

  assert.equal(d.settingsValue.translate.backgroundBrief, '旧摘要')
  assert.deepEqual(d.settingsValue.translate.glossary, ['旧=旧词'])
  assert.equal(c.glossaryError(), 'down')
})

test('prepareGlossary 空结果保留旧值并给出提示', async () => {
  const d = withPatch(fake())
  d.settingsValue = resolveConfig({ translate: { background: '电影', backgroundBrief: '旧摘要', glossary: ['旧=旧词'] } })
  d.translator.prepareResult = { brief: '', glossary: [] }
  const c = new Controller(d as never)

  await c.prepareGlossary()

  assert.equal(d.settingsValue.translate.backgroundBrief, '旧摘要')
  assert.deepEqual(d.settingsValue.translate.glossary, ['旧=旧词'])
  assert.equal(c.glossaryError(), '未生成内容，可手填或换个说法')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/controller.test.ts`
Expected: FAIL，`c.setBackground is not a function`。

- [ ] **Step 3: 实现**

`src/controller.ts`：加 `private glossaryErrorValue: string | null = null`；公开 `glossaryError(): string | null`；私有 `patchTranslate(patch: Partial<ResolvedSettings['translate']>)` 只用 `{ ...this.deps.settings().translate, ...patch }` 调 `patchSettings({ translate })`（不 emit），三个 setter 各调一次后 `emit()`。`prepareGlossary` 按设计第 3 步的流程实现（空背景 → 记错误并 `emit`；`AbortSignal.timeout(60_000)`；成功时摘要/词表各自为空则沿用旧值，两项都空则记"未生成内容"；异常记 `error.message`；任何路径最后只 `emit()` 一次）。

`controller.test()` 方法里给翻译请求补 `brief: settings.translate.backgroundBrief,`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/controller.test.ts`
Expected: PASS（原用例 + 新增 5 个）。

- [ ] **Step 5: 提交**

```bash
git add src/controller.ts tests/controller.test.ts
git commit -m "feat: add background and glossary controls to the controller"
```

---

### Task 6: pipeline 传摘要、面板快照暴露新字段

**Files:**
- Modify: `src/pipeline.ts:228-236`、`src/panel.ts`
- Test: `tests/pipeline.test.ts`、`tests/panel.test.ts`

**Interfaces:**
- Consumes: Task 1 的配置字段、Task 2 的 `TranslateRequest.brief`、Task 5 的 `Controller.glossaryError()`。
- Produces: 翻译请求带 `brief`；`PanelSnapshot.translate` 为 `{ provider, model, background, backgroundBrief, glossary, glossaryError }`。

- [ ] **Step 1: 写失败测试**

`tests/pipeline.test.ts` 的 `deps()` 里把 `translator.translate` 改为记录请求：

```ts
translator: {
  calls: 0,
  lastRequest: undefined as unknown,
  async *translate(req: unknown) { d.translator.calls++; d.translator.lastRequest = req; yield 'Hello' },
  async route() { return { provider: 'p', model: 'm' } },
},
```

末尾加：

```ts
test('pipeline 把背景摘要传给翻译请求', async () => {
  const d = deps({ settings: resolveConfig({ sourceLanguage: 'zh', targetLanguage: 'en', translate: { backgroundBrief: '魔法学校一年级' } }) })
  const p = new Pipeline(d as never)
  await feedSegment(p)
  assert.equal((d.translator.lastRequest as { brief: string }).brief, '魔法学校一年级')
})
```

`tests/panel.test.ts` 的 `fakeController()` 加 `glossaryError: () => null`，并在 `GET state` 用例里加：

```ts
assert.equal(stateBody.value.translate.background, '')
assert.equal(stateBody.value.translate.backgroundBrief, '')
assert.deepEqual(stateBody.value.translate.glossary, [])
assert.equal(stateBody.value.translate.glossaryError, null)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/pipeline.test.ts tests/panel.test.ts`
Expected: FAIL —— `brief` 为 `undefined`；快照 `background` 为 `undefined`。

- [ ] **Step 3: 实现**

`src/pipeline.ts` 的 `translate({...})` 加一行 `brief: settings.translate.backgroundBrief,`（放在 `glossary` 前）。

`src/panel.ts`：`PanelSnapshot['translate']` 类型加四个字段；`panelSnapshot` 里填 `background`、`backgroundBrief`、`glossary: [...settings.translate.glossary]`、`glossaryError: deps.controller.glossaryError()`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/pipeline.test.ts tests/panel.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/pipeline.ts src/panel.ts tests/pipeline.test.ts tests/panel.test.ts
git commit -m "feat: pass background brief to translation and expose it to the panel"
```

---

### Task 7: 控制页「翻译背景」卡（折叠、滚动、两步清空）

**Files:**
- Modify: `client.js`
- Test: `tests/client.test.ts`（既有用例应保持通过）

**Interfaces:**
- Consumes: Task 4 的动作名、Task 6 的快照字段。
- Produces: 无导出；`RtPage` 在「语言」卡后渲染背景卡。

- [ ] **Step 1: 实现卡片与本地编辑状态**

在 `RtPage` 顶部（`snap === null` 分支之前）用已有 hook 增加三个草稿状态（`null` 表示跟随快照，避免 1.5s 轮询覆盖输入）：

```js
const [bgDraft, setBgDraft] = useState(null)
const [briefDraft, setBriefDraft] = useState(null)
const [glossDraft, setGlossDraft] = useState(null)
const [briefOpen, setBriefOpen] = useState(false)
const [glossOpen, setGlossOpen] = useState(false)
const [preparing, setPreparing] = useState(false)
const [clearArmed, setClearArmed] = useState(false)
```

渲染（连接成功后）：`const tr = snap.translate || {}`，`const bg = bgDraft ?? tr.background ?? ''`，`const brief = briefDraft ?? tr.backgroundBrief ?? ''`，`const glossary = glossDraft ?? (tr.glossary || [])`，`const glossText = glossary.join('\n')`。

- 背景 `textarea`（2 行）：`onFocus` 把当前快照值写入 `bgDraft`，`onBlur` 时 `act('setBackground', 值)` 并 `setBgDraft(null)`；下方 `button` 「准备词汇」在 `bg.trim() === '' || preparing` 时 `disabled`，点击时先 `act('setBackground', bg)`，再 `setPreparing(true)`、`await act('prepareGlossary')`、`setPreparing(false)`（用 `finally` 复位）。
- 摘要行：未展开时显示 `背景摘要（会进 prompt） · ${brief.length} 字` 与「改」按钮；展开后是 3 行 `textarea`，`onBlur` 提交 `act('setBrief', 值)`、`setBriefDraft(null)`；`brief === ''` 时只显示一行提示「填背景后点准备词汇，或手写摘要」。
- 词表头部：`术语 ${glossary.length} 条 · ${glossText.length} 字符`；`glossary.length > 8 && !glossOpen` 时只显示「展开」，否则显示 240px 高、`overflowY: 'auto'`、等宽字体的 `textarea`（`onFocus` 写 `glossDraft`，`onBlur` 提交 `act('setGlossary', 按行 split 后传数组)` 并 `setGlossDraft(null)`），空表时显示「暂无术语，可手填」。
- 「清空术语」：第一次点击 `setClearArmed(true)` 并 `window.setTimeout(() => setClearArmed(false), 3000)`；已 armed 时点击提交 `act('setGlossary', [])` 并复位；按钮文案在 armed 时为「确认清空？」。
- 卡片底部：`tr.glossaryError` 非空时用 `P.error` 样式显示。

样式沿用 `S`/`P` 里的现有控件（`S.button`、`S.label`、`P.hint`、`P.card`），新增 textarea 样式就地写：`{ ...S.select, width: '100%', boxSizing: 'border-box', fontFamily: 'ui-monospace, Consolas, monospace', resize: 'vertical', whiteSpace: 'pre' }`。

- [ ] **Step 2: 跑测试确认 bundle 仍可加载**

Run: `npm test`
Expected: PASS（`tests/client.test.ts` 三个用例都不受影响；页面未连接分支不执行新卡）。

- [ ] **Step 3: 人工验收（需要桌面会话）**

完全退出 DSH 后重开，按 spec「验证」第 1–3 条检查：背景输入、准备、折叠/展开、滚动、两步清空、播放中改词条。把结果记入 handoff。

- [ ] **Step 4: 提交**

```bash
git add client.js
git commit -m "feat: add translation background card to the control page"
```

---

### Task 8: 文档与全量验证

**Files:**
- Modify: `README.md`、`AGENTS.md`、`docs/handoff-2026-11-24.md`

**Interfaces:**
- Consumes: 前面所有任务的行为与字段名。
- Produces: 无。

- [ ] **Step 1: 更新 README**

在功能说明里加一段：控制页「翻译背景」→ 填背景 → 「准备词汇」生成摘要与术语表 → 可编辑/清空；摘要每句进 prompt，词条只注入本句命中的（≤12 条）；数据写入 profile。标注 2026-11-25 更新。

- [ ] **Step 2: 更新 AGENTS.md**

- 第 5 节配置表加 `translate.background` / `translate.backgroundBrief` 两行（默认 `''`，说明用途）。
- 第 6 节「新增一个面板动作的完整路径」清单不变，但在 `PANEL_ACTIONS` 说明里列出四个新动作。
- 第 10 节「不要做」保持不变（片名库仍未恢复）。

- [ ] **Step 3: 追加 handoff 一节**

`docs/handoff-2026-11-24.md` 末尾加 `## 2026-11-25 追加：翻译背景摘要与术语表`：设计取舍（为什么按句过滤、为什么写 profile）、改动文件、`npm test` 结果、`npm run test:overlay` 结果、人工验收记录、遗留（`/rt bg`、导入导出）。

- [ ] **Step 4: 全量验证**

```powershell
npm test
npm run test:overlay
```

Expected: `npm test` 全部通过（含新增用例）；`test:overlay` 9 + 5 断言 PASS（overlay 未改，不应回归）。

- [ ] **Step 5: 提交**

```bash
git add README.md AGENTS.md docs/handoff-2026-11-24.md
git commit -m "docs: document background brief and glossary"
```

---

## 自检记录

- **Spec 覆盖**：背景输入（Task 1/5/7）、摘要进 prompt（Task 2/3/6）、词表按句过滤（Task 2）、长表 UI（Task 7）、错误语义（Task 5）、持久化（Task 1/5）、文档（Task 8）。非目标均未出现在任务里。
- **命名一致性**：`background` / `backgroundBrief` / `glossary` / `glossaryError` / `selectGlossary` / `parseModelPrep` / `buildPreparePrompt` / `prepareGlossary` 在全部任务中使用同一拼写。
- **未被测试覆盖的 Review Focus 项**：客户端折叠/滚动/两步清空无自动化测试，由 Task 7 的人工验收兜住；其余五项各有对应单测（Task 2/3/4/5/6）。
