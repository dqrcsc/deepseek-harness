---
description: "DeepSeek Harness 面向模型的 memory_save、memory_delete 与 memory_list 显式记忆工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-memory

[English](README.md) | 中文

## 概述

在智能体预设中挂载 `@deepseek-ai/dsh-tool-memory`，即可基于宿主 `ctx.memory` 暴露 `memory_save`、`memory_delete` 与 `memory_list` 三个工具。当用户明确要求助手记住某项规则、替换过时偏好或忘掉某条记录时，模型可在当前回合内同步完成修改，无需等待回合后的后台提炼。

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

将 `@deepseek-ai/dsh-tool-memory` 加入智能体预设。本插件通过 `ctx.inject(['memory'], ...)` 动态解析 `ctx.memory`，在未挂载宿主记忆服务的组合中保持静默。

```yaml
- id: tool-memory
  name: '@deepseek-ai/dsh-tool-memory'
```

`memory_save` 与 `memory_delete` 拒绝委派子智能体调用（`MEMORY_TOOL_SUBAGENT_FORBIDDEN`），且 `memory_save` 拒绝处于无痕模式的会话（`MEMORY_TOOL_INCOGNITO_SESSION`）。`memory_list` 为只读且支持并发执行（`isConcurrencySafe: () => true`）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节说明内部结构；可观察行为见[使用本包](#use-this-package)。

### 源码地图

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 动态 `memory` 注入、`tool:memory` 提示词段落、调用方鉴权与工具执行器 |
| [`src/schemas.ts`](src/schemas.ts) | 扁平工具参数 schema、纯文本结果格式化器与纯函数 `GenericCallView` 展示器 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-memory)——模型看到的精确 schema。
- [dsh-memory](../memory/README.zh.md)——宿主存储域与敏感凭据拦截机制。
- [dsh-memory-context](../memory-context/README.zh.md)——回合入口 `<user_memory>` 快照注入插件。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到的内容

当任一记忆工具在当前作用域可见时，`tool:memory` 提供一段精炼指引：

##### 系统提示词指引

```markdown
Use memory_save when the user explicitly asks you to remember, update, or enforce a standing preference, workflow, role fact, or prohibition across future sessions; pass supersedes_id when replacing an outdated memory. Use memory_delete when the user asks you to forget a stored memory, and memory_list to inspect existing memories before editing or when asked. Never pass API keys, passwords, tokens, or one-off task details to memory_save.
```

#### Token 影响

至少一个记忆工具可见时固定增加一段精炼指引；三个工具均被过滤时为零 token。

#### KV Cache 影响

工具可见性未变时在多轮对话间保持前缀稳定。

### 工具 schema

#### 模型看到的内容

模型看到生成的 [`memory_save`、`memory_delete` 与 `memory_list` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-memory)。

#### Token 影响

可见时每次请求携带三个紧凑扁平 schema。

#### KV Cache 影响

工具可见性与定义未变时保持前缀稳定。

### 工具结果

#### 模型看到的内容

每次调用返回一段纯文本确认说明或带编号的记忆列表。

#### Token 影响

受 `ctx.memory` 条目上限与单条字节上限约束。

#### KV Cache 影响

仅追加的工具结果文本位于可复用的请求前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅根会话具备写入权限**——委派子智能体在获授工具时可通过 `memory_list` 读取记忆，但无法通过 `memory_save` 或 `memory_delete` 修改持久化用户记忆。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
