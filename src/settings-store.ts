/**
 * Durable fallback for plugin settings when the DSH Settings service cannot
 * write the profile entry. That happens in `dsh web --patch` development runs:
 * the command-line overlay owns the plugin config and outranks the profile
 * patch, so Settings refuses the write. The fallback file lives inside the
 * active DSH profile and is used only while the plugin config has not changed
 * since it was written. A successful profile write removes it again.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { ResolvedSettings } from './config.ts'

const VERSION = 1

interface StoredDocument {
  version: number
  /** Raw plugin config the saved settings were written against. */
  base: unknown
  settings: ResolvedSettings
}

export interface SettingsStore {
  /** Restore settings only while the plugin config still matches the saved base. */
  load(base: unknown): ResolvedSettings | undefined
  save(base: unknown, settings: ResolvedSettings): void
  /** Remove the fallback once the profile accepts a write again. */
  clear(): void
}

/** Normalize a config snapshot for comparison and storage (drops undefined and proxies). */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null)) as unknown
}

/** Fallback file path inside one DSH profile. */
export function profileSettingsPath(profileDir: string): string {
  return join(profileDir, '.dsh-rt-translation', 'settings.json')
}

export function createSettingsStore(path: string): SettingsStore {
  const load = (base: unknown): ResolvedSettings | undefined => {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredDocument>
      if (parsed.version !== VERSION) return undefined
      if (typeof parsed.settings !== 'object' || parsed.settings === null) return undefined
      if (!isDeepStrictEqual(parsed.base, plain(base))) return undefined
      return parsed.settings as ResolvedSettings
    } catch {
      return undefined
    }
  }
  return {
    load,
    save(base, settings) {
      const document: StoredDocument = { version: VERSION, base: plain(base), settings }
      mkdirSync(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify(document, null, 2), { encoding: 'utf8', mode: 0o600 })
      try {
        renameSync(temp, path)
      } catch {
        rmSync(path, { force: true })
        renameSync(temp, path)
      }
    },
    clear() {
      try { rmSync(path, { force: true }) } catch { /* best effort */ }
    },
  }
}