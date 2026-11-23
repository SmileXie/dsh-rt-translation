/** Authenticated RPC bridge between the in-window control panel and the controller. */
import type { ResolvedSettings } from './config.ts'
import type { Controller } from './controller.ts'
import type { ActionName, UiState } from './subtitle/protocol.ts'
import { PANEL_ACTIONS } from './subtitle/protocol.ts'
import { dispatchAction } from './ui.ts'

/** Absolute Connection channel the browser panel posts to. */
export const PANEL_CHANNEL = '/rt-translation'

export interface PanelDeps {
  controller: Controller
  settings: () => ResolvedSettings
  sttStatus: () => string
  persistence: () => boolean
  log: (message: string, error?: unknown) => void
}

/** Everything the panel needs to render one consistent snapshot. */
export interface PanelSnapshot {
  state: UiState
  subtitle: ResolvedSettings['subtitle']
  capture: ResolvedSettings['capture']
  translate: { provider: string; model: string }
  stt: string
  persistence: boolean
}

export type PanelResult =
  | { ok: true; value: PanelSnapshot }
  | { ok: false; error: { code: string; message: string; details: object } }

const failure = (code: string, message: string): PanelResult => ({
  ok: false,
  error: { code, message, details: {} },
})

/** Build one snapshot from the same settings the controller reads. */
export function panelSnapshot(deps: PanelDeps): PanelSnapshot {
  const settings = deps.settings()
  return {
    state: deps.controller.state(),
    subtitle: { ...settings.subtitle },
    capture: { ...settings.capture },
    translate: { provider: settings.translate.provider, model: settings.translate.model },
    stt: deps.sttStatus(),
    persistence: deps.persistence(),
  }
}

/**
 * Handle one panel RPC call: `state` reads, `action` drives the controller.
 * The handler is stateless; the panel polls `state` after acting.
 */
export function createPanelHandler(deps: PanelDeps) {
  return async (endpoint: string, payload: unknown): Promise<PanelResult> => {
    switch (endpoint) {
      case 'state':
        return { ok: true, value: panelSnapshot(deps) }
      case 'action': {
        const record = (payload ?? {}) as { action?: unknown; value?: unknown }
        if (typeof record.action !== 'string' || !PANEL_ACTIONS.has(record.action as ActionName)) {
          return failure('rt/bad-action', `不支持的操作: ${String(record.action)}`)
        }
        try {
          await dispatchAction(
            { op: 'action', name: record.action as ActionName, value: record.value as never },
            deps.controller,
            deps.log,
          )
        } catch (error) {
          return failure('rt/action-failed', error instanceof Error ? error.message : String(error))
        }
        return { ok: true, value: panelSnapshot(deps) }
      }
      default:
        return failure('rt/bad-endpoint', `未知接口: ${endpoint}`)
    }
  }
}
