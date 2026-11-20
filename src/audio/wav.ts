/** Wrap mono PCM16 samples in a 44-byte RIFF/WAVE container. */
export function pcm16ToWav(pcm: Int16Array, sampleRate = 16000): Uint8Array {
  const dataBytes = pcm.byteLength
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buffer, 44)
  return new Uint8Array(buffer)
}
