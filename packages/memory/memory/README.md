---
description: "Cross-project persistent memory store, session privacy policy, and hybrid context selection for the DeepSeek Harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-memory

English | [中文](README.zh.md)

## Summary

Use `ctx.memory` to store, inspect, update, and select atomic user and workspace memories across projects. Entries persist in the Host `memory` storage domain under `$DSH_HOME/storages`, track creation origin (`user`, `tool`, or `auto`), enforce secret-redaction guards at write time, support per-session incognito policies, and produce deterministic budget-bounded `<user_memory>` selections ranked by `Intl.Segmenter` lexical overlap and optional `ctx.embedding` dense vectors.

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

Mount `@deepseek-ai/dsh-memory` alongside `@deepseek-ai/dsh-storage-domain` to expose `ctx.memory` to Host consumers (`dsh-memory-context`, `dsh-memory-extractor`, `dsh-tool-memory`) and Remote GUI clients (`ctx.remote.memory`).

### Configuration

```yaml
- id: memory
  name: '@deepseek-ai/dsh-memory'
  config:
    maxEntries: 500
    maxEntryBytes: 1024
    maxInjectEntries: 25
    maxInjectBytes: 8192
```

All four numeric bounds have validated defaults. `maxEntries` caps active and paused entries in the store; `maxEntryBytes` caps each statement's UTF-8 byte length; `maxInjectEntries` and `maxInjectBytes` bound each context selection returned by `ctx.memory.selectForContext()`.

### Scopes, privacy, and Remote access

Each entry belongs either to `{ kind: 'global' }` (shared across every workspace) or `{ kind: 'workspace', workspacePath }` (visible only in that directory). Per-session incognito state is read synchronously via `ctx.memory.isSessionIncognito(sessionId)` so `dsh-memory-extractor` and `dsh-tool-session-query` can isolate sensitive sessions without extra disk reads. Remote methods (`catalog`, `create`, `update`, `delete`, `clearScope`, `getPreferences`, `setPreferences`, `getSessionPolicy`, `setSessionPolicy`) emit `memory/changed` after durable writes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the internal structure; observable behavior is covered in [Use this package](#use-this-package).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `MemoryService`, FIFO mutation queue, Remote methods, and `memory/changed` emission |
| [`src/domain.ts`](src/domain.ts) | `MemoryInputError`, secret-redaction guards, scope/content normalization, and canonical comparators |
| [`src/storage.ts`](src/storage.ts) | Zod record schemas and `memoryDomain` (`entries`, `session_policies`, global `MemoryPreferences`) |
| [`src/selector.ts`](src/selector.ts) | `Intl.Segmenter` multilingual tokenization, optional dense vector RRF fusion, and canonical `<user_memory>` digesting |
| [`src/types.ts`](src/types.ts) | Durable record, Remote request/response, and context-selection value types |
| [`src/client.ts`](src/client.ts) | Browser-safe type re-exports |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Memory capability family](../README.md) — sibling context-injection, background extraction, and model-tool packages.
- [dsh-memory-context](../memory-context/README.md) — `agent/pre-step` snapshot injector that consumes `selectForContext()`.
- [dsh-memory-extractor](../memory-extractor/README.md) — background post-turn extractor and conflict resolver.
- [dsh-tool-memory](../tool-memory/README.md) — explicit `memory_save`, `memory_delete`, and `memory_list` tools.

-----

<a id="model-experience"></a>
## Model Experience

None, as `dsh-memory` provides the Host storage and selection service without directly registering any prompt section, message, schema, or tool.

#### KV Cache effect

Does not touch conversation requests directly; `selectForContext()` sorts admitted items into a canonical order before hashing so downstream `dsh-memory-context` preserves prompt-cache prefixes whenever the admitted set is unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Literal workspace path matching** — workspace-scoped memories compare normalized directory strings rather than resolving symlinks on disk, keeping reads synchronous and side-effect-free.
- **Regex-based credential guard** — `containsSensitiveSecret()` blocks common API keys, bearer tokens, private keys, and inline secret assignments deterministically, but cannot detect arbitrary domain-specific confidential prose unless the session is placed in incognito mode.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
