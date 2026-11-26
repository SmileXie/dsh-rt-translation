import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const readJson = (relative: string) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'))

test('package exports 暴露插件页要读的元数据资源', () => {
  const manifest = readJson('../package.json')
  assert.equal(manifest.exports['./package.json'], './package.json')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.ok(manifest.files.includes('locale'))
})

test('locale 文件带非空的标题与说明文字', () => {
  for (const language of ['en', 'zh']) {
    const meta = readJson(`../locale/${language}.json`).meta
    assert.equal(typeof meta.title, 'string')
    assert.ok(meta.title.trim().length > 0)
    assert.equal(typeof meta.description, 'string')
    assert.ok(meta.description.trim().length > 0)
  }
})
