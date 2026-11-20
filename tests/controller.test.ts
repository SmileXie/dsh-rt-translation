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
    hidden: 0,
    settingsValue: resolveConfig({}),
    patchSettings: async () => {},
    settings: () => d.settingsValue,
    stt: { async ensureReady() { order.push('prepare'); if (over.prepareFails) throw new Error('boom') }, async transcribe() { return { text: 'x', audioSeconds: 1, inferenceSeconds: 0 } }, status: () => '' },
    translator: { async *translate() {}, async route() { return { provider: 'p', model: 'm' } } },
    renderer: { start: async () => {}, cue() {}, state() {}, style() {}, ui() {}, clear() {}, showPanel() {}, hidePanel() { d.hidden++ }, onAction() {}, dispose: async () => {} },
    subtitles: { upsertSource() {}, beginTranslation() {}, appendTranslation() {}, finishCue() {}, clear() {}, configure() {}, tick() {}, snapshot: () => [] },
    capture: { open() { d.opened++; order.push('open'); return { close() { d.closed++ }, lastError: null as string | null } } },
    makePipeline: () => ({ feed() {}, pause() {}, resume() {}, flush: async () => {}, stop: async () => {}, stats: () => ({ count: 0, p50: 0, p90: 0, last: 0 }), lastSpeechAt: () => 0 }),
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

test('准备模型期间 stop 后不会打开采集', async () => {
  const d = fake()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  d.stt.ensureReady = () => gate
  const c = new Controller(d as never)

  const starting = c.start()
  assert.equal(c.state().phase, 'preparing')
  await c.stop()
  release()
  await starting

  assert.equal(c.state().phase, 'idle')
  assert.equal(d.opened, 0)
})

test('stop 关闭采集并回到 idle', async () => {
  const d = fake(); const c = new Controller(d as never)
  await c.start(); await c.stop()
  assert.equal(d.closed, 1)
  assert.equal(c.state().phase, 'idle')
  assert.equal(d.hidden, 1)
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

test('会议模式静音超过阈值自动暂停，start 可恢复', async () => {
  const d = fake()
  d.settingsValue = resolveConfig({ meeting: { autoPauseAfterMs: 1000 } })
  let paused = 0
  let resumed = 0
  const pipeline = {
    feed() {}, pause() { paused++ }, resume() { resumed++ }, flush: async () => {}, stop: async () => {},
    stats: () => ({ count: 0, p50: 0, p90: 0, last: 0 }), lastSpeechAt: () => 0,
  }
  d.makePipeline = () => pipeline as never
  const c = new Controller(d as never)

  await c.start()
  await c._checkIdleForTest(Date.now() + 6000)
  assert.equal(c.state().phase, 'paused')
  assert.equal(paused, 1)
  assert.equal(d.closed, 1)

  await c.start()
  assert.equal(c.state().phase, 'listening')
  assert.equal(resumed, 1)
  assert.equal(d.opened, 2)
})


test('采集连续失败按次数进入 error，不会无限 1s 重试', async () => {
  const d = fake()
  d.capture = { open() { d.opened++; return { close() { d.closed++ }, lastError: 'boom' } } }
  const c = new Controller({ ...d, retryDelays: [0, 0, 0] } as never)

  await c.start()
  for (let i = 0; i < 4; i++) await c._checkCaptureForTest()

  assert.equal(c.state().phase, 'error')
  assert.equal(d.opened, 4)
})

test('setMode 保留用户改过的字号，只替换仍是预设值的字段', async () => {
  const d = fake()
  d.patchSettings = (async (patch: Partial<typeof d.settingsValue>) => {
    d.settingsValue = { ...d.settingsValue, ...patch }
  }) as never
  const c = new Controller(d as never)

  await c.setSubtitle({ fontSize: 50 })
  await c.setMode('media')

  assert.equal(d.settingsValue.preset, 'media')
  assert.equal(d.settingsValue.subtitle.fontSize, 50)
  assert.equal(d.settingsValue.subtitle.maxLines, 3)
  assert.equal(d.settingsValue.subtitle.bilingual, true)
})

test('设置无法持久化时 status 明确标注', () => {
  const d = fake()
  ;(d as { persistence?: () => boolean }).persistence = () => false
  const c = new Controller(d as never)
  assert.match(c.status(), /未写入 profile/)
})
