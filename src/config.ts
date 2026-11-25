import z from '@deepseek-ai/schemastery'

export type Language = 'zh' | 'en' | 'ja' | 'ko' | 'yue'
export type SourceLanguage = Language | 'auto'

export interface Config {
  sourceLanguage?: SourceLanguage
  targetLanguage?: Language
  capture?: { mode?: 'system' | 'system-exclude-self' | 'app'; appName?: string }
  stt?: { providerId?: string; partials?: boolean; partialIntervalMs?: number }
  translate?: { provider?: string; model?: string; contextTurns?: number; followAgentDefault?: boolean; glossary?: string[] }
  segment?: { silenceMs?: number; maxSegmentMs?: number; preRollMs?: number }
  /** Pause capture after this much silence; 0 disables automatic pause. */
  autoPauseAfterMs?: number
  subtitle?: {
    fontSize?: number
    /** Sentence rows on screen (2-5); the newest row is the sentence being spoken. */
    maxLines?: number
    widthPercent?: number
    marginPercent?: number
    /** Background opacity of the subtitle window (0.1-1). */
    opacity?: number
    background?: boolean
    bilingual?: boolean
    fontFamily?: string
    holdMs?: number
    minReadMs?: number
  }
  debug?: { dumpAudioDir?: string }
  ui?: { tray?: boolean }
  hotkeys?: { enabled?: boolean }
}

export interface ResolvedSettings {
  sourceLanguage: SourceLanguage
  targetLanguage: Language
  capture: { mode: 'system' | 'system-exclude-self' | 'app'; appName: string }
  stt: { providerId: string; partials: boolean; partialIntervalMs: number }
  translate: { provider: string; model: string; contextTurns: number; followAgentDefault: boolean; glossary: string[] }
  segment: { silenceMs: number; maxSegmentMs: number; preRollMs: number }
  autoPauseAfterMs: number
  subtitle: {
    fontSize: number
    /** Sentence rows on screen (2-5); the last one is the sentence being spoken. */
    maxLines: number
    widthPercent: number
    marginPercent: number
    opacity: number
    background: boolean
    bilingual: boolean
    fontFamily: string
    holdMs: number
    minReadMs: number
  }
  debug: { dumpAudioDir: string }
  ui: { tray: boolean }
  hotkeys: { enabled: boolean }
}

const language = z.union(['zh', 'en', 'ja', 'ko', 'yue'])
const sourceLanguage = z.union(['auto', 'zh', 'en', 'ja', 'ko', 'yue'])

export const Config = z.object({
  sourceLanguage,
  targetLanguage: language,
  capture: z.object({
    mode: z.union(['system', 'system-exclude-self', 'app']),
    appName: z.string(),
  }),
  stt: z.object({
    providerId: z.string().min(1),
    partials: z.boolean(),
    partialIntervalMs: z.natural().min(200).max(5000),
  }),
  translate: z.object({
    provider: z.string(),
    model: z.string(),
    contextTurns: z.natural().min(0).max(10),
    followAgentDefault: z.boolean(),
    glossary: z.array(z.string()),
  }),
  segment: z.object({
    silenceMs: z.natural().min(100).max(3000),
    maxSegmentMs: z.natural().min(1000).max(30000),
    preRollMs: z.natural().max(1000),
  }),
  autoPauseAfterMs: z.natural().max(3600000),
  subtitle: z.object({
    fontSize: z.natural().min(12).max(96),
    maxLines: z.natural().min(2).max(5),
    widthPercent: z.natural().min(30).max(100),
    marginPercent: z.natural().max(30),
    opacity: z.number().min(0.1).max(1),
    background: z.boolean(),
    bilingual: z.boolean(),
    fontFamily: z.string(),
    holdMs: z.natural().max(60000),
    minReadMs: z.natural().max(30000),
  }),
  debug: z.object({ dumpAudioDir: z.string() }),
  ui: z.object({ tray: z.boolean() }),
  hotkeys: z.object({ enabled: z.boolean() }),
}).volatile()

/**
 * Merge configuration with the plugin's fixed defaults. Explicit fields always win.
 */
export function resolveConfig(input: Config): ResolvedSettings {
  return {
    sourceLanguage: input.sourceLanguage ?? 'auto',
    targetLanguage: input.targetLanguage ?? 'zh',
    capture: { mode: input.capture?.mode ?? 'system-exclude-self', appName: input.capture?.appName ?? '' },
    stt: {
      providerId: input.stt?.providerId ?? 'sensevoice-local',
      partials: input.stt?.partials ?? true,
      partialIntervalMs: input.stt?.partialIntervalMs ?? 900,
    },
    translate: {
      provider: input.translate?.provider ?? '',
      model: input.translate?.model ?? '',
      contextTurns: input.translate?.contextTurns ?? 2,
      followAgentDefault: input.translate?.followAgentDefault ?? true,
      glossary: input.translate?.glossary ?? [],
    },
    segment: {
      // 550 ms clears natural clause pauses; a shorter gate (e.g. 150 ms) cuts every
      // breath and shows each sentence as two halves.
      silenceMs: input.segment?.silenceMs ?? 550,
      maxSegmentMs: input.segment?.maxSegmentMs ?? 8000,
      preRollMs: input.segment?.preRollMs ?? 400,
    },
    autoPauseAfterMs: input.autoPauseAfterMs ?? 120000,
    subtitle: {
      fontSize: input.subtitle?.fontSize ?? 20,
      maxLines: input.subtitle?.maxLines ?? 3,
      widthPercent: input.subtitle?.widthPercent ?? 78,
      marginPercent: input.subtitle?.marginPercent ?? 8,
      opacity: input.subtitle?.opacity ?? 0.72,
      background: input.subtitle?.background ?? true,
      bilingual: input.subtitle?.bilingual ?? true,
      fontFamily: input.subtitle?.fontFamily ?? '',
      holdMs: input.subtitle?.holdMs ?? 6000,
      minReadMs: input.subtitle?.minReadMs ?? 1800,
    },
    debug: { dumpAudioDir: input.debug?.dumpAudioDir ?? '' },
    ui: { tray: input.ui?.tray ?? true },
    hotkeys: { enabled: input.hotkeys?.enabled ?? true },
  }
}
