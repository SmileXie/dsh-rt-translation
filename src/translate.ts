/** Streaming translation through the host's configured LLM routes. */
import type { Language, SourceLanguage } from './config.ts'

export interface TranslationContext { source: string; target: string }

export interface TranslateRequest {
  text: string
  source: SourceLanguage
  target: Language
  context: TranslationContext[]
  glossary: string[]
  signal: AbortSignal
}

type TextDelta = { type: 'text-delta'; text: string }
type Finish = { type: 'finish'; reason: { kind: string; failure?: { message?: string } } }
type Chunk = TextDelta | Finish | { type: string }

export interface LlmLike {
  stream(options: unknown): AsyncIterable<Chunk>
  listProviders?(): Array<{ id: string }>
  listModels?(provider: string): Promise<Array<{ id: string }>>
}

export interface TranslatorOptions {
  provider: string
  model: string
  followAgentDefault: boolean
  agentDefaultModel?: () => { provider: string; model: string } | undefined
  /** Live settings read on every request so `/rt model` takes effect immediately. */
  current?: () => { provider: string; model: string; followAgentDefault: boolean }
}

const NAMES: Record<SourceLanguage, string> = {
  auto: 'the source language of the text',
  zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean', yue: 'Cantonese',
}

/** Compose the system and user messages for one subtitle line. */
export function buildPrompt(req: TranslateRequest): { system: string; user: string } {
  const system = [
    `You translate live subtitles from ${NAMES[req.source]} to ${NAMES[req.target]}.`,
    'Output ONLY the translation: no quotes, no explanations, no Markdown, no prefixes.',
    'Keep proper nouns consistent. Keep it concise and natural for subtitles; do not merge or omit information.',
  ].join('\n')
  const parts: string[] = []
  if (req.glossary.length > 0) parts.push(`[Glossary]\n${req.glossary.join('\n')}`)
  if (req.context.length > 0) {
    parts.push(`[Recent context]\n${req.context.map(pair => `原文: ${pair.source}\n译文: ${pair.target}`).join('\n')}`)
  }
  parts.push(`[Current]\n${req.text}`)
  return { system, user: parts.join('\n\n') }
}

/** Normalize model output that wrapped the translation in formatting. */
export function cleanTranslation(raw: string): string {
  let text = raw.trim()
  text = text.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```$/, '').trim()
  if (text.startsWith('**') && text.endsWith('**') && text.length > 4) text = text.slice(2, -2)
  text = text.replace(/^译文\s*[:：]\s*/, '')
  text = text.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '')
  return text.trim()
}

export class Translator {
  private readonly llm: LlmLike
  private readonly options: TranslatorOptions

  constructor(llm: LlmLike, options: TranslatorOptions) {
    this.llm = llm
    this.options = options
  }

  /** Resolve the provider/model used for subtitle translation. */
  async route(): Promise<{ provider: string; model: string }> {
    const live = this.options.current?.()
    const provider = live?.provider ?? this.options.provider
    const model = live?.model ?? this.options.model
    const followAgentDefault = live?.followAgentDefault ?? this.options.followAgentDefault
    const agentDefaultModel = this.options.agentDefaultModel
    if (provider !== '' && model !== '') return { provider, model }
    if (followAgentDefault) {
      const selection = agentDefaultModel?.()
      if (selection !== undefined) return selection
    }
    const providers = this.llm.listProviders?.() ?? []
    const first = providers[0]
    if (first === undefined) throw new Error('没有可用的翻译模型')
    const models = await this.llm.listModels?.(first.id)
    const chosen = models?.[0]
    if (chosen === undefined) throw new Error(`模型路由 ${first.id} 没有可用模型`)
    return { provider: provider === '' ? first.id : provider, model: model === '' ? chosen.id : model }
  }

  /** Stream translated text deltas for one utterance. */
  async *translate(req: TranslateRequest): AsyncIterable<string> {
    const route = await this.route()
    const { system, user } = buildPrompt(req)
    const stream = this.llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens: 512,
      temperature: 0.2,
      signal: req.signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') yield (chunk as TextDelta).text
      else if (chunk.type === 'finish') {
        const reason = (chunk as Finish).reason
        if (reason.kind === 'error') throw new Error(reason.failure?.message ?? 'translation failed')
        if (reason.kind === 'aborted') return
      }
    }
  }
}
