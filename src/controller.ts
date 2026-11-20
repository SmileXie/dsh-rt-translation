/** Plugin lifecycle: model preparation, capture ownership, and UI state. */
import type { Language, Preset, ResolvedSettings, SourceLanguage } from './config.ts'
import type { Pipeline, PipelineDeps } from './pipeline.ts'
import type { SttClient } from './stt.ts'
import type { Translator } from './translate.ts'
import type { SubtitleModel } from './subtitle/state.ts'
import type { SubtitleRenderer } from './subtitle/renderer.ts'
import type { UiState } from './subtitle/protocol.ts'

export type Phase = 'idle' | 'preparing' | 'listening' | 'paused' | 'error'

export interface AudioSource { close(): void; readonly lastError: string | null }
export interface AudioSourceFactory { open(onChunk: (chunk: Uint8Array) => void, opts: { mode: string; appName: string }): AudioSource }

export interface ControllerDeps {
  settings: () => ResolvedSettings
  patchSettings: (patch: Partial<ResolvedSettings>) => Promise<void>
  stt: SttClient
  translator: Translator
  renderer: SubtitleRenderer
  subtitles: SubtitleModel
  capture: AudioSourceFactory
  makePipeline: (deps: PipelineDeps) => Pipeline
  log: (msg: string, err?: unknown) => void
}

const LANGUAGES = new Set(['zh', 'en', 'ja', 'ko', 'yue'])
const BACKOFF = [1000, 2000, 5000]

export class Controller {
  private readonly deps: ControllerDeps
  private phase: Phase = 'idle'
  private error: string | null = null
  private pipeline: Pipeline | undefined
  private source: AudioSource | undefined
  private listeners = new Set<(state: UiState) => void>()
  private monitor: ReturnType<typeof setInterval> | undefined
  private captureRetries = 0
  private disposed = false

  constructor(deps: ControllerDeps) {
    this.deps = deps
  }

  /** Prepare the recognizer and start capturing system audio. */
  async start(): Promise<void> {
    if (this.disposed) return
    if (this.phase === 'listening') return
    if (this.phase === 'paused') { this.resumePipeline(); return }
    this.setPhase('preparing')
    try {
      await this.deps.stt.ensureReady()
    } catch (error) {
      this.fail(error)
      return
    }
    try {
      this.openCapture()
    } catch (error) {
      this.fail(error)
      return
    }
    this.setPhase('listening')
  }

  /** Stop capture and clear the screen; the overlay process stays resident. */
  async stop(): Promise<void> {
    this.source?.close()
    this.source = undefined
    this.stopMonitor()
    await this.pipeline?.stop()
    this.pipeline = undefined
    this.deps.subtitles.clear()
    this.deps.renderer.clear()
    this.error = null
    this.setPhase('idle')
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  /** Change both subtitle languages and persist them. */
  async setLanguages(source: SourceLanguage, target: Language): Promise<void> {
    if (source !== 'auto' && !LANGUAGES.has(source)) throw new Error(`不支持的语言: ${source}`)
    if (!LANGUAGES.has(target)) throw new Error(`不支持的语言: ${target}`)
    await this.deps.patchSettings({ sourceLanguage: source, targetLanguage: target })
    this.emit()
  }

  /** Switch the meeting/media preset. */
  async setMode(preset: Preset): Promise<void> {
    if (preset !== 'meeting' && preset !== 'media') throw new Error(`不支持的模式: ${preset}`)
    await this.deps.patchSettings({ preset })
    this.emit()
  }

  /** Translate one literal string and show it, without touching capture. */
  async test(text: string): Promise<void> {
    const settings = this.deps.settings()
    const id = `test-${Date.now()}`
    this.deps.subtitles.upsertSource(id, text, false)
    this.deps.subtitles.beginTranslation(id)
    let translated = ''
    for await (const delta of this.deps.translator.translate({
      text,
      source: settings.sourceLanguage,
      target: settings.targetLanguage,
      context: [],
      glossary: [...settings.translate.glossary, ...settings.media.glossary],
      signal: AbortSignal.timeout(30_000),
    })) { translated += delta; this.deps.subtitles.appendTranslation(id, delta) }
    this.deps.subtitles.finishCue(id, Date.now())
    const cue = this.deps.subtitles.snapshot().at(-1)
    if (cue !== undefined) this.deps.renderer.cue(cue)
  }

  status(): string {
    const settings = this.deps.settings()
    const stats = this.pipeline?.stats() ?? { count: 0, p50: 0, p90: 0, last: 0 }
    return [
      `状态: ${this.phase}`,
      `语言: ${settings.sourceLanguage} → ${settings.targetLanguage}`,
      `模式: ${settings.preset}`,
      `识别: ${this.deps.stt.status()}`,
      `翻译: ${settings.translate.provider || '跟随默认'} / ${settings.translate.model || '自动'}`,
      `延迟: P50 ${Math.round(stats.p50)}ms / P90 ${Math.round(stats.p90)}ms (${stats.count})`,
      `错误: ${this.error ?? '无'}`,
    ].join('\n')
  }

  state(): UiState {
    const settings = this.deps.settings()
    return {
      running: this.phase === 'listening',
      phase: this.phase,
      source: settings.sourceLanguage,
      target: settings.targetLanguage,
      preset: settings.preset,
      error: this.error,
    }
  }

  onState(cb: (state: UiState) => void): void { this.listeners.add(cb) }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
    await this.deps.renderer.dispose()
  }

  /** Capture health check, exposed so tests can drive it without timers. */
  async _checkCaptureForTest(): Promise<void> {
    const source = this.source
    if (source === undefined || source.lastError === null) { this.captureRetries = 0; return }
    const message = source.lastError
    if (this.captureRetries >= BACKOFF.length) { this.fail(new Error(message)); return }
    const delay = BACKOFF[this.captureRetries++]
    this.deps.log(`capture failed: ${message}; retrying in ${delay}ms`)
    await new Promise(resolve => setTimeout(resolve, delay))
    if (this.disposed) return
    try { this.openCapture() } catch (error) { this.fail(error) }
  }

  private openCapture(): void {
    this.source?.close()
    const settings = this.deps.settings()
    const pipeline = this.pipeline ?? this.deps.makePipeline({
      stt: this.deps.stt,
      translator: this.deps.translator,
      subtitles: this.deps.subtitles,
      renderer: this.deps.renderer,
      settings: this.deps.settings,
      now: () => Date.now(),
      log: this.deps.log,
    })
    this.pipeline = pipeline
    this.source = this.deps.capture.open(chunk => pipeline.feed(chunk), {
      mode: settings.capture.mode,
      appName: settings.capture.appName,
    })
    this.captureRetries = 0
    this.startMonitor()
  }

  private startMonitor(): void {
    this.stopMonitor()
    const timer = setInterval(() => { void this._checkCaptureForTest() }, 500)
    timer.unref?.()
    this.monitor = timer
  }

  private stopMonitor(): void {
    if (this.monitor !== undefined) clearInterval(this.monitor)
    this.monitor = undefined
  }

  private resumePipeline(): void {
    this.pipeline?.resume()
    this.setPhase('listening')
  }

  private setPhase(phase: Phase): void {
    this.phase = phase
    this.emit()
  }

  private fail(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error)
    this.deps.log('controller error', error)
    this.source?.close()
    this.source = undefined
    this.stopMonitor()
    this.setPhase('error')
  }

  private emit(): void {
    const state = this.state()
    for (const listener of this.listeners) listener(state)
    this.deps.renderer.state(state)
  }
}
