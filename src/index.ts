/** DSH plugin entry: wires capture, SenseVoice, LLM translation, and the WPF overlay. */
import { fileURLToPath } from 'node:url'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-settings'
import type { Config as RtConfig, ResolvedSettings } from './config.ts'
import { resolveConfig } from './config.ts'
import { createSettingsStore, profileSettingsPath } from './settings-store.ts'
import { SenseVoiceClient } from './stt.ts'
import { Translator } from './translate.ts'
import { SubtitleModel } from './subtitle/state.ts'
import { toStylePayload, toUiConfig } from './subtitle/protocol.ts'
import { WindowsWpfRenderer, type SpawnFn } from './subtitle/windows-wpf.ts'
import { Controller } from './controller.ts'
import { loopbackCapture } from './capture.ts'
import { Pipeline } from './pipeline.ts'
import { registerCommands } from './commands.ts'
import { registerTool } from './tool.ts'
import { dispatchAction } from './ui.ts'
import { registerPanelRoutes, type PanelWebServer } from './panel.ts'
export { Config } from './config.ts'
export const name = 'rt-translation'
export const inject = ['speechToText', 'llm', 'commands', 'tools', 'subprocess']

interface SettingsService { update(namespace: string, patch: object): Promise<void> }
interface AgentDefaultModel { currentSelection(): { provider: string; model: string } }
interface ProfileContextService { dir?: string }

/** Temporary bridge diagnostics: the Desktop Host does not expose ctx.logger output. */
function debugBridge(message: string): void {
  try { appendFileSync(join(tmpdir(), 'dsh-rt-translation.log'), `${new Date().toISOString()} ${message}\n`) } catch { /* diagnostics only */ }
}

export function apply(ctx: Context, config: Volatile<RtConfig>): void {
  if (process.platform !== 'win32') throw new Error('dsh-rt-translation v1 supports Windows only')

  const log = (message: string, error?: unknown): void => {
    const suffix = error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`
    if (error === undefined) ctx.logger.info(`[rt-translation] ${message}`)
    else ctx.logger.warn(`[rt-translation] ${message}${suffix}`)
  }

  const baseConfig = config.get() as RtConfig
  const profile = ctx.get('profileContext') as ProfileContextService | undefined
  // `dsh web --patch` runs cannot write the profile entry: the command-line
  // overlay outranks the profile patch. Keep a profile-local fallback so panel
  // choices still survive a restart, and let a successful profile write clear it.
  const store = typeof profile?.dir === 'string' && profile.dir !== ''
    ? createSettingsStore(profileSettingsPath(profile.dir))
    : undefined
  const restored = store?.load(baseConfig)
  let restoredFromStore = restored !== undefined
  let fallbackDirty = false
  let profileWriteNoted = false
  let settings: ResolvedSettings = restored === undefined ? resolveConfig(baseConfig) : resolveConfig(restored)
  const entryId = ctx.fiber.entry?.options.id
  const settingsService = (): SettingsService | undefined => ctx.get('settings') as SettingsService | undefined
  debugBridge(`profile=${profile?.dir ?? 'none'} store=${store === undefined ? 'none' : 'ok'} restored=${restored !== undefined} settings=${settingsService() === undefined ? 'late' : 'ok'}`)

  const patchSettings = async (patch: Partial<ResolvedSettings>): Promise<void> => {
    settings = { ...settings, ...patch }
    // The Settings service can bind after this plugin; resolve it on every write.
    const service = settingsService()
    if (entryId !== undefined && service !== undefined) {
      try {
        // Migrate fallback values with the first profile write; afterwards the
        // normal patch keeps profile writes as small as before.
        await service.update(entryId, (restoredFromStore || fallbackDirty ? settings : patch) as unknown as object)
        restoredFromStore = false
        fallbackDirty = false
        profileWriteNoted = false
        store?.clear()
        return
      } catch (error) {
        if (!profileWriteNoted) {
          profileWriteNoted = true
          debugBridge(`settings update failed: ${error instanceof Error ? error.message : String(error)}`)
          log('settings update failed', error)
        }
      }
    }
    if (store === undefined) {
      log('settings are not persisted: no profile store')
      return
    }
    try {
      store.save(baseConfig, settings)
      fallbackDirty = true
    } catch (error) {
      debugBridge(`settings fallback write failed: ${error instanceof Error ? error.message : String(error)}`)
      log('settings fallback write failed', error)
    }
  }

  const stt = new SenseVoiceClient(ctx.speechToText as never, settings.stt.providerId)
  const translator = new Translator(ctx.llm as never, {
    provider: settings.translate.provider,
    model: settings.translate.model,
    followAgentDefault: settings.translate.followAgentDefault,
    agentDefaultModel: () => (ctx.get('agentDefaultModel') as AgentDefaultModel | undefined)?.currentSelection(),
    current: () => ({
      provider: settings.translate.provider,
      model: settings.translate.model,
      followAgentDefault: settings.translate.followAgentDefault,
    }),
  })
  const subtitles = new SubtitleModel({
    maxCues: Math.max(3, settings.subtitle.maxLines + 1),
    bilingual: settings.subtitle.bilingual,
    holdMs: settings.subtitle.holdMs,
  })
  const spawn: SpawnFn = argv => {
    const child = ctx.subprocess.spawn({
      argv,
      cwd: process.cwd(),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 3000,
    })
    child.stderr?.on('data', chunk => {
      const text = String(chunk).trim()
      if (text !== '') log(`overlay stderr: ${text}`)
    })
    return {
      stdin: { write: chunk => { child.stdin?.write(chunk); return true } },
      stdout: { on: (event, cb) => { child.stdout?.on(event, cb as never) } },
      onExit: cb => {
        void child.done.then((outcome: { exitCode: number | null }) => cb(outcome.exitCode)).catch(() => cb(null))
      },
      kill: () => { child.terminate() },
    }
  }
  let handleOverlayFatal = (error: unknown): void => { log('overlay fatal', error) }
  const renderer = new WindowsWpfRenderer({
    scriptPath: fileURLToPath(new URL('../assets/overlay/overlay.ps1', import.meta.url)),
    style: toStylePayload(settings.subtitle),
    spawn,
    onFatal: error => handleOverlayFatal(error),
  })
  const controller = new Controller({
    settings: () => settings,
    patchSettings,
    stt,
    translator,
    renderer,
    subtitles,
    capture: loopbackCapture,
    makePipeline: deps => new Pipeline(deps),
    log,
  })

  handleOverlayFatal = error => {
    log('overlay fatal', error)
    controller.rendererFailed(error)
  }

  renderer.onAction(op => {
    if (op.op === 'error') log(`overlay error: ${op.text}`)
    else if (op.op === 'log') log(`overlay: ${op.text}`)
    void dispatchAction(op, controller, log)
  })
  registerCommands(ctx.commands as never, controller as never)
  registerTool(ctx.tools as never, controller as never)

  // The control bar lives in the DSH window. Register its two authenticated
  // routes on the Web server exactly as other installed plugins do; the
  // service may bind after this plugin, so retry on each service binding.
  const panelDeps = {
    controller,
    settings: () => settings,
    sttStatus: () => stt.status(),
    log,
  }
  const services = ctx as unknown as {
    get(name: string): unknown
    effect(callback: () => () => void, label?: string): unknown
    on(event: string, listener: (name: string) => void): unknown
  }
  debugBridge(`apply pid=${process.pid}`)
  let panelRegistered = false
  const registerPanel = (): void => {
    if (panelRegistered) return
    const webServer = services.get('webServer') as PanelWebServer | undefined
    debugBridge(`webServer=${webServer === undefined ? 'undefined' : 'ok'}`)
    if (webServer === undefined) return
    panelRegistered = true
    try {
      services.effect(
        () => registerPanelRoutes(webServer, panelDeps),
        'rt-translation: control panel routes',
      )
      debugBridge('routes registered: state + action')
      log('control panel routes registered')
    } catch (error) {
      panelRegistered = false
      debugBridge(`route registration failed: ${error instanceof Error ? error.stack : String(error)}`)
      log('control panel routes failed', error)
    }
  }
  registerPanel()
  try {
    services.on('internal/service', name => {
      debugBridge(`internal/service ${name}`)
      if (name === 'webServer') registerPanel()
    })
  } catch (error) {
    debugBridge(`service watch failed: ${String(error)}`)
    log('control panel service watch failed', error)
  }

  ctx.effect(() => {
    void renderer.start().then(() => {
      renderer.style(toStylePayload(settings.subtitle))
      renderer.ui(toUiConfig(settings))
      log('overlay ready')
    }).catch(error => log('overlay start failed', error))
    return async () => { await controller.dispose() }
  })
}
