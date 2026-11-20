import assert from 'node:assert/strict'
import test from 'node:test'
import { Segmenter } from '../src/audio/vad.ts'

const FRAME = 320
const loud = () => Int16Array.from({ length: FRAME }, (_, i) => Math.round(6000 * Math.sin(i / 5)))
const quiet = () => new Int16Array(FRAME)

function feed(seg: Segmenter, frames: Int16Array[]) { return frames.flatMap(f => seg.push(f)) }

test('纯静音不产生任何事件', () => {
  const seg = new Segmenter({ silenceMs: 280, maxSegmentMs: 5000, partialIntervalMs: 900 })
  assert.deepEqual(feed(seg, Array.from({ length: 250 }, quiet)), [])
})

test('一次 1s 语音 + 静音产生 partial 与 final', () => {
  const seg = new Segmenter({ silenceMs: 280, maxSegmentMs: 5000, partialIntervalMs: 900 })
  const events = feed(seg, [...Array.from({ length: 50 }, loud), ...Array.from({ length: 20 }, quiet)])
  assert.ok(events.some(e => e.kind === 'partial'))
  assert.equal(events.at(-1)?.kind, 'final')
})

test('10ms 爆音被丢弃', () => {
  const seg = new Segmenter({ silenceMs: 280, maxSegmentMs: 5000, partialIntervalMs: 900 })
  const events = feed(seg, [loud(), ...Array.from({ length: 20 }, quiet)])
  assert.equal(events.filter(e => e.kind === 'final').length, 0)
})

test('超过 maxSegmentMs 强制切分', () => {
  const seg = new Segmenter({ silenceMs: 500, maxSegmentMs: 1000, partialIntervalMs: 900 })
  const events = feed(seg, Array.from({ length: 120 }, loud))
  assert.ok(events.filter(e => e.kind === 'final').length >= 2)
})
