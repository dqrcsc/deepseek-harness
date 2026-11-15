# 网络隧道与智能分流

[English](network.md) | 中文

[VPN 隧道插件](../../packages/network/vpn-tunnel/README.zh.md)注册 `ctx.vpnTunnel`，提供纯 TypeScript 出站代理引擎与绑定在 `127.0.0.1` 上的混合 HTTP/CONNECT + SOCKS5 回环网关。它负责解析 Clash YAML 与 Base64/纯文本代理 URI 订阅、通过 HTTP `Date` 响应头校准服务器时钟偏移、在遭遇 `198.18.0.0/15` FakeIP 劫持时通过纯净 UDP DNS 查询真实代理节点 IP，并在 TCP、TLS、`simple-obfs` 或 WebSocket 传输层之上拨号 `ss2022`（含 SIP023 多 PSK EIH）、`ss`、`trojan`、`vless`、`vmess`、`socks5` 与 `http` 隧道。

候选节点选路按地区优先级梯队（如 `美国|新加坡`）与 EWMA 往返延迟对健康节点排序，当首选地区节点延迟超过 `maxPreferredLatencyMs` 时自动降级至更快的备选梯队，并通过指数退避熔断器隔离连续失败节点。本地与私有网段目标（`localhost`、RFC 1918、RFC 6598、IPv6 ULA/链路本地地址）始终直连绕过隧道，所有状态快照与错误报告均自动脱敏原始 URL、节点域名、IP 字面量与凭据密钥。

[网络代理控制器](../../packages/network/network-proxy/README.zh.md)注册 `ctx.networkProxy`（及 `ctx.remote.networkProxy`），在 `network` 存储域中持久化脱敏后的订阅元数据与 `direct`／`smart`／`global` 分流策略，并将机密订阅 URL 与 256 位 AES-256-GCM 节点缓存密钥保存在 `ctx.credentials` 中。它基于调用方 `TrafficContext` 流量归因安装动态 `undici` 代理路由器，在桌面端同步 Electron `<webview>` 会话代理规则，后台自动刷新订阅，执行并发连通性诊断，并在状态变更后发出 `network-proxy/changed`。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxnetworkproxy--networkproxyservice"></a>

### `ctx.networkProxy` — `NetworkProxyService`

Host-wide VPN subscription manager and smart-routing policy controller (`ctx.networkProxy`).

```ts cordis-catalog
/**
 * Return the loopback HTTP proxy URL (`http://127.0.0.1:<port>`) for Desktop Electron `<webview>` partitions,
 * or `null` when `direct` mode is active, `proxyBrowserGuests` is disabled, or no gateway is running.
 * @returns loopback proxy URL or `null`.
 */
browserGuestProxyUrl(): string | null

/**
 * Read the complete redacted status snapshot including subscriptions, node telemetry, and discoverable `.env` candidates.
 * @returns current {@link NetworkProxyStatus}.
 */
@Remote('status') async status(): Promise<NetworkProxyStatus>

/**
 * Switch outbound routing mode (`direct`, `smart`, or `global`) durably and start or stop the loopback gateway as needed.
 * @param request - target {@link NetworkProxyMode}.
 * @param signal - optional cancellation signal.
 * @returns updated {@link NetworkProxyStatus}.
 */
@Remote('setMode') async setMode(request: SetNetworkModeRequest, signal?: AbortSignal): Promise<NetworkProxyStatus>

/**
 * Update region-tier preferences, latency ceiling, subprocess/guest toggles, provider/capability overrides, or custom rules.
 * @param request - partial routing settings update.
 * @param signal - optional cancellation signal.
 * @returns updated {@link NetworkProxyStatus}.
 */
@Remote('updateRouting') async updateRouting(request: UpdateNetworkRoutingRequest, signal?: AbortSignal): Promise<NetworkProxyStatus>

/**
 * Add a VPN subscription URL, store its secret URL in `ctx.credentials`, fetch & encrypt-cache its nodes, and activate it.
 * @param request - display label, secret URL, optional enabled toggle, and optional auto-refresh interval.
 * @param signal - optional cancellation signal.
 * @returns refresh outcome and updated {@link NetworkProxyStatus}.
 */
@Remote('addSubscription') async addSubscription(request: AddSubscriptionRequest, signal?: AbortSignal): Promise<RefreshSubscriptionsResult>

/**
 * Update an existing subscription's name, URL, enabled state, or auto-refresh interval.
 * @param request - subscription ID and fields to revise.
 * @param signal - optional cancellation signal.
 * @returns updated {@link NetworkProxyStatus}.
 */
@Remote('updateSubscription') async updateSubscription(request: UpdateSubscriptionRequest, signal?: AbortSignal): Promise<NetworkProxyStatus>

/**
 * Remove a subscription, deleting its metadata row, `ctx.credentials` secret record, and encrypted cache file.
 * @param request - target subscription identifier.
 * @param signal - optional cancellation signal.
 * @returns removal flag and updated {@link NetworkProxyStatus}.
 */
@Remote('removeSubscription') async removeSubscription( request: RemoveSubscriptionRequest, signal?: AbortSignal, ): Promise<RemoveSubscriptionResult & { readonly status: NetworkProxyStatus }>

/**
 * Refresh one subscription (`request.id`) or all enabled subscriptions, updating encrypted caches and active nodes.
 * @param request - optional single subscription filter.
 * @param signal - optional cancellation signal.
 * @returns per-subscription outcomes and updated {@link NetworkProxyStatus}.
 */
@Remote('refreshSubscriptions') async refreshSubscriptions( request: RefreshSubscriptionsRequest, signal?: AbortSignal, ): Promise<RefreshSubscriptionsResult>

/**
 * Discover `SUB_VPN_*` and `VPN_SUB_*` URLs from `process.env`, `$DSH_HOME/.env`, and `~/.env`,
 * store new URLs in `ctx.credentials`, and fetch their initial node lists.
 * @param signal - optional cancellation signal.
 * @returns counts of imported/skipped candidates, fetch outcomes, and updated {@link NetworkProxyStatus}.
 */
@Remote('importEnvSubscriptions') async importEnvSubscriptions(signal?: AbortSignal): Promise<ImportEnvSubscriptionsResult>

/**
 * Pin traffic to `request.nodeId`, or pass `null` to restore automatic region-tier and latency selection.
 * @param request - target node identifier or `null`.
 * @param signal - optional cancellation signal.
 * @returns updated {@link NetworkProxyStatus}.
 */
@Remote('selectNode') async selectNode(request: SelectNetworkNodeRequest, signal?: AbortSignal): Promise<NetworkProxyStatus>

/**
 * Benchmark candidate or subscription-filtered proxy nodes through the pure-TypeScript tunnel engine.
 * @param request - optional subscription filter, custom probe URL, and node count limit.
 * @param signal - optional cancellation signal.
 * @returns node probe results and updated {@link NetworkProxyStatus}.
 */
@Remote('probeNodes') async probeNodes( request: ProbeNetworkNodesRequest, signal?: AbortSignal, ): Promise<ProbeNetworkNodesResult>

/**
 * Run concurrent end-to-end connectivity diagnostics across domestic and overseas endpoints using the active router.
 * @param signal - optional cancellation signal.
 * @returns structured {@link NetworkDiagnosticReport}.
 */
@Remote('runDiagnostics') async runDiagnostics(signal?: AbortSignal): Promise<NetworkDiagnosticReport>
```

Source: [`packages/network/network-proxy/src/index.ts`](../../packages/network/network-proxy/src/index.ts)

<a id="ctxvpntunnel--vpntunnelruntime"></a>

### `ctx.vpnTunnel` — `VpnTunnelRuntime`

Pure-TypeScript VPN tunnel runtime (`ctx.vpnTunnel`). Mounting opens no socket until ensureGateway, fetchSubscription, probeNodes, or probeUrl is called.

```ts cordis-catalog
/**
 * Return a redacted snapshot of the gateway endpoint, node health metrics, and active selection preferences.
 * @returns current {@link VpnTunnelStateSnapshot}.
 */
state(): VpnTunnelStateSnapshot

/**
 * Start the loopback HTTP/CONNECT + SOCKS5 gateway on `127.0.0.1` if not already running.
 * @returns bound loopback proxy endpoint.
 */
async ensureGateway(): Promise<VpnGatewayEndpoint>

/**
 * Stop the loopback gateway and close any in-flight tunnel streams.
 */
async stopGateway(): Promise<void>

/**
 * Replace the active parsed subscriptions, merging their proxy nodes and Clash routing rules.
 * @param subscriptions - active parsed subscription documents.
 */
setSubscriptions(subscriptions: readonly ParsedSubscription[]): void

/**
 * Update gateway mode, region-tier preferences, latency ceiling, or custom high-priority routing rules.
 * @param policy - partial routing policy fields to update.
 */
setRoutingPolicy(policy: VpnRoutingPolicyInput): void

/**
 * Pin traffic to `nodeId`, or pass `null` to restore automatic region-tier and latency selection.
 * @param nodeId - target node identifier, or `null` for automatic mode.
 */
selectNode(nodeId: VpnNodeId | null): void

/**
 * Evaluate the routing disposition (`proxy`, `direct`, or `reject`) for `host` under `mode`.
 * @param host - destination hostname or IP literal.
 * @param mode - routing mode (`direct`, `smart`, or `global`; defaults to the active gateway mode).
 * @returns computed {@link VpnRouteDecision}.
 */
decideRoute(host: string, mode: 'direct' | 'smart' | 'global' = this.gatewayMode): VpnRouteDecision

/**
 * Fetch and parse a remote VPN subscription URL directly (bypassing global proxy dispatchers and FakeIP DNS).
 * @param url - HTTP(S) subscription URL.
 * @param subscriptionId - nominal identifier assigned to parsed nodes.
 * @param signal - optional caller cancellation signal.
 * @returns validated {@link ParsedSubscription}.
 */
async fetchSubscription( url: string, subscriptionId: VpnSubscriptionId, signal?: AbortSignal, ): Promise<ParsedSubscription>

/**
 * Benchmark candidate or specified proxy nodes in bounded parallel batches and update node health metrics.
 * @param options - optional node ID filter, count limit, probe URL, concurrency, and deadline.
 * @returns per-node {@link VpnProbeResult} list in input/candidate order.
 */
async probeNodes(options: ProbeNodesOptions = {}): Promise<VpnProbeResult[]>

/**
 * Probe `targetUrl` through an explicit `nodeId` or the currently highest-ranked proxy node.
 * @param targetUrl - HTTP(S) URL to request through the tunnel.
 * @param options - optional node ID, deadline, and cancellation signal.
 * @returns redacted {@link VpnProbeResult}.
 */
async probeUrl(targetUrl: string, options: ProbeUrlOptions = {}): Promise<VpnProbeResult>

/**
 * Parse raw Clash YAML or Base64/plain URI subscription content offline.
 * @param text - raw subscription payload text.
 * @param options - subscription ID, optional quota header, and server Date header.
 * @returns validated {@link ParsedSubscription}.
 */
parseSubscription(text: string, options: ParseSubscriptionOptions): ParsedSubscription

/**
 * Discover `SUB_VPN_*` and `VPN_SUB_*` candidate URLs across `env` and `.env` file layers.
 * @param env - process environment record.
 * @param fileLayers - ordered `.env` file contents (`dsh-env` and `user-env`).
 * @returns deduplicated {@link EnvSubscriptionCandidate} list.
 */
discoverEnvSubscriptions( env: Readonly<Record<string, string | undefined>>, fileLayers: readonly { readonly source: 'dsh-env' | 'user-env'; readonly content: string }[] = [], ): EnvSubscriptionCandidate[]

/**
 * Mask path and query tokens in a subscription URL for display (`https://host/***`).
 * @param url - raw subscription URL.
 * @returns masked display URL.
 */
maskUrl(url: string): string

/**
 * Redact URLs, hostnames, IP literals, and credentials from an error or message.
 * @param err - thrown error or diagnostic value.
 * @returns redacted single-line summary.
 */
redactError(err: unknown): string

/**
 * Brand a raw identifier as a {@link VpnSubscriptionId}.
 * @param raw - non-empty subscription identifier string.
 * @returns branded {@link VpnSubscriptionId}.
 */
subscriptionId(raw: string): VpnSubscriptionId

/**
 * Brand a raw identifier as a {@link VpnNodeId}.
 * @param raw - non-empty node identifier string.
 * @returns branded {@link VpnNodeId}.
 */
nodeId(raw: string): VpnNodeId

/**
 * Parse a single Clash-style routing rule line (`DOMAIN-SUFFIX,openai.com,PROXY`).
 * @param line - rule line text.
 * @returns parsed {@link RoutingRule}, or `null` when blank, comment, or unsupported.
 */
parseRuleLine(line: string): RoutingRule | null
```

Source: [`packages/network/vpn-tunnel/src/index.ts`](../../packages/network/vpn-tunnel/src/index.ts)

<a id="network-proxy-events"></a>

### `network-proxy/*` events

<a id="network-proxychanged--emit"></a>

#### `network-proxy/changed` — emit

Network proxy mode, subscriptions, routing preferences, selected node, or gateway endpoint changed.

```ts cordis-catalog
/**
 * Network proxy mode, subscriptions, routing preferences, selected node, or gateway endpoint changed.
 * @mode emit
 */
'network-proxy/changed'(): void
```

Source: [`packages/network/network-proxy/src/types.ts`](../../packages/network/network-proxy/src/types.ts)
<!-- END GENERATED cordis-surface -->
