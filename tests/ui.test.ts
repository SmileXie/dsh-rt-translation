import assert from 'node:assert/strict'
import test from 'node:test'
import { dispatchAction, parseSubtitlePatch } from '../src/ui.ts'

test('parseSubtitlePatch 钳制数值并忽略非法输入', () => {
  assert.deepEqual(parseSubtitlePatch('{"fontSize":500,"maxLines":0,"opacity":2}'), { fontSize: 96, maxLines: 2, opacity: 1 })
  assert.deepEqual(parseSubtitlePatch({ position: 'top', bilingual: false }), { bilingual: false, position: 'top' })
  assert.equal(parseSubtitlePatch('{oops'), undefined)
  assert.equal(parseSubtitlePatch({ nope: 1 }), undefined)
})

test('dispatchAction 把字号动作转成字幕设置', async () => {
  const patches: unknown[] = []
  const controller = { async setSubtitle(patch: unknown) { patches.push(patch) } }
  await dispatchAction({ op: 'action', name: 'setFontSize', value: 200 }, controller as never)
  assert.deepEqual(patches, [{ fontSize: 96 }])
})

test('dispatchAction 空应用名恢复系统声音，quit 释放控制器', async () => {
  const calls: string[] = []
  const controller = {
    async setCapture(mode: string, name: string) { calls.push(`capture:${mode}:${name}`) },
    async dispose() { calls.push('dispose') },
  }
  await dispatchAction({ op: 'action', name: 'setApp', value: '' }, controller as never)
  await dispatchAction({ op: 'action', name: 'quit' }, controller as never)
  assert.deepEqual(calls, ['capture:system-exclude-self:', 'dispose'])
})
