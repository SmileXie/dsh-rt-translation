import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadGlossary, resolveDshHome } from '../src/commands.ts'

test('loadGlossary 读取 from/to 并转成术语行', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rt-glossary-'))
  try {
    const dir = join(home, 'rt-translation', 'glossaries')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'film.json'), JSON.stringify([
      { from: 'Transformer', to: 'Transformer' },
      { from: '注意力机制', to: 'attention mechanism' },
    ]), 'utf8')
    assert.deepEqual(await loadGlossary('film', home), ['Transformer=Transformer', '注意力机制=attention mechanism'])
    await assert.rejects(loadGlossary('missing', home))
    await writeFile(join(dir, 'bad.json'), JSON.stringify([{ from: 'x' }]), 'utf8')
    await assert.rejects(loadGlossary('bad', home), /缺少 from\/to/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('resolveDshHome 优先 DSH_HOME，空值时回退到 ~/.dsh', () => {
  assert.equal(resolveDshHome('/custom/dsh', '/home/u'), '/custom/dsh')
  assert.equal(resolveDshHome('  ', '/home/u'), join('/home/u', '.dsh'))
  const saved = process.env.DSH_HOME
  delete process.env.DSH_HOME
  try {
    assert.equal(resolveDshHome(undefined, '/home/u'), join('/home/u', '.dsh'))
  } finally {
    if (saved !== undefined) process.env.DSH_HOME = saved
  }
})
