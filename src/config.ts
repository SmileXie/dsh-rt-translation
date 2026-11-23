import z from '@deepseek-ai/schemastery'

export type Language = 'zh' | 'en' | 'ja' | 'ko' | 'yue'
export type SourceLanguage = Language | 'auto'
export type Preset = 'meeting' | 'media'

export interface Config {
  sourceLanguage?: SourceLanguage
  targetLanguage?: Language
  preset?: Preset
  capture?: { mode?: 'system' | 'system-exclude-self' | 'app'; appName?: string }
  stt?: { providerId?: string; partials?: boolean; partialIntervalMs?: number }
  translate?: { provider?: string; model?: string; contextTurns?: number; followAgentDefault?: boolean; glossary?: string[] }
  segment?: { silenceMs?: number; maxSegmentMs?: number; preRollMs?: number }
  subtitle?: {
    display?: 'primary' | 'all'
    position?: 'bottom' | 'top'
    fontSize?: number
    maxLines?: number
    widthPercent?: number
    marginPercent?: number
    opacity?: number
    background?: boolean
    bilingual?: boolean
    fontFamily?: string
    holdMs?: number
    minReadMs?: number
  }
  meeting?: { autoPauseAfterMs?: number }
  media?: { glossary?: string[] }
  debug?: { dumpAudioDir?: string }
  ui?: { tray?: boolean }
  hotkeys?: { enabled?: boolean }
}

export interface ResolvedSettings {
  sourceLanguage: SourceLanguage
  targetLanguage: Language
  preset: Preset
  capture: { mode: 'system' | 'system-exclude-self' | 'app'; appName: string }
  stt: { providerId: string; partials: boolean; partialIntervalMs: number }
  translate: { provider: string; model: string; contextTurns: number; followAgentDefault: boolean; glossary: string[] }
  segment: { silenceMs: number; maxSegmentMs: number; preRollMs: number }
  subtitle: {
    display: 'primary' | 'all'
    position: 'bottom' | 'top'
    fontSize: number
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
  meeting: { autoPauseAfterMs: number }
  media: { glossary: string[] }
  debug: { dumpAudioDir: string }
  ui: { tray: boolean }
  hotkeys: { enabled: boolean }
}

const language = z.union(['zh', 'en', 'ja', 'ko', 'yue'])
const sourceLanguage = z.union(['auto', 'zh', 'en', 'ja', 'ko', 'yue'])

export const Config = z.object({
  sourceLanguage,
  targetLanguage: language,
  preset: z.union(['meeting', 'media']),
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
  subtitle: z.object({
    display: z.union(['primary', 'all']),
    position: z.union(['bottom', 'top']),
    fontSize: z.natural().min(12).max(96),
    maxLines: z.natural().min(1).max(6),
    widthPercent: z.natural().min(30).max(100),
    marginPercent: z.natural().max(30),
    opacity: z.number().min(0.1).max(1),
    background: z.boolean(),
    bilingual: z.boolean(),
    fontFamily: z.string(),
    holdMs: z.natural().max(60000),
    minReadMs: z.natural().max(30000),
  }),
  meeting: z.object({ autoPauseAfterMs: z.natural().max(3600000) }),
  media: z.object({ glossary: z.array(z.string()) }),
  debug: z.object({ dumpAudioDir: z.string() }),
  ui: z.object({ tray: z.boolean() }),
  hotkeys: z.object({ enabled: z.boolean() }),
}).volatile()

const presets = {
  meeting: {
    silenceMs: 280,
    maxSegmentMs: 5000,
    maxLines: 2,
    holdMs: 6000,
    minReadMs: 1800,
    bilingual: true,
    fontSize: 30,
  },
  media: {
    silenceMs: 550,
    maxSegmentMs: 7000,
    maxLines: 3,
    holdMs: 6000,
    minReadMs: 1200,
    bilingual: true,
    fontSize: 34,
  },
} as const

/**
 * Merge configuration with the selected preset and the plugin's fixed defaults.
 * Preset values fill anything the user did not set; explicit fields always win.
 */
export function resolveConfig(input: Config): ResolvedSettings {
  const preset: Preset = input.preset ?? 'meeting'
  const base = presets[preset]
  return {
    sourceLanguage: input.sourceLanguage ?? 'auto',
    targetLanguage: input.targetLanguage ?? 'zh',
    preset,
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
      silenceMs: input.segment?.silenceMs ?? base.silenceMs,
      maxSegmentMs: input.segment?.maxSegmentMs ?? base.maxSegmentMs,
      preRollMs: input.segment?.preRollMs ?? 200,
    },
    subtitle: {
      display: input.subtitle?.display ?? 'primary',
      position: input.subtitle?.position ?? 'bottom',
      fontSize: input.subtitle?.fontSize ?? base.fontSize,
      maxLines: input.subtitle?.maxLines ?? base.maxLines,
      widthPercent: input.subtitle?.widthPercent ?? 78,
      marginPercent: input.subtitle?.marginPercent ?? 8,
      opacity: input.subtitle?.opacity ?? 0.72,
      background: input.subtitle?.background ?? true,
      bilingual: input.subtitle?.bilingual ?? base.bilingual,
      fontFamily: input.subtitle?.fontFamily ?? '',
      holdMs: input.subtitle?.holdMs ?? base.holdMs,
      minReadMs: input.subtitle?.minReadMs ?? base.minReadMs,
    },
    meeting: { autoPauseAfterMs: input.meeting?.autoPauseAfterMs ?? 120000 },
    media: { glossary: input.media?.glossary ?? [] },
    debug: { dumpAudioDir: input.debug?.dumpAudioDir ?? '' },
    ui: { tray: input.ui?.tray ?? true },
    hotkeys: { enabled: input.hotkeys?.enabled ?? true },
  }
}
