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
    cleared: 0,
    subtitlesCleared: 0,
    rendererStarts: 0,
    rendererCloses: 0,
    settingsValue: resolveConfig({}),
    patchSettings: async () => {},
    settings: () => d.settingsValue,
    stt: { prepare() {}, async ensureReady() { order.push('prepare'); if (over.prepareFails) throw new Error('boom') }, async transcribe() { return { text: 'x', audioSeconds: 1, inferenceSeconds: 0 } }, status: () => '' },
    translator: {
      async *translate() {},
      async route() { return { provider: 'p', model: 'm' } },
      prepareCalls: 0,
      prepareResult: { brief: '', glossary: [] as string[] },
      prepareError: undefined as Error | undefined,
      async prepareGlossary() {
        d.translator.prepareCalls += 1
        if (d.translator.prepareError !== undefined) throw d.translator.prepareError
        return d.translator.prepareResult
      },
    },
    renderer: { start: async () => { d.rendererStarts++ }, close: async () => { d.rendererCloses++ }, cue() {}, style() {}, ui() {}, clear() { d.cleared++ }, onAction() {}, dispose: async () => {} },
    subtitles: { upsertSource() {}, beginTranslation() {}, appendTranslation() {}, finishCue() {}, clear() { d.subtitlesCleared++ }, configure() {}, tick() {}, snapshot: () => [] },
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

test('prepareModel 只准备识别器，不打开采集', () => {
  const d = fake()
  let prepared = 0
  d.stt.prepare = () => { prepared++ }
  const c = new Controller(d as never)
  c.prepareModel()
  assert.equal(prepared, 1)
  assert.equal(d.opened, 0)
  assert.equal(c.state().phase, 'idle')
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

test('stop 关闭采集、关闭字幕窗并回到 idle', async () => {
  const d = fake(); const c = new Controller(d as never)
  await c.start(); await c.stop()
  assert.equal(d.closed, 1)
  assert.equal(c.state().phase, 'idle')
  assert.equal(d.cleared, 1)
  assert.equal(d.subtitlesCleared, 1)
})

test('托盘退出后仍可再次开始并重新拉起字幕窗', async () => {
  const d = fake(); const c = new Controller(d as never)
  await c.start()
  assert.equal(d.rendererStarts, 1)
  await c.quit()
  assert.equal(d.rendererCloses, 1)
  assert.equal(c.state().phase, 'idle')

  await c.start()
  assert.equal(d.rendererStarts, 2)
  assert.equal(d.opened, 2)
  assert.equal(c.state().phase, 'listening')
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
  assert.deepEqual(configured.at(-1), { maxCues: 4, bilingual: true, holdMs: 6000 })
  assert.equal(styles.at(-1)?.fontSize, 40)
})

test('长静音超过阈值自动暂停，start 可恢复', async () => {
  const d = fake()
  d.settingsValue = resolveConfig({ autoPauseAfterMs: 1000 })
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

test('setSegment 更新切分参数；收听中会重连采集', async () => {
  const d = fake()
  d.patchSettings = (async (patch: Partial<typeof d.settingsValue>) => {
    d.settingsValue = { ...d.settingsValue, ...patch }
  }) as never
  const c = new Controller(d as never)

  await c.setSegment({ silenceMs: 600 })
  assert.equal(d.settingsValue.segment.silenceMs, 600)
  assert.equal(d.opened, 0)

  await c.start()
  const openedBefore = d.opened
  await c.setSegment({ maxSegmentMs: 8000 })
  assert.equal(d.settingsValue.segment.maxSegmentMs, 8000)
  assert.equal(d.opened, openedBefore + 1)
  assert.equal(c.state().phase, 'listening')
})

test('setAutoPause 更新长静音阈值', async () => {
  const d = fake()
  d.patchSettings = (async (patch: Partial<typeof d.settingsValue>) => {
    d.settingsValue = { ...d.settingsValue, ...patch }
  }) as never
  const c = new Controller(d as never)

  await c.setAutoPause(0)
  assert.equal(d.settingsValue.autoPauseAfterMs, 0)
  await c.setAutoPause(90_000)
  assert.equal(d.settingsValue.autoPauseAfterMs, 90_000)
})

test('resetDefaults 恢复切分/自动暂停/字幕默认值并保留语言', async () => {
  const d = fake()
  d.settingsValue = resolveConfig({
    sourceLanguage: 'zh',
    targetLanguage: 'en',
    segment: { silenceMs: 150, maxSegmentMs: 10_000, preRollMs: 200 },
    autoPauseAfterMs: 0,
    subtitle: { fontSize: 44, maxLines: 5, opacity: 0.4, bilingual: false, minReadMs: 0 },
  })
  d.patchSettings = (async (patch: Partial<typeof d.settingsValue>) => {
    d.settingsValue = { ...d.settingsValue, ...patch }
  }) as never
  const configured: unknown[] = []
  const styles: Array<Record<string, unknown>> = []
  ;(d.subtitles as unknown as { configure(value: unknown): void }).configure = value => { configured.push(value) }
  ;(d.renderer as unknown as { style(value: Record<string, unknown>): void }).style = value => { styles.push(value) }

  const c = new Controller(d as never)
  await c.resetDefaults()

  assert.equal(d.settingsValue.sourceLanguage, 'zh')
  assert.equal(d.settingsValue.targetLanguage, 'en')
  assert.deepEqual(d.settingsValue.segment, { silenceMs: 550, maxSegmentMs: 8000, preRollMs: 400 })
  assert.equal(d.settingsValue.autoPauseAfterMs, 120_000)
  assert.equal(d.settingsValue.subtitle.fontSize, 20)
  assert.equal(d.settingsValue.subtitle.maxLines, 3)
  assert.equal(d.settingsValue.subtitle.opacity, 0.72)
  assert.equal(d.settingsValue.subtitle.bilingual, true)
  assert.equal(d.settingsValue.subtitle.minReadMs, 1800)
  assert.deepEqual(configured.at(-1), { maxCues: 4, bilingual: true, holdMs: 6000 })
  assert.equal(styles.at(-1)?.fontSize, 20)
  assert.equal(d.opened, 0, '未收听时不应重连采集')
})

test('resetDefaults 清空翻译背景、摘要、术语并清掉准备错误', async () => {
  const d = withPatch(fake())
  d.settingsValue = resolveConfig({
    translate: { provider: 'p', model: 'm', background: '看《哈利·波特与魔法石》', backgroundBrief: '旧摘要', glossary: ['Hermione=赫敏'] },
  })
  const c = new Controller(d as never)
  await c.prepareGlossary()
  assert.match(c.glossaryError() ?? '', /源语言/)

  await c.resetDefaults()

  assert.equal(d.settingsValue.translate.background, '')
  assert.equal(d.settingsValue.translate.backgroundBrief, '')
  assert.deepEqual(d.settingsValue.translate.glossary, [])
  assert.equal(d.settingsValue.translate.provider, 'p')
  assert.equal(d.settingsValue.translate.model, 'm')
  assert.equal(c.glossaryError(), null)
})

test('收听中 resetDefaults 会重连采集并保持收听状态', async () => {
  const d = fake()
  d.settingsValue = resolveConfig({ segment: { silenceMs: 150, maxSegmentMs: 10_000 } })
  d.patchSettings = (async (patch: Partial<typeof d.settingsValue>) => {
    d.settingsValue = { ...d.settingsValue, ...patch }
  }) as never
  const c = new Controller(d as never)

  await c.start()
  const openedBefore = d.opened
  await c.resetDefaults()

  assert.equal(d.opened, openedBefore + 1)
  assert.equal(d.settingsValue.segment.silenceMs, 550)
  assert.equal(c.state().phase, 'listening')
})

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
  d.settingsValue = resolveConfig({ sourceLanguage: 'zh', translate: { background: '看《哈利·波特与魔法石》' } })
  d.translator.prepareResult = { brief: '魔法学校观影场景', glossary: ['Hermione=赫敏'] }
  const c = new Controller(d as never)

  await c.prepareGlossary()

  assert.equal(d.translator.prepareCalls, 1)
  assert.equal(d.settingsValue.translate.backgroundBrief, '魔法学校观影场景')
  assert.deepEqual(d.settingsValue.translate.glossary, ['Hermione=赫敏'])
  assert.equal(c.glossaryError(), null)
})

test('prepareGlossary 源语言为自动时拒绝提炼', async () => {
  const d = withPatch(fake())
  d.settingsValue = resolveConfig({ sourceLanguage: 'auto', translate: { background: '看《哈利·波特与魔法石》' } })
  const c = new Controller(d as never)

  await c.prepareGlossary()

  assert.equal(d.translator.prepareCalls, 0)
  assert.match(c.glossaryError() ?? '', /源语言/)
  assert.equal(d.settingsValue.translate.backgroundBrief, '')
  assert.deepEqual(d.settingsValue.translate.glossary, [])
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
  d.settingsValue = resolveConfig({ sourceLanguage: 'zh', translate: { background: '电影', backgroundBrief: '旧摘要', glossary: ['旧=旧词'] } })
  d.translator.prepareError = new Error('down')
  const c = new Controller(d as never)

  await c.prepareGlossary()

  assert.equal(d.settingsValue.translate.backgroundBrief, '旧摘要')
  assert.deepEqual(d.settingsValue.translate.glossary, ['旧=旧词'])
  assert.equal(c.glossaryError(), 'down')
})

test('prepareGlossary 空结果保留旧值并给出提示', async () => {
  const d = withPatch(fake())
  d.settingsValue = resolveConfig({ sourceLanguage: 'zh', translate: { background: '电影', backgroundBrief: '旧摘要', glossary: ['旧=旧词'] } })
  d.translator.prepareResult = { brief: '', glossary: [] }
  const c = new Controller(d as never)

  await c.prepareGlossary()

  assert.equal(d.settingsValue.translate.backgroundBrief, '旧摘要')
  assert.deepEqual(d.settingsValue.translate.glossary, ['旧=旧词'])
  assert.equal(c.glossaryError(), '未生成内容，可手填或换个说法')
})
