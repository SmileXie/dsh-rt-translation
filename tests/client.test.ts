import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * Load the hand-written browser bundle in a tiny fake shell: the module loader
 * captures the factory, and React is a stub good enough to register components
 * and render the page's pre-connection branch once.
 */
function loadBundle() {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let loaded: { id: string; factory: (require: (name: string) => unknown) => unknown } | undefined
  const window = { __ModuleLoader__: { load: (options: typeof loaded) => { loaded = options } } }
  // The bundle only touches its own `window` argument at load time.
  new Function('window', source)(window)
  assert.ok(loaded !== undefined, 'bundle must register a factory')
  assert.equal(loaded.id, 'dsh-rt-translation')

  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useState: (initial: unknown) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial: unknown) => ({ current: initial }),
    useCallback: (fn: unknown) => fn,
  }
  const plugin = loaded.factory(name => {
    if (name === 'react') return react
    throw new Error(`unexpected module: ${name}`)
  }) as { inject?: string[]; apply: (ctx: unknown) => void }
  return { plugin, react }
}

/** Collect every string in a fake element tree. */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (node && typeof node === 'object' && 'children' in node) {
    return (node as { children: unknown[] }).children.map(textOf).join(' ')
  }
  return ''
}

test('浏览器半把入口放进左侧导航，并打开 main 页面，不再占用 shell.overlay', () => {
  const { plugin } = loadBundle()
  const injected: string[] = []
  const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
  const ctx = {
    slots: {
      inject(name: string, install: () => void) { injected.push(name); install() },
      register(options: Record<string, unknown>, component: unknown) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  plugin.apply(ctx)

  assert.deepEqual(injected.sort(), ['main', 'sidebar.panellist'])
  assert.equal(registrations.some(entry => entry.options.name === 'shell.overlay'), false)

  const page = registrations.find(entry => entry.options.name === 'main')
  const entry = registrations.find(entry => entry.options.name === 'sidebar.panellist')
  assert.ok(page !== undefined, 'main page must be registered')
  assert.ok(entry !== undefined, 'sidebar entry must be registered')
  // One id ties the sidebar row to the panel it selects.
  assert.equal(page.options.key, 'rt-translation')
  assert.equal(entry.options.id, 'rt-translation')
  const label = entry.options.label
  assert.equal(typeof label, 'function')
  assert.equal((label as () => string)(), '实时翻译')
  assert.equal(entry.options.order, 20)
})

test('侧边栏图标按宿主给的大小绘制，使用 currentColor', () => {
  const { plugin } = loadBundle()
  let entryComponent: ((props: { size: number }) => unknown) | undefined
  const ctx = {
    slots: {
      inject(_name: string, install: () => void) { install() },
      register(options: Record<string, unknown>, component: unknown) {
        if (options.name === 'sidebar.panellist') entryComponent = component as never
        return () => {}
      },
    },
  }
  plugin.apply(ctx)

  assert.ok(entryComponent !== undefined)
  const icon = entryComponent({ size: 24 }) as { type: string; props: Record<string, unknown> }
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 24)
  assert.equal(icon.props.height, 24)
  assert.equal(icon.props['aria-hidden'], 'true')
})

test('页面在拿到快照前显示标题与连接提示', () => {
  const { plugin } = loadBundle()
  let pageComponent: (() => unknown) | undefined
  const ctx = {
    slots: {
      inject(_name: string, install: () => void) { install() },
      register(options: Record<string, unknown>, component: unknown) {
        if (options.name === 'main') pageComponent = component as never
        return () => {}
      },
    },
  }
  plugin.apply(ctx)

  assert.ok(pageComponent !== undefined)
  const text = textOf(pageComponent())
  assert.match(text, /实时翻译/)
  assert.match(text, /连接中/)
})

/** Render the page far enough to reach the connected branch: hooks update, effects run, fetch resolves. */
async function renderConnectedPage(afterMount?: (tree: unknown) => void) {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const snapshot = {
    state: { running: false, phase: 'idle', source: 'auto', target: 'zh', error: null },
    subtitle: { fontSize: 20, maxLines: 3, widthPercent: 78, marginPercent: 8, opacity: 0.72, background: true, bilingual: true, fontFamily: '', holdMs: 6000, minReadMs: 1800 },
    segment: { silenceMs: 550, maxSegmentMs: 8000 },
    autoPauseAfterMs: 120000,
    capture: { mode: 'system-exclude-self', appName: '' },
    translate: { provider: '', model: '', background: '', backgroundBrief: '', glossary: [], glossaryError: null },
    stt: '待机',
    persistence: true,
  }

  let loaded: { factory: (require: (name: string) => unknown) => unknown } | undefined
  const window = {
    __ModuleLoader__: { load: (options: typeof loaded) => { loaded = options } },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  }
  new Function('window', source)(window)

  const slots: Array<Record<string, any>> = []
  let cursor = 0
  let dirty = false
  const queue: number[] = []
  const same = (a: unknown[] | undefined, b: unknown[] | undefined) => a !== undefined && b !== undefined
    && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      // Mirror React: argument children win, otherwise keep whatever the bundle put in props.
      props: children.length > 0 ? { ...(props as object), children } : { ...(props as object) },
    }),
    useState: (initial: unknown) => {
      const index = cursor++
      slots[index] = slots[index] ?? { value: initial }
      return [slots[index].value, (value: unknown) => {
        slots[index].value = typeof value === 'function' ? (value as (prev: unknown) => unknown)(slots[index].value) : value
        dirty = true
      }]
    },
    useRef: (initial: unknown) => {
      const index = cursor++
      slots[index] = slots[index] ?? { ref: { current: initial } }
      return slots[index].ref
    },
    useEffect: (fn: () => unknown, deps: unknown[]) => {
      const index = cursor++
      slots[index] = slots[index] ?? {}
      if (!same(slots[index].deps, deps)) { slots[index].deps = deps; slots[index].fn = fn; queue.push(index) }
    },
    useCallback: (fn: unknown, deps: unknown[]) => {
      const index = cursor++
      slots[index] = slots[index] ?? {}
      if (!same(slots[index].deps, deps)) { slots[index].deps = deps; slots[index].fn = fn }
      return slots[index].fn
    },
  }

  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: snapshot }) })) as never
  const plugin = (loaded as { factory: (require: (name: string) => unknown) => unknown }).factory(name => {
    if (name === 'react') return react
    throw new Error(`unexpected module: ${name}`)
  }) as { apply: (ctx: unknown) => void }

  let pageComponent: (() => unknown) | undefined
  plugin.apply({
    slots: {
      inject(_name: string, install: () => void) { install() },
      register(options: Record<string, unknown>, component: unknown) {
        if (options.name === 'main') pageComponent = component as never
        return () => {}
      },
    },
  })

  let tree: unknown
  const render = () => {
    cursor = 0
    tree = (pageComponent as () => unknown)()
    while (queue.length > 0) {
      const index = queue.shift() as number
      const slot = slots[index]
      if (typeof slot.cleanup === 'function') slot.cleanup()
      slot.cleanup = slot.fn()
    }
  }
  const pump = async () => {
    for (let round = 0; round < 40; round++) {
      dirty = false
      render()
      await new Promise(resolve => setTimeout(resolve, 5))
      if (!dirty) break
    }
  }
  try {
    await pump()
    if (afterMount !== undefined) {
      afterMount(tree)
      await pump()
    }
  } finally {
    for (const slot of slots) if (slot && typeof slot.cleanup === 'function') slot.cleanup()
    globalThis.fetch = realFetch
  }
  return tree
}

function collectByType(node: unknown, type: string, out: Array<{ type: string; props: Record<string, unknown> }> = []) {
  if (Array.isArray(node)) { for (const child of node) collectByType(child, type, out); return out }
  if (node && typeof node === 'object') {
    const element = node as { type?: unknown; props?: { children?: unknown } }
    if (element.type === type) out.push(element as { type: string; props: Record<string, unknown> })
    if (element.props !== undefined) collectByType(element.props.children, type, out)
  }
  return out
}

/** Text of a tree whose children live in props (the shape createElement produces). */
function treeText(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(treeText).join(' ')
  if (node && typeof node === 'object') {
    const element = node as { props?: { children?: unknown } }
    if (element.props !== undefined) return treeText(element.props.children)
  }
  return ''
}

test('连接后的页面渲染翻译背景卡，且 textarea 不携带 children（React 19 会抛错）', async () => {
  const tree = await renderConnectedPage()
  assert.match(treeText(tree), /翻译背景/)
  assert.match(treeText(tree), /提炼背景并生成词表/)
  assert.equal(treeText(tree).includes('用当前翻译模型提炼背景并生成词表'), false, '按钮右侧的说明小字应已删除')
  const textareas = collectByType(tree, 'textarea')
  assert.ok(textareas.length > 0, '背景卡应包含 textarea')
  for (const textarea of textareas) {
    assert.equal((textarea.props as { children?: unknown }).children, undefined)
  }
})

test('聚焦术语输入框后页面仍能渲染（草稿状态不能当数组用）', async () => {
  let focused = false
  const tree = await renderConnectedPage(first => {
    const area = collectByType(first, 'textarea').find(entry => String(entry.props.placeholder ?? '').includes('原文=译文'))
    assert.ok(area !== undefined, '应有术语输入框')
    assert.equal(typeof area.props.onFocus, 'function')
    ;(area.props.onFocus as () => void)()
    focused = true
  })
  assert.equal(focused, true)
  assert.match(treeText(tree), /翻译背景/)
  assert.match(treeText(tree), /术语/)
})
