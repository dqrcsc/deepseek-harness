---
description: "Silent post-turn durable memory extractor and conflict resolver for the DeepSeek Harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-extractor

English | [中文](README.zh.md)

## Summary

Mount `@deepseek-ai/dsh-memory-extractor` on the Host to distill standing user preferences, workflows, profile traits, and workspace constraints in the background after completed turns. Extraction runs out-of-band after `turn/end` with per-session debouncing, reconciles against existing memories via `ADD`, `UPDATE`, `SUPERSEDE`, and `NOOP` operations, skips incognito and subagent sessions, and filters out credentials before writing to `ctx.memory`.

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

Mount `@deepseek-ai/dsh-memory-extractor` alongside `@deepseek-ai/dsh-memory` in interactive Host bundles (`dsh-base`). Automation-only bundles (`dsh-sdk-app`, `dsh-acp-app`) disable `memory-extractor` so deterministic automation runs emit zero background auxiliary model calls unless explicitly enabled.

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

Optional `provider` and `model` must be supplied together to pin extraction to a dedicated lightweight model; when omitted, the extractor reuses the session's logged `request/header` route with minimum supported reasoning effort.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the internal structure; observable behavior is covered in [Use this package](#use-this-package).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `session/event` turn accumulator, per-session debounce queue, auxiliary `memory-extract` LLM call, and teardown cancellation |
| [`src/parser.ts`](src/parser.ts) | System instruction, UTF-8 byte truncation, and Zod schema validation of `ADD` / `UPDATE` / `SUPERSEDE` / `NOOP` JSON output |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-memory](../memory/README.md) — durable Host memory store and secret-redaction chokepoint.
- [dsh-memory-context](../memory-context/README.md) — snapshot injector that consumes extracted memories in subsequent sessions.
- [dsh-tool-memory](../tool-memory/README.md) — synchronous model tools for explicit memory edits during a turn.

-----

<a id="model-experience"></a>
## Model Experience

### Auxiliary memory extraction request

#### What the model sees

Main conversation requests see nothing from this package. After an eligible turn finishes, a separate background `ctx.llm` call (`purpose: 'memory-extract'`) receives `EXTRACTION_SYSTEM_PROMPT` and one bounded JSON user message containing `workspaceAvailable`, compact `existingMemoriesJson`, and the completed `exchanges`.

#### Token effect

Zero tokens on main conversation requests. Auxiliary background requests are bounded by `maxInputBytes` (default 8192) and `maxOutputTokens` (default 1024) with the route's lowest reasoning effort.

#### KV Cache effect

Does not modify main conversation history or invalidate conversation KV caches.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Best-effort JSON adherence** — if a provider returns malformed JSON or terminates via `max-tokens`, the extraction pass logs a warning (or drops the incomplete stream) without retrying or disturbing the user's session.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
