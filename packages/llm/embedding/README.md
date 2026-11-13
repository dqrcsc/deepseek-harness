---
description: "Dense text-embedding runtime and OpenAI-compatible HTTP provider for hybrid retrieval and similarity ranking."
kind: "package-reference"
---

# @deepseek-ai/dsh-embedding

English | [中文](README.zh.md)

## Summary

Use `ctx.embedding` when a host subsystem needs normalized dense vectors for hybrid retrieval or semantic ranking. The service coordinates HMR-safe provider registrations and an optional built-in OpenAI-compatible `POST /embeddings` HTTP provider. When neither a custom provider nor an HTTP endpoint is configured, `ctx.embedding.isAvailable()` returns `false` with zero startup overhead so retrieval callers can fall back cleanly to lexical scoring.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@deepseek-ai/dsh-embedding` to expose `ctx.embedding`. Deployments without a dedicated embedding endpoint mount it with empty configuration; deployments connecting to a local server (such as Ollama or vLLM) or a cloud OpenAI-compatible API supply `baseUrl` and `model`.

### Configuration

```yaml
- id: embedding
  name: '@deepseek-ai/dsh-embedding'
  config:
    baseUrl: http://127.0.0.1:11434/v1
    model: nomic-embed-text
    maxBatchSize: 32
    timeoutMs: 30000
```

`baseUrl` and `model` must be supplied together or omitted together. Optional `apiKey` sends `Authorization: Bearer <apiKey>`, and optional `dimensions` forwards the requested output dimensionality in the JSON payload.

### Calling and registering providers

Check `ctx.embedding.isAvailable()` before requesting vectors on optional hybrid paths. `ctx.embedding.embed(texts, { signal })` splits inputs by `maxBatchSize`, validates finite components and uniform positive dimensionality, and L2-normalizes every returned `Float32Array` so cosine similarity reduces to a bounded dot product. Custom plugins call `ctx.embedding.registerProvider(provider)` inside their fiber; the newest active registration overrides the configured HTTP provider until disposed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the internal structure; observable behavior is covered in [Use this package](#use-this-package).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `EmbeddingRuntime` service, provider precedence, and batching |
| [`src/http-provider.ts`](src/http-provider.ts) | OpenAI-compatible `POST /embeddings` request/response handling and index reordering |
| [`src/math.ts`](src/math.ts) | L2 vector normalization and `cosineSimilarity()` |
| [`src/types.ts`](src/types.ts) | `EmbeddingProvider`, `EmbeddingResult`, `Config`, and `EmbeddingError` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [LLM capability family](../README.md) — sibling model-call and token-measurement packages in `packages/llm/`.
- [dsh-session-query-sqlite](../../session-query/session-query-sqlite/README.md) — hybrid session search consumer that fuses BM25 and dense vectors.

-----

<a id="model-experience"></a>
## Model Experience

None, as the embedding runtime returns normalized dense vectors only to callers and registers no prompt, message, schema, or tool.

#### KV Cache effect

Does not touch conversation requests or invalidate model prompt caches.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Single active provider precedence** — `ctx.embedding` routes to the newest registered provider or the configured HTTP endpoint rather than multiplexing named embedding models concurrently; persisted vector consumers key rows by `modelId` so switching providers rebuilds vectors lazily without corrupting existing entries.
- **Text-only input** — multimodal image or audio embeddings are not part of this runtime; callers pass UTF-8 strings only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
