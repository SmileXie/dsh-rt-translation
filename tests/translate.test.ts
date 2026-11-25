import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPreparePrompt, buildPrompt, cleanTranslation, parseModelPrep, selectGlossary, Translator } from '../src/translate.ts'

test('buildPrompt 含语言名、术语与原文', () => {
  const { system, user } = buildPrompt({ text: 'Hermione 来了', source: 'zh', target: 'en', context: [], glossary: ['Hermione=赫敏'], signal: AbortSignal.timeout(1000) })
  assert.ok(system.includes('Chinese') && system.includes('English'))
  assert.ok(system.includes('Output ONLY the translation'))
  assert.ok(user.includes('Hermione=赫敏'))
  assert.ok(user.includes('[Current]\nHermione 来了'))
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

test('超长词条在解析与读侧都截到 120 字符', () => {
  const long = `Hermione${'x'.repeat(300)}=赫敏`
  assert.equal(parseModelPrep(`[术语]\n${long}`).glossary[0].length, 120)
  assert.equal(selectGlossary(`聊 ${long}`, [long])[0].length, 120)
})

test('route 跟随 agentDefaultModel', async () => {
  const t = new Translator({} as never, { provider: '', model: '', followAgentDefault: true, agentDefaultModel: () => ({ provider: 'p', model: 'm' }) })
  assert.deepEqual(await t.route(), { provider: 'p', model: 'm' })
})

test('显式 provider/model 优先', async () => {
  const t = new Translator({} as never, { provider: 'x', model: 'y', followAgentDefault: true, agentDefaultModel: () => ({ provider: 'p', model: 'm' }) })
  assert.deepEqual(await t.route(), { provider: 'x', model: 'y' })
})

test('只指定 provider 时选该 provider 第一个模型', async () => {
  const llm = {
    listProviders: () => [{ id: 'x' }, { id: 'y' }],
    listModels: async (provider: string) => provider === 'y' ? [{ id: 'y1' }] : [{ id: 'x1' }],
  }
  const t = new Translator(llm as never, {
    provider: 'y', model: '', followAgentDefault: true,
    agentDefaultModel: () => ({ provider: 'p', model: 'm' }),
  })
  assert.deepEqual(await t.route(), { provider: 'y', model: 'y1' })
})

test('buildPreparePrompt 要求摘要与原文=译文格式，并带目标语言', () => {
  const { system, user } = buildPreparePrompt({ background: '看《哈利·波特与魔法石》', source: 'auto', target: 'zh' })
  assert.ok(system.includes('Chinese'))
  assert.ok(system.includes('[摘要]') && system.includes('[术语]'))
  assert.ok(system.includes('='))
  assert.ok(system.includes('industry-standard'))
  assert.ok(system.includes('at least 20'))
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

test('parseModelPrep 压缩摘要为一行并截断，词表上限 1000', () => {
  const brief = parseModelPrep('[摘要]\n第一行\n第二行\n[术语]').brief
  assert.equal(brief, '第一行 第二行')
  const long = parseModelPrep(`[摘要]\n${'摘'.repeat(400)}`).brief
  assert.equal(long.length, 300)
  const lines = Array.from({ length: 1100 }, (_, i) => `t${i}=词${i}`).join('\n')
  assert.equal(parseModelPrep(`[术语]\n${lines}`).glossary.length, 1000)
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
