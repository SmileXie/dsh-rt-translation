import assert from 'node:assert/strict'
import test from 'node:test'
import { WindowsWpfRenderer } from '../src/subtitle/windows-wpf.ts'

type FakeChild = {
  written: string[]
  emit(line: string): void
  exit(code: number): void
  killed: boolean
}

function makeSpawn() {
  const children: FakeChild[] = []
  const spawn = () => {
    const dataHandlers: Array<(chunk: string) => void> = []
    const exitHandlers: Array<(code: number | null) => void> = []
    const child: FakeChild = {
      written: [],
      killed: false,
      emit(line) { for (const cb of dataHandlers) cb(`${line}\n`) },
      exit(code) { for (const cb of exitHandlers) cb(code) },
    }
    children.push(child)
    return {
      stdin: { write: (chunk: string) => { child.written.push(chunk); return true } },
      stdout: { on: (_event: string, cb: (chunk: string) => void) => { dataHandlers.push(cb) } },
      onExit: (cb: (code: number | null) => void) => { exitHandlers.push(cb) },
      kill: () => { child.killed = true },
    }
  }
  return { spawn, children }
}

const style = { fontSize: 32, maxLines: 3, position: 'bottom' as const, marginPercent: 8, widthPercent: 78, opacity: 0.72, background: true, bilingual: true, display: 'primary' as const, fontFamily: '' }

test('start 写出 style 并在 ready 后 resolve', async () => {
  const fake = makeSpawn()
  const r = new WindowsWpfRenderer({ scriptPath: 'overlay.ps1', style, spawn: fake.spawn as never })
  const started = r.start()
  assert.ok(fake.children[0].written[0].includes('"op":"style"'))
  fake.children[0].emit('{"op":"ready"}')
  await started
})

test('进程退出只重启一次，第二次退出触发 onFatal', async () => {
  const fake = makeSpawn()
  let fatal = 0
  const r = new WindowsWpfRenderer({ scriptPath: 'overlay.ps1', style, spawn: fake.spawn as never, onFatal: () => { fatal++ } })
  const started = r.start()
  fake.children[0].emit('{"op":"ready"}')
  await started
  fake.children[0].exit(1)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(fake.children.length, 2)
  assert.ok(fake.children[1].written[0].includes('"op":"style"'))
  fake.children[1].exit(1)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(fake.children.length, 2)
  assert.equal(fatal, 1)
})

test('ready 前以 0 退出会 reject 而不是永远挂起', async () => {
  const fake = makeSpawn()
  const r = new WindowsWpfRenderer({ scriptPath: 'overlay.ps1', style, spawn: fake.spawn as never })
  const started = r.start()
  fake.children[0].exit(0)
  await assert.rejects(started, /before ready/)
})
