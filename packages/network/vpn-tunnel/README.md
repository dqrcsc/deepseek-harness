---
description: "Dial encrypted VPN subscriptions, score region-tiered node health, and serve a loopback proxy gateway in pure TypeScript."
kind: "package-reference"
---

# @deepseek-ai/dsh-vpn-tunnel

English | [中文](README.zh.md)

## Summary

Mount `vpnTunnel` to parse Clash YAML and URI-based VPN subscriptions, resolve real server IPs around `198.18.0.0/15` FakeIP intercepts, dial encrypted outbound proxy streams (`ss2022`, `ss`, `trojan`, `vless`, `vmess`, `socks5`, `http` over TCP, TLS, `simple-obfs`, or WebSocket), rank nodes by region tier and EWMA latency, and bind a mixed HTTP/CONNECT and SOCKS5 loopback gateway on `127.0.0.1`. Mounting opens no network socket until a consumer starts the gateway, fetches a subscription, or runs a probe.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Consumers inject `vpnTunnel` to drive outbound tunnel routing without spawning external proxy binaries or altering operating-system proxy settings. Call `ctx.vpnTunnel.fetchSubscription(url, subscriptionId)` to download and parse Clash YAML or Base64/plain proxy URIs directly while calibrating clock offset from the HTTP `Date` response header. Pass parsed documents to `ctx.vpnTunnel.setSubscriptions(subscriptions)`, configure region tiers (`美国|新加坡`) and latency ceilings via `setRoutingPolicy(policy)`, and call `ensureGateway()` to obtain the `127.0.0.1` HTTP and SOCKS5 proxy URLs.

`ctx.vpnTunnel.probeNodes(options)` benchmarks candidate nodes in bounded parallel batches and updates EWMA latency and exponential-backoff circuit state. `ctx.vpnTunnel.decideRoute(host, mode)` evaluates private-network bypass, custom rules, Clash rules, or built-in smart-routing rules without opening a connection. Disposing the owning Cordis fiber aborts in-flight probes and closes the loopback listener and active tunnel sockets.

<a id="understand-the-implementation"></a>
## Understand the implementation

`src/index.ts` registers `VpnTunnelRuntime`; `blake3.ts` implements pure-TypeScript BLAKE3 hashing and key derivation for Shadowsocks 2022 (`2022-blake3-aes-128-gcm`, `2022-blake3-aes-256-gcm`, `2022-blake3-chacha20-poly1305`) and SIP023 Multi-PSK Extended Identity Headers; `dns.ts` detects `198.18.0.0/15` FakeIP results and queries clean UDP DNS A records directly; `protocols/` implements AEAD chunk framing, `simple-obfs` (`http`/`tls`), RFC 6455 client WebSockets, Shadowsocks 2022, legacy Shadowsocks AEAD, Trojan, VLESS, VMess AEAD, SOCKS5, and HTTP `CONNECT`; `subscription.ts` parses Clash YAML, Base64 URI lists, Subconverter `url=` fallbacks, and `.env` `SUB_VPN_*` variables; `rules.ts` and `router.ts` evaluate ordered domain/CIDR rules and region-tier health ranking; `gateway.ts` multiplexes SOCKS5, HTTP `CONNECT`, and plain HTTP proxy traffic on one `127.0.0.1` listener with candidate failover.

All state snapshots and error reports pass through `redactNetworkError` and `maskSubscriptionUrl` so proxy server hostnames, IP literals, subscription tokens, and pre-shared keys never appear in health records or diagnostics.

<a id="further-exploration"></a>
## Further Exploration

- [Network subsystem](../../../docs/subsystems/network.md) — `ctx.vpnTunnel` service reference and routing types.
- [HTTP proxy utility](../../util/http-proxy/README.md) — process-wide dynamic `undici` dispatcher and child-process proxy environment helpers.

<a id="model-experience"></a>
## Model Experience

None, as the service tunnels outbound bytes without changing model context.

#### KV Cache effect

None; outbound socket transport does not modify prompt tokens or request prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The pure-TypeScript tunnel runtime has the following protocol bounds.

- Outbound proxy streams transport TCP payloads (HTTP, HTTPS, WebSocket, SSE); UDP relay (`QUIC` / HTTP/3) and kernel TUN virtual network interfaces are outside scope.
- VLESS reality/XTLS vision flow control and Hysteria2/TUIC UDP transports are not implemented; standard TCP, TLS, `simple-obfs`, and WebSocket carriers are supported.

<a id="dev-note"></a>
### Dev Note

None.
