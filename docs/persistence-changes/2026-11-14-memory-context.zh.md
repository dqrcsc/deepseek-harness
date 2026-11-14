---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-14-memory-context

[English](2026-11-14-memory-context.md) | 中文

## 概述

在 `MessageSourceMap` 中新增仅用于来源标记的 `memory-context` 变体，使 `dsh-memory-context` 能够在 `user/message` 事件中记录注入的 `<user_memory>` 快照及其轮次编号、SHA-256 摘要和引用记忆条目。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

`MessageSourceMap` 是开放的可声明合并来源联合类型，读取方通过默认分支处理未知 `source.kind` 并原样保留 `ContextFormed` 快照字段。不包含 `memory-context` 的既有会话日志在当前 `SESSION_FORMAT_VERSION` 下无需迁移即可继续读取，未接入记忆引用的读取方会将 `source.kind === 'memory-context'` 的 `user/message` 事件视为普通非用户上下文快照。

<a id="verification"></a>
## 验证

已通过 `pnpm exec vitest run packages/memory/memory packages/memory/memory-context packages/memory/memory-extractor packages/memory/tool-memory`（单文件覆盖率 100%）以及 `pnpm run verify-persistence-changes` 验证。

<a id="dev-note"></a>
## 开发备注

无。
