---
description: "memory 包组：Host 拥有的跨项目持久化用户记忆、记入日志的上下文注入、静默提炼与显式记忆工具。"
kind: "package-group"
---

# memory/ — 跨项目持久化记忆

[English](README.md) | 中文

## 概述

在 `$DSH_HOME/storages` 下跨工作区与宿主重启持久保存用户的长期偏好、背景信息、工作流、事实与常驻约束，同时确保每条注入模型的记忆均完整记录于 Session 日志并支持用户随时查看与编辑。`dsh-memory` 负责经过 schema 校验的领域存储、受相关性预算约束的上下文选择器、按会话控制的无痕策略及 Typert Remote 管理端点；`dsh-memory-context` 仅在所选记忆摘要发生变化时将活跃记忆注入模型请求；`dsh-memory-extractor` 在根会话轮次结束后带敏感凭据拦截守卫静默提炼长期记忆；`dsh-tool-memory` 暴露显式的 `memory_save`、`memory_delete` 与 `memory_list` 工具。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

选择本组包以实现跨项目持久记忆存储、上下文注入、后台提炼与面向模型的管理工具。

| 包 | 职责 |
|---|---|
| [`memory/`](memory/README.zh.md) | Host 拥有的跨项目记忆领域存储、相关性预算选择器、无痕会话策略与 Remote 端点 |
| [`memory-context/`](memory-context/README.zh.md) | 在符合条件的模型步骤前执行保持 KV Cache 稳定的 `memory-context` 快照注入 |
| [`memory-extractor/`](memory-extractor/README.zh.md) | 轮次结束后的防抖静默记忆提炼、冲突消解与敏感凭据拦截守卫 |
| [`tool-memory/`](tool-memory/README.zh.md) | 基于 `ctx.memory` 的 preset 级 `memory_save`、`memory_delete` 与 `memory_list` 工具 |

-----

<a id="related-documentation"></a>
## 相关文档

- [Storage 子系统](../../docs/subsystems/storage.zh.md)——非会话领域存储及自动生成的 `ctx.memory` 服务与事件 API。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-memory)——由各 preset 贡献的 `memory_save`、`memory_delete` 与 `memory_list` schema。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
