import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeOp, decodeOverlayLine, toUiConfig } from '../src/subtitle/protocol.ts'
import { resolveConfig } from '../src/config.ts'

test('encodeOp 输出单行 JSON 加换行', () => {
  assert.equal(encodeOp({ op: 'clear' }), '{"op":"clear"}\n')
})

test('decode 忽略空行与坏 JSON', () => {
  assert.equal(decodeOverlayLine(''), undefined)
  assert.equal(decodeOverlayLine('{oops'), undefined)
})

test('decode 校验 action 名称与 value 类型', () => {
  assert.deepEqual(decodeOverlayLine('{"op":"action","name":"toggle"}'), { op: 'action', name: 'toggle' })
  assert.deepEqual(decodeOverlayLine('{"op":"action","name":"resetDefaults"}'), { op: 'action', name: 'resetDefaults' })
  assert.deepEqual(decodeOverlayLine('{"op":"action","name":"setFontSize","value":36}'), { op: 'action', name: 'setFontSize', value: 36 })
  assert.equal(decodeOverlayLine('{"op":"action","name":"rm -rf"}'), undefined)
  assert.equal(decodeOverlayLine('{"op":"action","name":"toggle","value":{"a":1}}'), undefined)
})

test('未知 op 被忽略', () => {
  assert.equal(decodeOverlayLine('{"op":"nope"}'), undefined)
})

test('toUiConfig 投影托盘与热键设置', () => {
  const config = resolveConfig({
    ui: { tray: false },
    hotkeys: { enabled: false },
  })
  assert.deepEqual(toUiConfig(config), {
    tray: false,
    hotkeysEnabled: false,
  })
})
