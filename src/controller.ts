/** Plugin lifecycle: model preparation, capture ownership, and UI state. */
import type { Language, ResolvedSettings, SourceLanguage } from './config.ts'
import { resolveConfig } from './config.ts'
import type { Pipeline, PipelineDeps } from './pipeline.ts'
import type { SttClient } from './stt.ts'
import type { Translator } from './translate.ts'
import type { SubtitleModel } from './subtitle/state.ts'
import type { SubtitleRenderer } from './subtitle/renderer.ts'
import type { UiState } from './subtitle/protocol.ts'
import { toStylePayload } from './subtitle/protocol.ts'

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
  /** Whether runtime setting changes reach the profile; false shows a status warning. */
  persistence?: () => boolean
  /** Retry delays for capture failures; tests can shorten them. */
  retryDelays?: number[]
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
  private listeningSince = 0
  private lastIdleCheck = 0
  private startGeneration = 0
  private captureRetrying = false
  private captureOpenedAt = 0
  private readonly backoff: number[]

  constructor(deps: ControllerDeps) {
    this.deps = deps
    this.backoff = deps.retryDelays ?? BACKOFF
  }

  /** Prepare the recognizer and start capturing system audio. */
  async start(): Promise<void> {
    if (this.disposed) return
    if (this.phase === 'listening') return
    if (this.phase === 'paused') { this.resumeFromPause(); return }
    const generation = ++this.startGeneration
    this.setPhase('preparing')
    try {
      // The tray "quit" action closes the overlay; starting again respawns it.
      await this.deps.renderer.start()
      await this.deps.stt.ensureReady()
    } catch (error) {
      if (generation === this.startGeneration) this.fail(error)
      return
    }
    if (generation !== this.startGeneration || this.disposed) return
    this.captureRetries = 0
    try {
      this.openCapture()
    } catch (error) {
      if (generation === this.startGeneration) this.fail(error)
      return
    }
    this.listeningSince = Date.now()
    this.lastIdleCheck = Date.now()
    this.setPhase('listening')
  }

  /** Download and load the recognizer without opening audio capture. */
  prepareModel(): void {
    this.deps.stt.prepare()
  }

  /** Stop capture and close the subtitle window; the overlay process stays resident. */
  async stop(): Promise<void> {
    await this.halt()
    this.deps.subtitles.clear()
    this.deps.renderer.clear()
  }

  /**
   * Tray "quit": close the overlay and tray without disposing the plugin, so the
   * control panel (or `/rt start`) can spawn them again on the next start.
   */
  async quit(): Promise<void> {
    await this.stop()
    await this.deps.renderer.close()
    this.setPhase('idle')
  }

  async restart(): Promise<void> {
    await this.halt()
    await this.start()
  }

  /** Stop capture and translation without touching overlay visibility. */
  private async halt(): Promise<void> {
    this.startGeneration += 1
    this.source?.close()
    this.source = undefined
    this.stopMonitor()
    await this.pipeline?.stop()
    this.pipeline = undefined
    this.error = null
    this.setPhase('idle')
  }

  /** Change both subtitle languages and persist them. */
  async setLanguages(source: SourceLanguage, target: Language): Promise<void> {
    if (source !== 'auto' && !LANGUAGES.has(source)) throw new Error(`不支持的语言: ${source}`)
    if (!LANGUAGES.has(target)) throw new Error(`不支持的语言: ${target}`)
    await this.deps.patchSettings({ sourceLanguage: source, targetLanguage: target })
    this.emit()
  }

  /** Update segmentation; rebuilding the running pipeline applies it immediately. */
  async setSegment(patch: Partial<ResolvedSettings['segment']>): Promise<void> {
    const segment = { ...this.deps.settings().segment, ...patch }
    await this.deps.patchSettings({ segment })
    if (this.phase === 'listening') await this.restart()
    else this.emit()
  }

  /** Update the long-silence auto-pause threshold (0 disables it). */
  async setAutoPause(afterMs: number): Promise<void> {
    await this.deps.patchSettings({ autoPauseAfterMs: Math.max(0, Math.round(afterMs)) })
    this.emit()
  }

  /**
   * Restore the panel's tuning knobs to the plugin defaults. Languages stay as
   * chosen: they describe the audio being played, not a preference to reset.
   */
  async resetDefaults(): Promise<void> {
    const defaults = resolveConfig({})
    await this.deps.patchSettings({
      segment: defaults.segment,
      autoPauseAfterMs: defaults.autoPauseAfterMs,
      subtitle: defaults.subtitle,
    })
    this.applySubtitle()
    this.emit()
    // Segment values only reach the running segmenter through a new pipeline.
    if (this.phase === 'listening') await this.restart()
  }

  /** Apply a partial subtitle style change from the settings panel or hotkeys. */
  async setSubtitle(patch: Partial<ResolvedSettings['subtitle']>): Promise<void> {
    const subtitle = { ...this.deps.settings().subtitle, ...patch }
    await this.deps.patchSettings({ subtitle })
    this.applySubtitle()
    this.emit()
  }

  /** Switch capture scope and restart capture when it is already running. */
  async setCapture(mode: 'system' | 'system-exclude-self' | 'app', appName: string): Promise<void> {
    const settings = this.deps.settings()
    await this.deps.patchSettings({ capture: { ...settings.capture, mode, appName } })
    if (this.phase === 'listening') await this.restart()
    else this.emit()
  }

  /** Override the translation route. */
  async setModel(provider: string, model: string): Promise<void> {
    const settings = this.deps.settings()
    await this.deps.patchSettings({ translate: { ...settings.translate, provider, model } })
    this.emit()
  }

  /** Clear visible subtitles without stopping capture. */
  clear(): void {
    this.deps.subtitles.clear()
    this.deps.renderer.clear()
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
      glossary: [...settings.translate.glossary],
      signal: AbortSignal.timeout(30_000),
    })) { translated += delta; this.deps.subtitles.appendTranslation(id, delta) }
    this.deps.subtitles.finishCue(id, Date.now())
    const cue = this.deps.subtitles.snapshot().at(-1)
    if (cue !== undefined) this.deps.renderer.cue(cue)
  }

  status(): string {
    const settings = this.deps.settings()
    const stats = this.pipeline?.stats() ?? { count: 0, p50: 0, p90: 0, last: 0 }
    const autoPause = settings.autoPauseAfterMs > 0 ? `${Math.round(settings.autoPauseAfterMs / 1000)}s` : '关闭'
    return [
      `状态: ${this.phase}`,
      `语言: ${settings.sourceLanguage} → ${settings.targetLanguage}`,
      `切分: 静音 ${settings.segment.silenceMs}ms / 最长 ${settings.segment.maxSegmentMs}ms / 自动暂停 ${autoPause}`,
      `识别: ${this.deps.stt.status()}`,
      `翻译: ${settings.translate.provider || '跟随默认'} / ${settings.translate.model || '自动'}`,
      ...this.deps.persistence?.() === false ? ['持久化: 未写入 profile（仅内存）'] : [],
      `延迟: P50 ${Math.round(stats.p50)}ms / P90 ${Math.round(stats.p90)}ms (${stats.count})`,
      ...stats.breakdown === undefined ? [] : [`分段: 队列 ${Math.round(stats.breakdown.queueWait)}ms / 识别 ${Math.round(stats.breakdown.stt)}ms / 首字 ${Math.round(stats.breakdown.firstToken)}ms`],
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
      error: this.error,
    }
  }

  onState(cb: (state: UiState) => void): void { this.listeners.add(cb) }

  /** Mark the controller failed after the renderer process dies. */
  rendererFailed(error: unknown): void { this.fail(error) }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
    await this.deps.renderer.dispose()
  }

  /** Capture health check, exposed so tests can drive it without timers. */
  async _checkCaptureForTest(): Promise<void> {
    if (this.captureRetrying) return
    const source = this.source
    if (source === undefined) return
    if (source.lastError === null) {
      if (this.captureRetries > 0 && Date.now() - this.captureOpenedAt > 10_000) this.captureRetries = 0
      return
    }
    const message = source.lastError
    if (this.captureRetries >= this.backoff.length) { this.fail(new Error(message)); return }
    const delay = this.backoff[this.captureRetries++]
    this.captureRetrying = true
    this.deps.log(`capture failed: ${message}; retrying in ${delay}ms`)
    try {
      await new Promise(resolve => setTimeout(resolve, delay))
      if (this.disposed || this.phase !== 'listening') return
      try { this.openCapture() } catch (error) { this.fail(error) }
    } finally {
      this.captureRetrying = false
    }
  }

  /** Long-silence auto-pause check, exposed so tests can drive it without timers. */
  async _checkIdleForTest(now = Date.now()): Promise<void> {
    if (now - this.lastIdleCheck < 5000) return
    this.lastIdleCheck = now
    const settings = this.deps.settings()
    if (this.phase !== 'listening') return
    const threshold = settings.autoPauseAfterMs
    const pipeline = this.pipeline
    if (threshold <= 0 || pipeline === undefined) return
    const last = pipeline.lastSpeechAt()
    const baseline = last > 0 ? last : this.listeningSince
    if (baseline <= 0 || now - baseline <= threshold) return
    pipeline.pause()
    this.source?.close()
    this.source = undefined
    this.stopMonitor()
    this.deps.log(`idle ${now - baseline}ms; paused`)
    this.setPhase('paused')
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
      onFatal: error => this.fail(error),
    })
    this.pipeline = pipeline
    this.source = this.deps.capture.open(chunk => pipeline.feed(chunk), {
      mode: settings.capture.mode,
      appName: settings.capture.appName,
    })
    this.captureOpenedAt = Date.now()
    this.startMonitor()
  }

  private startMonitor(): void {
    this.stopMonitor()
    const timer = setInterval(() => {
      void this._checkIdleForTest()
      void this._checkCaptureForTest()
    }, 500)
    timer.unref?.()
    this.monitor = timer
  }

  private stopMonitor(): void {
    if (this.monitor !== undefined) clearInterval(this.monitor)
    this.monitor = undefined
  }

  /** Resume from the long-silence auto-pause; capture was closed, so reopen it. */
  private resumeFromPause(): void {
    if (this.source === undefined) {
      try { this.openCapture() } catch (error) { this.fail(error); return }
    }
    this.pipeline?.resume()
    this.captureRetries = 0
    this.listeningSince = Date.now()
    this.lastIdleCheck = Date.now()
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
    void this.pipeline?.stop()
    this.pipeline = undefined
    this.setPhase('error')
  }

  private emit(): void {
    const state = this.state()
    for (const listener of this.listeners) listener(state)
  }

  private applySubtitle(): void {
    const subtitle = this.deps.settings().subtitle
    this.deps.subtitles.configure({
      // Keep the visible history rows plus the sentence still being spoken.
      maxCues: Math.max(3, subtitle.maxLines + 1),
      bilingual: subtitle.bilingual,
      holdMs: subtitle.holdMs,
    })
    this.deps.renderer.style(toStylePayload(subtitle))
  }
}

