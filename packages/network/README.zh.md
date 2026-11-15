---
description: "纯 TypeScript VPN 隧道运行时与智能分流代理包。"
kind: "package-group"
---

# network/ — 加密隧道与智能代理分流

[English](README.md) | 中文

## 概述

本组负责纯 TypeScript 出站代理隧道、VPN 订阅解析、反 FakeIP DNS 解析、按地区梯队的节点健康度评分，以及不依赖外部二进制进程且不修改操作系统代理设置的进程级智能分流。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`vpn-tunnel`](vpn-tunnel/README.zh.md) | Cordis 服务（`ctx.vpnTunnel`），以纯 TypeScript 实现加密代理协议、Clash/URI 订阅解析、反 FakeIP DNS、地区梯队健康选路与 `127.0.0.1` HTTP/SOCKS5 网关 |
| [`network-proxy`](network-proxy/README.zh.md) | Cordis 与远程服务（`ctx.networkProxy`、`ctx.remote.networkProxy`），负责 VPN 订阅管理、`ctx.credentials` 机密 URL 存储、AES-256-GCM 节点缓存、按提供商／能力的智能分流、桌面内嵌页代理同步与连通性诊断 |

<a id="related-documentation"></a>
## 相关文档

- [网络子系统](../../docs/subsystems/network.zh.md) — `ctx.vpnTunnel` 与 `ctx.networkProxy` 服务参考与分流词汇。
- [网络代理用户指南](../../docs/user/guide/network-proxy.zh.md) — 内置 VPN 订阅配置、智能分流模式与 `HTTP_PROXY`／`HTTPS_PROXY` 环境变量。

<a id="dev-note"></a>
## 开发备注

无。
