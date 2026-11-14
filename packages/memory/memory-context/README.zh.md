---
description: "DeepSeek Harness 的 KV 缓存稳定型已记录记忆上下文快照注入插件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-context

[English](README.md) | 中文

## 概述

在智能体预设中挂载 `@deepseek-ai/dsh-memory-context`，即可在符合条件的回合入口（`step === 1`）注入当前生效的跨项目与工作区记忆。每次注入均记录为携带 `{ kind: 'memory-context', turn, digest, items }` 的 `snapshot` 形态 `user/message`。当后续回合选出的记忆集合完全一致（`selection.digest === lastDigest`）时，插件不追加任何消息以保持提示词缓存完整命中；当上下文压缩替换了会话表面上的早期快照时，下一回合会自动重新注入当前生效记忆。

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

在挂载了宿主 `@deepseek-ai/dsh-memory` 的前提下，将 `@deepseek-ai/dsh-memory-context` 加入智能体预设。当宿主组合未挂载 `ctx.memory` 时，本插件自动保持空操作。

```yaml
- id: memory-context
  name: '@deepseek-ai/dsh-memory-context'
```

委派子智能体会话（`origin === 'subagent'` 或 `delegationDepth > 0`）、被拒绝的步骤以及空消息首步回合（`step === 1` 且无认领消息）均不会注入记忆快照。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节说明内部结构；可观察行为见[使用本包](#use-this-package)。

### 源码地图

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `memoryContext` 会话投影（`stateVersion: 1`）与 `agent/pre-step` 快照组装器 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-memory](../memory/README.zh.md)——宿主存储域与规范上下文精选服务。
- [记忆能力族](../README.zh.md)——同级的后台提炼与模型工具包。

-----

<a id="model-experience"></a>
## 模型体验

### 准备期记忆快照

#### 模型看到的内容

当存在生效记忆且摘要与会话表面最新未压缩的 `memory-context` 快照不同时，回合 `step === 1` 会收到一条追加的用户消息：

##### 记忆快照消息

```markdown
<user_memory>
Durable user and workspace memories persisted across sessions. Apply them naturally when relevant without repeating them verbatim unless asked:
- [preference | global, pinned] Prefer Markdown deliverables with tables.
- [workflow | workspace] Always pass --offline to pnpm install in alpha.
</user_memory>
```

#### Token 影响

当记忆库为空或入选记忆摘要与上一条未压缩快照一致时为零 token；否则受 `ctx.memory`（`maxInjectEntries` 与 `maxInjectBytes`）约束。

#### KV Cache 影响

仅追加且按摘要去重：早期回合历史保持不变，未发生变化的记忆集合不会发出新消息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **按回合入口粒度评估**——快照仅在每回合 `step === 1` 评估，而不在同一回合内的工具调用步骤之间重复注入，以避免在调用 `memory_save` 后立即重复上下文。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
