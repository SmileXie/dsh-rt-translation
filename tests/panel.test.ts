import assert from 'node:assert/strict'
import test from 'node:test'
import { PANEL_ACTION_PATH, PANEL_STATE_PATH, registerPanelRoutes } from '../src/panel.ts'
import { resolveConfig } from '../src/config.ts'

function fakeWebServer() {
  const routes = new Map<string, { kind: string; path: string; auth?: string; handler: (req: never, res: never) => unknown }>()
  return {
    routes,
    register(route: { kind: string; path: string; auth?: string; handler: (req: never, res: never) => unknown }) {
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
  }
}

function fakeRes() {
  const state = { status: 0, headers: {} as Record<string, unknown>, body: '' }
  return {
    state,
    writeHead(status: number, headers?: Record<string, unknown>) {
      state.status = status
      Object.assign(state.headers, headers ?? {})
    },
    end(body?: string) { state.body = body ?? '' },
  }
}

function fakeController() {
  const calls: Array<[string, unknown]> = []
  return {
    calls,
    state: () => ({ running: false, phase: 'idle', source: 'auto', target: 'zh', error: null }),
    async setSubtitle(patch: unknown) { calls.push(['setSubtitle', patch]) },
    async setSegment(patch: unknown) { calls.push(['setSegment', patch]) },
    async resetDefaults() { calls.push(['resetDefaults', undefined]) },
    prepareModel() { calls.push(['prepareModel', undefined]) },
    async start() { calls.push(['start', undefined]) },
    glossaryError: () => null,
  }
}

function deps(controller: ReturnType<typeof fakeController>) {
  return {
    controller: controller as never,
    settings: () => resolveConfig({}),
    sttStatus: () => '待机',
    persistence: () => true,
    log: () => {},
  }
}

test('注册 state/action 两个精确路由，并提供 disposer', () => {
  const webServer = fakeWebServer()
  const dispose = registerPanelRoutes(webServer as never, deps(fakeController()))
  assert.deepEqual([...webServer.routes.keys()].sort(), [PANEL_ACTION_PATH, PANEL_STATE_PATH].sort())
  assert.equal(webServer.routes.get(PANEL_STATE_PATH)?.kind, 'exact')
  assert.equal(webServer.routes.get(PANEL_STATE_PATH)?.auth, 'required')
  assert.equal(webServer.routes.get(PANEL_ACTION_PATH)?.auth, 'required')
  dispose()
  assert.equal(webServer.routes.size, 0)
})

test('GET state 返回面板快照；POST action 驱动控制器', async () => {
  const webServer = fakeWebServer()
  const controller = fakeController()
  registerPanelRoutes(webServer as never, deps(controller))

  const getRes = fakeRes()
  await webServer.routes.get(PANEL_STATE_PATH)!.handler({ method: 'GET', headers: {} } as never, getRes as never)
  assert.equal(getRes.state.status, 200)
  const stateBody = JSON.parse(getRes.state.body)
  assert.equal(stateBody.ok, true)
  assert.equal(stateBody.value.state.phase, 'idle')
  assert.equal(stateBody.value.subtitle.maxLines, 3)
  assert.equal(stateBody.value.segment.silenceMs, 550)
  assert.equal(stateBody.value.autoPauseAfterMs, 120000)
  assert.equal(stateBody.value.translate.background, '')
  assert.equal(stateBody.value.translate.backgroundBrief, '')
  assert.deepEqual(stateBody.value.translate.glossary, [])
  assert.equal(stateBody.value.translate.glossaryError, null)

  const postRes = fakeRes()
  const payload = { action: 'setSubtitle', value: { fontSize: 44 } }
  const req = {
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload), 'utf8') },
  }
  await webServer.routes.get(PANEL_ACTION_PATH)!.handler(req as never, postRes as never)
  assert.equal(postRes.state.status, 200)
  assert.deepEqual(controller.calls, [['setSubtitle', { fontSize: 44 }]])
})

test('POST action setSegment 驱动分段设置', async () => {
  const webServer = fakeWebServer()
  const controller = fakeController()
  registerPanelRoutes(webServer as never, deps(controller))
  const res = fakeRes()
  const payload = { action: 'setSegment', value: { silenceMs: 500 } }
  const req = {
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload), 'utf8') },
  }
  await webServer.routes.get(PANEL_ACTION_PATH)!.handler(req as never, res as never)
  assert.equal(res.state.status, 200)
  assert.deepEqual(controller.calls, [['setSegment', { silenceMs: 500 }]])
})

test('POST action resetDefaults 走面板白名单并驱动控制器', async () => {
  const webServer = fakeWebServer()
  const controller = fakeController()
  registerPanelRoutes(webServer as never, deps(controller))
  const res = fakeRes()
  const req = {
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"action":"resetDefaults"}', 'utf8') },
  }
  await webServer.routes.get(PANEL_ACTION_PATH)!.handler(req as never, res as never)
  assert.equal(res.state.status, 200)
  assert.deepEqual(controller.calls, [['resetDefaults', undefined]])
})

test('方法不对返回 405，非法动作返回 400', async () => {
  const webServer = fakeWebServer()
  registerPanelRoutes(webServer as never, deps(fakeController()))
  const wrongMethod = fakeRes()
  await webServer.routes.get(PANEL_ACTION_PATH)!.handler({ method: 'GET', headers: {} } as never, wrongMethod as never)
  assert.equal(wrongMethod.state.status, 405)
  assert.equal(wrongMethod.state.headers.allow, 'POST')

  const badRes = fakeRes()
  const badReq = {
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"action":"nope"}', 'utf8') },
  }
  await webServer.routes.get(PANEL_ACTION_PATH)!.handler(badReq as never, badRes as never)
  assert.equal(badRes.state.status, 400)
})

test('鉴权交给 webServer 的 required 准入，不再调用 connection.requestRejection', async () => {
  const webServer = fakeWebServer()
  registerPanelRoutes(webServer as never, deps(fakeController()))
  const state = webServer.routes.get(PANEL_STATE_PATH)!
  assert.equal(state.auth, 'required')
  // Regression: current DSH has no requestRejection on Connection. The handler
  // must answer on its own once the Web server admitted the request.
  const res = fakeRes()
  await state.handler({ method: 'GET', headers: {} } as never, res as never)
  assert.equal(res.state.status, 200)
})
