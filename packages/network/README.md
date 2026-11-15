---
description: "Pure-TypeScript VPN tunnel runtime and smart-routing proxy packages."
kind: "package-group"
---

# network/ — encrypted tunnel and smart proxy routing

English | [中文](README.zh.md)

## Summary

This group owns pure-TypeScript outbound proxy tunneling, VPN subscription parsing, anti-FakeIP DNS resolution, region-tiered node health scoring, and process-scoped smart routing without external proxy binaries or operating-system proxy modifications.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`vpn-tunnel`](vpn-tunnel/README.md) | Cordis service (`ctx.vpnTunnel`) implementing pure-TypeScript encrypted proxy protocols, Clash/URI subscription parsing, anti-FakeIP DNS, health-scored region routing, and a `127.0.0.1` HTTP/SOCKS5 gateway |

<a id="related-documentation"></a>
## Related documentation

- [Network subsystem](../../docs/subsystems/network.md) — `ctx.vpnTunnel` service reference and routing vocabulary.

<a id="dev-note"></a>
## Dev Note

None.
