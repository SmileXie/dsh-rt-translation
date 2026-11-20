import assert from 'node:assert/strict'
import test from 'node:test'
import { pcm16ToWav } from '../src/audio/wav.ts'

test('WAV 头字段正确', () => {
  const wav = pcm16ToWav(new Int16Array(1600), 16000)
  const b = Buffer.from(wav)
  assert.equal(b.toString('ascii', 0, 4), 'RIFF')
  assert.equal(b.toString('ascii', 8, 12), 'WAVE')
  assert.equal(b.readUInt32LE(24), 16000)
  assert.equal(b.readUInt16LE(34), 16)
  assert.equal(b.readUInt16LE(22), 1)
  assert.equal(b.length, 44 + 3200)
})
