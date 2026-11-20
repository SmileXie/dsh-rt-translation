/** Downmix 48 kHz stereo PCM16 to 16 kHz mono PCM16. */
export class DownmixResampler {
  private carry: Buffer = Buffer.alloc(0)
  private lp1 = 0
  private lp2 = 0
  private phase = 0

  private readonly inputRate: number
  private readonly outputRate: number

  constructor(inputRate = 48000, outputRate = 16000) {
    this.inputRate = inputRate
    this.outputRate = outputRate
  }

  /** Consume one 48 kHz stereo chunk and return any complete 16 kHz mono samples. */
  push(chunk: Uint8Array): Int16Array {
    const buffer = this.carry.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.carry, Buffer.from(chunk)])
    const frames = Math.floor(buffer.length / 4)
    const step = Math.max(1, Math.round(this.inputRate / this.outputRate))
    const out: number[] = []
    for (let frame = 0; frame < frames; frame++) {
      const offset = frame * 4
      const mono = (buffer.readInt16LE(offset) + buffer.readInt16LE(offset + 2)) >> 1
      const filtered = (this.lp2 + 2 * this.lp1 + mono) / 4
      this.lp2 = this.lp1
      this.lp1 = mono
      this.phase++
      if (this.phase >= step) {
        this.phase = 0
        out.push(Math.max(-32768, Math.min(32767, Math.round(filtered))))
      }
    }
    this.carry = buffer.subarray(frames * 4)
    return Int16Array.from(out)
  }

  /** Drop any partial frame and reset filter state. */
  flush(): Int16Array {
    this.carry = Buffer.alloc(0)
    this.lp1 = 0
    this.lp2 = 0
    this.phase = 0
    return new Int16Array(0)
  }
}

