import assert from 'node:assert/strict'
import test from 'node:test'
import { Segmenter } from '../src/audio/vad.ts'

const FRAME = 320
const loud = () => Int16Array.from({ length: FRAME }, (_, i) => Math.round(6000 * Math.sin(i / 5)))
const quiet = () => new Int16Array(FRAME)
/** A frame whose RMS is roughly `rms`, for soft syllables and quiet onsets. */
const tone = (rms: number) => Int16Array.from({ length: FRAME }, (_, i) => Math.round(rms * Math.SQRT2 * Math.sin(i / 5)))

function feed(seg: Segmenter, frames: Int16Array[]) { return frames.flatMap(f => seg.push(f)) }
const finals = (events: Array<{ kind: string }>) => events.filter(e => e.kind === 'final')
const frames = (count: number, make: () => Int16Array) => Array.from({ length: count }, make)

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

// 会议语音里句尾常常是轻声（降调、语气词），旧实现按“最后一个过门限的帧 + 100ms”裁剪，
// 会把这段轻声整块丢掉，屏幕上就只剩半句。整段音频必须全部送识别。
test('句尾轻声不被裁掉', () => {
  const seg = new Segmenter({ silenceMs: 550, maxSegmentMs: 8000, partialIntervalMs: 900 })
  const events = feed(seg, [...frames(100, loud), ...frames(15, () => tone(320)), ...frames(60, quiet)])
  const final = finals(events).at(-1)
  assert.ok(final !== undefined, '应产生 final')
  assert.ok(final.audio.length >= 115 * FRAME, `句尾轻声应保留，实际 ${final.audio.length / FRAME} 帧`)
})

// 轻声起句（换人、句首弱读）只能靠 pre-roll 兜住；旧 pre-roll 200ms 会吃掉句首几百毫秒。
test('句首轻声不被裁掉', () => {
  const seg = new Segmenter({ silenceMs: 550, maxSegmentMs: 8000, partialIntervalMs: 900 })
  const events = feed(seg, [...frames(50, quiet), ...frames(20, () => tone(300)), ...frames(100, loud), ...frames(60, quiet)])
  const final = finals(events).at(-1)
  assert.ok(final !== undefined, '应产生 final')
  assert.ok(final.audio.length >= 120 * FRAME, `句首轻声应保留，实际 ${final.audio.length / FRAME} 帧`)
})

// 同一句里比句首轻得多的字（约 -20dB）不能被当成静音，否则一句会被切成两半。
test('句中轻声字不算静音', () => {
  const seg = new Segmenter({ silenceMs: 300, maxSegmentMs: 8000, partialIntervalMs: 900 })
  const events = feed(seg, [...frames(100, loud), ...frames(16, () => tone(320)), ...frames(100, loud), ...frames(40, quiet)])
  assert.equal(finals(events).length, 1)
})

test('550ms 以内的自然停顿不切句', () => {
  const seg = new Segmenter({ silenceMs: 550, maxSegmentMs: 8000, partialIntervalMs: 900 })
  const events = feed(seg, [...frames(100, loud), ...frames(20, quiet), ...frames(100, loud), ...frames(60, quiet)])
  assert.equal(finals(events).length, 1)
})

test('超过阈值的停顿仍然切句', () => {
  const seg = new Segmenter({ silenceMs: 550, maxSegmentMs: 8000, partialIntervalMs: 900 })
  const events = feed(seg, [...frames(100, loud), ...frames(35, quiet), ...frames(100, loud), ...frames(60, quiet)])
  assert.equal(finals(events).length, 2)
})
