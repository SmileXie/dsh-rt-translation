import assert from 'node:assert/strict'
import test from 'node:test'
import { Controller } from '../src/controller.ts'
import { resolveConfig } from '../src/config.ts'

function fake(over: { prepareFails?: boolean } = {}) {
  const order: string[] = []
  const d = {
    order,
    opened: 0,
    closed: 0,
    settingsValue: resolveConfig({}),
    patchSettings: async () => {},
    settings: () => d.settingsValue,
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

test('setSubtitle 重建字幕配置并推送样式', async () => {
  const d = fake()
  d.patchSettings = (async (patch: { subtitle: typeof d.settingsValue.subtitle }) => {
    d.settingsValue = { ...d.settingsValue, ...patch }
  }) as never
  const configured: unknown[] = []
  const styles: Array<Record<string, unknown>> = []
  const subtitles = d.subtitles as unknown as { configure(value: unknown): void }
  subtitles.configure = value => { configured.push(value) }
  const renderer = d.renderer as unknown as { style(value: Record<string, unknown>): void }
  renderer.style = value => { styles.push(value) }

  const c = new Controller(d as never)
  await c.setSubtitle({ fontSize: 40, bilingual: true })

  assert.equal(d.settingsValue.subtitle.fontSize, 40)
  assert.deepEqual(configured.at(-1), { maxCues: 3, bilingual: true, holdMs: 3500 })
  assert.equal(styles.at(-1)?.fontSize, 40)
})

