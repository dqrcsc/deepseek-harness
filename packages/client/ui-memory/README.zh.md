---
description: "Web UI 中的跨项目记忆中心页面、会话无痕开关与轮次记忆引用胶囊。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-memory

[English](README.md) | 中文

## 概述

记忆中心侧栏页面、输入栏无痕模式标识与轮次尾部引用胶囊在浏览器中展示并管理跨项目与工作区记忆。所有读写均通过 Typert Remote 调用宿主 Memory 服务。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

宽度小于 768px 时，记忆中心使用 20px 的左右内边距，与插件页和自动化任务页一致。

发布的 Web 组合将 `ui-memory` 与宿主 Memory 一起挂载。“记忆”侧栏入口直接打开记忆中心，不选择或激活会话。顶部开关控制轮次完成后的无感自动记忆提炼、轮次初始请求前的自动上下文注入，以及无痕模式读取隔离。范围标签支持按“全部”“全局”“工作区”筛选记录，可进一步指定单个工作区目录，并与分类筛选（`profile`、`preference`、`workflow`、`fact`、`constraint`）及针对记忆正文和工作区路径的文本搜索组合使用。粗指针设备的搜索、正文、分类与路径控件使用 16px 字号，避免 iOS Safari 聚焦时自动缩放。

每张记忆卡片显示分类标签、全局或工作区范围标识、手动或自动来源标识、置顶与取消置顶操作、启用与暂停开关、行内编辑表单、可选的打开来源会话按钮，以及一键删除操作。“添加记忆”打开模态对话框，用于创建带分类和置顶状态的全局或工作区条目。“清空记忆”在确认后清空全部、全局或指定工作区的记忆条目，同时保留偏好设置与已有会话。写入失败时保留编辑状态，并显示本地化的校验或冲突提示。

在已打开对话中，`/incognito` 指令（可通过 `/` 或输入栏指令菜单触发）用于切换单会话记忆隔离（`memory.setSessionPolicy`）：开启期间，自动记忆提炼与跨会话检索均跳过该会话，输入栏工具条显示可点击关闭的“无痕”标识（`conversation.input.left`），即使在发送首条消息前也可即时生效与可见。在注入过记忆的每个轮次下方，紧凑的引用胶囊显示召回条数，点击后打开锚定弹层，列出每条被引用记忆及其最新生效中、已暂停或已删除状态，并提供行内暂停与恢复、编辑、删除及跳转到记忆中心入口。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

当 Peer 可读取 `memory/catalog` 时，浏览器入口注册 `memories` 主面板及其侧栏启动图标、仅在激活时显示的 `memory-incognito` 输入栏模式标识（`conversation.input.left`）、`/incognito` 输入栏指令贡献、`memory-citations` 轮次尾部胶囊，并在 `ctx.uiConversation.events` 上注册 `memory-citations` 轮次状态归约器。轮次归约器折叠 `source.kind` 为 `'memory-context'` 的 `user/message` 事件，在轮次事件间对 `MemoryCitationItem` 快照去重，不发起按轮次的额外 RPC。

主面板、输入栏模式标识、`/incognito` 指令与轮次引用弹层共享同一个可观察的 `createMemoryCatalogSource` 实例。该数据源仅在存在订阅者时监听 `memory/changed` 与连接重置事件，在最后一个订阅者退出后递增代次以丢弃过期的在途读取，并将 `memory/input-invalid` 错误详情（`sensitive_content`、`capacity_exceeded`、`invalid_scope`、`invalid_content`、`empty_patch`、`invalid_category`）及冲突、缺失结果映射为全部八种内置界面语言的本地化键。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [Memory](../../memory/memory/README.zh.md) 拥有持久化 SQLite 存储、排序、敏感内容拦截与单会话策略。
- [Memory Context](../../memory/memory-context/README.zh.md) 注入排序后的记忆并记录 `memory-context` 引用元数据。
- [槽位](../../../docs/subsystems/slots.zh.md) 定义框架读取器和面板贡献。

<a id="model-experience"></a>
## 模型体验

无：本浏览器包不注册模型工具或自动消息。

#### KV Cache 影响

无。记忆中心视图与引用弹层不会直接进入模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 打开记忆来源对话仅在该会话仍存在于工作区目录且未归档时跳转；已删除或已归档会话隐藏跳转按钮。
- 轮次引用胶囊展示该轮组装初始请求时记录的快照；暂停或编辑被引用记忆仅影响后续轮次，不会改写历史会话事件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护工作上下文 — 点击展开</summary>

无。

</details>
