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
    resolve(r: { language: string; providerId: string; audio: Uint8Array }) { api.last = r; return { language: r.language, audio: r.audio } },
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
