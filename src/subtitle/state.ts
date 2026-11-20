/** Cue bookkeeping for the subtitle overlay; pure state, no rendering. */
export interface CueLine { kind: 'source' | 'target'; text: string; live: boolean }
export interface Cue { id: string; lines: CueLine[]; holdMs: number }

interface StoredCue extends Cue { finishedAt?: number }

export interface SubtitleModelOptions { maxCues: number; bilingual: boolean; holdMs: number }

export class SubtitleModel {
  private readonly maxCues: number
  private readonly bilingual: boolean
  private readonly holdMs: number
  private readonly cues: StoredCue[] = []
  private clock = 0

  constructor(options: SubtitleModelOptions) {
    this.maxCues = options.maxCues
    this.bilingual = options.bilingual
    this.holdMs = options.holdMs
  }

  /** Create or update the source line of a cue. */
  upsertSource(id: string, text: string, live: boolean): void {
    const cue = this.find(id)
    if (cue === undefined) {
      this.cues.push({ id, lines: [{ kind: 'source', text, live }], holdMs: this.holdMs })
      while (this.cues.length > this.maxCues) this.cues.shift()
      return
    }
    const line = cue.lines.find(l => l.kind === 'source')
    if (line) { line.text = text; line.live = live }
    else cue.lines.unshift({ kind: 'source', text, live })
  }

  /** Switch a cue from source-only to translation. */
  beginTranslation(id: string): void {
    const cue = this.find(id)
    if (cue === undefined) return
    if (this.bilingual) {
      cue.lines.push({ kind: 'target', text: '', live: true })
      return
    }
    cue.lines = [{ kind: 'target', text: '', live: true }]
  }

  /** Append streamed translation text to the cue's target line. */
  appendTranslation(id: string, delta: string): void {
    const cue = this.find(id)
    if (cue === undefined) return
    let line = cue.lines.find(l => l.kind === 'target')
    if (line === undefined) { line = { kind: 'target', text: '', live: true }; cue.lines.push(line) }
    line.text += delta
  }

  /** Mark the cue complete so its hold timer starts. */
  finishCue(id: string, now?: number): void {
    const cue = this.find(id)
    if (cue === undefined) return
    cue.finishedAt = now ?? this.clock
    cue.lines = cue.lines.filter(line => line.kind === 'source' || line.text.trim() !== '')
  }

  clear(): void { this.cues.length = 0 }

  /** Advance the model clock and drop expired cues. */
  tick(now: number): void {
    this.clock = now
    for (let i = this.cues.length - 1; i >= 0; i--) {
      const cue = this.cues[i]
      if (cue.finishedAt !== undefined && now - cue.finishedAt > cue.holdMs) this.cues.splice(i, 1)
    }
  }

  /** Visible cues with empty target lines removed. */
  snapshot(): Cue[] {
    return this.cues.map(cue => ({
      id: cue.id,
      holdMs: cue.holdMs,
      lines: cue.lines
        .filter(line => cue.finishedAt === undefined || line.text.trim() !== '')
        .map(line => ({ ...line })),
    }))
  }

  private find(id: string): StoredCue | undefined {
    return this.cues.find(cue => cue.id === id)
  }
}

