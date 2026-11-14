---
description: "Model-facing memory_save, memory_delete, and memory_list tools for the DeepSeek Harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-memory

English | [中文](README.zh.md)

## Summary

Mount `@deepseek-ai/dsh-tool-memory` in an agent preset to expose `memory_save`, `memory_delete`, and `memory_list` over Host `ctx.memory`. When a user explicitly asks the assistant to remember a rule, replace an outdated preference, or forget an item, the model applies the change synchronously during the turn instead of waiting for post-turn extraction.

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

Add `@deepseek-ai/dsh-tool-memory` to an agent preset. The plugin resolves `ctx.memory` dynamically via `ctx.inject(['memory'], ...)`, staying inert in compositions that omit the Host memory service.

```yaml
- id: tool-memory
  name: '@deepseek-ai/dsh-tool-memory'
```

`memory_save` and `memory_delete` reject delegated subagent callers (`MEMORY_TOOL_SUBAGENT_FORBIDDEN`), and `memory_save` rejects sessions placed in incognito mode (`MEMORY_TOOL_INCOGNITO_SESSION`). `memory_list` is read-only and concurrency-safe (`isConcurrencySafe: () => true`).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the internal structure; observable behavior is covered in [Use this package](#use-this-package).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Dynamic `memory` injection, `tool:memory` prompt section, caller authorization, and tool executors |
| [`src/schemas.ts`](src/schemas.ts) | Flat tool parameter schemas, plain-text result formatters, and pure `GenericCallView` presenters |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory) — exact schemas seen by the model.
- [dsh-memory](../memory/README.md) — Host storage domain and secret-redaction enforcement.
- [dsh-memory-context](../memory-context/README.md) — turn-entry `<user_memory>` snapshot injector.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

When any of the three tools is visible in the scope, `tool:memory` contributes one concise guidance paragraph:

##### System prompt guidance

```markdown
Use memory_save when the user explicitly asks you to remember, update, or enforce a standing preference, workflow, role fact, or prohibition across future sessions; pass supersedes_id when replacing an outdated memory. Use memory_delete when the user asks you to forget a stored memory, and memory_list to inspect existing memories before editing or when asked. Never pass API keys, passwords, tokens, or one-off task details to memory_save.
```

#### Token effect

One fixed concise paragraph while at least one memory tool is visible; zero tokens when all three tools are filtered out.

#### KV Cache effect

Prefix-stable across turns while tool visibility is unchanged.

### Tool schemas

#### What the model sees

The model sees the generated [`memory_save`, `memory_delete`, and `memory_list` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory).

#### Token effect

Three compact flat schemas on each request while visible.

#### KV Cache effect

Prefix-stable while tool visibility and definitions are unchanged.

### Tool results

#### What the model sees

Each call returns one plain-text confirmation or numbered memory list.

#### Token effect

Bounded by `ctx.memory` entry count and per-entry byte caps.

#### KV Cache effect

Append-only tool result text follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Root-session write authority** — delegated subagents can read memories via `memory_list` when granted the tool, but cannot mutate durable user memories via `memory_save` or `memory_delete`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
