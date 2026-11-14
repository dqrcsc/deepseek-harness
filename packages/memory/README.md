---
description: "The memory package group: Host-owned cross-project persistent user memory, logged context injection, silent extraction, and explicit memory tools."
kind: "package-group"
---

# memory/ — Cross-project persistent memory

English | [中文](README.zh.md)

## Summary

Persist durable user preferences, personal context, workflows, facts, and standing constraints across workspaces and restarts under `$DSH_HOME/storages`, while keeping every injected memory transparent in the Session log and editable by the user. `dsh-memory` owns the schema-validated domain store, relevance-budgeted context selector, per-session incognito policy, and Typert Remote management endpoints; `dsh-memory-context` injects active memories into model requests only when the selected digest changes; `dsh-memory-extractor` distills durable facts after completed root turns with secret-redaction guards; and `dsh-tool-memory` exposes explicit `memory_save`, `memory_delete`, and `memory_list` tools.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Choose these packages for cross-project persistent memory storage, context injection, background extraction, and model-facing management tools.

| Package | Role |
|---|---|
| [`memory/`](memory/README.md) | Host-owned cross-project memory domain, relevance-budgeted selector, incognito session policy, and Remote endpoints |
| [`memory-context/`](memory-context/README.md) | KV-cache-stable logged `memory-context` snapshot injection before eligible model steps |
| [`memory-extractor/`](memory-extractor/README.md) | Silent debounced post-turn memory extraction, conflict resolution, and secret-redaction guard |
| [`tool-memory/`](tool-memory/README.md) | Preset-scoped `memory_save`, `memory_delete`, and `memory_list` tools over `ctx.memory` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Storage subsystem](../../docs/subsystems/storage.md) — non-session storage domains and the generated `ctx.memory` service and event API.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-memory) — the `memory_save`, `memory_delete`, and `memory_list` schemas contributed by presets.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
