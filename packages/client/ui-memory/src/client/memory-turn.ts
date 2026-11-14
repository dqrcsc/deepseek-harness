/**
 * Turn-scoped cited-memory projection for `memory-context` snapshots.
 *
 * Accumulates the cited items carried on `user/message` events whose `source.kind`
 * is `'memory-context'` against the entered Turn, enabling the `conversation.chat.turnTail`
 * pill to list and manage every memory referenced during that Turn.
 */

import type {
  ConversationNodeDefinition,
  TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MemoryCitationItem } from '@deepseek-ai/dsh-memory/client'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'

/** Cited memories published against one Turn in `ConversationTurnDataMap`. */
export interface MemoryTurnData {
  readonly items: readonly MemoryCitationItem[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Memories injected via `memory-context` snapshots on this Turn, deduplicated in order. */
    'memory-citations': MemoryTurnData
  }
}

/** Turn-tail owner currency read by the citation pill. */
export interface MemoryTurnOwner {
  readonly turn: TurnLocation
}

interface MemoryTurnState {
  readonly turn: number
  readonly items: readonly MemoryCitationItem[]
}

/**
 * Read the deduplicated memory citations recorded on one Turn.
 * @param owner - Turn-tail owner props carrying the Turn location.
 * @returns cited items for the Turn; empty when no memories were injected.
 */
export function selectTurnMemoryCitations(owner: MemoryTurnOwner): readonly MemoryCitationItem[] {
  return owner.turn.data.get('memory-citations')?.items ?? []
}

/** Turn-local `memory-context` citation accumulator; publishes Turn location data without a standalone chat node. */
export const memoryTurnDefinition: ConversationNodeDefinition<MemoryTurnState> = {
  kind: 'memory-citations',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (
      event.type === 'user/message'
      && isAppendSurfaceEvent(event)
      && event.data.source.kind === 'memory-context'
    ) {
      return { id: String(event.data.source.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('memory-citations start requires turn/start')
    return { turn: match.event.data.turn, items: [] }
  },
  update: (context, match) => {
    if (match.event.type !== 'user/message' || match.event.data.source.kind !== 'memory-context') {
      return context.state
    }
    const incoming = match.event.data.source.items
    if (incoming.length === 0) return context.state
    const seen = new Set(context.state.items.map(item => item.id))
    const additions = incoming.filter((item) => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
    if (additions.length === 0) return context.state
    return {
      ...context.state,
      items: [...context.state.items, ...additions],
    }
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined) return null
    if (
      previous?.kind === 'turn'
      && previous.turn === context.state.turn
      && previous.key === 'memory-citations'
      && previous.value.items === context.state.items
    ) {
      return previous
    }
    return {
      kind: 'turn',
      turn: context.state.turn,
      key: 'memory-citations',
      value: { items: context.state.items },
    }
  },
}
