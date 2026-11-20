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
