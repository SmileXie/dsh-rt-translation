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

async function feedSegment(p: Pipeline): Promise<void> {
  for (let i = 0; i < 70; i++) p.feed(loudChunk())
  for (let i = 0; i < 30; i++) p.feed(silence())
  await p.flush()
}

function deps(over: Record<string, unknown> = {}) {
  const settings = (over.settings as ReturnType<typeof resolveConfig>) ?? resolveConfig({ sourceLanguage: 'auto', targetLanguage: 'en', preset: 'meeting' })
  const subs = new SubtitleModel({ maxCues: 3, bilingual: settings.subtitle.bilingual, holdMs: settings.subtitle.holdMs })
  const d = {
    stt: { calls: 0, maxOutstanding: 0, async ensureReady() {}, async transcribe() { d.stt.calls++; return { text: (over.transcript as string) ?? '你好', audioSeconds: 1, inferenceSeconds: 0.1 } }, status: () => '' },
    translator: { calls: 0, async *translate() { d.translator.calls++; yield 'Hello' }, async route() { return { provider: 'p', model: 'm' } } },
    subtitles: subs,
    renderer: { last: undefined as unknown, start: async () => {}, cue(c: unknown) { d.renderer.last = c }, state() {}, style() {}, clear() {}, onAction() {}, dispose: async () => {} },
    settings: () => settings,
    now: () => 0,
    log: () => {},
    onFatal: undefined as ((error: unknown) => void) | undefined,
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

test('final 到达后丢弃仍在识别的 partial', async () => {
  const d = deps()
  const signals: AbortSignal[] = []
  let release!: (value: { text: string; audioSeconds: number; inferenceSeconds: number }) => void
  const gate = new Promise<{ text: string; audioSeconds: number; inferenceSeconds: number }>(resolve => { release = resolve })
  ;(d.stt as { transcribe: unknown }).transcribe = async (_wav: Uint8Array, _lang: string, signal: AbortSignal) => {
    signals.push(signal)
    if (signals.length === 1) return gate
    return { text: '你好', audioSeconds: 1, inferenceSeconds: 0.1 }
  }
  const p = new Pipeline(d as never)

  for (let i = 0; i < 70; i++) p.feed(loudChunk())
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(signals.length, 1)

  for (let i = 0; i < 30; i++) p.feed(silence())
  assert.equal(signals[0].aborted, true)
  release({ text: '临时文本', audioSeconds: 1, inferenceSeconds: 0.1 })
  await p.flush()

  const cue = d.renderer.last as { lines: Array<{ text: string }> }
  assert.equal(d.translator.calls, 1)
  assert.equal(cue.lines.some(line => line.text.includes('临时文本')), false)
  assert.equal(cue.lines.some(line => line.text === 'Hello'), true)
})

test('翻译失败时回退显示原文与警告', async () => {
  const d = deps({ settings: resolveConfig({ sourceLanguage: 'zh', targetLanguage: 'en', preset: 'media' }) })
  ;(d.translator as { translate: unknown }).translate = async function* () { throw new Error('down') }
  const p = new Pipeline(d as never)

  await feedSegment(p)

  const cue = d.renderer.last as { lines: Array<{ kind: string; text: string }> }
  assert.equal(cue.lines.find(line => line.kind === 'source')?.text, '你好')
  assert.equal(cue.lines.find(line => line.kind === 'target')?.text, '⚠ 翻译失败')
})

test('翻译连续失败 3 次触发 onFatal', async () => {
  const d = deps({ settings: resolveConfig({ sourceLanguage: 'zh', targetLanguage: 'en', preset: 'media' }) })
  let fatal = 0
  d.onFatal = () => { fatal++ }
  ;(d.translator as { translate: unknown }).translate = async function* () { throw new Error('down') }
  const p = new Pipeline(d as never)

  for (let i = 0; i < 3; i++) await feedSegment(p)

  assert.equal(fatal, 1)
})


