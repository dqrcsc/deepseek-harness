---
description: "Web 界面中的网络与代理设置分区及侧栏底部状态快捷切换控件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-network

[English](README.md) | 中文

## 概述

「网络与代理」设置分区与侧栏底部状态控件负责在浏览器端管理 Host VPN 订阅、智能分流覆盖策略、按延迟排序的节点优选以及一键连通性诊断。所有读写操作均通过 Host `networkProxy` Remote 服务完成。

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

内置 Web 组合在挂载 Host `network-proxy` 与 `vpn-tunnel` 的同时挂载 `ui-settings-network`。在「设置」中，「网络与代理」分区可在「直连」、「智能分流」与「全局代理」之间切换出站传输模式，并实时展示回环网关地址（`127.0.0.1:<port>`）与当前出口节点。

订阅管理卡片会自动检测 Host 环境层中尚未导入的 `SUB_VPN_*` 与 `VPN_SUB_*` 订阅链接并提供一键导入，同时支持通过内联表单新增、重命名、轮换、刷新、启停或删除订阅。机密订阅 URL 仅通过只写密码框提交，永不回显至浏览器状态；订阅列表仅展示脱敏的 `https://host/***` 预览、缓存节点数、流量配额摘要与脱敏错误提示。

智能分流卡片可编辑优先区域梯队（如 `美国|新加坡`）、优先区域延迟上限、子进程代理注入、桌面端内嵌浏览器视图代理路由、按模型服务商覆盖、按能力模块覆盖（`web`、`mcp`、`plugin`、`embedding`）以及自定义 Clash 规则；粗指针设备下的输入框与规则多行文本框使用 16px 字号以避免移动端聚焦缩放。节点优选卡片通过 204 隧道探针测量节点延迟，支持手动固定节点或恢复按区域自动优选；连通性诊断卡片并发验证国内外典型端点的直连与代理可达性。

在左侧栏底部（`sidebar.footer.action`），紧凑型代理状态按钮仅在「智能分流」或「全局代理」激活时显示，可在展开侧栏的标签行与收起侧栏的 36 × 36 px 图标按钮（附悬停提示）之间自适应切换，点击后弹出锚定菜单以快速切换模式、选择出口节点或触发测速。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

当当前 Peer 具备 `networkProxy/status` 访问权限时，`apply(ctx)` 创建一个与 React 解耦的 `createNetworkProxySource` 控制器，由 `settings.section`（`id: 'network'`，`order: 25`）、`settings.section.icon`（`id: 'network'`）与 `sidebar.footer.action`（`id: 'network-status'`，`order: 10`）共享。

该控制器仅在存在订阅者时惰性监听 `network-proxy/changed` 与 `connection/reset`，在卸载时递增代数计数器以避免过期响应覆盖最新状态，直接利用变更接口返回的状态快照原地刷新，并在 `settings.network` 命名空间下提供全部八种内置界面语言的本地化文案。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [网络代理服务](../../network/network-proxy/README.zh.md)负责持久化设置、加密凭据、AES-256-GCM 节点缓存、动态 `undici` 分流与 Remote 端点。
- [VPN 隧道服务](../../network/vpn-tunnel/README.zh.md)负责纯 TypeScript 协议出站拨号、FakeIP DNS 绕过、延迟探测与回环网关。
- [网络子系统](../../../docs/subsystems/network.zh.md)记录端到端智能分流架构与 Cordis API。

<a id="model-experience"></a>
## 模型体验

无，本浏览器包仅配置 Host 出站传输策略，不注册任何模型工具、提示词段落或会话事件。

#### KV Cache 影响

无。网络设置界面与侧栏控件不会进入模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 已有订阅 URL 属于只写凭据：编辑订阅时 URL 输入框默认留空，仅在需要轮换为新 URL 时填写。
- 侧栏底部快捷菜单最多展示前六个候选节点以便快速切换；完整节点列表与连通性诊断矩阵位于「设置」页中。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护说明 — 点击展开</summary>

无。

</details>
