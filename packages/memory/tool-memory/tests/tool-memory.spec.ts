import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm'
import MemoryService from '@deepseek-ai/dsh-memory'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageSqlitePlugin from '@deepseek-ai/dsh-storage-sqlite'
import SystemPromptService from '@deepseek-ai/dsh-system-prompt'
import * as nativeExecutorPlugin from '@deepseek-ai/dsh-tool-executor-native'
import ToolRegistry, { type ToolExecutionToken, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as toolMemoryPlugin from '../src/index.ts'
import { presentDeleteCall, presentListCall, presentSaveCall } from '../src/schemas.ts'

function makeExec(agent?: Agent): ToolRunContext {
  const callId = ToolCallId('call-1')
  return {
    ...(agent === undefined ? {} : { agent }),
    callId,
    rootCallId: callId,
    name: 'memory_save',
    arguments: {},
    signal: new AbortController().signal,
    token: Symbol('tok-1') as ToolExecutionToken,
    deferContext: () => {},
    concludeTurn: () => {},
  }
}

function getTool(ctx: Context, name: string) {
  const tool = ctx.tools.get(name)
  if (tool === undefined) throw new Error(`missing tool ${name}`)
  return tool
}

function extractSavedId(raw: unknown): string {
  const text = String(raw)
  const match = /Saved memory (mem-[^\s]+)/.exec(text)
  if (match === null || match[1] === undefined) throw new Error(`missing saved id in: ${text}`)
  return match[1]
}

describe('dsh-tool-memory', () => {
  it('saves, supersedes, lists, deletes, enforces subagent/incognito/workspace guards, and renders call views', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageSqlitePlugin, { path: ':memory:' })
    await ctx.plugin(storageDomainPlugin, { backend: 'sqlite' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(nativeExecutorPlugin)
    await ctx.plugin(SystemPromptService)
    await ctx.plugin(MemoryService)
    await ctx.plugin(toolMemoryPlugin)

    try {
      const promptWithTools = (await ctx.systemPrompt.assemble()).sections.map(s => s.text).join('\n')
      expect(promptWithTools).toContain('memory_save')

      const saveTool = getTool(ctx, 'memory_save')
      const deleteTool = getTool(ctx, 'memory_delete')
      const listTool = getTool(ctx, 'memory_list')
      expect(listTool.isConcurrencySafe?.({})).toBe(true)

      // Presenters & output renderers.
      expect(presentSaveCall({ content: 'Rule A' }).title).toBe('Save memory')
      expect(presentSaveCall({ content: 'Rule B', supersedes_id: 'mem-1' }).title).toBe('Update memory')
      expect(presentDeleteCall({ id: 'mem-1' }).rawInput).toBe('mem-1')
      expect(presentListCall({}).rawInput).toBeUndefined()
      expect(presentListCall({ query: 'markdown' }).rawInput).toBe('markdown')
      expect(saveTool.output.render({}, 'ok')).toEqual([{ type: 'text', text: 'ok' }])

      // Missing agent throws MEMORY_TOOL_MISSING_AGENT.
      await expect(saveTool.execute({ content: 'A', category: 'fact' }, makeExec())).rejects.toThrow(HarnessError)

      // Subagent write forbidden, subagent read allowed.
      const subSess = ctx.sessions.create(SessionId('s-sub'), { meta: { origin: 'subagent', delegationDepth: 1 } })
      const subAgent = { session: subSess } as Agent
      await expect(saveTool.execute({ content: 'A', category: 'fact' }, makeExec(subAgent))).rejects.toThrow(
        'Delegated subagent sessions cannot mutate',
      )
      await expect(deleteTool.execute({ id: 'mem-1' }, makeExec(subAgent))).rejects.toThrow(
        'Delegated subagent sessions cannot mutate',
      )
      expect(await listTool.execute({}, makeExec(subAgent))).toBe('No stored memories matched the filter.')

      const depthOnlySess = ctx.sessions.create(SessionId('s-depth'), { meta: { delegationDepth: 1 } })
      await expect(
        saveTool.execute({ content: 'A', category: 'fact' }, makeExec({ session: depthOnlySess } as Agent)),
      ).rejects.toThrow('Delegated subagent sessions cannot mutate')

      // Root session without workspace rejects scope="workspace", accepts global.
      const noWsSess = ctx.sessions.create(SessionId('s-nows'))
      const noWsAgent = { session: noWsSess } as Agent
      const closedSet = await ctx.tools.resolve({
        agent: noWsAgent,
        signal: new AbortController().signal,
        modelSelection: { provider: 'mock', model: 'mock' },
      })
      closedSet.dispose()
      const promptFiltered = (await ctx.systemPrompt.assemble({ scope: noWsAgent, toolSet: closedSet }))
        .sections.map(s => s.text).join('\n')
      expect(promptFiltered).not.toContain('memory_save')

      await expect(
        saveTool.execute({ content: 'Workspace rule', category: 'workflow', scope: 'workspace' }, makeExec(noWsAgent)),
      ).rejects.toThrow('no workspace directory')

      const savedGlobalText = await saveTool.execute(
        { content: 'Always include clear summary tables.', category: 'preference', pinned: true },
        makeExec(noWsAgent),
      )
      expect(savedGlobalText).toContain('[preference | global, pinned]')
      const globalId = extractSavedId(savedGlobalText)

      const listedWithPin = await listTool.execute({ scope: 'global' }, makeExec(noWsAgent))
      expect(listedWithPin).toContain('pinned')

      // Root session with workspace saves workspace memory and supersedes with explicit pinned=false override.
      const wsSess = ctx.sessions.create(SessionId('s-ws'), { meta: { cwd: '/projects/demo' } })
      const wsAgent = { session: wsSess } as Agent
      const savedWsText = await saveTool.execute(
        { content: 'Use pnpm offline in demo.', category: 'workflow', scope: 'workspace' },
        makeExec(wsAgent),
      )
      expect(savedWsText).toContain('workspace:/projects/demo')

      const supersededText = await saveTool.execute(
        {
          content: 'Always include concise Markdown tables.',
          category: 'preference',
          supersedes_id: globalId,
          pinned: false,
        },
        makeExec(wsAgent),
      )
      expect(supersededText).toContain(`(superseding ${globalId})`)
      expect(supersededText).not.toContain('pinned')

      const supersededSamePinText = await saveTool.execute(
        {
          content: 'Always include concise GFM tables.',
          category: 'preference',
          supersedes_id: extractSavedId(supersededText),
        },
        makeExec(wsAgent),
      )
      expect(supersededSamePinText).toContain('Saved memory')

      // List with filters.
      const listed = await listTool.execute(
        { scope: 'applicable', category: 'workflow', query: 'pnpm' },
        makeExec(wsAgent),
      )
      expect(listed).toContain('Stored memories (1):')
      expect(listed).toContain('workspace:/projects/demo')

      const listedPinned = await listTool.execute({ scope: 'global' }, makeExec(wsAgent))
      expect(listedPinned).toContain('global')

      // Incognito session blocks save, and blocks list when incognitoIsolatesRead=true.
      await ctx.memory.setSessionPolicy({ sessionId: wsSess.id, incognito: true })
      await expect(
        saveTool.execute({ content: 'Blocked in incognito', category: 'fact' }, makeExec(wsAgent)),
      ).rejects.toThrow('incognito mode')
      await ctx.memory.setPreferences({ incognitoIsolatesRead: true })
      expect(await listTool.execute({}, makeExec(wsAgent))).toContain('isolated while this session is in incognito mode')

      // Delete existing + missing.
      const wsId = extractSavedId(savedWsText)
      expect(await deleteTool.execute({ id: wsId }, makeExec(wsAgent))).toBe(`Deleted memory ${wsId}.`)
      expect(await deleteTool.execute({ id: 'mem-missing' }, makeExec(wsAgent))).toBe('Memory mem-missing was not found.')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('works without WorkingDirectoryService mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageSqlitePlugin, { path: ':memory:' })
    await ctx.plugin(storageDomainPlugin, { backend: 'sqlite' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(nativeExecutorPlugin)
    await ctx.plugin(SystemPromptService)
    await ctx.plugin(MemoryService)
    await ctx.plugin(toolMemoryPlugin)
    try {
      const listTool = getTool(ctx, 'memory_list')
      const sess = ctx.sessions.create(SessionId('s-plain'))
      expect(await listTool.execute({}, makeExec({ session: sess } as Agent))).toBe(
        'No stored memories matched the filter.',
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
