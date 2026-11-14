import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import MemoryService from '@deepseek-ai/dsh-memory'
import SessionRegistry, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageSqlitePlugin from '@deepseek-ai/dsh-storage-sqlite'
import { describe, expect, it } from 'vitest'
import * as memoryContextPlugin from '../src/index.ts'

async function createContextHarness(options: { withMemory?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(storageSqlitePlugin, { path: ':memory:' })
  await ctx.plugin(storageDomainPlugin, { backend: 'sqlite' })
  await ctx.plugin(SessionRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  if (options.withMemory !== false) await ctx.plugin(MemoryService)
  await ctx.plugin(memoryContextPlugin)
  return ctx
}

function makeAgentStub(session: Session): Agent {
  return { session } as Agent
}

function runPreStep(
  ctx: Context,
  payload: {
    agent: Agent
    turn: number
    step: number
    messages: UserMessage[]
    signal?: AbortSignal
  },
  decision?: PreStepDecision,
): Promise<PreStepDecision> {
  return ctx.waterfall(
    'agent/pre-step',
    {
      agent: payload.agent,
      turn: payload.turn,
      step: payload.step,
      messages: payload.messages,
      signal: payload.signal ?? new AbortController().signal,
      modelSelection: { provider: 'mock', model: 'mock' },
    },
    async (): Promise<PreStepDecision> => decision ?? { kind: 'enter', messages: payload.messages },
  )
}

describe('dsh-memory-context', () => {
  it('injects on turn 1, skips unchanged digests on turn 2, re-injects after memory edit or compaction replace, and skips ineligible steps', async () => {
    const ctx = await createContextHarness({ withMemory: true })
    try {
      const session = ctx.sessions.create(SessionId('sess-ctx-1'), {
        meta: { cwd: '/workspace/demo' },
      })
      const agent = makeAgentStub(session)

      const promptMsg = createUserMessage({
        content: [{ type: 'text', text: 'Summarize our quarterly metrics.' }, { type: 'reasoning', text: 'internal' }],
        source: { kind: 'user' },
      })

      // Empty store -> no snapshot appended.
      const emptyDecision = await runPreStep(ctx, {
        agent,
        turn: 1,
        step: 1,
        messages: [promptMsg],
      })
      expect(emptyDecision.kind === 'enter' && emptyDecision.messages).toHaveLength(1)

      // Add a global and workspace memory.
      const mem1 = await ctx.memory.create({
        content: 'Use Markdown tables for financial summaries.',
        category: 'preference',
        scope: { kind: 'global' },
        pinned: true,
      })
      await ctx.memory.create({
        content: ' Fiscal year starts in April for demo workspace.',
        category: 'fact',
        scope: { kind: 'workspace', workspacePath: '/workspace/demo' },
      })

      // Rejected decision, pre-aborted signal, step !== 1, empty messages, and subagent sessions are skipped.
      const rejected = await runPreStep(
        ctx,
        { agent, turn: 1, step: 1, messages: [promptMsg] },
        { kind: 'reject' },
      )
      expect(rejected.kind).toBe('reject')

      const preAborted = await runPreStep(ctx, {
        agent,
        turn: 1,
        step: 1,
        messages: [promptMsg],
        signal: AbortSignal.abort(),
      })
      expect(preAborted.kind === 'enter' && preAborted.messages).toHaveLength(1)

      const stepTwo = await runPreStep(ctx, {
        agent,
        turn: 1,
        step: 2,
        messages: [promptMsg],
      })
      expect(stepTwo.kind === 'enter' && stepTwo.messages).toHaveLength(1)

      const emptyMessages = await runPreStep(ctx, {
        agent,
        turn: 1,
        step: 1,
        messages: [],
      })
      expect(emptyMessages.kind === 'enter' && emptyMessages.messages).toHaveLength(0)

      const subagentSession = ctx.sessions.create(SessionId('sess-sub'), {
        meta: { origin: 'subagent', delegationDepth: 1 },
      })
      const subDecision = await runPreStep(ctx, {
        agent: makeAgentStub(subagentSession),
        turn: 1,
        step: 1,
        messages: [promptMsg],
      })
      expect(subDecision.kind === 'enter' && subDecision.messages).toHaveLength(1)

      const depthOnlySession = ctx.sessions.create(SessionId('sess-depth'), {
        meta: { delegationDepth: 1 },
      })
      const depthDecision = await runPreStep(ctx, {
        agent: makeAgentStub(depthOnlySession),
        turn: 1,
        step: 1,
        messages: [promptMsg],
      })
      expect(depthDecision.kind === 'enter' && depthDecision.messages).toHaveLength(1)

      // Turn 1, step 1 -> injects `<user_memory>` snapshot!
      const turn1Decision = await runPreStep(ctx, {
        agent,
        turn: 1,
        step: 1,
        messages: [promptMsg],
      })
      expect(turn1Decision.kind).toBe('enter')
      if (turn1Decision.kind !== 'enter') throw new Error('expected enter')
      expect(turn1Decision.messages).toHaveLength(2)
      const injected1 = turn1Decision.messages[1]
      if (injected1 === undefined) throw new Error('missing injected message')
      expect(injected1.source.kind).toBe('memory-context')
      if (injected1.source.kind === 'memory-context') {
        expect(injected1.source.turn).toBe(1)
        expect(injected1.source.items).toHaveLength(2)
      }

      // Persist Turn 1 messages to session log so projection records `lastDigest` and `lastSeq`.
      session.append('turn/start', { turn: 1 })
      session.append('user/message', promptMsg, { surfaceOp: 'append' })
      const memEvent = session.append('user/message', injected1, { surfaceOp: 'append' })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      // Turn 2 with unchanged memories -> skipped (100% KV-cache preservation!).
      const turn2Prompt = createUserMessage({
        content: [{ type: 'text', text: 'Now break down Q2 revenue.' }],
        source: { kind: 'user' },
      })
      const turn2Decision = await runPreStep(ctx, {
        agent,
        turn: 2,
        step: 1,
        messages: [turn2Prompt],
      })
      expect(turn2Decision.kind === 'enter' && turn2Decision.messages).toHaveLength(1)

      // Compaction replace outside `lastSeq` leaves `lastDigest` intact.
      const summaryBefore = createUserMessage({
        content: [{ type: 'text', text: 'earlier summary' }],
        source: { kind: 'user' },
      })
      const r1 = session.append('user/message', summaryBefore, {
        surfaceOp: { op: 'replace', startSeq: SessionSeq(1), endSeq: SessionSeq(1) },
        sourceEventSeqs: [SessionSeq(1)],
      })
      const afterUnrelatedReplace = await runPreStep(ctx, {
        agent,
        turn: 3,
        step: 1,
        messages: [turn2Prompt],
      })
      expect(afterUnrelatedReplace.kind === 'enter' && afterUnrelatedReplace.messages).toHaveLength(1)

      // Compaction replace covering `memEvent.seq` resets `lastDigest` -> Turn 3 re-injects!
      session.append('user/message', summaryBefore, {
        surfaceOp: { op: 'replace', startSeq: r1.seq, endSeq: memEvent.seq },
        sourceEventSeqs: [r1.seq, memEvent.seq],
      })
      const turn3Decision = await runPreStep(ctx, {
        agent,
        turn: 3,
        step: 1,
        messages: [turn2Prompt],
      })
      if (turn3Decision.kind !== 'enter') throw new Error('expected enter')
      expect(turn3Decision.messages).toHaveLength(2)
      const injected3 = turn3Decision.messages[1]
      if (injected3 === undefined) throw new Error('missing injected message')
      session.append('user/message', injected3, { surfaceOp: 'append' })

      // Editing a memory changes the digest -> Turn 4 re-injects updated snapshot!
      await ctx.memory.update({
        id: mem1.id,
        patch: { content: 'Use Markdown tables and executive summaries.' },
      })
      const turn4Decision = await runPreStep(
        ctx,
        { agent, turn: 4, step: 1, messages: [turn2Prompt, injected3] },
        { kind: 'enter', messages: [turn2Prompt, injected3] },
      )
      expect(turn4Decision.kind === 'enter' && turn4Decision.messages).toHaveLength(3)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('operates without workspace or without memory service and respects mid-select cancellation', async () => {
    const noMemCtx = await createContextHarness({ withMemory: false })
    try {
      const session = noMemCtx.sessions.create(SessionId('sess-nomem'))
      const promptMsg = createUserMessage({
        content: [{ type: 'text', text: 'Hello' }],
        source: { kind: 'user' },
      })
      const res = await runPreStep(noMemCtx, {
        agent: makeAgentStub(session),
        turn: 1,
        step: 1,
        messages: [promptMsg],
      })
      expect(res.kind === 'enter' && res.messages).toHaveLength(1)
    } finally {
      await noMemCtx.fiber.dispose()
    }

    const noWdCtx = await createContextHarness({ withMemory: true })
    try {
      await noWdCtx.memory.create({
        content: 'Global note',
        category: 'profile',
        scope: { kind: 'global' },
      })
      const session = noWdCtx.sessions.create(SessionId('sess-nowd'))
      const promptMsg = createUserMessage({
        content: [{ type: 'text', text: 'Hi' }],
        source: { kind: 'user' },
      })
      const okRes = await runPreStep(noWdCtx, {
        agent: makeAgentStub(session),
        turn: 1,
        step: 1,
        messages: [promptMsg],
      })
      expect(okRes.kind === 'enter' && okRes.messages).toHaveLength(2)

      // Mid-select abort returns original decision unchanged.
      const abortController = new AbortController()
      const origSelect = noWdCtx.memory.selectForContext.bind(noWdCtx.memory)
      noWdCtx.memory.selectForContext = async (req) => {
        const result = await origSelect(req)
        abortController.abort()
        return result
      }
      const abortedSession = noWdCtx.sessions.create(SessionId('sess-abort'))
      const abortedRes = await runPreStep(noWdCtx, {
        agent: makeAgentStub(abortedSession),
        turn: 1,
        step: 1,
        messages: [promptMsg],
        signal: abortController.signal,
      })
      expect(abortedRes.kind === 'enter' && abortedRes.messages).toHaveLength(1)
    } finally {
      await noWdCtx.fiber.dispose()
    }
  })
})
