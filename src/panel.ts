/** Authenticated HTTP routes between the in-window control panel and the controller. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ResolvedSettings } from './config.ts'
import type { Controller } from './controller.ts'
import type { ActionName, UiState } from './subtitle/protocol.ts'
import { PANEL_ACTIONS } from './subtitle/protocol.ts'
import { dispatchAction } from './ui.ts'

/** Exact paths the browser half polls; both live under the `/plugins` prefix. */
export const PANEL_STATE_PATH = '/plugins/dsh-rt-translation/state'
export const PANEL_ACTION_PATH = '/plugins/dsh-rt-translation/action'

const MAX_BODY_BYTES = 64 * 1024
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

export interface PanelDeps {
  controller: Controller
  settings: () => ResolvedSettings
  sttStatus: () => string
  log: (message: string, error?: unknown) => void
}

/** Everything the panel needs to render one consistent snapshot. */
export interface PanelSnapshot {
  state: UiState
  subtitle: ResolvedSettings['subtitle']
  segment: { silenceMs: number; maxSegmentMs: number }
  autoPauseAfterMs: number
  capture: ResolvedSettings['capture']
  translate: {
    provider: string
    model: string
    background: string
    backgroundBrief: string
    glossary: string[]
    glossaryError: string | null
  }
  stt: string
}

export type PanelResult =
  | { ok: true; value: PanelSnapshot }
  | { ok: false; error: { code: string; message: string; details: object } }

/** Minimal WebServer face used here, so the plugin type-checks without the harness packages. */
export interface PanelWebServer {
  register(route: {
    kind: 'exact'
    path: string
    /** Authenticated admission is the Web server's default; state it so the route can never become public. */
    auth?: 'required'
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Build one snapshot from the same settings the controller reads. */
export function panelSnapshot(deps: PanelDeps): PanelSnapshot {
  const settings = deps.settings()
  return {
    state: deps.controller.state(),
    subtitle: { ...settings.subtitle },
    segment: { silenceMs: settings.segment.silenceMs, maxSegmentMs: settings.segment.maxSegmentMs },
    autoPauseAfterMs: settings.autoPauseAfterMs,
    capture: { ...settings.capture },
    translate: {
      provider: settings.translate.provider,
      model: settings.translate.model,
      background: settings.translate.background,
      backgroundBrief: settings.translate.backgroundBrief,
      glossary: [...settings.translate.glossary],
      glossaryError: deps.controller.glossaryError(),
    },
    stt: deps.sttStatus(),
  }
}

/** Read a bounded JSON object body; resolves undefined for malformed or oversized input. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of req) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += part.length
      if (size > MAX_BODY_BYTES) return undefined
      chunks.push(part)
    }
  } catch {
    return undefined
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/**
 * Register the two exact routes the control panel uses. `webServer.register`
 * returns the disposer; call this inside `ctx.effect` so the routes vanish
 * with the plugin. Admission (Host/Origin fence + DSH session) is enforced by
 * the Web server's `webserver/authorize` waterfall before either handler runs;
 * do not add a second Connection check here (current DSH removed
 * `connection.requestRejection`, and calling it made every authenticated
 * request fail with 400).
 */
export function registerPanelRoutes(
  webServer: PanelWebServer,
  deps: PanelDeps,
): () => void {
  const stateRoute = webServer.register({
    kind: 'exact',
    path: PANEL_STATE_PATH,
    auth: 'required',
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
        res.end()
        return
      }
      const body = JSON.stringify({ ok: true, value: panelSnapshot(deps) })
      res.writeHead(200, JSON_HEADERS)
      res.end(req.method === 'HEAD' ? undefined : body)
    },
  })

  const actionRoute = webServer.register({
    kind: 'exact',
    path: PANEL_ACTION_PATH,
    auth: 'required',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
        res.end()
        return
      }
      const payload = await readJsonBody(req)
      if (payload === undefined) {
        writeJson(res, 400, { ok: false, error: { code: 'rt/bad-body', message: '请求体必须是 JSON 对象', details: {} } })
        return
      }
      const action = payload.action
      if (typeof action !== 'string' || !PANEL_ACTIONS.has(action as ActionName)) {
        writeJson(res, 400, {
          ok: false,
          error: { code: 'rt/bad-action', message: `不支持的操作: ${String(action)}`, details: {} },
        })
        return
      }
      try {
        await dispatchAction(
          { op: 'action', name: action as ActionName, value: payload.value as never },
          deps.controller,
          deps.log,
        )
      } catch (error) {
        writeJson(res, 500, {
          ok: false,
          error: { code: 'rt/action-failed', message: error instanceof Error ? error.message : String(error), details: {} },
        })
        return
      }
      writeJson(res, 200, { ok: true, value: panelSnapshot(deps) })
    },
  })

  return () => {
    stateRoute()
    actionRoute()
  }
}
