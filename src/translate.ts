/** Streaming translation through the host's configured LLM routes. */
import type { Language, SourceLanguage } from './config.ts'

export interface TranslationContext { source: string; target: string }

export interface TranslateRequest {
  text: string
  source: SourceLanguage
  target: Language
  context: TranslationContext[]
  glossary: string[]
  /** Distilled background injected into every prompt; omitted when empty. */
  brief?: string
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

/** Keep only glossary entries whose source form occurs in the sentence. */
export function selectGlossary(text: string, glossary: string[], limit = 12): string[] {
  const haystack = text.toLowerCase()
  const picked: string[] = []
  const seen = new Set<string>()
  for (const entry of glossary) {
    if (entry.trim() === '' || seen.has(entry)) continue
    const from = (entry.split('=')[0] ?? '').trim().toLowerCase()
    if (from === '' || !haystack.includes(from)) continue
    seen.add(entry)
    picked.push(entry.slice(0, 120))
    if (picked.length >= limit) break
  }
  return picked
}

/** Compose the system and user messages for one subtitle line. */
export function buildPrompt(req: TranslateRequest): { system: string; user: string } {
  const system = [
    `You translate live subtitles from ${NAMES[req.source]} to ${NAMES[req.target]}.`,
    'Output ONLY the translation: no quotes, no explanations, no Markdown, no prefixes.',
    'Keep proper nouns consistent. Keep it concise and natural for subtitles; do not merge or omit information.',
  ].join('\n')
  const parts: string[] = []
  const brief = req.brief?.trim() ?? ''
  if (brief !== '') parts.push(`[Background]\n${brief}`)
  const matched = selectGlossary(req.text, req.glossary)
  if (matched.length > 0) parts.push(`[Glossary]\n${matched.join('\n')}`)
  if (req.context.length > 0) {
    parts.push(`[Recent context]\n${req.context.map(pair => `原文: ${pair.source}\n译文: ${pair.target}`).join('\n')}`)
  }
  parts.push(`[Current]\n${req.text}`)
  return { system, user: parts.join('\n\n') }
}

export interface PrepareRequest {
  background: string
  source: SourceLanguage
  target: Language
  signal: AbortSignal
}

/** Ask the model for a short background brief plus glossary entries. */
export function buildPreparePrompt(req: Omit<PrepareRequest, 'signal'>): { system: string; user: string } {
  const system = [
    `You prepare context for live subtitle translation from ${NAMES[req.source]} to ${NAMES[req.target]}.`,
    'The user describes what is being translated (a film, a talk, a topic). Output exactly these two sections and nothing else:',
    '',
    '[摘要]',
    `At most three sentences, at most 120 characters, in ${NAMES[req.target]}: what is being discussed, which people/works/concepts are involved, and the setting.`,
    '',
    '[术语]',
    'Only proper nouns and domain terms whose rendering matters, one per line as original=translation, at most 60 entries.',
    'No numbering, no bullets, no explanations, no Markdown. If the background only names a work, you may add key characters and settings you are confident about; never invent uncertain details.',
    'If nothing useful can be extracted, output an empty [摘要] section and no entries.',
  ].join('\n')
  return { system, user: `[Background]\n${req.background}` }
}

const SECTION = /^[\s[【（(]*(摘要|背景摘要|术语表?|词表|glossary)[\s\]】）):：]*$/i
const INLINE = /^[\s[【（(]*(摘要|背景摘要|术语表?|词表|glossary)[\s\]】）):：]*(.+)$/i

function stripLine(line: string): string {
  return line.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
}

function cleanEntries(lines: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of lines) {
    const line = stripLine(raw).replace(/^[-*•]\s*/, '').replace(/^\d+[.)、]\s*/, '').trim()
    if (line === '' || !line.includes('=')) continue
    const at = line.indexOf('=')
    const from = line.slice(0, at).trim()
    const to = line.slice(at + 1).trim()
    if (from === '' || to === '') continue
    const key = from.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(`${from}=${to}`.slice(0, 120))
    if (out.length >= 80) break
  }
  return out
}

/** Split the preparation output into one brief line and normalized `original=translation` entries. */
export function parseModelPrep(raw: string): { brief: string; glossary: string[] } {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').filter(line => !line.trim().startsWith('```'))
  const hasMarker = lines.some(line => SECTION.test(line) || INLINE.test(line))
  const briefLines: string[] = []
  const entryLines: string[] = []
  let section: 'brief' | 'glossary' = 'brief'
  for (const line of lines) {
    if (SECTION.test(line)) { section = /术语|词表|glossary/i.test(line) ? 'glossary' : 'brief'; continue }
    const inline = INLINE.exec(line)
    if (inline !== null) {
      section = /术语|词表|glossary/i.test(inline[1]) ? 'glossary' : 'brief'
      if (inline[2].trim() !== '') (section === 'glossary' ? entryLines : briefLines).push(inline[2])
      continue
    }
    if (line.trim() === '') continue
    // No section markers at all: treat term-like lines as entries, the rest as the brief.
    if (!hasMarker && line.includes('=')) { entryLines.push(line); continue }
    if (section === 'glossary') entryLines.push(line)
    else briefLines.push(line)
  }
  const brief = briefLines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300)
  return { brief, glossary: cleanEntries(entryLines) }
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
    if (provider !== '') {
      if (model !== '') return { provider, model }
      const models = await this.llm.listModels?.(provider)
      const chosen = models?.[0]
      if (chosen === undefined) throw new Error(`模型路由 ${provider} 没有可用模型`)
      return { provider, model: chosen.id }
    }
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
    return { provider: first.id, model: model === '' ? chosen.id : model }
  }

  /** Prepare a background brief and glossary through the same route as translation. */
  async prepareGlossary(req: PrepareRequest): Promise<{ brief: string; glossary: string[] }> {
    const route = await this.route()
    const { system, user } = buildPreparePrompt(req)
    const stream = this.llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens: 2000,
      temperature: 0.2,
      signal: req.signal,
    })
    let raw = ''
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') raw += (chunk as TextDelta).text
      else if (chunk.type === 'finish') {
        const reason = (chunk as Finish).reason
        if (reason.kind === 'error') throw new Error(reason.failure?.message ?? 'glossary preparation failed')
        if (reason.kind === 'aborted') throw new Error('准备词汇超时或已取消')
      }
    }
    return parseModelPrep(raw)
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
