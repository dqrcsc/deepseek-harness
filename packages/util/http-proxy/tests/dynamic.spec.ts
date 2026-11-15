import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getGlobalDispatcher, type Dispatcher } from 'undici'
import {
  createRouteDispatcher,
  installDynamicProxyRouter,
  installProxyFromEnvironment,
  proxyEnvironmentForChild,
  proxyRouteFor,
  runWithTrafficContext,
  type DynamicProxyDecision,
  type TrafficContext,
} from '../src/index.ts'
import { PROXY_ENV_NAMES } from '../src/policy.ts'

let proxyAHits: string[] = []
let proxyBHits: string[] = []
let envProxyHits: string[] = []
let proxyA: Server
let proxyB: Server
let envProxy: Server
let origin: Server
let proxyAUrl: string
let proxyBUrl: string
let envProxyUrl: string
let originUrl: string

function listen(server: Server): Promise<AddressInfo> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve(server.address() as AddressInfo) })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => { server.close(() => { resolve() }) })
}

function env(values: Record<string, string>): { get(name: string): { value: string } | undefined } {
  return { get: name => (name in values ? { value: values[name] as string } : undefined) }
}

beforeAll(async () => {
  proxyA = createServer((req, res) => {
    proxyAHits.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('VIA-A')
  })
  proxyB = createServer((req, res) => {
    proxyBHits.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('VIA-B')
  })
  envProxy = createServer((req, res) => {
    envProxyHits.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('VIA-ENV')
  })
  origin = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('DIRECT-LOOPBACK')
  })
  const [addrA, addrB, addrEnv, addrOrigin] = await Promise.all([
    listen(proxyA),
    listen(proxyB),
    listen(envProxy),
    listen(origin),
  ])
  proxyAUrl = `http://127.0.0.1:${String(addrA.port)}`
  proxyBUrl = `http://127.0.0.1:${String(addrB.port)}`
  envProxyUrl = `http://127.0.0.1:${String(addrEnv.port)}`
  originUrl = `http://127.0.0.1:${String(addrOrigin.port)}/ping`
})

afterAll(async () => {
  await Promise.all([close(proxyA), close(proxyB), close(envProxy), close(origin)])
})

afterEach(() => {
  proxyAHits = []
  proxyBHits = []
  envProxyHits = []
})

describe('installDynamicProxyRouter', () => {
  it('hot-swaps routing decisions per URL and TrafficContext without restarting, and always bypasses loopback', async () => {
    let activeProxy = proxyAUrl
    const router = await installDynamicProxyRouter({
      resolve(url: URL, context: TrafficContext | undefined): DynamicProxyDecision {
        if (context?.providerId === 'deepseek') return { kind: 'direct' }
        if (context?.providerId === 'openai') return { kind: 'proxy', proxyUrl: activeProxy }
        if (url.hostname === 'unsupported-scheme.test') return { kind: 'proxy', proxyUrl: 'socks5://127.0.0.1:1080' }
        if (url.hostname === 'fallback.test') return { kind: 'fallback' }
        return { kind: 'proxy', proxyUrl: activeProxy }
      },
    })

    try {
      // Loopback is bypassed before resolver runs.
      expect(await (await fetch(originUrl)).text()).toBe('DIRECT-LOOPBACK')
      expect(proxyRouteFor(new URL(originUrl))).toEqual({ proxied: false })
      // Non-http(s) scheme is never routed through HTTP proxy.
      expect(proxyRouteFor(new URL('ws://openai.test/realtime'))).toEqual({ proxied: false })
      // Unsupported proxy URL falls back to direct.
      expect(proxyRouteFor(new URL('http://unsupported-scheme.test/x'))).toEqual({ proxied: false })
      // Fallback with no outer env policy stays direct.
      expect(proxyRouteFor(new URL('http://fallback.test/x'))).toEqual({ proxied: false })

      // Tagged openai traffic routes via proxyA (twice to exercise pooled ProxyAgent hit).
      await runWithTrafficContext({ category: 'llm', providerId: 'openai' }, async () => {
        expect(await (await fetch('http://api.openai.test/v1/models')).text()).toBe('VIA-A')
        expect(await (await fetch('http://api.openai.test/v1/chat')).text()).toBe('VIA-A')
        const route = proxyRouteFor(new URL('http://api.openai.test/v1/chat'))
        expect(route).toMatchObject({ proxied: true, proxy: proxyAUrl })
      })

      // Hot-swap activeProxy to proxyB and evict proxyA (and a non-existent URL no-op).
      activeProxy = proxyBUrl
      await router.evictProxy('http://127.0.0.1:1')
      await router.evictProxy(proxyAUrl)

      await runWithTrafficContext({ category: 'llm', providerId: 'openai' }, async () => {
        expect(await (await fetch('http://api.openai.test/v1/models')).text()).toBe('VIA-B')
      })

      // bypassProxy flag forces direct even when resolver would return proxy.
      await runWithTrafficContext({ category: 'diagnostics', providerId: 'openai', bypassProxy: true }, async () => {
        expect(proxyRouteFor(new URL('http://api.openai.test/v1/models'))).toEqual({ proxied: false })
      })

      // Direct provider route stays direct.
      await runWithTrafficContext({ category: 'llm', providerId: 'deepseek' }, async () => {
        expect(proxyRouteFor(new URL('http://api.deepseek.test/v1/chat'))).toEqual({ proxied: false })
      })

      expect(proxyAHits).toEqual([
        'GET http://api.openai.test/v1/models',
        'GET http://api.openai.test/v1/chat',
      ])
      expect(proxyBHits).toEqual(['GET http://api.openai.test/v1/models'])
    } finally {
      await router.dispose()
      // Idempotent second dispose.
      await router.dispose()
    }
  })

  it('delegates fallback decisions to an outer installProxyFromEnvironment policy and publishes childProxyUrl', async () => {
    const saved = Object.fromEntries(PROXY_ENV_NAMES.map(name => [name, process.env[name]]))
    for (const name of PROXY_ENV_NAMES) Reflect.deleteProperty(process.env, name)
    process.env.NO_PROXY = 'corp.internal'

    const disposeOuter = await installProxyFromEnvironment(
      env({ HTTP_PROXY: envProxyUrl, HTTPS_PROXY: envProxyUrl, NO_PROXY: 'corp.internal' }),
      () => undefined,
    )
    let childGate: string | undefined = proxyAUrl
    const router = await installDynamicProxyRouter({
      allowH2: false,
      resolve(url: URL): DynamicProxyDecision {
        if (url.hostname === 'via-vpn.test') return { kind: 'proxy', proxyUrl: proxyAUrl }
        return { kind: 'fallback' }
      },
      childProxyUrl: () => childGate,
    })

    try {
      expect(await (await fetch('http://via-vpn.test/hello')).text()).toBe('VIA-A')
      expect(await (await fetch('http://via-env.test/hello')).text()).toBe('VIA-ENV')

      const childEnv = proxyEnvironmentForChild()
      expect(childEnv.HTTP_PROXY).toBe(proxyAUrl)
      expect(childEnv.HTTPS_PROXY).toBe(proxyAUrl)
      expect(childEnv.ALL_PROXY).toBe(proxyAUrl)
      expect(childEnv.NODE_USE_ENV_PROXY).toBe('1')
      expect(childEnv.NO_PROXY).toContain('corp.internal')
      expect(childEnv.NO_PROXY).toContain('127.0.0.1')

      // When childProxyUrl returns undefined, falls back to outer environment child policy.
      childGate = undefined
      expect(proxyEnvironmentForChild().HTTP_PROXY).toBe(envProxyUrl)

      // createRouteDispatcher while dynamic router is active honors both env-backed and direct fallback.
      const undici = await import('undici')
      const customWithEnv = await createRouteDispatcher(env({ HTTP_PROXY: envProxyUrl }), { allowH2: false })
      const customWithoutEnv = await createRouteDispatcher(env({}), { allowH2: false })
      expect(await (await undici.fetch('http://via-env.test/hello', { dispatcher: customWithEnv })).text()).toBe('VIA-ENV')
      customWithoutEnv.dispatch(
        { origin: 'http://via-env.test', path: '/hello', method: 'GET' },
        {
          onRequestStart(controller) { controller.abort(new Error('abort-direct')) },
          onResponseStart() {},
          onResponseData() {},
          onResponseEnd() {},
          onResponseError() {},
        },
      )
      await customWithEnv.close()
      await customWithoutEnv.close()

      // Layering a direct installProxyFromEnvironment over an active dynamic router suspends and restores it.
      const suspend = await installProxyFromEnvironment(env({}), () => undefined)
      expect(proxyRouteFor(new URL('http://via-vpn.test/hello'))).toEqual({ proxied: false })
      await suspend()
      expect(proxyRouteFor(new URL('http://via-vpn.test/hello')).proxied).toBe(true)
    } finally {
      await router.dispose()
      await disposeOuter()
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
    }
  })

  it('handles out-of-order disposal, process.env NO_PROXY fallback, low-level dispatch edge cases, and callback close/destroy overloads', async () => {
    const savedNoProxy = process.env.no_proxy
    const savedUpperNoProxy = process.env.NO_PROXY
    Reflect.deleteProperty(process.env, 'no_proxy')
    process.env.NO_PROXY = 'intranet.local'

    const before = getGlobalDispatcher()
    const orphan = await installDynamicProxyRouter({
      resolve: () => ({ kind: 'direct' }),
    })
    const orphan2 = await installDynamicProxyRouter({
      resolve: () => ({ kind: 'direct' }),
    })
    const suspendForOrphan = await installProxyFromEnvironment(env({}), () => undefined)
    // Disposing while suspended (dynamicRouter === undefined) walks zero entries cleanly.
    await orphan2.dispose()
    // Disposing an unlinked router while a fresh stack is active walks the stack to exhaustion cleanly.
    const nested = await installDynamicProxyRouter({ resolve: () => ({ kind: 'direct' }) })
    await orphan.dispose()
    await nested.dispose()
    await suspendForOrphan()
    expect(getGlobalDispatcher()).toBe(before)

    const first = await installDynamicProxyRouter({
      resolve: () => ({ kind: 'direct' }),
      childProxyUrl: () => proxyAUrl,
    })
    const middle = await installDynamicProxyRouter({
      resolve: () => ({ kind: 'direct' }),
    })
    const second = await installDynamicProxyRouter({
      resolve: () => ({ kind: 'proxy', proxyUrl: proxyBUrl }),
      childProxyUrl: () => proxyBUrl,
    })

    try {
      expect(proxyEnvironmentForChild().NO_PROXY).toContain('intranet.local')
      Reflect.deleteProperty(process.env, 'NO_PROXY')
      expect(proxyEnvironmentForChild().NO_PROXY).toBe('localhost,127.0.0.1,::1,[::1]')

      // Exercise low-level dispatch origin/path shapes: undefined origin, unparseable origin, URL origin, and non-slash path.
      const current = getGlobalDispatcher()
      const captureDispatchOutcome = (opts: Dispatcher.DispatchOptions): Promise<'end' | 'error' | 'threw'> =>
        new Promise((resolve) => {
          try {
            current.dispatch(opts, {
              onRequestStart() {},
              onResponseStart() {},
              onResponseData() {},
              onResponseEnd() { resolve('end') },
              onResponseError() { resolve('error') },
            })
          } catch {
            resolve('threw')
          }
        })
      expect(await captureDispatchOutcome({ path: '/x', method: 'GET' })).not.toBe('end')
      expect(await captureDispatchOutcome({ origin: 'not a valid url', path: 'relative', method: 'GET' })).not.toBe('end')
      const originParsed = new URL(originUrl)
      expect(await captureDispatchOutcome({ origin: originParsed, path: 'relative-without-slash', method: 'GET' })).not.toBe('end')
      expect(await captureDispatchOutcome({ origin: new URL(originParsed.origin), path: '/ping', method: 'GET' })).toBe('end')

      // Disposing first and middle out-of-order while second is top-of-stack splices links cleanly.
      await first.dispose()
      await middle.dispose()
      expect(proxyRouteFor(new URL('http://example.test/')).proxied).toBe(true)
      await second.dispose()
      expect(getGlobalDispatcher()).toBe(before)
    } finally {
      await second.dispose()
      await middle.dispose()
      await first.dispose()
      if (savedNoProxy === undefined) Reflect.deleteProperty(process.env, 'no_proxy')
      else process.env.no_proxy = savedNoProxy
      if (savedUpperNoProxy === undefined) Reflect.deleteProperty(process.env, 'NO_PROXY')
      else process.env.NO_PROXY = savedUpperNoProxy
    }

    // Exercise callback close and all destroy overloads on createRouteDispatcher's DynamicDispatcher.
    const holder = await installDynamicProxyRouter({
      resolve: () => ({ kind: 'proxy', proxyUrl: proxyAUrl }),
    })
    try {
      const d1 = await createRouteDispatcher(env({}))
      // Trigger one proxyAgent creation before close(cb).
      const undici = await import('undici')
      await undici.fetch('http://via-d1.test/ok', { dispatcher: d1 })
      await new Promise<void>((resolve) => { d1.close(() => { resolve() }) })

      const d2 = await createRouteDispatcher(env({}))
      await undici.fetch('http://via-d2.test/ok', { dispatcher: d2 })
      await d2.destroy()

      const d3 = await createRouteDispatcher(env({}))
      await undici.fetch('http://via-d3.test/ok', { dispatcher: d3 })
      await d3.destroy(new Error('abort'))

      const d4 = await createRouteDispatcher(env({}))
      await new Promise<void>((resolve) => { d4.destroy(() => { resolve() }) })

      const d5 = await createRouteDispatcher(env({}))
      await new Promise<void>((resolve) => { d5.destroy(null, () => { resolve() }) })
    } finally {
      await holder.dispose()
    }
  })
})
