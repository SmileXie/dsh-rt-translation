/** Thin client over the host's speech-to-text registry. */
import type { SourceLanguage } from './config.ts'

export interface TranscriptResult { text: string; audioSeconds: number; inferenceSeconds: number }

export interface SpeechPreparationSnapshot {
  phase: string
  message?: string
  completedBytes?: number
  totalBytes?: number
}

export interface SpeechProviderSnapshot {
  providers: Array<{ id: string; preparation: SpeechPreparationSnapshot }>
}

export interface SpeechToTextLike {
  prepare(id: string): void
  snapshot(): SpeechProviderSnapshot
  resolve(request: { audio: Uint8Array; language: string; providerId: string }): unknown
  transcribe(spec: unknown, signal: AbortSignal): Promise<TranscriptResult>
}

export interface SttClient {
  prepare(): void
  ensureReady(signal?: AbortSignal): Promise<void>
  transcribe(wav: Uint8Array, language: SourceLanguage, signal: AbortSignal): Promise<TranscriptResult>
  status(): string
}

const READY = new Set(['ready', 'standby'])
const LABELS: Record<string, string> = {
  unprepared: '未准备', downloading: '下载中', checking: '检查中', loading: '加载中',
  waking: '唤醒中', ready: '就绪', standby: '待机', failed: '失败', cancelled: '已取消',
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    const abort = (): void => { clearTimeout(timer); reject(signal?.reason) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export class SenseVoiceClient implements SttClient {
  private readonly speechToText: SpeechToTextLike
  private readonly providerId: string
  private readonly pollMs: number
  private readonly timeoutMs: number

  constructor(speechToText: SpeechToTextLike, providerId: string, opts: { pollMs?: number; timeoutMs?: number } = {}) {
    this.speechToText = speechToText
    this.providerId = providerId
    this.pollMs = opts.pollMs ?? 250
    this.timeoutMs = opts.timeoutMs ?? 600_000
  }

  /** Start downloading and loading the recognizer without waiting for readiness. */
  prepare(): void {
    this.speechToText.prepare(this.providerId)
  }

  /** Ask the host to prepare the recognizer and wait until it can accept audio. */
  async ensureReady(signal?: AbortSignal): Promise<void> {
    const started = Date.now()
    this.speechToText.prepare(this.providerId)
    for (;;) {
      const provider = this.speechToText.snapshot().providers.find(p => p.id === this.providerId)
      if (provider !== undefined && READY.has(provider.preparation.phase)) return
      if (provider?.preparation.phase === 'failed') throw new Error(provider.preparation.message ?? '语音模型准备失败')
      if (Date.now() - started > this.timeoutMs) throw new Error('语音模型准备超时')
      await sleep(this.pollMs, signal)
    }
  }

  /** Transcribe one WAV recording with an explicit language hint. */
  async transcribe(wav: Uint8Array, language: SourceLanguage, signal: AbortSignal): Promise<TranscriptResult> {
    const spec = this.speechToText.resolve({ audio: wav, language, providerId: this.providerId })
    return await this.speechToText.transcribe(spec, signal)
  }

  status(): string {
    const provider = this.speechToText.snapshot().providers.find(p => p.id === this.providerId)
    const preparation = provider?.preparation
    const phase = preparation?.phase ?? 'unprepared'
    if (phase === 'downloading' && preparation?.totalBytes !== undefined && preparation.totalBytes > 0) {
      const completedBytes = preparation.completedBytes ?? 0
      const percent = Math.min(100, Math.floor(completedBytes / preparation.totalBytes * 100))
      return `下载中 ${percent}%（${formatMegabytes(completedBytes)} / ${formatMegabytes(preparation.totalBytes)}）`
    }
    if (phase === 'failed' && preparation?.message !== undefined) return `失败：${preparation.message}`
    return LABELS[phase] ?? phase
  }
}
