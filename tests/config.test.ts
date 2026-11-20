import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, resolveConfig } from '../src/config.ts'

test('meeting 预设的默认值', () => {
  const s = resolveConfig({ preset: 'meeting' })
  assert.equal(s.targetLanguage, 'zh')
  assert.equal(s.sourceLanguage, 'auto')
  assert.equal(s.segment.silenceMs, 280)
  assert.equal(s.segment.maxSegmentMs, 5000)
  assert.equal(s.subtitle.maxLines, 2)
  assert.equal(s.subtitle.holdMs, 3500)
  assert.equal(s.subtitle.bilingual, false)
  assert.equal(s.subtitle.fontSize, 30)
  assert.equal(s.meeting.autoPauseAfterMs, 120000)
})

test('media 预设的默认值', () => {
  const s = resolveConfig({ preset: 'media' })
  assert.equal(s.segment.silenceMs, 550)
  assert.equal(s.segment.maxSegmentMs, 7000)
  assert.equal(s.subtitle.maxLines, 3)
  assert.equal(s.subtitle.holdMs, 6000)
  assert.equal(s.subtitle.bilingual, true)
  assert.equal(s.subtitle.fontSize, 34)
})

test('显式字段覆盖预设', () => {
  const s = resolveConfig({ preset: 'media', subtitle: { fontSize: 44, bilingual: false } })
  assert.equal(s.subtitle.fontSize, 44)
  assert.equal(s.subtitle.bilingual, false)
  assert.equal(s.subtitle.maxLines, 3)
})

test('缺省 preset 为 meeting，目标语言默认 zh', () => {
  const s = resolveConfig({})
  assert.equal(s.preset, 'meeting')
  assert.equal(s.targetLanguage, 'zh')
})

test('非法语言在 schema 层被拒绝', () => {
  assert.throws(() => Config({ targetLanguage: 'de' }))
})
