import assert from 'node:assert/strict'
import test from 'node:test'
import { SubtitleModel } from '../src/subtitle/state.ts'

test('单语模式：译文到达前保留原文，随后追加译文', () => {
  const m = new SubtitleModel({ maxCues: 2, bilingual: false, holdMs: 1000 })
  m.upsertSource('a', '你好', true)
  assert.deepEqual(m.snapshot()[0].lines, [{ kind: 'source', text: '你好', live: true }])
  m.beginTranslation('a')
  assert.deepEqual(m.snapshot()[0].lines, [
    { kind: 'source', text: '你好', live: true },
    { kind: 'target', text: '', live: true },
  ])
  m.appendTranslation('a', 'Hello')
  assert.deepEqual(m.snapshot()[0].lines, [
    { kind: 'source', text: '你好', live: true },
    { kind: 'target', text: 'Hello', live: true },
  ])
})

test('双语模式：保留原文并追加译文', () => {
  const m = new SubtitleModel({ maxCues: 3, bilingual: true, holdMs: 1000 })
  m.upsertSource('a', '你好', false)
  m.beginTranslation('a'); m.appendTranslation('a', 'Hello')
  assert.deepEqual(m.snapshot()[0].lines.map(l => l.kind), ['source', 'target'])
  assert.equal(m.snapshot()[0].lines[1].text, 'Hello')
})

test('最多保留 maxCues 条', () => {
  const m = new SubtitleModel({ maxCues: 2, bilingual: false, holdMs: 10_000 })
  for (const id of ['a', 'b', 'c']) { m.upsertSource(id, id, false); m.finishCue(id) }
  assert.deepEqual(m.snapshot().map(c => c.id), ['b', 'c'])
})

test('hold 到期后移除', () => {
  const m = new SubtitleModel({ maxCues: 2, bilingual: false, holdMs: 1000 })
  m.upsertSource('a', '你好', false); m.finishCue('a')
  m.tick(0); m.tick(999); assert.equal(m.snapshot().length, 1)
  m.tick(1001); assert.equal(m.snapshot().length, 0)
})

test('空译文不会产生 target 行', () => {
  const m = new SubtitleModel({ maxCues: 2, bilingual: true, holdMs: 1000 })
  m.upsertSource('a', '你好', false); m.beginTranslation('a'); m.appendTranslation('a', '   ')
  m.finishCue('a')
  assert.deepEqual(m.snapshot()[0].lines.map(l => l.kind), ['source'])
})

test('configure 更新双语、上限与停留时间', () => {
  const m = new SubtitleModel({ maxCues: 3, bilingual: false, holdMs: 1000 })
  for (const id of ['a', 'b', 'c', 'd']) { m.upsertSource(id, id, false); m.finishCue(id, 0) }
  m.configure({ maxCues: 2, bilingual: true, holdMs: 5000 })
  assert.deepEqual(m.snapshot().map(c => c.id), ['c', 'd'])
  assert.equal(m.snapshot()[0].holdMs, 5000)
  m.upsertSource('e', '你好', false); m.beginTranslation('e')
  assert.deepEqual(m.snapshot().at(-1)?.lines.map(l => l.kind), ['source', 'target'])
})

test('翻译失败时保留原文并附加警告', () => {
  const meeting = new SubtitleModel({ maxCues: 2, bilingual: false, holdMs: 1000 })
  meeting.upsertSource('a', '你好', false); meeting.beginTranslation('a'); meeting.markFailed('a', '⚠ 翻译失败')
  assert.deepEqual(meeting.snapshot()[0].lines, [{ kind: 'source', text: '你好  ⚠ 翻译失败', live: false }])

  const media = new SubtitleModel({ maxCues: 2, bilingual: true, holdMs: 1000 })
  media.upsertSource('b', '你好', false); media.beginTranslation('b'); media.markFailed('b', '⚠ 翻译失败')
  assert.deepEqual(media.snapshot()[0].lines.map(line => [line.kind, line.text]), [
    ['source', '你好'],
    ['target', '⚠ 翻译失败'],
  ])
})
