import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPrompt, cleanTranslation, selectGlossary, Translator } from '../src/translate.ts'

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
