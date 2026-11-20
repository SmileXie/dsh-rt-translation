/** Rendering port implemented by the WPF overlay process. */
import type { Cue } from './state.ts'
import type { OverlayOp, StylePayload, UiConfigPayload, UiState } from './protocol.ts'

export interface SubtitleRenderer {
  start(): Promise<void>
  cue(cue: Cue): void
  state(state: UiState): void
  style(style: StylePayload): void
  ui(config: UiConfigPayload): void
  clear(): void
  showPanel(): void
  hidePanel(): void
  onAction(cb: (op: OverlayOp) => void): void
  dispose(): Promise<void>
}

