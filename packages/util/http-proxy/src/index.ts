/**
 * Outbound HTTP proxy support for DeepSeek Harness.
 *
 * Node's built-in `fetch` ignores `HTTP_PROXY` and friends, so every harness request would connect
 * directly no matter what the user exported. The launcher resolves one policy from the launch
 * environment and installs it as undici's global dispatcher, while {@link installDynamicProxyRouter}
 * layers atomic hot-swappable split-tunneling and {@link TrafficContext} attribution on top of it
 * without restarting the process.
 * @module @deepseek-ai/dsh-http-proxy
 */

export {
  currentTrafficContext,
  runWithTrafficContext,
  streamWithTrafficContext,
  type TrafficCategory,
  type TrafficContext,
} from './context.ts'
export {
  clearedProxyEnv,
  createRouteDispatcher,
  installDynamicProxyRouter,
  installProxyFromEnvironment,
  proxyEnvironmentForChild,
  proxyRouteFor,
  type DispatcherOptions,
  type DynamicProxyDecision,
  type DynamicProxyRouterHandle,
  type DynamicProxyRouterSpec,
  type ProxyRoute,
} from './install.ts'
export {
  isLoopbackHost,
  isPrivateNetworkHost,
} from './policy.ts'
