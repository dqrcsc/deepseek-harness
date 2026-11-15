---
description: "Host VPN subscription manager, smart-routing policy controller, encrypted subscription cache, and connectivity diagnostics service for the DeepSeek Harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-network-proxy

English | [中文](README.zh.md)

## Summary

Use `ctx.networkProxy` to manage VPN subscriptions, drive process-scoped `direct`, `smart`, and `global` routing over `ctx.vpnTunnel`, and run end-to-end connectivity diagnostics without external proxy binaries or operating-system proxy changes. Redacted subscription metadata and routing rules persist in the Host `network` storage domain under `$DSH_HOME/storages`, secret subscription URLs and the 256-bit cache key live in `ctx.credentials`, and parsed node payloads cache at rest in AES-256-GCM envelopes under `$DSH_HOME/cache/network-proxy`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@deepseek-ai/dsh-network-proxy` alongside `@deepseek-ai/dsh-vpn-tunnel`, `@deepseek-ai/dsh-storage-domain`, and `@deepseek-ai/dsh-credentials-local` to expose `ctx.networkProxy` to Host callers and `ctx.remote.networkProxy` to GUI clients.

### Configuration

```yaml
- id: network-proxy
  name: '@deepseek-ai/dsh-network-proxy'
  config:
    autoRefreshCheckIntervalMs: 60000
    diagnosticTimeoutMs: 8000
    defaultProbeLimit: 24
```

All fields have validated defaults. `dshHome` and `userEnvPath` override path discovery in isolated tests; `diagnosticTargets` replaces the default six-endpoint domestic and overseas diagnostic suite (`deepseek`, `openai`, `anthropic`, `gemini`, `github`, `google`).

### Routing modes, overrides, and credential separation

In `direct` mode, the loopback gateway stays stopped and outbound calls fall back to ambient `HTTP_PROXY` / `HTTPS_PROXY` environment variables. In `smart` mode, private/loopback addresses bypass the proxy, explicit per-provider (`providerOverrides`) and per-capability (`capabilityOverrides` for `web`, `mcp`, `plugin`, and `embedding`) overrides run first, user `customRules` and built-in domestic baseline rules (`deepseek.com`, `aliyuncs.com`, `volces.com`, `minimaxi.com`, `npmmirror.com`, `cn`) run next, and subscription Clash rules run last. In `global` mode, all non-private destinations route through the selected tunnel node unless matched by a user `DIRECT` or `REJECT` custom rule.

`importEnvSubscriptions` scans `process.env`, `$DSH_HOME/.env`, and `~/.env` for `SUB_VPN_*` and `VPN_SUB_*` entries, deduplicates them by SHA-256 URL digest, writes secret URLs only to `ctx.credentials` (`network-proxy/<id>`), and exposes only masked previews (`https://host/***`) and opaque node hashes over Remote RPC.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the internal structure; observable behavior is covered in [Use this package](#use-this-package).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `NetworkProxyService`, dynamic `undici` router hook, `llm/stream` attribution listener, auto-refresh loop, and `@Remote` methods |
| [`src/domain.ts`](src/domain.ts) | `NetworkProxyInputError`, domestic baseline rules, URL/rule validation, and `ctx.credentials` key constructors |
| [`src/storage.ts`](src/storage.ts) | Zod schemas and `networkDomain` (`subscriptions` table and global routing settings) |
| [`src/cache.ts`](src/cache.ts) | `EncryptedSubscriptionCache` storing parsed node lists in AES-256-GCM `0600` files with subscription-ID AAD |
| [`src/diagnostics.ts`](src/diagnostics.ts) | Concurrent domestic and overseas HTTP reachability runner with redacted error reporting |
| [`src/types.ts`](src/types.ts) | Browser-safe status, subscription, routing, diagnostic, and event declarations |
| [`src/client.ts`](src/client.ts) | Browser-safe type re-exports |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Network package group](../README.md) — sibling pure-TypeScript tunnel runtime and subsystem overview.
- [dsh-vpn-tunnel](../vpn-tunnel/README.md) — outbound encrypted proxy protocols, subscription parser, anti-FakeIP DNS, and loopback gateway.
- [Network subsystem](../../../docs/subsystems/network.md) — `ctx.vpnTunnel` and `ctx.networkProxy` Cordis API reference.

-----

<a id="model-experience"></a>
## Model Experience

None, as `dsh-network-proxy` manages Host outbound transport routing and registers no prompt section, message, schema, or tool.

#### KV Cache effect

None; routing decisions happen at the HTTP dispatcher layer below serialized model payloads, leaving prompt prefixes unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **HTTP(S)-oriented child-process forwarding** — when `proxySubprocesses` is enabled, child tools receive `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` pointing to the loopback HTTP/CONNECT gateway; raw non-HTTP TCP sockets opened directly by external binaries bypass environment-variable proxies.
- **Process-local node health** — EWMA latency and circuit-breaker counters live in `ctx.vpnTunnel` memory and re-converge via passive traffic or `probeNodes` after a Host restart, while parsed subscription nodes restore immediately from the encrypted disk cache.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
