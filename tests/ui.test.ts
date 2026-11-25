import assert from 'node:assert/strict'
import test from 'node:test'
import { dispatchAction, parseAutoPause, parseBackground, parseBrief, parseGlossaryPatch, parseSegmentPatch, parseSubtitlePatch } from '../src/ui.ts'

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

test('dispatchAction 把 resetDefaults 转成控制器调用', async () => {
  let calls = 0
  const controller = { async resetDefaults() { calls += 1 } }
  await dispatchAction({ op: 'action', name: 'resetDefaults' }, controller as never)
  assert.equal(calls, 1)
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

test('parseBackground 截断超长输入，非字符串忽略', () => {
  assert.equal(parseBackground('  电影  '), '电影')
  assert.equal(parseBackground('a'.repeat(2500))?.length, 2000)
  assert.equal(parseBackground(42), undefined)
  assert.equal(parseBackground(null), undefined)
})

test('parseBrief 压成一行并截断 300', () => {
  assert.equal(parseBrief('第一行\n第二行'), '第一行 第二行')
  assert.equal(parseBrief('x'.repeat(400))?.length, 300)
  assert.equal(parseBrief(''), '')
  assert.equal(parseBrief(42), undefined)
})

test('parseGlossaryPatch 去空、去重、限 200 行与 120 字符', () => {
  assert.deepEqual(parseGlossaryPatch([' a ', '', 'a', 'b']), ['a', 'b'])
  assert.deepEqual(parseGlossaryPatch('a\nb'), ['a', 'b'])
  assert.deepEqual(parseGlossaryPatch(''), [])
  assert.equal(parseGlossaryPatch(42), undefined)
  assert.equal(parseGlossaryPatch(Array.from({ length: 250 }, (_, i) => `t${i}`))?.length, 200)
  assert.equal(parseGlossaryPatch(['x'.repeat(200)])?.[0].length, 120)
})

test('dispatchAction 把背景/摘要/词表动作转成控制器调用', async () => {
  const calls: unknown[] = []
  const controller = {
    async setBackground(text: string) { calls.push(['background', text]) },
    async setBrief(text: string) { calls.push(['brief', text]) },
    async setGlossary(lines: string[]) { calls.push(['glossary', lines]) },
    async prepareGlossary() { calls.push(['prepare', undefined]) },
  }
  await dispatchAction({ op: 'action', name: 'setBackground', value: ' 电影 ' }, controller as never)
  await dispatchAction({ op: 'action', name: 'setBrief', value: '摘要' }, controller as never)
  await dispatchAction({ op: 'action', name: 'setGlossary', value: ['Hermione=赫敏'] } as never, controller as never)
  await dispatchAction({ op: 'action', name: 'prepareGlossary' }, controller as never)
  assert.deepEqual(calls, [['background', '电影'], ['brief', '摘要'], ['glossary', ['Hermione=赫敏']], ['prepare', undefined]])
})
