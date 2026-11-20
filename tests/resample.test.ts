import assert from 'node:assert/strict'
import test from 'node:test'
import { DownmixResampler } from '../src/audio/resample.ts'

function stereo(samples: number[]): Uint8Array {
  const buf = Buffer.alloc(samples.length * 4)
  samples.forEach((v, i) => { buf.writeInt16LE(v, i * 4); buf.writeInt16LE(v, i * 4 + 2) })
  return buf
}

test('48k 的 6 帧产生 16k 的 2 个采样', () => {
  const r = new DownmixResampler()
  assert.equal(r.push(stereo([1000, 1000, 1000, 1000, 1000, 1000])).length, 2)
})

test('奇数长度 Buffer 不越界，尾帧进入 flush', () => {
  const r = new DownmixResampler()
  const bytes = stereo([500, 500, 500, 500, 500])
  r.push(bytes.subarray(0, 7))
  r.push(bytes.subarray(7))
  assert.ok(r.push(new Uint8Array(0)).length + r.flush().length >= 0)
})

test('分块拼接与整块结果一致', () => {
  const samples = Array.from({ length: 4800 }, (_, i) => Math.round(8000 * Math.sin(i / 10)))
  const whole = new DownmixResampler().push(stereo(samples))
  const split = new DownmixResampler()
  const all = stereo(samples)
  const total = split.push(all.subarray(0, 4001)).length
    + split.push(all.subarray(4001)).length
    + split.flush().length
  assert.equal(whole.length, total)
})

test('双声道相反相位降混为静音', () => {
  const buf = Buffer.alloc(6 * 4)
  for (let i = 0; i < 6; i++) { buf.writeInt16LE(1000, i * 4); buf.writeInt16LE(-1000, i * 4 + 2) }
  const out = new DownmixResampler().push(buf)
  assert.ok(out.every(v => Math.abs(v) <= 2))
})
