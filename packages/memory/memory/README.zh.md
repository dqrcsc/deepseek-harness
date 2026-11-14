---
description: "DeepSeek Harness 的跨项目持久化记忆存储、会话隐私策略与混合上下文精选服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory

[English](README.md) | 中文

## 概述

使用 `ctx.memory` 跨项目存储、查看、更新并精选原子化的用户与工作区记忆。条目持久化在 `$DSH_HOME/storages` 下的宿主 `memory` 存储域中，记录创建来源（`user`、`tool` 或 `auto`），在写入时执行敏感凭据拦截守卫，支持会话级无痕策略，并通过 `Intl.Segmenter` 词法重合度与可选 `ctx.embedding` 稠密向量排序生成受预算约束的确定性 `<user_memory>` 精选结果。

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

将 `@deepseek-ai/dsh-memory` 与 `@deepseek-ai/dsh-storage-domain` 一同挂载，即可向宿主消费方（`dsh-memory-context`、`dsh-memory-extractor`、`dsh-tool-memory`）与远程 GUI 客户端（`ctx.remote.memory`）暴露 `ctx.memory`。

### 配置

```yaml
- id: memory
  name: '@deepseek-ai/dsh-memory'
  config:
    maxEntries: 500
    maxEntryBytes: 1024
    maxInjectEntries: 25
    maxInjectBytes: 8192
```

四个数值上限均具备经过校验的默认值。`maxEntries` 限制存储中启用与暂停条目的总数；`maxEntryBytes` 限制单条陈述的 UTF-8 字节长度；`maxInjectEntries` 与 `maxInjectBytes` 限制 `ctx.memory.selectForContext()` 每次返回的上下文精选规模。

### 作用域、隐私与远程访问

每条记忆归属于 `{ kind: 'global' }`（跨全部工作区共享）或 `{ kind: 'workspace', workspacePath }`（仅在该目录可见）。会话级无痕状态可通过 `ctx.memory.isSessionIncognito(sessionId)` 同步读取，使 `dsh-memory-extractor` 与 `dsh-tool-session-query` 无需额外磁盘读取即可隔离敏感会话。远程方法（`catalog`、`create`、`update`、`delete`、`clearScope`、`getPreferences`、`setPreferences`、`getSessionPolicy`、`setSessionPolicy`）在持久化写入完成后发出 `memory/changed`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节说明内部结构；可观察行为见[使用本包](#use-this-package)。

### 源码地图

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `MemoryService`、FIFO 变更队列、远程方法与 `memory/changed` 事件发射 |
| [`src/domain.ts`](src/domain.ts) | `MemoryInputError`、敏感凭据守卫、作用域／正文规范化与规范比较器 |
| [`src/storage.ts`](src/storage.ts) | Zod 记录校验模式与 `memoryDomain`（`entries`、`session_policies`、全局 `MemoryPreferences`） |
| [`src/selector.ts`](src/selector.ts) | `Intl.Segmenter` 多语言分词、可选稠密向量 RRF 融合与规范 `<user_memory>` 摘要计算 |
| [`src/types.ts`](src/types.ts) | 持久化记录、远程请求／响应与上下文精选值类型 |
| [`src/client.ts`](src/client.ts) | 浏览器安全的类型重导出 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [记忆能力族](../README.zh.md)——同级的上下文注入、后台提炼与模型工具包。
- [dsh-memory-context](../memory-context/README.zh.md)——消费 `selectForContext()` 的 `agent/pre-step` 快照注入插件。
- [dsh-memory-extractor](../memory-extractor/README.zh.md)——回合后后台无感提炼与冲突消解插件。
- [dsh-tool-memory](../tool-memory/README.zh.md)——显式 `memory_save`、`memory_delete` 与 `memory_list` 工具。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 `dsh-memory` 仅提供宿主存储与精选服务，不直接注册任何提示词段落、消息、schema 或工具。

#### KV Cache 影响

不直接触碰对话请求；`selectForContext()` 在计算哈希前将入选条目按规范顺序排列，从而使下游 `dsh-memory-context` 在入选集合未变时保持提示词缓存前缀稳定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **工作区路径按字面匹配**——工作区作用域记忆直接比较规范化后的目录字符串，而不在磁盘上解析符号链接，从而保持读取同步且无副作用。
- **基于正则的凭据拦截守卫**——`containsSensitiveSecret()` 可确定性拦截常见 API 密钥、Bearer 令牌、私钥及行内密钥赋值，但无法识别任意业务敏感叙述；此类对话应开启会话无痕模式。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
