---
description: "Cross-project Memory center page, Session incognito switch, and Turn memory citation pills in the Web UI."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-memory

English | [中文](README.zh.md)

## Summary

The Memory center sidebar page, composer incognito mode chip, and Turn tail citation pill present and manage cross-project and Workspace memories in the browser. All reads and writes go through the Host Memory service over Typert Remote.

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

Below 768px, the Memory center uses 20px horizontal insets, matching the Plugins and Automation tasks pages.

The shipped Web composition mounts `ui-memory` alongside Host Memory. The Memories sidebar entry opens the Memory center without selecting or activating a Session. Top-level switches control automatic memory extraction after completed Turns, automatic context injection before initial Turn requests, and incognito read isolation. Scope tabs filter All, Global, and Workspace records, optionally narrowed to one Workspace directory and combined with category chips (`profile`, `preference`, `workflow`, `fact`, `constraint`) and text search over statement content and Workspace paths. Coarse-pointer search, statement, category, and path controls use 16px text to prevent focus zoom on iOS Safari.

Each memory card displays its category tag, Global or Workspace scope badge, manual or automatic origin badge, Pin / Unpin action, Enable / Pause switch, inline Edit form, optional Open source conversation button, and immediate Delete action. Add memory opens a modal dialog for creating Global or Workspace entries with category and pin state. Clear memories confirms before deleting All, Global, or one Workspace's entries while preserving preferences and Sessions. Failed writes leave editors open and display localized validation or conflict messages.

In an open conversation, the `/incognito` command (available from `/` or the composer command menu) toggles per-Session memory isolation (`memory.setSessionPolicy`): while enabled, automatic memory extraction and cross-Session recall skip that Session, and the composer toolbar displays a clickable Incognito chip (`conversation.input.left`) that turns incognito mode off even before the first prompt is sent. Under each Turn that received injected memories, a compact citation pill shows the recalled count and opens an anchored dialog listing each cited statement with live Active, Paused, or Deleted status, inline Pause / Resume, Edit, Delete, and a shortcut to open the Memory center.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

While the Peer may read `memory/catalog`, the browser entry registers the `memories` main panel and its sidebar launcher icon, the active-only `memory-incognito` composer mode chip (`conversation.input.left`), the `/incognito` composer command contribution, the `memory-citations` Turn tail pill, and a `memory-citations` Turn state reducer on `ctx.uiConversation.events`. The Turn reducer folds `user/message` events whose `source.kind` is `'memory-context'`, deduplicating `MemoryCitationItem` snapshots across Turn events without issuing per-Turn RPCs.

One observable `createMemoryCatalogSource` instance serves the main panel, composer mode chip, `/incognito` command, and Turn citation popovers. It subscribes to `memory/changed` and connection resets only while observed, increments an epoch to discard superseded reads after the last subscriber leaves, and maps `memory/input-invalid` error details (`sensitive_content`, `capacity_exceeded`, `invalid_scope`, `invalid_content`, `empty_patch`, `invalid_category`) plus conflict and missing-record outcomes to localized keys in all eight shipped UI locales.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Memory](../../memory/memory/README.md) owns durable SQLite storage, ranking, sensitivity checks, and per-Session policy.
- [Memory Context](../../memory/memory-context/README.md) injects ranked memories and logs `memory-context` citation metadata.
- [Slots](../../../docs/subsystems/slots.md) defines framework readers and panel contributions.

<a id="model-experience"></a>
## Model Experience

None, as this browser package registers no model tools or automatic messages.

#### KV Cache effect

None. Memory center views and popovers do not enter model requests directly.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Opening a memory's source conversation navigates to the Session when it remains unarchived in the Workspace catalog; deleted or archived Sessions hide the jump button.
- Turn citation pills reflect the snapshot logged when the Turn assembled its initial request; pausing or editing a cited memory affects subsequent Turns rather than rewriting historical Session events.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintenance context — click to expand</summary>

None.

</details>
