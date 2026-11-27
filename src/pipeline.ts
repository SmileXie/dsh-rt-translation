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

export interface LatencyBreakdown { queueWait: number; stt: number; firstToken: number; total: number }
export interface LatencyStats {
  count: number
  p50: number
  p90: number
  last: number
  breakdown?: LatencyBreakdown
}

export interface PipelineDeps {
  stt: SttClient
  translator: Translator
  subtitles: SubtitleModel
  renderer: SubtitleRenderer
  settings: () => ResolvedSettings
  now: () => number
  log: (msg: string, err?: unknown) => void
  onFatal?: (error: unknown) => void
}

interface Job {
  kind: 'partial' | 'final'
  audio: Int16Array
  queuedAt: number
  abort: AbortController
  /** Aborts only this job's LLM stream when a newer segment supersedes it. */
  translation: AbortController
  /** True once the LLM produced text for this job. */
  streamed: boolean
}

const FRAME = 320
const MAX_QUEUED_FINALS = 3
const MAX_LATENCIES = 50
const STT_TIMEOUT_MS = 60_000
const TRANSLATE_TIMEOUT_MS = 30_000

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
  private latencies: LatencyBreakdown[] = []
  private waiters: Array<() => void> = []
  private lastSpeech = 0
  private activeJob: Job | undefined
  private sttFailures = 0
  private translationFailures = 0

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

  pause(): void {
    this.paused = true
    for (const job of this.queue) job.abort.abort(new Error('pipeline paused'))
    this.queue = []
    this.activeJob?.abort.abort(new Error('pipeline paused'))
  }

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
    const values = this.latencies.map(sample => sample.total).sort((a, b) => a - b)
    if (values.length === 0) return { count: 0, p50: 0, p90: 0, last: 0 }
    return {
      count: values.length,
      p50: values[Math.floor(values.length * 0.5)],
      p90: values[Math.min(values.length - 1, Math.floor(values.length * 0.9))],
      last: values[values.length - 1],
      breakdown: this.latencies[this.latencies.length - 1],
    }
  }

  /** Timestamp of the most recent recognised speech, for idle auto-pause. */
  lastSpeechAt(): number { return this.lastSpeech }

  private accept(event: SegmentEvent): void {
    if (event.kind === 'partial' && !this.deps.settings().stt.partials) return
    if (event.kind === 'partial') {
      this.dropQueuedPartials('superseded by newer partial')
    } else {
      this.dropQueuedPartials('superseded by final segment')
      const finals = this.queue.filter(job => job.kind === 'final')
      if (finals.length >= MAX_QUEUED_FINALS) {
        const index = this.queue.findIndex(job => job.kind === 'final')
        if (index >= 0) {
          const [dropped] = this.queue.splice(index, 1)
          dropped?.abort.abort(new Error('stale final segment'))
        }
        this.deps.log('drop stale segment')
      }
    }
    this.abortSupersededPartialTranslation(event.kind)
    this.queue.push({
      kind: event.kind,
      audio: event.audio,
      queuedAt: this.deps.now(),
      abort: new AbortController(),
      translation: new AbortController(),
      streamed: false,
    })
    this.pump()
  }

  /**
   * Stop translating a partial whose text is already on screen when newer audio
   * arrives, so the latest words get translated next instead of waiting for a
   * stale request. A partial that has not produced a token yet is left alone:
   * aborting it would restart the request every 900 ms and, with a slow first
   * token, no translation would ever reach the screen. A final is authoritative
   * and always preempts the in-flight partial, even before its first token.
   */
  private abortSupersededPartialTranslation(kind: 'partial' | 'final'): void {
    const active = this.activeJob
    if (active?.kind !== 'partial') return
    if (kind === 'partial' && !active.streamed) return
    active.translation.abort(new Error(kind === 'final' ? 'final segment' : 'newer partial'))
  }

  /**
   * Discard partials that have not started yet. The active partial is left
   * alone: aborting it makes the local recognizer tear its worker down, so the
   * next partial paid a cold start and was often superseded again before it
   * produced text — the bottom line then stayed empty until the final arrived.
   * Keeping one partial in flight makes partials appear at recognition speed;
   * its result is replaced by the queued newer partial or by the final.
   */
  private dropQueuedPartials(reason: string): void {
    for (const job of this.queue) if (job.kind === 'partial') job.abort.abort(new Error(reason))
    this.queue = this.queue.filter(job => job.kind !== 'partial')
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
      this.activeJob = job
      try { await this.handle(job) } catch (error) {
        if (!this.cancelled(job)) this.deps.log(`${job.kind} job failed`, error)
      } finally {
        if (this.activeJob === job) this.activeJob = undefined
      }
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
    const queueWait = Math.max(0, started - job.queuedAt)
    const id = job.kind === 'final' ? (this.currentId ?? this.nextId()) : (this.currentId ??= this.nextId())
    if (job.kind === 'final') this.currentId = undefined

    let text: string
    try {
      ({ text } = await this.deps.stt.transcribe(pcm16ToWav(job.audio), settings.sourceLanguage, this.jobSignal(job, STT_TIMEOUT_MS)))
    } catch (error) {
      if (this.cancelled(job)) return
      this.sttFailures += 1
      this.deps.log('stt failed', error)
      if (this.sttFailures >= 3) { this.deps.onFatal?.(error); return }
      if (job.kind === 'final') this.showFailure(id, '⚠ 识别失败')
      return
    }
    if (this.cancelled(job)) return
    this.sttFailures = 0
    const transcribedAt = this.deps.now()
    const sttMs = transcribedAt - started
    const source = text.trim()
    if (source === '') return
    this.lastSpeech = this.deps.now()

    const detected = settings.sourceLanguage === 'auto' ? detectLanguage(source) : settings.sourceLanguage
    const needsTranslation = detected !== settings.targetLanguage

    // Translate a partial as soon as it is recognised. Waiting for the final
    // segment made the first translated words appear only after the speaker had
    // finished the sentence and the silence gate had passed.
    if (job.kind === 'partial') {
      this.deps.subtitles.upsertSource(id, source, true)
      if (!needsTranslation) {
        this.deps.subtitles.clearTranslation(id)
        this.renderLatest()
        return
      }
      this.deps.subtitles.beginTranslation(id)
      this.renderLatest()
      try {
        await this.streamTranslation(job, id, source, settings, transcribedAt)
      } catch (error) {
        if (this.cancelled(job)) return
        // The next partial or the final retries; a warning every 900 ms would
        // only flicker, so only finals count towards the fatal threshold.
        this.deps.log('partial translation failed', error)
      }
      return
    }

    if (!needsTranslation) {
      this.deps.subtitles.upsertSource(id, source, false)
      this.deps.subtitles.clearTranslation(id)
      this.deps.subtitles.finishCue(id, this.deps.now())
      this.renderLatest()
      this.record({ queueWait, stt: sttMs, firstToken: 0, total: this.deps.now() - job.queuedAt })
      return
    }

    this.deps.subtitles.upsertSource(id, source, false)
    this.deps.subtitles.beginTranslation(id)
    this.renderLatest()
    let translated = ''
    let firstToken = 0
    try {
      const result = await this.streamTranslation(job, id, source, settings, transcribedAt)
      translated = result.translated
      firstToken = result.firstToken
      if (this.cancelled(job)) return
    } catch (error) {
      if (this.cancelled(job)) return
      this.translationFailures += 1
      this.deps.log('translation failed', error)
      if (this.translationFailures >= 3) { this.deps.onFatal?.(error); return }
      this.deps.subtitles.markFailed(id, '⚠ 翻译失败')
      this.deps.subtitles.finishCue(id, this.deps.now())
      this.renderLatest()
      this.record({ queueWait, stt: sttMs, firstToken, total: this.deps.now() - job.queuedAt })
      return
    }
    this.translationFailures = 0
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
    this.record({ queueWait, stt: sttMs, firstToken, total: this.deps.now() - job.queuedAt })
  }

  /**
   * Stream one translation attempt into the cue. Every attempt overwrites the
   * previous translation (a newer partial or the final segment), instead of
   * appending to it; the old text stays visible until the new attempt's first
   * token arrives so the row does not blank out while waiting.
   */
  private async streamTranslation(
    job: Job,
    id: string,
    source: string,
    settings: ResolvedSettings,
    transcribedAt: number,
  ): Promise<{ translated: string; firstToken: number }> {
    const signal = AbortSignal.any([this.jobSignal(job, TRANSLATE_TIMEOUT_MS), job.translation.signal])
    let translated = ''
    let firstToken = 0
    let replaced = false
    for await (const delta of this.deps.translator.translate({
      text: source,
      source: settings.sourceLanguage,
      target: settings.targetLanguage,
      context: this.context.slice(-settings.translate.contextTurns),
      glossary: [...settings.translate.glossary],
      brief: settings.translate.backgroundBrief,
      signal,
    })) {
      if (this.cancelled(job)) break
      if (firstToken === 0) firstToken = this.deps.now() - transcribedAt
      if (replaced) {
        this.deps.subtitles.appendTranslation(id, delta)
      } else {
        this.deps.subtitles.setTranslation(id, delta)
        replaced = true
        job.streamed = true
      }
      translated += delta
      this.renderLatest()
    }
    return { translated, firstToken }
  }

  private cancelled(job: Job): boolean {
    return job.abort.signal.aborted || job.translation.signal.aborted || this.lifetime.signal.aborted
  }

  private jobSignal(job: Job, timeoutMs: number): AbortSignal {
    return AbortSignal.any([this.lifetime.signal, job.abort.signal, AbortSignal.timeout(timeoutMs)])
  }

  private showFailure(id: string, warning: string): void {
    this.deps.subtitles.upsertSource(id, warning, false)
    this.deps.subtitles.finishCue(id, this.deps.now())
    this.renderLatest()
  }

  private record(sample: LatencyBreakdown): void {
    this.latencies.push(sample)
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
