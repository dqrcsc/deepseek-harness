---
kind: upgrade-guide
description: "“会话搜索”可选 bundle 已移除；基础与 Web profile 默认挂载持久化混合会话搜索和会话历史工具。"
---

# “会话搜索” bundle 已移除

[English](guide.md) | 中文

## 变更

在 v0.2.2-rc.2 中，在插件管理页开启“会话搜索”会把 `@deepseek-ai/dsh-experimental-session-search` 追加到 `$DSH_HOME/profiles/<name>/package.json` 的 `dsh.profile.bundles`。该 bundle 挂载隔离的 `:memory:` `session-query-sqlite` 行以及限定同工作区的 `@deepseek-ai/dsh-tool-session-query`，而默认基础与 Web 组合将 `session-query-sqlite` 保持为 `openAt: never`。

下一版本移除 `@deepseek-ai/dsh-experimental-session-search`，并将 `@deepseek-ai/dsh-tool-session-query` 晋升至 `packages/session-query/tool-session-query`。`@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 将 `session-query-sqlite` 配置为 `dshHomePath('search', 'session-search.db')` 与 `openAt: 'first-search'`，并挂载 `@deepseek-ai/dsh-embedding` 以支持可选稠密向量 RRF 融合。Web 的 `standard`、`cordis` 与 `ptc` preset 默认以 `workspaceScope: 'cross-workspace'` 和 `searchMode: 'hybrid'` 挂载 `tool-session-query`（[详情](../../../../packages/session-query/tool-session-query/README.zh.md)）；`minimal` 不挂载。

加载 profile 时会从 `dsh.profile.bundles` 中删除 `@deepseek-ai/dsh-experimental-session-search` 并重写 `package.json`；其他 manifest 字段保持不变。

## 迁移

1. 用每个受影响的 profile 启动一次 `dsh`；除非外部工具直接写入 `dsh.profile.bundles`，否则无需手动编辑。
2. 将针对 `optional-session-search`、`optional-session-query-sqlite` 或 `optional-tool-session-query` 的 patch 替换为针对 `session-query-sqlite`（Host 层）或目标 preset `plugins` 列表中 `tool-session-query` 的覆盖项。若需把模型会话召回限制在调用方完全一致的 `cwd`，请在 `tool-session-query` 上设置 `workspaceScope: 'same-workspace'`；若需关闭全文索引，请在 `session-query-sqlite` 上设置 `openAt: 'never'`。
3. 确认：`dsh.profile.bundles` 不再列出 `@deepseek-ai/dsh-experimental-session-search`，插件管理页不再报告缺失 bundle 错误，且侧栏搜索与 `session_search` 能跨既往会话返回内容命中。
