---
kind: upgrade-guide
description: "The Session search optional bundle is removed; base and Web profiles mount persistent hybrid session search and session history tools by default."
---

# Session search bundle removed

English | [中文](guide.zh.md)

## Change

In v0.2.2-rc.2, enabling Session search in the Plugins page appended `@deepseek-ai/dsh-experimental-session-search` to `dsh.profile.bundles` in `$DSH_HOME/profiles/<name>/package.json`. That bundle mounted an isolated `:memory:` `session-query-sqlite` row and `@deepseek-ai/dsh-tool-session-query` with same-workspace confinement while shipped base and Web compositions kept `session-query-sqlite` at `openAt: never`.

The next release removes `@deepseek-ai/dsh-experimental-session-search` and promotes `@deepseek-ai/dsh-tool-session-query` to `packages/session-query/tool-session-query`. `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` configure `session-query-sqlite` at `dshHomePath('search', 'session-search.db')` with `openAt: 'first-search'` and mount `@deepseek-ai/dsh-embedding` for optional dense-vector RRF fusion. The Web `standard`, `cordis`, and `ptc` presets mount `tool-session-query` with `workspaceScope: 'cross-workspace'` and `searchMode: 'hybrid'` ([details](../../../../packages/session-query/tool-session-query/README.md)); `minimal` omits it.

Loading a profile removes `@deepseek-ai/dsh-experimental-session-search` from `dsh.profile.bundles` and rewrites `package.json`; other manifest fields are preserved.

## Migration

1. Start `dsh` once with each affected profile; no manual edit is needed unless an external tool writes `dsh.profile.bundles` directly.
2. Replace any patch targeting `optional-session-search`, `optional-session-query-sqlite`, or `optional-tool-session-query` with overrides on `session-query-sqlite` (Host layer) or `tool-session-query` inside the target preset's `plugins` list. To restrict model session recall to the caller's exact `cwd`, set `workspaceScope: 'same-workspace'` on `tool-session-query`. To disable full-text indexing, set `openAt: 'never'` on `session-query-sqlite`.
3. Confirm: `dsh.profile.bundles` no longer lists `@deepseek-ai/dsh-experimental-session-search`, the Plugins page reports no missing bundle error, and sidebar search and `session_search` return content matches across prior sessions.
