/** `/rt` slash commands: direct user control without model messages. */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Controller } from './controller.ts'
import type { Language, Preset, SourceLanguage } from './config.ts'

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
  setMode(preset: Preset): Promise<void>
  setCapture(mode: 'system' | 'system-exclude-self' | 'app', appName: string): Promise<void>
  setModel(provider: string, model: string): Promise<void>
  setGlossary(entries: string[]): Promise<void>
  showControlBar(): void
  test(text: string): Promise<void>
  status(): string
}

const USAGE = '用法: /rt start|prepare|stop|status|lang <src> <tgt>|mode meeting|media|app <name>|model <provider> <model>|restart|ui|test <text>|title <name>|title off'
const SOURCES = new Set(['auto', 'zh', 'en', 'ja', 'ko', 'yue'])
const TARGETS = new Set(['zh', 'en', 'ja', 'ko', 'yue'])

const ok = (text: string): CommandResult => ({ kind: 'success', text })
const bad = (text: string): CommandResult => ({ kind: 'error', text })

/** Load a per-title glossary file into `from=to` entries. */
export function resolveDshHome(env = process.env.DSH_HOME, userHome = homedir()): string {
  const trimmed = env?.trim()
  return trimmed !== undefined && trimmed !== '' ? trimmed : join(userHome, '.dsh')
}

export async function loadGlossary(name: string, home = resolveDshHome()): Promise<string[]> {
  const path = join(home, 'rt-translation', 'glossaries', `${name}.json`)
  const raw = await readFile(path, 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('术语表必须是数组')
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`术语表第 ${index + 1} 项无效`)
    const record = entry as Record<string, unknown>
    if (typeof record.from !== 'string' || typeof record.to !== 'string') throw new Error(`术语表第 ${index + 1} 项缺少 from/to`)
    return `${record.from}=${record.to}`
  })
}

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
        case 'ui': controller.showControlBar(); return ok('控制条已切换')
        case 'lang': {
          const source = parts[1]
          const target = parts[2]
          if (source === undefined || target === undefined || !SOURCES.has(source) || !TARGETS.has(target)) {
            return bad(`语言无效，可选: ${[...SOURCES].join('/')} → ${[...TARGETS].join('/')}`)
          }
          await controller.setLanguages(source as SourceLanguage, target as Language)
          return ok(`语言: ${source} → ${target}`)
        }
        case 'mode': {
          const mode = parts[1]
          if (mode !== 'meeting' && mode !== 'media') return bad('模式必须是 meeting 或 media')
          await controller.setMode(mode)
          return ok(`模式: ${mode}`)
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
        case 'title': {
          const name = parts[1]
          if (name === undefined) return bad('用法: /rt title <name> 或 /rt title off')
          if (name === 'off') { await controller.setGlossary([]); return ok('已清除术语表') }
          const entries = await loadGlossary(name)
          await controller.setGlossary(entries)
          return ok(`术语表已加载: ${entries.length} 条`)
        }
        default: return bad(USAGE)
      }
    } catch (error) {
      return bad(error instanceof Error ? error.message : String(error))
    }
  }

  registry.register({ name: 'rt', description: '实时语音翻译字幕控制', input: { hint: '<start|prepare|stop|status|lang|mode|app|model|restart|ui|test|title>' }, handler: ({ rawInput }) => run(rawInput) })
  registry.register({ name: 'rt-start', description: '开始实时语音翻译字幕', handler: async () => { await controller.start(); return ok('字幕已开始') } })
  registry.register({ name: 'rt-stop', description: '停止实时语音翻译字幕', handler: async () => { await controller.stop(); return ok('字幕已停止') } })
}
