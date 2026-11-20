/** Energy-based speech segmentation with pre-roll, forced cuts and partial results. */
export type SegmentEvent = { kind: 'partial' | 'final'; audio: Int16Array }

export interface SegmenterOptions {
  silenceMs: number
  maxSegmentMs: number
  partialIntervalMs: number
  speechMs?: number
  releaseMs?: number
  preRollMs?: number
}

const FRAME_MS = 20
const OVERLAP_FRAMES = 12
const TRAIL_MS = 100

function rms(frame: Int16Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / frame.length)
}

function concat(frames: Int16Array[]): Int16Array {
  const total = frames.reduce((n, f) => n + f.length, 0)
  const out = new Int16Array(total)
  let offset = 0
  for (const frame of frames) { out.set(frame, offset); offset += frame.length }
  return out
}

export class Segmenter {
  private readonly silenceFrames: number
  private readonly maxFrames: number
  private readonly partialFrames: number
  private readonly speechFrames: number
  private readonly releaseFrames: number
  private readonly preRollFrames: number

  private current: 'idle' | 'speech' = 'idle'
  private noiseFloor = 200
  private above = 0
  private below = 0
  private ring: Int16Array[] = []
  private segment: Int16Array[] = []
  private partialAt = 0

  constructor(options: SegmenterOptions) {
    this.silenceFrames = Math.max(1, Math.round(options.silenceMs / FRAME_MS))
    this.maxFrames = Math.max(2, Math.round(options.maxSegmentMs / FRAME_MS))
    this.partialFrames = Math.max(1, Math.round(options.partialIntervalMs / FRAME_MS))
    this.speechFrames = Math.max(1, Math.round((options.speechMs ?? 60) / FRAME_MS))
    this.releaseFrames = Math.max(1, Math.round((options.releaseMs ?? 300) / FRAME_MS))
    this.preRollFrames = Math.max(0, Math.round((options.preRollMs ?? 200) / FRAME_MS))
  }

  get state(): 'idle' | 'speech' { return this.current }

  reset(): void {
    this.current = 'idle'
    this.noiseFloor = 200
    this.above = 0
    this.below = 0
    this.ring = []
    this.segment = []
    this.partialAt = 0
  }

  push(frame: Int16Array): SegmentEvent[] {
    const energy = rms(frame)
    const threshold = Math.max(this.noiseFloor * 3, 400)
    if (this.current === 'idle') return this.pushIdle(frame, energy, threshold)
    return this.pushSpeech(frame, energy, threshold)
  }

  private pushIdle(frame: Int16Array, energy: number, threshold: number): SegmentEvent[] {
    this.noiseFloor = this.noiseFloor * 0.98 + energy * 0.02
    this.ring.push(frame)
    if (this.ring.length > this.preRollFrames + this.speechFrames) this.ring.shift()
    this.above = energy > threshold ? this.above + 1 : 0
    if (this.above < this.speechFrames) return []
    this.current = 'speech'
    this.segment = [...this.ring]
    this.ring = []
    this.below = 0
    this.partialAt = this.segment.length
    return []
  }

  private pushSpeech(frame: Int16Array, energy: number, threshold: number): SegmentEvent[] {
    this.segment.push(frame)
    this.below = energy > threshold ? 0 : this.below + 1
    const events: SegmentEvent[] = []
    if (this.below >= this.silenceFrames) {
      const final = this.finalize()
      if (final) events.push(final)
      return events
    }
    if (this.segment.length >= this.maxFrames) {
      const cut = this.forcedCut()
      if (cut) events.push(cut)
      return events
    }
    if (this.segment.length - this.partialAt >= this.partialFrames) {
      this.partialAt = this.segment.length
      events.push({ kind: 'partial', audio: concat(this.segment) })
    }
    return events
  }

  private finalize(): SegmentEvent | undefined {
    let lastLoud = -1
    const threshold = Math.max(this.noiseFloor * 3, 400)
    for (let i = this.segment.length - 1; i >= 0; i--) {
      if (rms(this.segment[i]) > threshold) { lastLoud = i; break }
    }
    const keep = lastLoud < 0 ? 0 : lastLoud + 1 + Math.round(TRAIL_MS / FRAME_MS)
    const frames = this.segment.slice(0, keep)
    this.current = 'idle'
    this.segment = []
    this.partialAt = 0
    this.above = 0
    this.below = 0
    this.ring = []
    if (frames.length < this.releaseFrames) return undefined
    return { kind: 'final', audio: concat(frames) }
  }

  private forcedCut(): SegmentEvent | undefined {
    const windowStart = Math.max(this.releaseFrames, this.segment.length - Math.round(1500 / FRAME_MS))
    let cut = this.segment.length - 1
    let lowest = Infinity
    for (let i = windowStart; i < this.segment.length; i++) {
      const energy = rms(this.segment[i])
      if (energy <= lowest) { lowest = energy; cut = i }
    }
    const frames = this.segment.slice(0, cut + 1)
    const remainder = this.segment.slice(Math.max(0, cut - OVERLAP_FRAMES))
    this.current = 'speech'
    this.segment = remainder
    this.below = 0
    this.partialAt = this.segment.length
    if (frames.length < this.releaseFrames) return undefined
    return { kind: 'final', audio: concat(frames) }
  }
}

