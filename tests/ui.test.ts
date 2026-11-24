import assert from 'node:assert/strict'
import test from 'node:test'
import { dispatchAction, parseAutoPause, parseSegmentPatch, parseSubtitlePatch } from '../src/ui.ts'

test('parseSubtitlePatch 钳制数值并忽略非法输入', () => {
  assert.deepEqual(parseSubtitlePatch('{"fontSize":500,"maxLines":0,"opacity":2}'), { fontSize: 96, maxLines: 2, opacity: 1 })
  assert.deepEqual(parseSubtitlePatch({ position: 'top', bilingual: false }), { bilingual: false })
  assert.equal(parseSubtitlePatch('{oops'), undefined)
  assert.equal(parseSubtitlePatch({ nope: 1 }), undefined)
})

test('parseSegmentPatch 与 parseAutoPause 钳制范围', () => {
  assert.deepEqual(parseSegmentPatch({ silenceMs: 10, maxSegmentMs: 99_999 }), { silenceMs: 100, maxSegmentMs: 30_000 })
  assert.deepEqual(parseSegmentPatch({}), undefined)
  assert.equal(parseSegmentPatch('{oops'), undefined)
  assert.equal(parseAutoPause('5000'), 5000)
  assert.equal(parseAutoPause(-1), 0)
  assert.equal(parseAutoPause(99_999_999), 3_600_000)
  assert.equal(parseAutoPause('abc'), undefined)
})

test('dispatchAction 把 setSegment/setAutoPause 转成控制器调用', async () => {
  const calls: unknown[] = []
  const controller = {
    async setSegment(patch: unknown) { calls.push(['segment', patch]) },
    async setAutoPause(ms: number) { calls.push(['auto', ms]) },
  }
  await dispatchAction({ op: 'action', name: 'setSegment', value: { silenceMs: 500 } }, controller as never)
  await dispatchAction({ op: 'action', name: 'setAutoPause', value: 60_000 }, controller as never)
  assert.deepEqual(calls, [['segment', { silenceMs: 500 }], ['auto', 60_000]])
})

test('dispatchAction 把字号动作转成字幕设置', async () => {
  const patches: unknown[] = []
  const controller = { async setSubtitle(patch: unknown) { patches.push(patch) } }
  await dispatchAction({ op: 'action', name: 'setFontSize', value: 200 }, controller as never)
  assert.deepEqual(patches, [{ fontSize: 96 }])
})

test('dispatchAction 空应用名恢复系统声音，quit 关闭托盘与字幕窗', async () => {
  const calls: string[] = []
  const controller = {
    async setCapture(mode: string, name: string) { calls.push(`capture:${mode}:${name}`) },
    async quit() { calls.push('quit') },
  }
  await dispatchAction({ op: 'action', name: 'setApp', value: '' }, controller as never)
  await dispatchAction({ op: 'action', name: 'quit' }, controller as never)
  assert.deepEqual(calls, ['capture:system-exclude-self:', 'quit'])
})
