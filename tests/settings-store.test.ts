import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { createSettingsStore, profileSettingsPath } from '../src/settings-store.ts'

test('profile 兜底按原配置保存并恢复设置，配置层变化后不再使用旧值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-settings-'))
  try {
    const store = createSettingsStore(profileSettingsPath(dir))
    const base = { sourceLanguage: 'auto', targetLanguage: 'zh' }
    assert.equal(store.load(base), undefined)
    const settings = resolveConfig({ subtitle: { fontSize: 34, maxLines: 4 }, translate: { background: '看《哈利·波特与魔法石》' } })
    store.save(base, settings)
    assert.deepEqual(store.load(base), settings)
    assert.equal(store.load({ ...base, targetLanguage: 'en' }), undefined, 'profile 或命令行配置变化后应忽略旧兜底')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('profile 兜底忽略损坏文件，flush 后不再恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-settings-'))
  try {
    const store = createSettingsStore(profileSettingsPath(dir))
    const settings = resolveConfig({})
    store.save({}, settings)
    assert.deepEqual(store.load({}), settings)
    store.clear()
    assert.equal(store.load({}), undefined)
    writeFileSync(profileSettingsPath(dir), '{not json', 'utf8')
    assert.equal(store.load({}), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})