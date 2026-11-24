import assert from 'node:assert/strict'
import test from 'node:test'
import { PANEL_ACTION_PATH, PANEL_STATE_PATH, registerPanelRoutes } from '../src/panel.ts'
import { resolveConfig } from '../src/config.ts'

function fakeWebServer() {
  const routes = new Map<string, { kind: string; path: string; handler: (req: never, res: never) => unknown }>()
  return {
    routes,
    register(route: { kind: string; path: string; handler: (req: never, res: never) => unknown }) {
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
    prepareModel() { calls.push(['prepareModel', undefined]) },
    async start() { calls.push(['start', undefined]) },
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

const authorized = { requestRejection: () => undefined as 401 | 403 | undefined }

test('注册 state/action 两个精确路由，并提供 disposer', () => {
  const webServer = fakeWebServer()
  const dispose = registerPanelRoutes(webServer as never, () => authorized, deps(fakeController()))
  assert.deepEqual([...webServer.routes.keys()].sort(), [PANEL_ACTION_PATH, PANEL_STATE_PATH].sort())
  assert.equal(webServer.routes.get(PANEL_STATE_PATH)?.kind, 'exact')
  dispose()
  assert.equal(webServer.routes.size, 0)
})

test('GET state 返回面板快照；POST action 驱动控制器', async () => {
  const webServer = fakeWebServer()
  const controller = fakeController()
  registerPanelRoutes(webServer as never, () => authorized, deps(controller))

  const getRes = fakeRes()
  await webServer.routes.get(PANEL_STATE_PATH)!.handler({ method: 'GET', headers: {} } as never, getRes as never)
  assert.equal(getRes.state.status, 200)
  const stateBody = JSON.parse(getRes.state.body)
  assert.equal(stateBody.ok, true)
  assert.equal(stateBody.value.state.phase, 'idle')
  assert.equal(stateBody.value.subtitle.maxLines, 3)
  assert.equal(stateBody.value.segment.silenceMs, 280)
  assert.equal(stateBody.value.autoPauseAfterMs, 120000)

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
  registerPanelRoutes(webServer as never, () => authorized, deps(controller))
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

test('未授权返回 401，方法不对返回 405，非法动作返回 400', async () => {
  const webServer = fakeWebServer()
  registerPanelRoutes(webServer as never, () => ({ requestRejection: () => 401 as const }), deps(fakeController()))
  const denied = fakeRes()
  await webServer.routes.get(PANEL_STATE_PATH)!.handler({ method: 'GET', headers: {} } as never, denied as never)
  assert.equal(denied.state.status, 401)

  const authorizedServer = fakeWebServer()
  registerPanelRoutes(authorizedServer as never, () => authorized, deps(fakeController()))
  const wrongMethod = fakeRes()
  await authorizedServer.routes.get(PANEL_ACTION_PATH)!.handler({ method: 'GET', headers: {} } as never, wrongMethod as never)
  assert.equal(wrongMethod.state.status, 405)
  assert.equal(wrongMethod.state.headers.allow, 'POST')

  const badRes = fakeRes()
  const badReq = {
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"action":"nope"}', 'utf8') },
  }
  await authorizedServer.routes.get(PANEL_ACTION_PATH)!.handler(badReq as never, badRes as never)
  assert.equal(badRes.state.status, 400)
})
