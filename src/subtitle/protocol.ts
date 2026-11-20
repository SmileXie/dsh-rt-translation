/** NDJSON wire types shared by the host plugin and the WPF overlay process. */
import type { ResolvedSettings } from '../config.ts'
import type { Cue } from './state.ts'

export type ActionName =
  | 'toggle' | 'start' | 'stop' | 'clear' | 'restart'
  | 'setSource' | 'setTarget' | 'setMode' | 'setFontSize' | 'setSubtitle'
  | 'setApp' | 'showPanel' | 'quit'

export interface UiState {
  running: boolean
  phase: 'idle' | 'preparing' | 'listening' | 'paused' | 'error'
  source: string
  target: string
  preset: string
  error: string | null
}

export interface StylePayload {
  fontSize: number
  maxLines: number
  position: 'bottom' | 'top'
  marginPercent: number
  widthPercent: number
  opacity: number
  background: boolean
  bilingual: boolean
  display: 'primary' | 'all'
  fontFamily: string
}

/** Overlay chrome options from `ui.*` and `hotkeys.*`. */
export interface UiConfigPayload {
  tray: boolean
  controlBar: boolean
  controlBarHotkey: string
  showStatusDot: boolean
  hotkeysEnabled: boolean
}

export type HostOp =
  | { op: 'style'; style: StylePayload }
  | { op: 'ui'; ui: UiConfigPayload }
  | { op: 'cue'; cue: Cue }
  | { op: 'state'; state: UiState }
  | { op: 'panel'; visible: boolean | 'toggle' }
  | { op: 'clear' }
  | { op: 'shutdown' }

export type OverlayOp =
  | { op: 'ready' }
  | { op: 'action'; name: ActionName; value?: string | number | boolean | null }
  | { op: 'error'; text: string }
  | { op: 'log'; text: string }

const ACTIONS = new Set<string>([
  'toggle', 'start', 'stop', 'clear', 'restart',
  'setSource', 'setTarget', 'setMode', 'setFontSize', 'setSubtitle',
  'setApp', 'showPanel', 'quit',
])

/** Serialize one host instruction as a single NDJSON line. */
export function encodeOp(op: HostOp): string {
  return `${JSON.stringify(op)}\n`
}

/** Parse one overlay line, returning undefined for blank, malformed, or unknown messages. */
export function decodeOverlayLine(line: string): OverlayOp | undefined {
  const text = line.trim()
  if (text === '') return undefined
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  switch (record.op) {
    case 'ready': return { op: 'ready' }
    case 'error': return typeof record.text === 'string' ? { op: 'error', text: record.text } : undefined
    case 'log': return typeof record.text === 'string' ? { op: 'log', text: record.text } : undefined
    case 'action': {
      const name = record.name
      if (typeof name !== 'string' || !ACTIONS.has(name)) return undefined
      if (!('value' in record)) return { op: 'action', name: name as ActionName }
      const payload = record.value
      if (payload !== null && typeof payload !== 'string' && typeof payload !== 'number' && typeof payload !== 'boolean') return undefined
      return { op: 'action', name: name as ActionName, value: payload }
    }
    default: return undefined
  }
}

/** Project resolved subtitle settings onto the overlay's style payload. */
export function toStylePayload(subtitle: ResolvedSettings['subtitle']): StylePayload {
  return {
    fontSize: subtitle.fontSize,
    maxLines: subtitle.maxLines,
    position: subtitle.position,
    marginPercent: subtitle.marginPercent,
    widthPercent: subtitle.widthPercent,
    opacity: subtitle.opacity,
    background: subtitle.background,
    bilingual: subtitle.bilingual,
    display: subtitle.display,
    fontFamily: subtitle.fontFamily,
  }
}

/** Project host settings onto the overlay chrome payload. */
export function toUiConfig(settings: ResolvedSettings): UiConfigPayload {
  return {
    tray: settings.ui.tray,
    controlBar: settings.ui.controlBar,
    controlBarHotkey: settings.ui.controlBarHotkey,
    showStatusDot: settings.ui.showStatusDot,
    hotkeysEnabled: settings.hotkeys.enabled,
  }
}
