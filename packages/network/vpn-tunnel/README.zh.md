---
description: "使用纯 TypeScript 解析加密 VPN 订阅、按地区梯队评估节点健康度并运行本地回环代理网关。"
kind: "package-reference"
---

# @deepseek-ai/dsh-vpn-tunnel

[English](README.md) | 中文

## 概述

挂载 `vpnTunnel` 可解析 Clash YAML 与 URI 格式的 VPN 订阅、绕过 `198.18.0.0/15` FakeIP 劫持解析真实服务器 IP、建立加密出站代理流（支持 TCP、TLS、`simple-obfs` 或 WebSocket 承载下的 `ss2022`、`ss`、`trojan`、`vless`、`vmess`、`socks5`、`http`）、按地区优先级梯队与 EWMA 延迟对节点排序，并在 `127.0.0.1` 上绑定混合 HTTP/CONNECT 与 SOCKS5 回环网关。仅挂载服务不会打开任何网络套接字，直到调用方启动网关、拉取订阅或执行探测。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

调用方注入 `vpnTunnel` 即可驱动出站隧道分流，无需拉起外部代理二进制进程，也不会修改操作系统代理设置。调用 `ctx.vpnTunnel.fetchSubscription(url, subscriptionId)` 可直接下载并解析 Clash YAML 或 Base64/纯文本代理 URI，同时根据 HTTP `Date` 响应头校准时钟偏移。将解析结果传入 `ctx.vpnTunnel.setSubscriptions(subscriptions)`，通过 `setRoutingPolicy(policy)` 配置地区梯队（如 `新加坡|日本|美国, 台湾`）与延迟上限，再调用 `ensureGateway()` 获取 `127.0.0.1` 的 HTTP 与 SOCKS5 代理地址。

`ctx.vpnTunnel.probeNodes(options)` 以受控并发批量探测候选节点，并更新 EWMA 延迟与指数退避熔断状态；当上游服务拒绝某个节点的出口 IP 或地区时，`ctx.vpnTunnel.penalizeNode(nodeId, reason, cooldownMs)` 会将该节点立即加入隔离冷却期，避免通用连通性探针过早恢复该节点。`ctx.vpnTunnel.decideRoute(host, mode)` 在不建立连接的前提下评估内网直连保护、自定义规则、Clash 规则或内置智能分流规则。销毁所属 Cordis fiber 时会中止进行中的探测，并关闭回环监听端口与活动隧道连接。

<a id="understand-the-implementation"></a>
## 理解实现

`src/index.ts` 注册 `VpnTunnelRuntime`；`blake3.ts` 以纯 TypeScript 实现 BLAKE3 哈希与密钥派生，供 Shadowsocks 2022（`2022-blake3-aes-128-gcm`、`2022-blake3-aes-256-gcm`、`2022-blake3-chacha20-poly1305`）及 SIP023 多 PSK 扩展身份头（EIH）使用；`dns.ts` 检测 `198.18.0.0/15` FakeIP 结果并直接通过纯净 UDP DNS 查询真实 A 记录；`protocols/` 实现 AEAD 分块帧、`simple-obfs`（`http`/`tls`）、RFC 6455 客户端 WebSocket、Shadowsocks 2022、传统 Shadowsocks AEAD、Trojan、VLESS、VMess AEAD、SOCKS5 与 HTTP `CONNECT`；`subscription.ts` 解析 Clash YAML、Base64 URI 列表、Subconverter `url=` 回退地址及 `.env` 中的 `SUB_VPN_*` 变量；`rules.ts` 与 `router.ts` 负责有序域名/CIDR 规则匹配与地区梯队健康度排序；`gateway.ts` 在单一 `127.0.0.1` 端口上复用 SOCKS5、HTTP `CONNECT` 与普通 HTTP 代理流量并提供候选节点故障切换。

所有状态快照与错误消息均经过 `redactNetworkError` 与 `maskSubscriptionUrl` 脱敏处理，确保代理服务器域名、IP 字面量、订阅令牌与预共享密钥绝不出现在健康记录或诊断信息中。

<a id="further-exploration"></a>
## 进一步探索

- [网络子系统](../../../docs/subsystems/network.zh.md) — `ctx.vpnTunnel` 服务参考与分流类型说明。
- [HTTP 代理工具包](../../util/http-proxy/README.zh.md) — 进程级动态 `undici` 分发器与子进程代理环境变量辅助函数。

<a id="model-experience"></a>
## 模型体验

无，因为服务仅承载出站字节隧道，不改变模型上下文。

#### KV Cache 影响

无；出站套接字传输不会修改提示词 token 或请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

纯 TypeScript 隧道运行时具有以下协议范围约束。

- 出站代理流仅承载 TCP 载荷（HTTP、HTTPS、WebSocket、SSE）；UDP 转发（`QUIC` / HTTP/3）与内核 TUN 虚拟网卡不在支持范围内。
- 未实现 VLESS Reality/XTLS Vision 流控及 Hysteria2/TUIC 等 UDP 传输协议；支持标准 TCP、TLS、`simple-obfs` 与 WebSocket 传输承载。

<a id="dev-note"></a>
### 开发备注

无。
