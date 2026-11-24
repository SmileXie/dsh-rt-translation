/** DSH plugin entry: wires capture, SenseVoice, LLM translation, and the WPF overlay. */
import { fileURLToPath } from 'node:url'
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
import { createPanelHandler, PANEL_CHANNEL } from './panel.ts'

export { Config } from './config.ts'
export const name = 'rt-translation'
export const inject = ['speechToText', 'llm', 'commands', 'tools', 'subprocess']

interface SettingsService { update(namespace: string, patch: object): Promise<void> }
interface AgentDefaultModel { currentSelection(): { provider: string; model: string } }

export function apply(ctx: Context, config: Volatile<RtConfig>): void {
  if (process.platform !== 'win32') throw new Error('dsh-rt-translation v1 supports Windows only')

  const log = (message: string, error?: unknown): void => {
    const suffix = error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`
    if (error === undefined) ctx.logger.info(`[rt-translation] ${message}`)
    else ctx.logger.warn(`[rt-translation] ${message}${suffix}`)
  }

  let settings: ResolvedSettings = resolveConfig(config.get() as RtConfig)
  const entryId = ctx.fiber.entry?.options.id
  const settingsService = ctx.get('settings') as SettingsService | undefined
  let persisted = entryId !== undefined && settingsService !== undefined

  const patchSettings = async (patch: Partial<ResolvedSettings>): Promise<void> => {
    settings = { ...settings, ...patch }
    if (entryId === undefined || settingsService === undefined) { persisted = false; return }
    try {
      await settingsService.update(entryId, patch as object)
      persisted = true
    } catch (error) {
      persisted = false
      log('settings update failed', error)
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
    persistence: () => persisted,
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

  // The control bar lives in the DSH window; the browser half reaches it through
  // an authenticated Connection RPC channel registered here.
  const panel = createPanelHandler({
    controller,
    settings: () => settings,
    sttStatus: () => stt.status(),
    persistence: () => persisted,
    log,
  })
  type PanelRpc = { handle(channel: string, handler: typeof panel): () => Promise<void> }
  type PanelContext = { connection?: { rpc: PanelRpc } }
  const injectable = ctx as unknown as {
    inject(deps: string[], callback: (child: PanelContext) => void): void
  }
  try {
    injectable.inject(['connection', 'webServer'], child => {
      const connection = child.connection
      if (connection === undefined) {
        log('control panel bridge unavailable: connection service is missing')
        return
      }
      try {
        connection.rpc.handle(PANEL_CHANNEL, panel)
        log(`control panel bridge ready at ${PANEL_CHANNEL}`)
      } catch (error) {
        log('control panel bridge failed', error)
      }
    })
  } catch (error) {
    log('control panel bridge unavailable', error)
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
