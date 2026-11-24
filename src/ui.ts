/** Map overlay button, tray, and hotkey actions onto the shared controller. */
import type { Controller } from './controller.ts'
import type { Language, ResolvedSettings, SourceLanguage } from './config.ts'
import type { OverlayOp } from './subtitle/protocol.ts'

const SOURCES = new Set(['auto', 'zh', 'en', 'ja', 'ko', 'yue'])
const TARGETS = new Set(['zh', 'en', 'ja', 'ko', 'yue'])

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Validate a JSON-string or object sent by the settings panel. */
export function parseSubtitlePatch(value: unknown): Partial<ResolvedSettings['subtitle']> | undefined {
  let raw: unknown = value
  if (typeof value === 'string') {
    try { raw = JSON.parse(value) } catch { return undefined }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const patch: Partial<ResolvedSettings['subtitle']> = {}
  if (typeof record.fontSize === 'number' && Number.isFinite(record.fontSize)) patch.fontSize = Math.round(clamp(record.fontSize, 12, 96))
  if (typeof record.maxLines === 'number' && Number.isFinite(record.maxLines)) patch.maxLines = Math.round(clamp(record.maxLines, 2, 5))
  if (typeof record.widthPercent === 'number' && Number.isFinite(record.widthPercent)) patch.widthPercent = Math.round(clamp(record.widthPercent, 30, 100))
  if (typeof record.marginPercent === 'number' && Number.isFinite(record.marginPercent)) patch.marginPercent = Math.round(clamp(record.marginPercent, 0, 30))
  if (typeof record.opacity === 'number' && Number.isFinite(record.opacity)) patch.opacity = clamp(record.opacity, 0.1, 1)
  if (typeof record.background === 'boolean') patch.background = record.background
  if (typeof record.bilingual === 'boolean') patch.bilingual = record.bilingual
  if (record.position === 'top' || record.position === 'bottom') patch.position = record.position
  if (typeof record.fontFamily === 'string' && record.fontFamily.trim() !== '') patch.fontFamily = record.fontFamily.trim()
  if (typeof record.holdMs === 'number' && Number.isFinite(record.holdMs)) patch.holdMs = Math.round(clamp(record.holdMs, 500, 60_000))
  if (typeof record.minReadMs === 'number' && Number.isFinite(record.minReadMs)) patch.minReadMs = Math.round(clamp(record.minReadMs, 0, 30_000))
  return Object.keys(patch).length > 0 ? patch : undefined
}

/** Execute one overlay action; unknown names and values are ignored. */
export async function dispatchAction(
  op: OverlayOp,
  controller: Controller,
  log: (message: string, error?: unknown) => void = () => {},
): Promise<void> {
  if (op.op !== 'action') return
  try {
    switch (op.name) {
      case 'toggle': {
        const phase = controller.state().phase
        if (phase === 'listening' || phase === 'preparing') await controller.stop()
        else await controller.start()
        return
      }
      case 'start': await controller.start(); return
      case 'prepare': controller.prepareModel(); return
      case 'stop': await controller.stop(); return
      case 'restart': await controller.restart(); return
      case 'clear': controller.clear(); return
      case 'setSource': {
        if (typeof op.value !== 'string' || !SOURCES.has(op.value)) return
        const state = controller.state()
        await controller.setLanguages(op.value as SourceLanguage, state.target as Language)
        return
      }
      case 'setTarget': {
        if (typeof op.value !== 'string' || !TARGETS.has(op.value)) return
        const state = controller.state()
        await controller.setLanguages(state.source as SourceLanguage, op.value as Language)
        return
      }
      case 'setMode':
        if (op.value === 'meeting' || op.value === 'media') await controller.setMode(op.value)
        return
      case 'setFontSize':
        if (typeof op.value === 'number' && Number.isFinite(op.value)) {
          await controller.setSubtitle({ fontSize: Math.round(clamp(op.value, 12, 96)) })
        }
        return
      case 'setSubtitle': {
        const patch = parseSubtitlePatch(op.value)
        if (patch !== undefined) await controller.setSubtitle(patch)
        return
      }
      case 'setApp':
        if (typeof op.value === 'string') {
          if (op.value.trim() === '') await controller.setCapture('system-exclude-self', '')
          else await controller.setCapture('app', op.value.trim())
        }
        return
      case 'quit': await controller.dispose(); return
    }
  } catch (error) {
    log(`action ${op.name} failed`, error)
  }
}
