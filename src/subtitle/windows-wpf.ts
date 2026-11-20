/** Resident PowerShell/WPF overlay process driven by NDJSON over stdio. */
import { spawn as nodeSpawn } from 'node:child_process'
import { decodeOverlayLine, encodeOp } from './protocol.ts'
import type { HostOp, OverlayOp, StylePayload, UiState } from './protocol.ts'
import type { SubtitleRenderer } from './renderer.ts'
import type { Cue } from './state.ts'

/** Minimal process surface so tests can supply a fake child. */
export interface OverlayChild {
  stdin: { write(chunk: string): unknown }
  stdout: { on(event: string, cb: (chunk: string | Buffer) => void): unknown }
  onExit(cb: (code: number | null) => void): void
  kill(): void
}

export type SpawnFn = (argv: string[]) => OverlayChild

export interface WindowsWpfOptions {
  scriptPath: string
  style: StylePayload
  spawn: SpawnFn
  restartLimit?: number
  onFatal?: (error: unknown) => void
}

/** Spawn the PowerShell host without a console window. */
export const spawnPowerShell: SpawnFn = (argv) => {
  const [command, ...args] = argv
  if (command === undefined) throw new Error('missing command for overlay spawn')
  const child = nodeSpawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  return {
    stdin: { write: chunk => child.stdin?.write(chunk) },
    stdout: { on: (event, cb) => { child.stdout?.on(event, cb as (chunk: Buffer) => void) } },
    onExit: cb => { child.on('exit', code => cb(code)) },
    kill: () => { child.kill() },
  }
}

interface StartWaiter { resolve: () => void; reject: (error: unknown) => void }

export class WindowsWpfRenderer implements SubtitleRenderer {
  private readonly options: WindowsWpfOptions
  private readonly listeners = new Set<(op: OverlayOp) => void>()
  private readonly waiters: StartWaiter[] = []
  private stylePayload: StylePayload
  private child: OverlayChild | undefined
  private buffer = ''
  private restarts = 0
  private disposed = false

  constructor(options: WindowsWpfOptions) {
    this.options = options
    this.stylePayload = options.style
  }

  /** Spawn the overlay and resolve once it announces `ready`. */
  start(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.child !== undefined) return Promise.resolve()
    this.restarts = 0
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
      try {
        this.spawnChild()
      } catch (error) {
        this.fail(error)
      }
    })
  }

  cue(cue: Cue): void { this.write({ op: 'cue', cue }) }

  state(state: UiState): void { this.write({ op: 'state', state }) }

  style(style: StylePayload): void {
    this.stylePayload = style
    this.write({ op: 'style', style })
  }

  clear(): void { this.write({ op: 'clear' }) }

  /** Ask the overlay to flip the control bar; it owns the visibility bit. */
  showPanel(): void { this.write({ op: 'panel', visible: 'toggle' }) }

  onAction(cb: (op: OverlayOp) => void): void { this.listeners.add(cb) }

  async dispose(): Promise<void> {
    this.disposed = true
    const child = this.child
    if (child === undefined) return
    try { child.stdin.write(encodeOp({ op: 'shutdown' })) } catch { /* already gone */ }
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* already gone */ }
        if (this.child === child) this.child = undefined
        resolve()
      }, 2000)
      timer.unref?.()
    })
  }

  private spawnChild(): void {
    this.buffer = ''
    const encoded = Buffer.from(JSON.stringify(this.stylePayload), 'utf8').toString('base64')
    const argv = [
      'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', this.options.scriptPath, '-ConfigBase64', encoded,
    ]
    const child = this.options.spawn(argv)
    this.child = child
    child.stdout.on('data', chunk => { this.receive(String(chunk)) })
    child.onExit(code => { this.handleExit(child, code) })
    child.stdin.write(encodeOp({ op: 'style', style: this.stylePayload }))
  }

  private receive(text: string): void {
    this.buffer += text
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      this.dispatch(decodeOverlayLine(line))
      index = this.buffer.indexOf('\n')
    }
  }

  private dispatch(op: OverlayOp | undefined): void {
    if (op === undefined) return
    if (op.op === 'ready') {
      const waiters = this.waiters.splice(0)
      for (const waiter of waiters) waiter.resolve()
    }
    for (const listener of this.listeners) listener(op)
  }

  /** A clean exit (tray quit) is intentional; only crashes restart once. */
  private handleExit(child: OverlayChild, code: number | null): void {
    if (this.child !== child) return
    this.child = undefined
    if (this.disposed || code === 0) return
    const limit = this.options.restartLimit ?? 1
    if (this.restarts < limit) {
      this.restarts += 1
      try {
        this.spawnChild()
      } catch (error) {
        this.fail(error)
      }
      return
    }
    this.fail(new Error(`overlay exited with code ${code ?? 'null'}`))
  }

  private fail(error: unknown): void {
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) waiter.reject(error)
    this.options.onFatal?.(error)
  }

  private write(op: HostOp): void {
    const child = this.child
    if (child === undefined) return
    try { child.stdin.write(encodeOp(op)) } catch { /* process is going away */ }
  }
}
