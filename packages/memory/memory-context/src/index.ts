/**
 * Logged `<user_memory>` context snapshot injector for `agent/pre-step`.
 *
 * Appends a sourced snapshot message on turn entry (`step === 1`) only when the
 * canonical SHA-256 digest of selected active memories differs from the latest
 * uncompacted `memory-context` snapshot in the session surface, preserving prompt-cache prefixes.
 *
 * @module @deepseek-ai/dsh-memory-context
 */

import type { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { MemoryCitationItem, MemoryContextSource } from '@deepseek-ai/dsh-memory'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'

export type { MemoryCitationItem, MemoryContextSource }

/** Projected surface-snapshot state tracked per Session by `dsh-memory-context`. */
export interface MemoryContextProjectionState {
  /** Canonical SHA-256 digest of the latest active `memory-context` snapshot on the session surface, or null. */
  readonly lastDigest: string | null
  /** Event sequence of the latest active `memory-context` snapshot on the session surface, or null. */
  readonly lastSeq: SessionSeq | null
}

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'memory-context'

/** Services required to register the session projection and pre-step listener. */
export const inject = ['agents', 'sessionProjections']

const memoryContextStateSchema: zod.ZodType<MemoryContextProjectionState> = zod.object({
  lastDigest: zod.string().nullable(),
  lastSeq: zod.number().int().nonnegative().transform(SessionSeq).nullable(),
}).strict()

function extractQueryText(messages: readonly UserMessage[]): string {
  return messages
    .filter(message => message.source.kind !== name)
    .flatMap(message => message.content)
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * Register the `memoryContext` session projection and `agent/pre-step` snapshot listener.
 * @param ctx - plugin context; both registrations dispose with its fiber.
 * @returns resolution after the session projection is registered.
 */
export async function apply(ctx: Context): Promise<void> {
  const projectionReady = ctx.sessionProjections.register({
    key: 'memoryContext',
    stateVersion: 1,
    stateSchema: memoryContextStateSchema,
    init: () => ({
      lastDigest: null,
      lastSeq: null,
    }),
    apply: (state, event) => {
      let current = state
      if (
        typeof event.surfaceOp === 'object'
        && current.lastSeq !== null
        && event.sourceEventSeqs?.includes(current.lastSeq) === true
      ) {
        current = { lastDigest: null, lastSeq: null }
      }
      if (event.type === 'user/message' && event.data.source.kind === name) {
        return {
          lastDigest: event.data.source.digest,
          lastSeq: event.seq,
        }
      }
      return current
    },
  })

  ctx.on('agent/pre-step', async (
    { agent, turn, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const isAborted = (): boolean => signal.aborted
    const projectionHandle = await projectionReady
    ctx.fiber.assertActive()
    const decision = await next()
    if (
      decision.kind === 'reject'
      || isAborted()
      || step !== 1
      || decision.messages.length === 0
      || agent.session.header.origin === 'subagent'
      || (agent.session.header.delegationDepth ?? 0) > 0
    ) {
      return decision
    }
    const memory = ctx.get('memory')
    if (memory === undefined) return decision

    const workspacePath = agent.session.header.cwd
    const queryText = extractQueryText(decision.messages)
    const selection = await memory.selectForContext({
      sessionId: agent.session.id,
      ...(workspacePath === undefined ? {} : { workspacePath }),
      queryText,
      signal,
    })
    if (isAborted() || selection.items.length === 0) return decision

    const state = projectionHandle.stateOf(agent.session)
    if (selection.digest === state.lastDigest) return decision

    const snapshotMessage = createUserMessage({
      content: [{ type: 'text', text: selection.formattedText }],
      source: {
        kind: name,
        form: 'snapshot',
        sections: [{ name, text: selection.formattedText }],
        turn,
        digest: selection.digest,
        items: selection.items,
      },
    })
    return {
      ...decision,
      messages: [...decision.messages, snapshotMessage],
    }
  }, { prepend: true })

  await projectionReady
}
