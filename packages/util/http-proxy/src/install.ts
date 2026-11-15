/**
 * Proxy installation: the transport half of this package. It owns undici's global dispatcher and the
 * process-wide record of which policy or dynamic router is active.
 *
 * `undici` is imported dynamically so the pure {@link ProxyPolicy} half stays loadable where no Node
 * transport exists, matching how `dsh-web-fetch-http` defers its own transport import.
 * @module @deepseek-ai/dsh-http-proxy/install
 */

import type { Dispatcher, Pool } from 'undici'
import { currentTrafficContext, type TrafficContext } from './context.ts'
import {
  isLoopbackHost,
  isSupportedProxyUrl,
  POLICY_ENV_NAMES,
  PROXY_ENV_NAMES,
  proxyForUrl,
  resolveProxyPolicy,
  withLoopback,
  type EnvLookup,
  type ProxyPolicy,
} from './policy.ts'

/** The active policy, or `undefined` until one is installed. Process-wide, like the dispatcher it tracks. */
let active: ProxyPolicy | undefined

/**
 * The proxy environment as the user exported it, or `undefined` when no policy is installed.
 *
 * Owned by the OUTERMOST install: one layered over the launcher's would otherwise record the outer
 * policy's published values as if the user had written them, and
 * hand every child a normalization the user never asked for.
 *
 * {@link proxyEnvironmentForChild} keeps a value the user set rather than the one this process resolved from
 * it, so a SOCKS proxy `curl` can use is not replaced by an HTTP proxy named for another scheme.
 */
let inheritedProxyEnv: Readonly<Record<string, string | undefined>> | undefined

/** The dispatcher installed with {@link active}, so a route can hand back the one already routing. */
let installed: Dispatcher | undefined

/**
 * Per-request routing decision returned by a dynamic proxy router.
 */
export type DynamicProxyDecision =
  | { readonly kind: 'fallback' }
  | { readonly kind: 'direct' }
  | { readonly kind: 'proxy'; readonly proxyUrl: string }

/**
 * Configuration for {@link installDynamicProxyRouter}.
 */
export interface DynamicProxyRouterSpec extends DispatcherOptions {
  /**
   * Decide synchronously how one non-loopback request should egress.
   * @param url - parsed request URL.
   * @param context - outbound traffic attribution bound on the current async call tree.
   * @returns `direct`, `proxy` (with an `http(s)://` proxy URL), or `fallback` (delegate to launch environment policy).
   */
  resolve(url: URL, context: TrafficContext | undefined): DynamicProxyDecision
  /**
   * Optional child-process HTTP(S) proxy URL supplier when subprocess proxying is enabled.
   * Returning `undefined` preserves the standard launch-environment child policy.
   * @returns an `http(s)://` proxy URL for child processes, or `undefined`.
   */
  childProxyUrl?(): string | undefined
}

/**
 * Live handle returned by {@link installDynamicProxyRouter}.
 */
export interface DynamicProxyRouterHandle {
  /**
   * Gracefully close and evict one pooled `ProxyAgent` when a loopback gateway port retires.
   * @param proxyUrl - exact proxy URL to evict from the pool.
   * @returns a promise that settles once the pooled agent finishes closing.
   */
  evictProxy(proxyUrl: string): Promise<void>
  /**
   * Uninstall the dynamic router, restore the previous dispatcher, and close owned agents.
   * @returns a promise that settles once owned dispatchers finish closing.
   */
  dispose(): Promise<void>
}

interface ActiveDynamicRouter {
  readonly dispatcher: Dispatcher
  readonly spec: DynamicProxyRouterSpec
  resolveProxyUrl(url: URL, context: TrafficContext | undefined): string | undefined
  previousDispatcher: Dispatcher
  previousDynamic: ActiveDynamicRouter | undefined
  disposed: boolean
}

function unwindDisposedDynamic(
  savedDispatcher: Dispatcher,
  savedDynamic: ActiveDynamicRouter | undefined,
): { dispatcher: Dispatcher; dynamic: ActiveDynamicRouter | undefined } {
  let dispatcher = savedDispatcher
  let dynamic = savedDynamic
  while (dynamic?.disposed === true) {
    dispatcher = dynamic.previousDispatcher
    dynamic = dynamic.previousDynamic
  }
  return { dispatcher, dynamic }
}

/** Process-wide dynamic router layered over {@link active}, when mounted. */
let dynamicRouter: ActiveDynamicRouter | undefined

/**
 * How this process must send one request.
 *
 * A caller that branches on the answer needs the transport that answer assumed, or an install or
 * disposal landing between the two would send the request somewhere the branch did not clear. The
 * proxied arm therefore carries the dispatcher already routing by this policy: it is process-wide
 * and long-lived, so a caller uses it and never closes it. Disposal closes that dispatcher rather
 * than destroying it, so a request already dispatched when a policy is unmounted still finishes.
 */
export type ProxyRoute =
  | { readonly proxied: true; readonly proxy: string; readonly dispatcher: Dispatcher }
  | { readonly proxied: false }

/** A route that sends nothing through a proxy, shared because it carries no per-request state. */
const DIRECT_ROUTE: ProxyRoute = { proxied: false }

/** Optional dispatcher transport choices shared by global installation and per-request construction. */
export interface DispatcherOptions {
  /**
   * Whether the dispatcher may negotiate HTTP/2. Unset keeps undici's own default; pass `false`
   * for a caller that cannot tolerate an idle h2 session's informational `UND_ERR_INFO` error.
   */
  readonly allowH2?: boolean
}

/**
 * Translate the optional policy into undici's Agent option, preserving its own default when unset.
 * @param options - dispatcher choices.
 * @returns the allowH2 fragment to spread into every Agent and ProxyAgent.
 */
function h2Options(options: DispatcherOptions): { readonly allowH2?: boolean } {
  return options.allowH2 === undefined ? {} : { allowH2: options.allowH2 }
}

/**
 * Resolve the effective proxy URL for one request under a dynamic router specification and the
 * underlying environment policy.
 */
function evaluateDynamicProxyUrl(
  spec: DynamicProxyRouterSpec,
  fallbackPolicy: ProxyPolicy | undefined,
  url: URL,
  context: TrafficContext | undefined,
): string | undefined {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (isLoopbackHost(url.hostname)) return undefined
  if (context?.bypassProxy === true) return undefined
  const decision = spec.resolve(url, context)
  switch (decision.kind) {
    case 'direct':
      return undefined
    case 'proxy':
      return isSupportedProxyUrl(decision.proxyUrl) ? decision.proxyUrl : undefined
    case 'fallback':
      return fallbackPolicy === undefined ? undefined : proxyForUrl(fallbackPolicy, url)
  }
}

/**
 * Parse undici `DispatchOptions` origin and path into a `URL` for routing evaluation.
 */
function parseDispatchUrl(origin: Dispatcher.DispatchOptions['origin'], path: string): URL | undefined {
  if (origin === undefined) return undefined
  const base = typeof origin === 'string' ? origin : origin.toString()
  const relativePath = path.startsWith('/') ? path : '/'
  return URL.parse(relativePath, base) ?? undefined
}

/**
 * Decide how to send one request, and hand back the transport that decision assumed.
 *
 * @param url - the request URL.
 * @returns the proxied route with its proxy URL and dispatcher, or the direct route.
 */
export function proxyRouteFor(url: URL): ProxyRoute {
  const dynamic = dynamicRouter
  if (dynamic !== undefined) {
    const proxy = dynamic.resolveProxyUrl(url, currentTrafficContext())
    return proxy === undefined ? DIRECT_ROUTE : { proxied: true, proxy, dispatcher: dynamic.dispatcher }
  }
  const policy = active
  const dispatcher = installed
  if (policy === undefined || dispatcher === undefined) return DIRECT_ROUTE
  const proxy = proxyForUrl(policy, url)
  return proxy === undefined ? DIRECT_ROUTE : { proxied: true, proxy, dispatcher }
}

/**
 * Publish a policy through the proxy environment variables, which is how the consumers that read an
 * environment rather than a policy object — `node:http`'s `proxyEnv` and every spawned child — see
 * the one resolved answer, including the `ALL_PROXY` fallback and the merged loopback bypass that
 * neither derives on its own. The global dispatcher does not read these; it routes by the policy.
 *
 * @param policy - the policy to publish.
 * @returns a function restoring every name this call changed.
 */
function applyPolicyEnv(policy: ProxyPolicy): () => void {
  const previousInherited = inheritedProxyEnv
  inheritedProxyEnv = previousInherited ?? snapshotProxyEnv()
  const published: Record<string, string | undefined> = {}
  for (const [field, names] of Object.entries(POLICY_ENV_NAMES)) {
    const value = policy[field as keyof typeof POLICY_ENV_NAMES]
    for (const name of names) published[name] = value
  }
  const restore = writeProxyEnv(published)
  return () => {
    restore()
    inheritedProxyEnv = previousInherited
  }
}

/**
 * Read every proxy name this package publishes, as `process.env` holds it now.
 *
 * @returns one entry per name in {@link POLICY_ENV_NAMES}; `undefined` marks an absent name.
 */
function snapshotProxyEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {}
  for (const names of Object.values(POLICY_ENV_NAMES)) {
    for (const name of names) snapshot[name] = process.env[name]
  }
  return snapshot
}

/**
 * Set every proxy name to the value `values` holds for it, removing a name whose value is `undefined`.
 *
 * @param values - the value each name in {@link POLICY_ENV_NAMES} should hold.
 * @returns a function restoring every name to what it held before this call.
 */
function writeProxyEnv(values: Readonly<Record<string, string | undefined>>): () => void {
  // Snapshot EVERY name before writing any of them. Windows folds environment names case-insensitively,
  // so reading the uppercase spelling after writing the lowercase one would read back the value just
  // written and restore the policy instead of the user's environment.
  const previous = snapshotProxyEnv()
  for (const name of Object.keys(previous)) {
    const value = values[name]
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  }
}

/**
 * Build the global dispatcher for one static policy.
 *
 * @param policy - the policy to route by; it must proxy at least one scheme.
 * @param options - optional dispatcher overrides; `allowH2` unset keeps undici's own default.
 * @returns the dispatcher to install, owning every per-origin agent its factory created.
 */
async function createPolicyDispatcher(policy: ProxyPolicy, options: DispatcherOptions = {}): Promise<Dispatcher> {
  const { Agent, Pool, ProxyAgent } = await import('undici')
  const h2 = h2Options(options)
  return new Agent({
    ...h2,
    factory(origin, passedOptions) {
      const passed = passedOptions as Pool.Options
      const proxy = proxyForUrl(policy, new URL(origin.toString()))
      if (proxy !== undefined) return new ProxyAgent({ ...passed, uri: proxy, ...h2 })
      return new Pool(origin, { ...passed, ...h2 })
    },
  })
}

/**
 * Build a hot-swappable `Dispatcher` that evaluates {@link DynamicProxyRouterSpec.resolve} on every
 * request against the current {@link TrafficContext} and pools one `ProxyAgent` per upstream proxy URL.
 */
async function createDynamicDispatcher(
  spec: DynamicProxyRouterSpec,
  fallbackPolicyReader: () => ProxyPolicy | undefined,
): Promise<{
  dispatcher: Dispatcher
  evictProxy: (proxyUrl: string) => Promise<void>
  resolveProxyUrl: (url: URL, context: TrafficContext | undefined) => string | undefined
}> {
  const { Agent, Dispatcher: UndiciDispatcher, ProxyAgent } = await import('undici')
  const h2 = h2Options(spec)
  const directAgent = new Agent(h2)
  const proxyAgents = new Map<string, Dispatcher>()

  const proxyAgentFor = (proxyUrl: string): Dispatcher => {
    const existing = proxyAgents.get(proxyUrl)
    if (existing !== undefined) return existing
    const created = new ProxyAgent({ uri: proxyUrl, ...h2 })
    proxyAgents.set(proxyUrl, created)
    return created
  }

  const resolveProxyUrl = (url: URL, context: TrafficContext | undefined): string | undefined =>
    evaluateDynamicProxyUrl(spec, fallbackPolicyReader(), url, context)

  const closeAll = async (): Promise<void> => {
    const agents = [...proxyAgents.values()]
    proxyAgents.clear()
    await Promise.all([directAgent.close(), ...agents.map(agent => agent.close())])
  }

  const destroyAll = async (err: Error | null): Promise<void> => {
    const agents = [...proxyAgents.values()]
    proxyAgents.clear()
    await Promise.all([
      err === null ? directAgent.destroy() : directAgent.destroy(err),
      ...agents.map(agent => (err === null ? agent.destroy() : agent.destroy(err))),
    ])
  }

  class DynamicDispatcher extends UndiciDispatcher {
    override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      const url = parseDispatchUrl(options.origin, options.path)
      if (url === undefined) return directAgent.dispatch(options, handler)
      const proxyUrl = resolveProxyUrl(url, currentTrafficContext())
      const target = proxyUrl === undefined ? directAgent : proxyAgentFor(proxyUrl)
      return target.dispatch(options, handler)
    }

    override close(): Promise<void>
    override close(callback: () => void): void
    override close(callback?: () => void): Promise<void> | void {
      const task = closeAll()
      if (callback !== undefined) {
        void task.then(() => { callback() })
        return
      }
      return task
    }

    override destroy(err?: Error | null): Promise<void>
    override destroy(callback: () => void): void
    override destroy(err: Error | null, callback: () => void): void
    override destroy(errOrCallback?: Error | null | (() => void), maybeCallback?: () => void): Promise<void> | void {
      const callback = typeof errOrCallback === 'function' ? errOrCallback : maybeCallback
      const err = typeof errOrCallback === 'function' || errOrCallback === undefined ? null : errOrCallback
      const task = destroyAll(err)
      if (callback !== undefined) {
        void task.then(() => { callback() })
        return
      }
      return task
    }
  }

  const evictProxy = async (proxyUrl: string): Promise<void> => {
    const existing = proxyAgents.get(proxyUrl)
    if (existing === undefined) return
    proxyAgents.delete(proxyUrl)
    await existing.close()
  }

  return { dispatcher: new DynamicDispatcher(), evictProxy, resolveProxyUrl }
}

/**
 * Install a hot-swappable dynamic proxy router as undici's global dispatcher.
 *
 * Requests whose resolver returns `{ kind: 'fallback' }` continue honoring any outer policy
 * installed via {@link installProxyFromEnvironment}. Disposing the handle restores the previous
 * dispatcher and closes every pooled `ProxyAgent` after in-flight requests settle.
 *
 * @param spec - synchronous per-request route resolver and optional child-process proxy supplier.
 * @returns a handle supporting graceful proxy-pool eviction and full teardown.
 */
export async function installDynamicProxyRouter(spec: DynamicProxyRouterSpec): Promise<DynamicProxyRouterHandle> {
  const { getGlobalDispatcher, setGlobalDispatcher } = await import('undici')
  const { dispatcher, evictProxy, resolveProxyUrl } = await createDynamicDispatcher(spec, () => active)
  const entry: ActiveDynamicRouter = {
    dispatcher,
    spec,
    resolveProxyUrl,
    previousDispatcher: getGlobalDispatcher(),
    previousDynamic: dynamicRouter,
    disposed: false,
  }
  dynamicRouter = entry
  setGlobalDispatcher(dispatcher)
  return {
    evictProxy,
    async dispose(): Promise<void> {
      if (entry.disposed) return
      entry.disposed = true
      if (dynamicRouter === entry) {
        dynamicRouter = entry.previousDynamic
        setGlobalDispatcher(entry.previousDispatcher)
      } else {
        for (let cursor = dynamicRouter; cursor !== undefined; cursor = cursor.previousDynamic) {
          if (cursor.previousDynamic === entry) {
            cursor.previousDynamic = entry.previousDynamic
            cursor.previousDispatcher = entry.previousDispatcher
            break
          }
        }
      }
      await dispatcher.close()
    },
  }
}

/**
 * Route this process's outbound HTTP through `policy`.
 *
 * @param policy - the resolved policy to install.
 * @param options - optional dispatcher overrides; `allowH2` unset keeps undici's own default.
 * @returns a disposer restoring the previous dispatcher, policy, and environment, then closing the agent.
 */
async function installGlobalProxy(policy: ProxyPolicy, options: DispatcherOptions = {}): Promise<() => Promise<void>> {
  const previousPolicy = active
  const previousDynamic = dynamicRouter
  if (policy.source === 'none') {
    if (previousPolicy === undefined && previousDynamic === undefined) {
      active = policy
      return () => {
        active = previousPolicy
        return Promise.resolve()
      }
    }
    const previousInstalled = installed
    const restoreEnv = inheritedProxyEnv === undefined ? undefined : writeProxyEnv(inheritedProxyEnv)
    const undici = await import('undici')
    const previous = undici.getGlobalDispatcher()
    const direct = new undici.Agent(h2Options(options))
    undici.setGlobalDispatcher(direct)
    active = policy
    installed = undefined
    dynamicRouter = undefined
    return async () => {
      const unwound = unwindDisposedDynamic(previous, previousDynamic)
      undici.setGlobalDispatcher(unwound.dispatcher)
      active = previousPolicy
      installed = previousInstalled
      dynamicRouter = unwound.dynamic
      restoreEnv?.()
      await direct.close()
    }
  }
  const restoreEnv = applyPolicyEnv(policy)
  const { getGlobalDispatcher, setGlobalDispatcher } = await import('undici')
  const previousDispatcher = getGlobalDispatcher()
  const previousInstalled = installed
  const agent = await createPolicyDispatcher(policy, options)
  setGlobalDispatcher(agent)
  active = policy
  installed = agent
  dynamicRouter = undefined
  return async () => {
    const unwound = unwindDisposedDynamic(previousDispatcher, previousDynamic)
    setGlobalDispatcher(unwound.dispatcher)
    active = previousPolicy
    installed = previousInstalled
    dynamicRouter = unwound.dynamic
    restoreEnv()
    await agent.close()
  }
}

/**
 * The proxy environment a spawned child needs.
 *
 * When an active dynamic router supplies a `childProxyUrl()`, spawned tool subprocesses receive
 * that loopback gateway URL together with `NODE_USE_ENV_PROXY=1` and the loopback-merged `NO_PROXY`.
 * Otherwise the child inherits the user's own launch-environment proxy variables and resolved bypass list.
 *
 * @returns names to apply to the child environment, where `undefined` means remove, or an empty
 *   object when no proxy is active.
 */
export function proxyEnvironmentForChild(): Readonly<Record<string, string | undefined>> {
  const dynamicChildProxy = dynamicRouter?.spec.childProxyUrl?.()
  if (dynamicChildProxy !== undefined && isSupportedProxyUrl(dynamicChildProxy)) {
    const rawNoProxy = inheritedProxyEnv?.no_proxy
      ?? inheritedProxyEnv?.NO_PROXY
      ?? process.env.no_proxy
      ?? process.env.NO_PROXY
    const noProxy = withLoopback(rawNoProxy)
    return {
      NODE_USE_ENV_PROXY: '1',
      http_proxy: dynamicChildProxy,
      HTTP_PROXY: dynamicChildProxy,
      https_proxy: dynamicChildProxy,
      HTTPS_PROXY: dynamicChildProxy,
      all_proxy: dynamicChildProxy,
      ALL_PROXY: dynamicChildProxy,
      no_proxy: noProxy,
      NO_PROXY: noProxy,
    }
  }
  const policy = active
  const inherited = inheritedProxyEnv
  if (policy === undefined || policy.source === 'none' || inherited === undefined) return {}
  const overlay: Record<string, string | undefined> = { NODE_USE_ENV_PROXY: '1' }
  for (const [field, names] of Object.entries(POLICY_ENV_NAMES)) {
    const resolved = policy[field as keyof typeof POLICY_ENV_NAMES]
    const named = field !== 'noProxy' && names.some(name => inherited[name] !== undefined)
    for (const name of names) overlay[name] = named ? inherited[name] : resolved
  }
  const parsedByNode = [...POLICY_ENV_NAMES.httpProxy, ...POLICY_ENV_NAMES.httpsProxy]
  if (parsedByNode.some(name => overlay[name] !== undefined && !isSupportedProxyUrl(overlay[name]))) {
    delete overlay.NODE_USE_ENV_PROXY
  }
  return overlay
}

/**
 * Resolve this process's proxy policy from `env` and install it.
 *
 * @param env - the launch environment, whose own layering already prefers real variables over `.env` files.
 * @param report - receives one message per rejected value, in the order the values were considered.
 * @param options - optional dispatcher overrides; `allowH2` unset keeps undici's own default.
 * @returns a disposer restoring the previous dispatcher, policy, and environment.
 */
export async function installProxyFromEnvironment(
  env: EnvLookup,
  report: (message: string) => void,
  options: DispatcherOptions = {},
): Promise<() => Promise<void>> {
  const { policy, diagnostics } = resolveProxyPolicy(env)
  for (const diagnostic of diagnostics) report(diagnostic.message)
  return await installGlobalProxy(policy, options)
}

/**
 * Build a dispatcher for callers that need their own transport choices without replacing the
 * process-wide dispatcher. When a dynamic proxy router is active, the returned dispatcher honors
 * live routing changes under the caller's `options`; otherwise it routes by `env`'s static policy.
 *
 * @param env - the launch environment the fallback policy resolves from.
 * @param options - optional dispatcher overrides; `allowH2: false` pins the transport to HTTP/1.1.
 * @returns a dispatcher the caller closes.
 */
export async function createRouteDispatcher(
  env: EnvLookup,
  options: DispatcherOptions = {},
): Promise<Dispatcher> {
  const { policy } = resolveProxyPolicy(env)
  const currentDynamic = dynamicRouter
  if (currentDynamic !== undefined) {
    const { dispatcher } = await createDynamicDispatcher(
      { ...currentDynamic.spec, ...options },
      () => (policy.source === 'none' ? undefined : policy),
    )
    return dispatcher
  }
  const dispatcher = policy.source === 'none'
    ? await (async () => {
      const { Agent } = await import('undici')
      return new Agent(h2Options(options))
    })()
    : await createPolicyDispatcher(policy, options)
  return dispatcher
}

/**
 * The environment overlay that removes every proxy name from a spawned child.
 *
 * @returns one entry per proxy name, each `undefined`.
 */
export function clearedProxyEnv(): Record<string, undefined> {
  return Object.fromEntries(PROXY_ENV_NAMES.map(name => [name, undefined]))
}
