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
