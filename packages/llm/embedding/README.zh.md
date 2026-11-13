---
description: "面向混合检索与相似度排序的稠密文本向量化运行时及兼容 OpenAI 的 HTTP 提供方。"
kind: "package-reference"
---

# @deepseek-ai/dsh-embedding

[English](README.md) | 中文

## 概述

当宿主子系统需要归一化稠密向量以执行混合检索或语义排序时使用 `ctx.embedding`。本服务协调具备 HMR 安全性的提供方注册，并内置可选的兼容 OpenAI `POST /embeddings` 的 HTTP 提供方。当既未注册自定义提供方也未配置 HTTP 端点时，`ctx.embedding.isAvailable()` 以零启动开销返回 `false`，使检索调用方能够平滑回退至词法打分。

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

挂载 `@deepseek-ai/dsh-embedding` 以暴露 `ctx.embedding`。未配置独立向量端点的部署可以空配置挂载本插件；连接本地服务（如 Ollama 或 vLLM）或云端兼容 OpenAI API 的部署提供 `baseUrl` 与 `model`。

### 配置

```yaml
- id: embedding
  name: '@deepseek-ai/dsh-embedding'
  config:
    baseUrl: http://127.0.0.1:11434/v1
    model: nomic-embed-text
    maxBatchSize: 32
    timeoutMs: 30000
```

`baseUrl` 与 `model` 必须同时提供或同时省略。可选 `apiKey` 发送 `Authorization: Bearer <apiKey>` 请求头，可选 `dimensions` 在 JSON 请求体中转发期望的输出向量维度。

### 调用与注册提供方

在可选混合检索路径请求向量前先检查 `ctx.embedding.isAvailable()`。`ctx.embedding.embed(texts, { signal })` 按 `maxBatchSize` 切分批次，校验有限数值分量与统一正维度，并对每个返回的 `Float32Array` 执行 L2 归一化，从而使余弦相似度简化为有界点积。自定义插件可在自身 fiber 内调用 `ctx.embedding.registerProvider(provider)`；最新激活的注册项优先于配置的 HTTP 提供方，并在卸载时自动恢复。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节说明内部结构；可观察行为见[使用本包](#use-this-package)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `EmbeddingRuntime` 服务、提供方优先级与分批调度 |
| [`src/http-provider.ts`](src/http-provider.ts) | 兼容 OpenAI 的 `POST /embeddings` 请求／响应处理与按下标重排 |
| [`src/math.ts`](src/math.ts) | 向量 L2 归一化与 `cosineSimilarity()` |
| [`src/types.ts`](src/types.ts) | `EmbeddingProvider`、`EmbeddingResult`、`Config` 与 `EmbeddingError` |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [LLM 能力族](../README.zh.md)——`packages/llm/` 下的同级模型调用与 token 计量包。
- [dsh-session-query-sqlite](../../session-query/session-query-sqlite/README.zh.md)——融合 BM25 与稠密向量的混合会话检索消费方。

-----

<a id="model-experience"></a>
## 模型体验

无，因为向量化运行时仅向调用方返回归一化稠密向量，不注册任何提示词、消息、schema 或工具。

#### KV Cache 影响

不触碰对话请求，也不会使模型提示词缓存失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **单一活跃提供方优先级**——`ctx.embedding` 路由到最新注册的提供方或已配置的 HTTP 端点，而非同时多路复用多个命名向量模型；持久化向量消费方按 `modelId` 组织记录，因此切换提供方会按需惰性重建向量而不会破坏已有条目。
- **仅支持纯文本输入**——多模态图像或音频向量化不在本运行时范围内；调用方仅传入 UTF-8 字符串。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
