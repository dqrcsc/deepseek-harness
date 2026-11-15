---
description: "Network and proxy settings section and sidebar footer status switcher in the Web UI."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-network

English | [中文](README.zh.md)

## Summary

The Network and proxy Settings section and the sidebar footer status control manage Host VPN subscriptions, smart split-tunneling overrides, latency-ranked node selection, and connectivity diagnostics in the browser. All reads and writes go through the Host `networkProxy` Remote service.

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

The shipped Web composition mounts `ui-settings-network` alongside Host `network-proxy` and `vpn-tunnel`. In Settings, the Network and proxy section switches outbound transport between Direct, Smart routing, and Global proxy while reporting the live loopback gateway (`127.0.0.1:<port>`) and active exit node.

The Subscriptions card detects unimported `SUB_VPN_*` and `VPN_SUB_*` URLs in Host environment layers for one-click import, and offers inline forms to add, rename, rotate, refresh, enable, or remove subscriptions. Secret URLs enter write-only password fields and never reappear in browser state; subscription rows show only masked `https://host/***` previews, cached node counts, byte-quota summaries, and redacted error notices.

The Smart routing card edits preferred region tiers (such as `美国|新加坡`), the preferred-region latency ceiling, subprocess proxy injection, Desktop embedded browser proxy routing, per-provider LLM overrides, per-capability overrides (`web`, `mcp`, `plugin`, `embedding`), and custom Clash rules; coarse-pointer text inputs and rule textareas use 16px text to prevent mobile focus zoom. The Proxy nodes card benchmarks tunnel latency via 204 probes and pins a specific node or restores automatic regional selection, while Connectivity diagnostics verifies direct and proxied reachability across domestic and overseas endpoints.

In the left sidebar footer (`sidebar.footer.action`), a compact proxy status button appears only while Smart routing or Global proxy is active, adapting between an expanded label row and a 36 × 36 px rail icon with a hover tooltip, and opening an anchored menu for quick mode switching, exit-node selection, and latency probing.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

While the active Peer may call `networkProxy/status`, `apply(ctx)` creates one React-free `createNetworkProxySource` controller shared across `settings.section` (`id: 'network'`, `order: 25`), `settings.section.icon` (`id: 'network'`), and `sidebar.footer.action` (`id: 'network-status'`, `order: 10`).

The controller subscribes to `network-proxy/changed` and `connection/reset` lazily while observed, advances an epoch counter on teardown so late responses never overwrite newer state, updates status snapshots directly from mutation results, and ships localized copy in all eight UI locales under the `settings.network` namespace.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Network Proxy](../../network/network-proxy/README.md) owns durable settings, encrypted credentials, AES-256-GCM node caches, dynamic `undici` routing, and Remote endpoints.
- [VPN Tunnel](../../network/vpn-tunnel/README.md) owns pure-TypeScript protocol outbound dialers, FakeIP DNS bypass, latency probing, and the loopback gateway.
- [Network Subsystem](../../../docs/subsystems/network.md) documents the end-to-end split-tunneling architecture and Cordis API.

<a id="model-experience"></a>
## Model Experience

None, as this browser package configures Host outbound transport without registering model tools, prompt sections, or Session events.

#### KV Cache effect

None. Network settings views and sidebar controls do not enter model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Existing subscription URLs are write-only credentials: editing a subscription leaves the URL input blank unless rotating to a replacement URL.
- The sidebar footer quick menu lists up to six candidate nodes for fast switching; full node leaderboards and diagnostic matrices remain in Settings.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintenance context — click to expand</summary>

None.

</details>
