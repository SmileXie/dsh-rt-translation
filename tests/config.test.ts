import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, resolveConfig } from '../src/config.ts'

test('默认配置：单一模式，会议参数作为默认值', () => {
  const s = resolveConfig({})
  assert.equal(s.sourceLanguage, 'auto')
  assert.equal(s.targetLanguage, 'zh')
  assert.equal(s.segment.silenceMs, 550)
  assert.equal(s.segment.maxSegmentMs, 8000)
  assert.equal(s.segment.preRollMs, 400)
  assert.equal(s.autoPauseAfterMs, 120000)
  assert.equal(s.subtitle.maxLines, 3)
  assert.equal(s.subtitle.holdMs, 6000)
  assert.equal(s.subtitle.minReadMs, 1800)
  assert.equal(s.subtitle.bilingual, true)
  assert.equal(s.subtitle.fontSize, 20)
})

test('显式字段覆盖默认值', () => {
  const s = resolveConfig({
    segment: { silenceMs: 550, maxSegmentMs: 7000 },
    autoPauseAfterMs: 0,
    subtitle: { fontSize: 44, bilingual: false },
  })
  assert.equal(s.segment.silenceMs, 550)
  assert.equal(s.segment.maxSegmentMs, 7000)
  assert.equal(s.autoPauseAfterMs, 0)
  assert.equal(s.subtitle.fontSize, 44)
  assert.equal(s.subtitle.bilingual, false)
  assert.equal(s.subtitle.maxLines, 3)
})

test('翻译背景与摘要默认空，且可显式覆盖', () => {
  const defaults = resolveConfig({})
  assert.equal(defaults.translate.background, '')
  assert.equal(defaults.translate.backgroundBrief, '')
  assert.deepEqual(defaults.translate.glossary, [])

  const explicit = resolveConfig({ translate: { background: '看《哈利·波特与魔法石》', backgroundBrief: '魔法学校观影场景' } })
  assert.equal(explicit.translate.background, '看《哈利·波特与魔法石》')
  assert.equal(explicit.translate.backgroundBrief, '魔法学校观影场景')
})

test('非法语言与分段值在 schema 层被拒绝', () => {
  assert.throws(() => Config({ targetLanguage: 'de' } as never))
  assert.throws(() => Config({ segment: { silenceMs: 10 } } as never))
  assert.throws(() => Config({ autoPauseAfterMs: -1 } as never))
})
