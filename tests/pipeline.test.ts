import assert from 'node:assert/strict'
import test from 'node:test'
import { Pipeline } from '../src/pipeline.ts'
import { SubtitleModel } from '../src/subtitle/state.ts'
import { resolveConfig } from '../src/config.ts'

const silence = () => new Uint8Array(3840)
function loudChunk(): Uint8Array {
  const b = Buffer.alloc(3840)
  for (let i = 0; i < 960; i++) { const v = Math.round(8000 * Math.sin(i / 5)); b.writeInt16LE(v, i * 4); b.writeInt16LE(v, i * 4 + 2) }
  return b
}

function deps(over: Record<string, unknown> = {}) {
  const settings = (over.settings as ReturnType<typeof resolveConfig>) ?? resolveConfig({ sourceLanguage: 'auto', targetLanguage: 'en', preset: 'meeting' })
  const subs = new SubtitleModel({ maxCues: 3, bilingual: false, holdMs: 60_000 })
  const d = {
    stt: { calls: 0, maxOutstanding: 0, async ensureReady() {}, async transcribe() { d.stt.calls++; return { text: (over.transcript as string) ?? '你好', audioSeconds: 1, inferenceSeconds: 0.1 } }, status: () => '' },
    translator: { calls: 0, async *translate() { d.translator.calls++; yield 'Hello' }, async route() { return { provider: 'p', model: 'm' } } },
    subtitles: subs,
    renderer: { last: undefined as unknown, start: async () => {}, cue(c: unknown) { d.renderer.last = c }, state() {}, style() {}, clear() {}, onAction() {}, dispose: async () => {} },
    settings: () => settings,
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


