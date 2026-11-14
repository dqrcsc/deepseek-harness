/**
 * Model-facing `memory_save`, `memory_delete`, and `memory_list` tools over Host `ctx.memory`.
 * @module @deepseek-ai/dsh-tool-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { MemoryId, MemoryScope } from '@deepseek-ai/dsh-memory'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  MEMORY_PROMPT_TEXT,
  formatMemoryList,
  formatSavedMemory,
  memoryDeleteParameters,
  memoryListParameters,
  memorySaveParameters,
  presentDeleteCall,
  presentListCall,
  presentSaveCall,
} from './schemas.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-memory'

/** Services required by the model-facing memory tools; `memory` is resolved per scope. */
export const inject = ['tools', 'systemPrompt']

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

function requireRootAgent(exec: ToolRunContext, allowSubagentRead = false): Agent {
  const agent = exec.agent
  if (agent === undefined) {
    throw new HarnessError('Memory tools require an agent-bound caller.', 'MEMORY_TOOL_MISSING_AGENT')
  }
  const isSubagent = agent.session.header.origin === 'subagent' || (agent.session.header.delegationDepth ?? 0) > 0
  if (!allowSubagentRead && isSubagent) {
    throw new HarnessError(
      'Delegated subagent sessions cannot mutate persistent user memories.',
      'MEMORY_TOOL_SUBAGENT_FORBIDDEN',
    )
  }
  return agent
}

function resolveCallerWorkspace(agent: Agent): string | undefined {
  const trimmed = agent.session.header.cwd?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}

function registerMemoryTools(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:memory',
    order: ctx.systemPrompt.getSectionOrder('TOOL_MEMORY'),
    text: ({ scope, toolSet }) =>
      ctx.tools.get('memory_save', scope, toolSet) !== undefined
      || ctx.tools.get('memory_delete', scope, toolSet) !== undefined
      || ctx.tools.get('memory_list', scope, toolSet) !== undefined
        ? MEMORY_PROMPT_TEXT
        : '',
  })

  ctx.tools.register(defineTool({
    name: 'memory_save',
    description: 'Save or update one atomic persistent user or workspace memory across sessions.',
    parameters: memorySaveParameters,
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const agent = requireRootAgent(exec)
      if (ctx.memory.isSessionIncognito(agent.session.id)) {
        throw new HarnessError(
          'This session is in incognito mode; saving persistent memories is disabled.',
          'MEMORY_TOOL_INCOGNITO_SESSION',
        )
      }
      const requestedScope = args.scope ?? 'global'
      let scope: MemoryScope
      if (requestedScope === 'workspace') {
        const workspacePath = resolveCallerWorkspace(agent)
        if (workspacePath === undefined) {
          throw new HarnessError(
            'Current session has no workspace directory; save with scope "global" instead.',
            'MEMORY_TOOL_NO_WORKSPACE',
          )
        }
        scope = { kind: 'workspace', workspacePath }
      } else {
        scope = { kind: 'global' }
      }
      const source = { kind: 'tool' as const, sessionId: agent.session.id }
      if (args.supersedes_id !== undefined) {
        const record = await ctx.memory.supersede({
          targetId: brandString<MemoryId>(args.supersedes_id),
          content: args.content,
          category: args.category,
          scope,
          source,
          ...(args.pinned === undefined ? {} : { pinned: args.pinned }),
        }, exec.signal)
        return formatSavedMemory(record, args.supersedes_id)
      }
      const created = await ctx.memory.create({
        content: args.content,
        category: args.category,
        scope,
        ...(args.pinned === undefined ? {} : { pinned: args.pinned }),
        source,
      }, exec.signal)
      return formatSavedMemory(created)
    },
    presentCall: presentSaveCall,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_delete',
    description: 'Permanently delete one stored persistent memory by its id.',
    parameters: memoryDeleteParameters,
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      requireRootAgent(exec)
      const outcome = await ctx.memory.delete({ id: brandString<MemoryId>(args.id) }, exec.signal)
      return outcome.deleted
        ? `Deleted memory ${outcome.id}.`
        : `Memory ${outcome.id} was not found.`
    },
    presentCall: presentDeleteCall,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_list',
    description: 'List stored persistent memories filtered by scope, category, or search terms.',
    parameters: memoryListParameters,
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = requireRootAgent(exec, true)
      if (ctx.memory.isSessionIncognito(agent.session.id) && ctx.memory.getPreferences().incognitoIsolatesRead) {
        return 'Memory reads are isolated while this session is in incognito mode.'
      }
      const workspacePath = resolveCallerWorkspace(agent)
      const scopeKind = args.scope ?? 'applicable'
      const catalog = await ctx.memory.catalog({
        scopeKind,
        ...(workspacePath === undefined ? {} : { workspacePath }),
        ...(args.category === undefined ? {} : { category: args.category }),
        ...(args.query === undefined ? {} : { query: args.query }),
      })
      return formatMemoryList(catalog.items)
    },
    presentCall: presentListCall,
  }))
}

/**
 * Mount `memory_save`, `memory_delete`, and `memory_list` when Host `ctx.memory` is active.
 * @param ctx - plugin context exposing `tools` and `systemPrompt`.
 */
export function apply(ctx: Context): void {
  ctx.inject(['memory'], registerMemoryTools)
}
