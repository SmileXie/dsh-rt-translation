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
async function renderConnectedPage(
  afterMount?: (tree: unknown, api: { render: () => void; current: () => unknown; pump: () => Promise<void> }) => void | Promise<void>,
  overrides: { translate?: Record<string, unknown>; state?: Record<string, unknown>; actionTranslate?: Record<string, unknown> } = {},
) {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const snapshot = {
    state: { running: false, phase: 'idle', source: 'auto', target: 'zh', error: null, ...(overrides.state ?? {}) },
    subtitle: { fontSize: 20, maxLines: 3, widthPercent: 78, marginPercent: 8, opacity: 0.72, background: true, bilingual: true, fontFamily: '', holdMs: 6000, minReadMs: 1800 },
    segment: { silenceMs: 550, maxSegmentMs: 8000 },
    autoPauseAfterMs: 120000,
    capture: { mode: 'system-exclude-self', appName: '' },
    translate: { provider: '', model: '', background: '', backgroundBrief: '', glossary: [], glossaryError: null, ...(overrides.translate ?? {}) },
    stt: '待机',
  }
  // A POST may report the state after an action (for example a successful
  // preparation that clears glossaryError).
  const actionSnapshot = overrides.actionTranslate === undefined
    ? snapshot
    : { ...snapshot, translate: { ...snapshot.translate, ...overrides.actionTranslate } }

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
  globalThis.fetch = (async (_url: string, init?: { method?: string }) => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, value: init?.method === 'POST' ? actionSnapshot : snapshot }),
  })) as never
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
      await afterMount(tree, { render, current: () => tree, pump })
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

/** The "提炼背景并生成词表" button; after a click its label becomes "提炼中…". */
function prepareButton(tree: unknown) {
  const button = collectByType(tree, 'button').find(entry => treeText(entry).includes('提炼背景并生成词表'))
  assert.ok(button !== undefined, '应渲染提炼按钮')
  return button
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

test('运行中的开始按钮使用 DSH primary 按钮令牌，深色主题下文字不会消失', async () => {
  const tree = await renderConnectedPage(undefined, { state: { running: true, phase: 'listening' } })
  const stop = collectByType(tree, 'button').find(button => treeText(button).includes('停止'))
  assert.ok(stop !== undefined, '应渲染停止按钮')
  const style = stop.props.style as Record<string, string>
  assert.equal(style.background, 'var(--dsw-alias-button-primary-fill)')
  assert.equal(style.color, 'var(--dsw-alias-label-primary-foreground)')
})

test('连接后的页面渲染翻译背景卡，且 textarea 不携带 children（React 19 会抛错）', async () => {
  const tree = await renderConnectedPage()
  assert.match(treeText(tree), /翻译背景/)
  assert.match(treeText(tree), /提炼背景并生成词表/)
  assert.equal(treeText(tree).includes('用当前翻译模型提炼背景并生成词表'), false, '按钮右侧的说明小字应已删除')
  const textareas = collectByType(tree, 'textarea')
  assert.ok(textareas.length >= 3, '背景、背景摘要、术语都应是输入框')
  const placeholders = textareas.map(textarea => String(textarea.props.placeholder ?? ''))
  assert.ok(placeholders.some(value => value.includes('一两句话说清')), '背景摘要应直接显示为文本框')
  assert.ok(placeholders.some(value => value.includes('原文=译文')), '术语应有文本框')
  assert.equal(treeText(tree).includes('手写'), false, '摘要不再需要「手写」切换')
  const pageText = treeText(tree)
  assert.ok(pageText.indexOf('操作') > pageText.indexOf('语言'), '操作卡应在语言卡之后')
  assert.ok(pageText.indexOf('操作') < pageText.indexOf('翻译背景'), '操作卡应在翻译背景之前')
  assert.match(pageText, /状态/)
  assert.match(pageText, /识别:/)
  assert.ok(pageText.indexOf('识别:') > pageText.indexOf('操作'), '状态信息应排在操作卡之后')
  assert.equal(hasPairedCards(tree, '操作', '状态'), true, '操作与状态应是同一行的两个卡片')
  const row = pairedRow(tree, '操作', '状态')
  assert.ok(row !== undefined, '应找到操作/状态所在行')
  assert.equal(row.props.style.display, 'flex')
  assert.equal(row.props.style.alignItems, 'stretch', '行内卡片应拉伸到等高')
  const cards = row.props.children as Array<{ type: string; props: Record<string, any> }>
  assert.equal(cards.length, 2)
  for (const cardEl of cards) {
    assert.equal(cardEl.type, 'section', '行内直接子元素应是卡片本身，而不是包装 div')
    assert.match(String(cardEl.props.style.flex), /^1 1 /, '卡片需可伸展以对齐高度')
  }
  for (const textarea of textareas) {
    assert.equal((textarea.props as { children?: unknown }).children, undefined)
  }
})

/** Find divs whose direct children include a button with the given label. */
function rowsWithButton(tree: unknown, label: string): Array<{ props?: { children?: unknown } }> {
  const rows: Array<{ props?: { children?: unknown } }> = []
  const visit = (node: unknown) => {
    if (Array.isArray(node)) { for (const child of node) visit(child); return }
    if (!node || typeof node !== 'object') return
    const element = node as { type?: unknown; props?: { children?: unknown } }
    const children = Array.isArray(element.props?.children) ? element.props.children : [element.props?.children]
    const hasButton = children.some(child => child !== null && typeof child === 'object'
      && (child as { type?: unknown }).type === 'button'
      && treeText(child).includes(label))
    if (element.type === 'div' && hasButton) rows.push(element as never)
    visit(element.props?.children)
  }
  visit(tree)
  return rows
}

/** True when one div holds two direct children whose text contains both labels (side-by-side cards). */
function hasPairedCards(tree: unknown, left: string, right: string): boolean {
  let found = false
  const visit = (node: unknown) => {
    if (Array.isArray(node)) { for (const child of node) visit(child); return }
    if (!node || typeof node !== 'object') return
    const element = node as { type?: unknown; props?: { children?: unknown } }
    const children = Array.isArray(element.props?.children) ? element.props.children : [element.props?.children]
    const texts = children.map(child => treeText(child))
    if (element.type === 'div' && texts.some(text => text.includes(left)) && texts.some(text => text.includes(right))) {
      found = true
    }
    visit(element.props?.children)
  }
  visit(tree)
  return found
}

/** Find the row div whose two direct children are the cards containing both labels. */
function pairedRow(tree: unknown, left: string, right: string): { type: string; props: Record<string, any> } | undefined {
  let found: { type: string; props: Record<string, any> } | undefined
  const visit = (node: unknown) => {
    if (Array.isArray(node)) { for (const child of node) visit(child); return }
    if (!node || typeof node !== 'object') return
    const element = node as { type?: unknown; props?: { children?: unknown } }
    const children = Array.isArray(element.props?.children) ? element.props.children : []
    const texts = children.map(child => treeText(child))
    if (element.type === 'div' && texts.some(text => text.includes(left)) && texts.some(text => text.includes(right))) {
      found = element as never
    }
    visit(element.props?.children)
  }
  visit(tree)
  return found
}

test('提炼失败/前置条件的提示显示在按钮右侧，而不是卡片底部', async () => {
  const message = '请先在「语言」里选择源语言——「自动」时无法提炼背景与词表'
  const tree = await renderConnectedPage(undefined, { translate: { glossaryError: message } })
  const rows = rowsWithButton(tree, '提炼背景并生成词表')
  assert.ok(rows.length > 0, '应找到含提炼按钮的行')
  assert.ok(rows.some(row => treeText(row).includes(message)), '提示应与按钮在同一行')
  assert.equal((treeText(tree).match(/请先在「语言」里选择源语言/g) ?? []).length, 1, '提示只应出现一次')
})

test('背景为空时点击提炼按钮仍可点击，并立即提示先填背景；输入后提示消失', async () => {
  let afterClick = ''
  const tree = await renderConnectedPage(async (first, api) => {
    const button = prepareButton(first)
    assert.notEqual(button.props.disabled, true, '背景为空时按钮也应可点击')

    ;(button.props.onClick as () => void)()
    api.render()
    afterClick = treeText(api.current())
    assert.match(afterClick, /先填写翻译背景/, '点击后应立即提示先填背景')

    const background = collectByType(api.current(), 'textarea')
      .find(area => String(area.props.placeholder).includes('例：看'))
    assert.ok(background !== undefined, '应找到背景输入框')
    ;(background.props.onChange as (event: unknown) => void)({ target: { value: '看《哈利·波特与魔法石》' } })
    await api.pump()
    assert.equal(treeText(api.current()).includes('先填写翻译背景'), false, '输入背景后提示应消失')
  })
  assert.match(afterClick, /先填写翻译背景/)
  assert.equal(treeText(tree).includes('先填写翻译背景'), false)
})

test('再次点击提炼时旧提示立即消失；宿主仍报同一问题时重新显示', async () => {
  const message = '请先在「语言」里选择源语言——「自动」时无法提炼背景与词表'
  let afterClick = ''
  const tree = await renderConnectedPage(async (first, api) => {
    ;(prepareButton(first).props.onClick as () => void)()
    api.render()
    afterClick = treeText(api.current())
    assert.equal(afterClick.includes(message), false, '点击后不应等提炼完成，旧提示应立即消失')

    // 源语言仍是「自动」：宿主快速返回同一错误，提示应重新出现。
    await api.pump()
    assert.ok(treeText(api.current()).includes(message), '问题未修复时应重新显示提示')
  }, {
    state: { source: 'auto' },
    translate: { background: '看《哈利·波特与魔法石》', glossaryError: message },
  })
  assert.equal(afterClick.includes(message), false)
  assert.ok(treeText(tree).includes(message))
  assert.equal((treeText(tree).match(/请先在「语言」里选择源语言/g) ?? []).length, 1)
})

test('提炼成功后旧提示不会重新出现', async () => {
  const message = '请先在「语言」里选择源语言——「自动」时无法提炼背景与词表'
  const tree = await renderConnectedPage(async (first, api) => {
    ;(prepareButton(first).props.onClick as () => void)()
    api.render()
    assert.equal(treeText(api.current()).includes(message), false, '点击后旧提示应立即消失')

    await api.pump()
    assert.equal(treeText(api.current()).includes(message), false, '成功后旧提示不应重新出现')
  }, {
    state: { source: 'zh' },
    translate: { background: '电影', glossaryError: message },
    actionTranslate: { glossaryError: null, backgroundBrief: '一部电影', glossary: ['A=B'] },
  })
  assert.equal(treeText(tree).includes(message), false)
})

test('聚焦各输入框后页面仍能渲染（草稿状态不能当数组用）', async () => {
  let focused = 0
  const tree = await renderConnectedPage(first => {
    for (const area of collectByType(first, 'textarea')) {
      assert.equal(typeof area.props.onFocus, 'function')
      ;(area.props.onFocus as () => void)()
      focused += 1
    }
  })
  assert.ok(focused >= 3, '背景、背景摘要、术语三个输入框都要能聚焦')
  assert.match(treeText(tree), /翻译背景/)
  assert.match(treeText(tree), /术语/)
})
