---
description: "DeepSeek Harness 的宿主 VPN 订阅管理器、智能分流策略控制器、加密订阅缓存与连通性诊断服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-network-proxy

[English](README.md) | 中文

## 概述

使用 `ctx.networkProxy` 管理 VPN 订阅、在 `ctx.vpnTunnel` 之上驱动进程级 `direct`、`smart` 与 `global` 分流，并在不依赖外部代理二进制且不修改操作系统代理设置的前提下执行端到端连通性诊断。脱敏后的订阅元数据与分流规则持久化在 `$DSH_HOME/storages` 下的宿主 `network` 存储域中，机密订阅 URL 与 256 位缓存密钥保存在 `ctx.credentials` 中，解析后的节点列表以 AES-256-GCM 密文信封静态缓存在 `$DSH_HOME/cache/network-proxy` 下。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将 `@deepseek-ai/dsh-network-proxy` 与 `@deepseek-ai/dsh-vpn-tunnel`、`@deepseek-ai/dsh-storage-domain` 及 `@deepseek-ai/dsh-credentials-local` 一同挂载，即可向宿主调用方暴露 `ctx.networkProxy` 并向 GUI 客户端暴露 `ctx.remote.networkProxy`。

### 配置

```yaml
- id: network-proxy
  name: '@deepseek-ai/dsh-network-proxy'
  config:
    autoRefreshCheckIntervalMs: 60000
    diagnosticTimeoutMs: 8000
    defaultProbeLimit: 64
    autoProbeOnActivate: true
```

所有字段均具备经过校验的默认值。`dshHome` 与 `userEnvPath` 用于在隔离测试中覆盖路径发现；`autoProbeOnActivate` 在代理模式激活时于后台自动测速未探测节点，使地区梯队选路立即收敛到实测最低延迟节点；`diagnosticTargets` 可替换默认的六个国内外诊断端点（`deepseek`、`openai`、`anthropic`、`gemini`、`github`、`google`）。

### 分流模式、覆盖策略与凭据隔离

在 `direct` 模式下，回环网关保持停止，出站请求回退至环境中的 `HTTP_PROXY`／`HTTPS_PROXY` 变量。在 `smart` 模式下，私有／回环地址始终直连，显式的按模型提供商覆盖（`providerOverrides`）与按能力覆盖（面向 `web`、`mcp`、`plugin`、`embedding` 的 `capabilityOverrides`）最先求值，用户自定义规则（`customRules`）与内置国内基线规则（`deepseek.com`、`aliyuncs.com`、`volces.com`、`minimaxi.com`、`npmmirror.com`、`cn`）次之，订阅自带的 Clash 规则最后求值。在 `global` 模式下，所有非私网目标均经由当前选中的隧道节点转发，除非命中用户自定义的 `DIRECT` 或 `REJECT` 规则。每当选中节点发生切换，或未手动固定节点的 LLM 请求在输出内容前遭遇上游地区限制错误时，`NetworkProxyService` 会立即驱逐 `ProxyAgent` 连接池中的旧长连接隧道，并在地区受限场景下隔离问题节点后自动在下一健康候选节点上重试。

`importEnvSubscriptions` 扫描 `process.env`、`$DSH_HOME/.env` 与 `~/.env` 中的 `SUB_VPN_*` 与 `VPN_SUB_*` 条目，按 SHA-256 URL 摘要去重，仅将机密 URL 写入 `ctx.credentials`（`network-proxy/<id>`），并通过远程 RPC 仅暴露掩码预览（`https://host/***`）与不透明节点哈希。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节说明内部结构；可观察行为见[使用本包](#use-this-package)。

### 源码地图

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `NetworkProxyService`、动态 `undici` 路由钩子、`llm/stream` 流量归因监听、自动刷新循环与 `@Remote` 方法 |
| [`src/domain.ts`](src/domain.ts) | `NetworkProxyInputError`、国内基线规则、URL／规则校验与 `ctx.credentials` 键构造器 |
| [`src/storage.ts`](src/storage.ts) | Zod 校验模式与 `networkDomain`（`subscriptions` 表与全局分流设置） |
| [`src/cache.ts`](src/cache.ts) | `EncryptedSubscriptionCache`，以绑定订阅 ID AAD 的 AES-256-GCM `0600` 文件存储解析后的节点列表 |
| [`src/diagnostics.ts`](src/diagnostics.ts) | 并发国内外 HTTP 连通性探测执行器与脱敏错误报告 |
| [`src/types.ts`](src/types.ts) | 浏览器安全的状态、订阅、分流、诊断与事件声明 |
| [`src/client.ts`](src/client.ts) | 浏览器安全的类型重导出 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [网络包组](../README.zh.md)——同级纯 TypeScript 隧道运行时与子系统概览。
- [dsh-vpn-tunnel](../vpn-tunnel/README.zh.md)——出站加密代理协议、订阅解析器、反 FakeIP DNS 与回环网关。
- [网络子系统](../../../docs/subsystems/network.zh.md)——`ctx.vpnTunnel` 与 `ctx.networkProxy` Cordis API 参考。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 `dsh-network-proxy` 仅管理宿主出站传输分流，不注册任何提示词段落、消息、schema 或工具。

#### KV Cache 影响

无；分流决策发生在序列化模型负载之下的 HTTP 调度层，提示词前缀保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **面向 HTTP(S) 的子进程代理传递**——启用 `proxySubprocesses` 时，子工具进程接收指向回环 HTTP/CONNECT 网关的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与 `NO_PROXY`；外部二进制直接打开的非 HTTP 原始 TCP 套接字不会经过环境变量代理。
- **进程内节点健康度状态**——EWMA 延迟与熔断计数驻留在 `ctx.vpnTunnel` 内存中，宿主重启后解析后的订阅节点会立即从本地加密缓存恢复，健康度指标则随实时流量或 `probeNodes` 重新收敛。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
