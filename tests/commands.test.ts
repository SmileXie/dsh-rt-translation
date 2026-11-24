import assert from 'node:assert/strict'
import test from 'node:test'
import { registerCommands } from '../src/commands.ts'

function registry() {
  const defs = new Map<string, { handler: (ctx: { rawInput: string }) => Promise<{ kind: string; text: string }> }>()
  return { defs, register(d: { name: string; handler: (ctx: { rawInput: string }) => Promise<{ kind: string; text: string }> }) { defs.set(d.name, d); return () => {} } }
}

function fakeController() {
  const calls: string[] = []
  return {
    calls,
    start: async () => { calls.push('start') },
    prepareModel: () => { calls.push('prepare') },
    stop: async () => { calls.push('stop') },
    restart: async () => { calls.push('restart') },
    setLanguages: async (s: string, t: string) => { calls.push(`lang:${s}:${t}`) },
    status: () => 'status-ok',
    state: () => ({ phase: 'idle' }),
  }
}

test('/rt start 调用 controller.start', async () => {
  const r = registry(); const c = fakeController()
  registerCommands(r as never, c as never)
  const out = await r.defs.get('rt')!.handler({ rawInput: ' start' })
  assert.equal(out.kind, 'success')
  assert.deepEqual(c.calls, ['start'])
})

test('/rt prepare 启动模型预下载', async () => {
  const r = registry(); const c = fakeController()
  registerCommands(r as never, c as never)
  const out = await r.defs.get('rt')!.handler({ rawInput: ' prepare' })
  assert.equal(out.kind, 'success')
  assert.deepEqual(c.calls, ['prepare'])
})

test('/rt lang zh en 设置语言', async () => {
  const r = registry(); const c = fakeController()
  registerCommands(r as never, c as never)
  await r.defs.get('rt')!.handler({ rawInput: ' lang zh en' })
  assert.deepEqual(c.calls, ['lang:zh:en'])
})

test('/rt lang de en 返回错误', async () => {
  const r = registry(); const c = fakeController()
  registerCommands(r as never, c as never)
  const out = await r.defs.get('rt')!.handler({ rawInput: ' lang de en' })
  assert.equal(out.kind, 'error')
})

test('已移除的 /rt mode 返回用法提示', async () => {
  const r = registry(); const c = fakeController()
  registerCommands(r as never, c as never)
  const out = await r.defs.get('rt')!.handler({ rawInput: ' mode foo' })
  assert.equal(out.kind, 'error')
})
