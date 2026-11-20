/** Orchestrates capture chunks into subtitle cues; owns ordering, not IO. */
import { DownmixResampler } from './audio/resample.ts'
import { Segmenter, type SegmentEvent } from './audio/vad.ts'
import { pcm16ToWav } from './audio/wav.ts'
import { detectLanguage } from './detect.ts'
import type { ResolvedSettings } from './config.ts'
import type { SttClient } from './stt.ts'
import type { TranslationContext, Translator } from './translate.ts'
import { cleanTranslation } from './translate.ts'
import type { SubtitleModel } from './subtitle/state.ts'
import type { SubtitleRenderer } from './subtitle/renderer.ts'

export interface LatencyStats { count: number; p50: number; p90: number; last: number }

export interface PipelineDeps {
  stt: SttClient
  translator: Translator
  subtitles: SubtitleModel
  renderer: SubtitleRenderer
  settings: () => ResolvedSettings
  now: () => number
  log: (msg: string, err?: unknown) => void
}

interface Job { kind: 'partial' | 'final'; audio: Int16Array }

const FRAME = 320
const MAX_QUEUED_FINALS = 3
const MAX_LATENCIES = 50

export class Pipeline {
  private readonly deps: PipelineDeps
  private readonly resampler = new DownmixResampler()
  private readonly segmenter: Segmenter
  private readonly lifetime = new AbortController()
  private carry: Int16Array = new Int16Array(0)
  private queue: Job[] = []
  private running = false
  private paused = false
  private counter = 0
  private currentId: string | undefined
  private context: TranslationContext[] = []
  private latencies: number[] = []
  private waiters: Array<() => void> = []
  private lastSpeech = 0

  constructor(deps: PipelineDeps) {
    this.deps = deps
    const segment = deps.settings().segment
    this.segmenter = new Segmenter({
      silenceMs: segment.silenceMs,
      maxSegmentMs: segment.maxSegmentMs,
      partialIntervalMs: deps.settings().stt.partialIntervalMs,
      preRollMs: segment.preRollMs,
    })
  }

  /** Accept one 48 kHz stereo chunk from the capture source. */
  feed(chunk: Uint8Array): void {
    if (this.paused || this.lifetime.signal.aborted) return
    const pcm = this.resampler.push(chunk)
    this.carry = this.carry.length === 0 ? pcm : Pipeline.concat(this.carry, pcm)
    let offset = 0
    while (this.carry.length - offset >= FRAME) {
      const frame = this.carry.subarray(offset, offset + FRAME)
      offset += FRAME
      for (const event of this.segmenter.push(frame)) this.accept(event)
    }
    this.carry = this.carry.subarray(offset)
  }

  pause(): void { this.paused = true }

  resume(): void {
    this.paused = false
    this.segmenter.reset()
    this.carry = new Int16Array(0)
  }

  /** Wait until every queued segment settles. */
  flush(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve()
    return new Promise(resolve => { this.waiters.push(resolve) })
  }

  async stop(): Promise<void> {
    this.lifetime.abort(new Error('pipeline stopped'))
    this.queue = []
    this.paused = true
    await this.flush()
  }

  stats(): LatencyStats {
    const values = [...this.latencies].sort((a, b) => a - b)
    if (values.length === 0) return { count: 0, p50: 0, p90: 0, last: 0 }
    return {
      count: values.length,
      p50: values[Math.floor(values.length * 0.5)],
      p90: values[Math.min(values.length - 1, Math.floor(values.length * 0.9))],
      last: values[values.length - 1],
    }
  }

  /** Timestamp of the most recent recognised speech, for idle auto-pause. */
  lastSpeechAt(): number { return this.lastSpeech }

  private accept(event: SegmentEvent): void {
    if (event.kind === 'partial' && !this.deps.settings().stt.partials) return
    if (event.kind === 'final') {
      const finals = this.queue.filter(job => job.kind === 'final')
      if (finals.length >= MAX_QUEUED_FINALS) {
        const index = this.queue.findIndex(job => job.kind === 'final')
        if (index >= 0) this.queue.splice(index, 1)
        this.deps.log('drop stale segment')
      }
    }
    this.queue.push({ kind: event.kind, audio: event.audio })
    this.pump()
  }

  private pump(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  private async loop(): Promise<void> {
    while (this.queue.length > 0) {
      const job = this.queue.shift()
      if (job === undefined) break
      try { await this.handle(job) } catch (error) { this.deps.log(`${job.kind} job failed`, error) }
    }
    this.running = false
    if (this.queue.length === 0) {
      const waiters = this.waiters
      this.waiters = []
      for (const resolve of waiters) resolve()
    }
  }

  private async handle(job: Job): Promise<void> {
    const settings = this.deps.settings()
    const started = this.deps.now()
    const id = job.kind === 'final' ? (this.currentId ?? this.nextId()) : (this.currentId ??= this.nextId())
    if (job.kind === 'final') this.currentId = undefined

    const { text } = await this.deps.stt.transcribe(pcm16ToWav(job.audio), settings.sourceLanguage, this.lifetime.signal)
    const source = text.trim()
    if (source === '') return
    this.lastSpeech = this.deps.now()

    if (job.kind === 'partial') {
      this.deps.subtitles.upsertSource(id, source, true)
      this.renderLatest()
      return
    }

    const detected = settings.sourceLanguage === 'auto' ? detectLanguage(source) : settings.sourceLanguage
    if (detected === settings.targetLanguage) {
      this.deps.subtitles.upsertSource(id, source, false)
      this.deps.subtitles.finishCue(id, this.deps.now())
      this.renderLatest()
      this.record(started)
      return
    }

    this.deps.subtitles.upsertSource(id, source, false)
    this.deps.subtitles.beginTranslation(id)
    this.renderLatest()
    let translated = ''
    for await (const delta of this.deps.translator.translate({
      text: source,
      source: settings.sourceLanguage,
      target: settings.targetLanguage,
      context: this.context.slice(-settings.translate.contextTurns),
      glossary: [...settings.translate.glossary, ...settings.media.glossary],
      signal: this.lifetime.signal,
    })) {
      translated += delta
      this.deps.subtitles.appendTranslation(id, delta)
      this.renderLatest()
    }
    const final = cleanTranslation(translated)
    if (final === '') {
      this.deps.log('empty translation')
      this.deps.subtitles.upsertSource(id, source, false)
    }
    this.deps.subtitles.finishCue(id, this.deps.now())
    this.renderLatest()
    if (final !== '') {
      this.context.push({ source, target: final })
      if (this.context.length > 8) this.context.shift()
    }
    this.record(started)
  }

  private record(started: number): void {
    this.latencies.push(this.deps.now() - started)
    if (this.latencies.length > MAX_LATENCIES) this.latencies.shift()
  }

  private renderLatest(): void {
    const cue = this.deps.subtitles.snapshot().at(-1)
    if (cue !== undefined) this.deps.renderer.cue(cue)
  }

  private nextId(): string { this.counter += 1; return `c${this.counter}` }

  private static concat(a: Int16Array, b: Int16Array): Int16Array {
    const out = new Int16Array(a.length + b.length)
    out.set(a, 0); out.set(b, a.length)
    return out
  }
}
