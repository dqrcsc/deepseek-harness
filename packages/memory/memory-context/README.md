---
description: "KV-cache-stable logged memory context snapshot injector for the DeepSeek Harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-context

English | [中文](README.zh.md)

## Summary

Mount `@deepseek-ai/dsh-memory-context` in an agent preset to inject active cross-project and workspace memories into eligible turns (`step === 1`). Each injection is logged as a `snapshot`-form `user/message` carrying `{ kind: 'memory-context', turn, digest, items }`. When a later turn selects the identical memory set (`selection.digest === lastDigest`), the plugin appends nothing so conversation prompt caches remain intact; when compaction replaces the earlier snapshot on the session surface, the next turn re-injects active memories automatically.

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

Add `@deepseek-ai/dsh-memory-context` to an agent preset alongside Host `@deepseek-ai/dsh-memory`. When `ctx.memory` is absent from the Host composition, the plugin operates as a no-op.

```yaml
- id: memory-context
  name: '@deepseek-ai/dsh-memory-context'
```

Delegated subagent sessions (`origin === 'subagent'` or `delegationDepth > 0`), rejected steps, and no-step turns (`step === 1` with zero claimed messages) never receive memory snapshots.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the internal structure; observable behavior is covered in [Use this package](#use-this-package).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `memoryContext` session projection (`stateVersion: 1`) and `agent/pre-step` snapshot composer |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-memory](../memory/README.md) — Host storage domain and canonical context selector.
- [Memory capability family](../README.md) — sibling extraction and model-tool packages.

-----

<a id="model-experience"></a>
## Model Experience

### Preparation-time memory snapshot

#### What the model sees

When active memories are present and differ from the latest uncompacted `memory-context` digest on the session surface, Turn `step === 1` receives one appended user message:

##### Memory snapshot message

```markdown
<user_memory>
Durable user and workspace memories persisted across sessions. Apply them naturally when relevant without repeating them verbatim unless asked:
- [preference | global, pinned] Prefer Markdown deliverables with tables.
- [workflow | workspace] Always pass --offline to pnpm install in alpha.
</user_memory>
```

#### Token effect

Zero tokens when the memory store is empty or when the selected memory digest matches the previous uncompacted snapshot; otherwise bounded by `ctx.memory` (`maxInjectEntries` and `maxInjectBytes`).

#### KV Cache effect

Append-only and digest-deduplicated: earlier turns remain untouched, and unchanged memory selections emit zero new messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Turn-entry granularity** — snapshots are evaluated on `step === 1` of each turn rather than between tool-call steps inside the same turn, avoiding mid-turn repetition after `memory_save`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
