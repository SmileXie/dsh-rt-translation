/** Rendering port implemented by the WPF overlay process. */
import type { Cue } from './state.ts'
import type { OverlayOp, StylePayload, UiConfigPayload } from './protocol.ts'

export interface SubtitleRenderer {
  start(): Promise<void>
  /** Close the overlay/tray but keep this renderer able to start again. */
  close(): Promise<void>
  cue(cue: Cue): void
  style(style: StylePayload): void
  ui(config: UiConfigPayload): void
  clear(): void
  onAction(cb: (op: OverlayOp) => void): void
  dispose(): Promise<void>
}
