/** `/rt` slash commands: direct user control without model messages. */
import type { Controller } from './controller.ts'
import type { Language, SourceLanguage } from './config.ts'

export interface CommandResult { kind: 'success' | 'error'; text: string }

export interface CommandDefinition {
  name: string
  description: string
  input?: { hint: string }
  handler: (ctx: { rawInput: string }) => Promise<CommandResult>
}

export interface CommandRegistry { register(definition: CommandDefinition): () => void }

/** Minimal controller surface the commands need. */
export interface CommandTarget {
  start(): Promise<void>
  prepareModel(): void
  stop(): Promise<void>
  restart(): Promise<void>
  setLanguages(source: SourceLanguage, target: Language): Promise<void>
  setCapture(mode: 'system' | 'system-exclude-self' | 'app', appName: string): Promise<void>
  setModel(provider: string, model: string): Promise<void>
  test(text: string): Promise<void>
  status(): string
}

const USAGE = '用法: /rt start|prepare|stop|status|lang <src> <tgt>|app <name>|model <provider> <model>|restart|test <text>'
const SOURCES = new Set(['auto', 'zh', 'en', 'ja', 'ko', 'yue'])
const TARGETS = new Set(['zh', 'en', 'ja', 'ko', 'yue'])

const ok = (text: string): CommandResult => ({ kind: 'success', text })
const bad = (text: string): CommandResult => ({ kind: 'error', text })

/** Register the `rt` command family against the controller. */
export function registerCommands(registry: CommandRegistry, controller: CommandTarget): void {
  const run = async (rawInput: string): Promise<CommandResult> => {
    const parts = rawInput.trim().split(/\s+/).filter(Boolean)
    const sub = parts[0] ?? ''
    try {
      switch (sub) {
        case 'start': await controller.start(); return ok('字幕已开始')
        case 'prepare': controller.prepareModel(); return ok('已开始准备 SenseVoice 模型，用 /rt status 查看下载进度')
        case 'stop': await controller.stop(); return ok('字幕已停止')
        case 'restart': await controller.restart(); return ok('已重新连接音频')
        case 'status': return ok(controller.status())
        case 'lang': {
          const source = parts[1]
          const target = parts[2]
          if (source === undefined || target === undefined || !SOURCES.has(source) || !TARGETS.has(target)) {
            return bad(`语言无效，可选: ${[...SOURCES].join('/')} → ${[...TARGETS].join('/')}`)
          }
          await controller.setLanguages(source as SourceLanguage, target as Language)
          return ok(`语言: ${source} → ${target}`)
        }
        case 'app': {
          const name = parts[1]
          if (name === undefined) return bad('用法: /rt app <name> 或 /rt app off')
          if (name === 'off') { await controller.setCapture('system-exclude-self', ''); return ok('已恢复系统声音') }
          await controller.setCapture('app', name)
          return ok(`只采集: ${name}`)
        }
        case 'model': {
          const provider = parts[1]
          const model = parts[2]
          if (provider === undefined || model === undefined) return bad('用法: /rt model <provider> <model>')
          await controller.setModel(provider, model)
          return ok(`翻译模型: ${provider}/${model}`)
        }
        case 'test': {
          const text = rawInput.trim().slice('test'.length).trim()
          if (text === '') return bad('用法: /rt test <text>')
          await controller.test(text)
          return ok('已上屏测试字幕')
        }
        default: return bad(USAGE)
      }
    } catch (error) {
      return bad(error instanceof Error ? error.message : String(error))
    }
  }

  registry.register({ name: 'rt', description: '实时语音翻译字幕控制', input: { hint: '<start|prepare|stop|status|lang|app|model|restart|test>' }, handler: ({ rawInput }) => run(rawInput) })
  registry.register({ name: 'rt-start', description: '开始实时语音翻译字幕', handler: async () => { await controller.start(); return ok('字幕已开始') } })
  registry.register({ name: 'rt-stop', description: '停止实时语音翻译字幕', handler: async () => { await controller.stop(); return ok('字幕已停止') } })
}
