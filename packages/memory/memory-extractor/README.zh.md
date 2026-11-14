---
description: "DeepSeek Harness 的回合后静默持久记忆提炼与冲突消解插件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-extractor

[English](README.md) | 中文

## 概述

在宿主挂载 `@deepseek-ai/dsh-memory-extractor`，即可在回合完成后于后台静默提炼长期有效的用户偏好、常用工作流、个人画像与工作区规范。提炼在 `turn/end` 之后按会话防抖异步执行，通过 `ADD`、`UPDATE`、`SUPERSEDE` 与 `NOOP` 操作同既有记忆消解冲突，跳过无痕会话与子智能体会话，并在写入 `ctx.memory` 前拦截敏感凭据。

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

在交互式宿主套件（`dsh-base`）中将 `@deepseek-ai/dsh-memory-extractor` 与 `@deepseek-ai/dsh-memory` 一同挂载。纯自动化套件（`dsh-sdk-app`、`dsh-acp-app`）默认禁用 `memory-extractor`，确保确定性自动化运行在未显式开启时不发出后台辅助模型调用。

```yaml
- id: memory-extractor
  name: '@deepseek-ai/dsh-memory-extractor'
  config:
    debounceMs: 1500
    minUserChars: 8
    maxInputBytes: 8192
    maxOutputTokens: 1024
    timeoutMs: 30000
```

可选 `provider` 与 `model` 必须成对提供以固定使用指定轻量模型；省略时，提炼器复用会话已记录的 `request/header` 路由并选择最低推理强度。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节说明内部结构；可观察行为见[使用本包](#use-this-package)。

### 源码地图

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `session/event` 回合累积器、会话防抖队列、辅助 `memory-extract` 模型调用与卸载取消 |
| [`src/parser.ts`](src/parser.ts) | 系统提示词、UTF-8 字节截断以及 `ADD`／`UPDATE`／`SUPERSEDE`／`NOOP` JSON 输出的 Zod 校验 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-memory](../memory/README.zh.md)——持久化宿主记忆存储与敏感凭据拦截收口。
- [dsh-memory-context](../memory-context/README.zh.md)——在后续会话消费已提炼记忆的快照注入插件。
- [dsh-tool-memory](../tool-memory/README.zh.md)——回合内供模型显式增删查记忆的同步工具。

-----

<a id="model-experience"></a>
## 模型体验

### 辅助记忆提炼请求

#### 模型看到的内容

主对话请求不会看到本包的任何内容。在符合条件的回合结束后，独立的后台 `ctx.llm` 调用（`purpose: 'memory-extract'`）会收到 `EXTRACTION_SYSTEM_PROMPT` 以及一条受字节上限约束的 JSON 用户消息（包含 `workspaceAvailable`、精简 `existingMemoriesJson` 与已完成 `exchanges`）。

#### Token 影响

主对话请求零 token 开销。后台辅助请求受 `maxInputBytes`（默认 8192）与 `maxOutputTokens`（默认 1024）约束，并采用路由支持的最低推理强度。

#### KV Cache 影响

不修改主对话历史，也不会使主对话的 KV 缓存失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **尽力而为的 JSON 遵循**——若提供方返回格式错误的 JSON 或因 `max-tokens` 截断结束，当次提炼仅记录警告（或丢弃不完整输出），不会重试或干扰用户当前会话。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
