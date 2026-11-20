/** System-audio capture adapter; Windows today, PipeWire path reserved for Linux. */
import { execFileSync } from 'node:child_process'
import loopback from 'loopback-capture'
import type { AudioSourceFactory } from './controller.ts'

/** Resolve one executable name to the first running PID. */
function findProcessId(appName: string, platform: NodeJS.Platform): number {
  const trimmed = appName.trim()
  if (trimmed === '') throw new Error('未指定要采集的应用')
  const image = platform === 'win32' && !trimmed.toLowerCase().endsWith('.exe') ? `${trimmed}.exe` : trimmed
  const command = platform === 'win32' ? 'tasklist' : 'pgrep'
  const args = platform === 'win32'
    ? ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH']
    : ['-x', image]
  const output = execFileSync(command, args, { encoding: 'utf8', windowsHide: true })
  const match = platform === 'win32' ? /"[^"]+","(\d+)"/.exec(output) : /^(\d+)/m.exec(output)
  if (match === null) throw new Error(`未找到正在运行的应用: ${appName}`)
  return Number(match[1])
}

/**
 * Build the capture factory for one platform. `loopback-capture` already
 * supports PipeWire on Linux; only the app-name resolution differs there, so
 * the v2 Linux port mostly needs UI and STT availability work.
 */
export function createLoopbackCapture(platform: NodeJS.Platform = process.platform): AudioSourceFactory {
  return {
    open(onChunk, options) {
      const capture = new loopback.LoopbackCapture()
      const deliver = (chunk: Buffer): void => { onChunk(new Uint8Array(chunk)) }
      try {
        if (options.mode === 'app') capture.start(findProcessId(options.appName, platform), deliver)
        else if (options.mode === 'system-exclude-self') capture.startSystemAudio(deliver, process.pid)
        else capture.startSystemAudio(deliver)
      } catch (error) {
        try { capture.stop() } catch { /* startup already failed */ }
        throw error
      }
      return {
        close() {
          try { capture.stop() } catch { /* terminal errors already surface through lastError */ }
        },
        get lastError() { return capture.lastError },
      }
    },
  }
}

export const loopbackCapture = createLoopbackCapture()
