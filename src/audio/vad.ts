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
const FORCED_CUT_WINDOW_MS = 2500
/** Start a segment above `noiseFloor * ratio` and never below this absolute RMS. */
const ENTER_NOISE_RATIO = 2.5
const ENTER_FLOOR = 320
/** Below this a frame is silence: quieter than the start gate, so soft syllables inside a sentence survive. */
const EXIT_NOISE_RATIO = 1.5
const EXIT_FLOOR = 140
/** Keep a real gap between start and end gates no matter how loud the background is. */
const EXIT_CEILING_RATIO = 0.7

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
    this.preRollFrames = Math.max(0, Math.round((options.preRollMs ?? 400) / FRAME_MS))
  }

  get state(): 'idle' | 'speech' { return this.current }

  reset(): void {
    this.resetSegment()
    this.noiseFloor = 200
  }

  push(frame: Int16Array): SegmentEvent[] {
    const energy = rms(frame)
    if (this.current === 'idle') return this.pushIdle(frame, energy)
    return this.pushSpeech(frame, energy)
  }

  /** Level that opens a segment; tracked from ambient noise only while idle. */
  private enterThreshold(): number {
    return Math.max(this.noiseFloor * ENTER_NOISE_RATIO, ENTER_FLOOR)
  }

  /** Level under which a frame is silence; always below the gate that opened the segment. */
  private exitThreshold(enter: number): number {
    return Math.min(Math.max(this.noiseFloor * EXIT_NOISE_RATIO, EXIT_FLOOR), enter * EXIT_CEILING_RATIO)
  }

  private voicedFrames(frames: Int16Array[]): number {
    const exit = this.exitThreshold(this.enterThreshold())
    let voiced = 0
    for (const frame of frames) if (rms(frame) > exit) voiced += 1
    return voiced
  }

  private pushIdle(frame: Int16Array, energy: number): SegmentEvent[] {
    const enter = this.enterThreshold()
    // Speech must not feed the ambient estimate: the first syllables of an utterance used
    // to raise the gate for the rest of that same utterance, so its own tail read as silence.
    if (energy <= enter) this.noiseFloor = this.noiseFloor * 0.98 + energy * 0.02
    this.ring.push(frame)
    if (this.ring.length > this.preRollFrames + this.speechFrames) this.ring.shift()
    this.above = energy > enter ? this.above + 1 : 0
    if (this.above < this.speechFrames) return []
    this.current = 'speech'
    this.segment = [...this.ring]
    this.ring = []
    this.below = 0
    this.partialAt = this.segment.length
    return []
  }

  private pushSpeech(frame: Int16Array, energy: number): SegmentEvent[] {
    this.segment.push(frame)
    this.below = energy > this.exitThreshold(this.enterThreshold()) ? 0 : this.below + 1
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

  /**
   * Keep the whole segment. Trimming back to the last frame above the start gate used to
   * discard soft sentence endings (falling pitch, trailing particles): the audio was read
   * as silence and never reached the recognizer, so sentences showed up as halves.
   */
  private finalize(): SegmentEvent | undefined {
    const frames = this.segment
    this.resetSegment()
    if (this.voicedFrames(frames) < this.releaseFrames) return undefined
    return { kind: 'final', audio: concat(frames) }
  }

  private forcedCut(): SegmentEvent | undefined {
    const windowStart = Math.max(this.releaseFrames, this.segment.length - Math.round(FORCED_CUT_WINDOW_MS / FRAME_MS))
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
    if (this.voicedFrames(frames) < this.releaseFrames) return undefined
    return { kind: 'final', audio: concat(frames) }
  }

  private resetSegment(): void {
    this.current = 'idle'
    this.segment = []
    this.partialAt = 0
    this.above = 0
    this.below = 0
    this.ring = []
  }
}
