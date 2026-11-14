---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-14-memory-context

English | [中文](2026-11-14-memory-context.zh.md)

## Summary

Adds the attribution-only `memory-context` variant on `MessageSourceMap` so `dsh-memory-context` can record injected `<user_memory>` snapshots in `user/message` events with turn number, SHA-256 digest, and cited memory items.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-memory-context
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "33c9bd15d9213eaad2cda1cbaab81756d664cc550f93873bc72dbe8ee98a42b8"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "deb3d2584dd7ada1130abced0ba3d72e7796da4121523dfcd2aed1180aca40c7"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "ac3514dc67717c4a4dbfc6ff2259c0e5f86ce230689f7f4084a6d8ff6dce6e3b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "6db6075f87ba664b652f84b639ea512060ae050c5ab8e85d1ea64f7bd1fdd992"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

`MessageSourceMap` is an open merge-extensible source union where readers inspect `source.kind` via fallthrough defaults and carry `ContextFormed` snapshot fields unchanged. Existing session logs without `memory-context` remain valid under `SESSION_FORMAT_VERSION` without migration, and readers that do not render memory citations treat `user/message` events with `source.kind === 'memory-context'` as ordinary non-user context snapshots.

<a id="verification"></a>
## Verification

Verified with `pnpm exec vitest run packages/memory/memory packages/memory/memory-context packages/memory/memory-extractor packages/memory/tool-memory` at 100% per-file coverage and `pnpm run verify-persistence-changes`.

<a id="dev-note"></a>
## Dev Note

None.
