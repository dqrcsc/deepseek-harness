/**
 * Unit tests for `memoryTurnDefinition` and `selectTurnMemoryCitations`.
 */

import { describe, expect, it } from 'vitest'
import type {
  ConversationLocationDataSource,
  ConversationLocationDataStore,
  ConversationTurnDataMap,
  TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MemoryCitationItem, MemoryId } from '@deepseek-ai/dsh-memory/client'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  memoryTurnDefinition,
  selectTurnMemoryCitations,
  type MemoryTurnData,
} from '../src/client/memory-turn.ts'

const MSG_ID = 'msg-1' as SessionEvent<'user/message'>['data']['id']

const ITEM_A: MemoryCitationItem = {
  id: 'mem-a' as MemoryId,
  content: 'Use pnpm in TypeScript monorepos.',
  category: 'workflow',
  scope: { kind: 'global' },
  pinned: false,
  sourceKind: 'user',
}

const ITEM_B: MemoryCitationItem = {
  id: 'mem-b' as MemoryId,
  content: 'Run vitest before committing.',
  category: 'preference',
  scope: { kind: 'workspace', workspacePath: '/repo/app' },
  pinned: true,
  sourceKind: 'auto',
}

class StubTurnStore implements ConversationLocationDataStore<ConversationTurnDataMap> {
  private readonly map = new Map<string, unknown>()

  get<K extends Extract<keyof ConversationTurnDataMap, string>>(
    key: K,
  ): Readonly<ConversationTurnDataMap[K]> | undefined {
    return this.map.get(key) as Readonly<ConversationTurnDataMap[K]> | undefined
  }

  source<K extends Extract<keyof ConversationTurnDataMap, string>>(
    key: K,
  ): ConversationLocationDataSource<Readonly<ConversationTurnDataMap[K]> | undefined> {
    return {
      getSnapshot: () => this.get(key),
      subscribe: () => () => {},
    }
  }

  set(data: MemoryTurnData): void {
    this.map.set('memory-citations', data)
  }
}

function makeTurn(data?: MemoryTurnData): TurnLocation {
  const store = new StubTurnStore()
  if (data !== undefined) store.set(data)
  return {
    turn: 1,
    start: undefined,
    status: 'closed',
    steps: [],
    data: store,
    end: undefined,
  }
}

describe('selectTurnMemoryCitations', () => {
  it('returns empty array when no citations were recorded and items when present', () => {
    expect(selectTurnMemoryCitations({ turn: makeTurn() })).toEqual([])
    expect(selectTurnMemoryCitations({ turn: makeTurn({ items: [ITEM_A] }) })).toEqual([ITEM_A])
  })
})

describe('memoryTurnDefinition', () => {
  const turnStartEvent: SessionEvent<'turn/start'> = {
    seq: SessionSeq(1),
    time: 100,
    type: 'turn/start',
    data: { turn: 2 },
  }

  const memoryAppendEvent = (items: readonly MemoryCitationItem[]): SessionEvent<'user/message'> => ({
    seq: SessionSeq(2),
    time: 101,
    type: 'user/message',
    surfaceOp: 'append',
    data: {
      id: MSG_ID,
      role: 'user',
      content: [{ type: 'text', text: '<user_memory/>' }],
      source: {
        kind: 'memory-context',
        form: 'snapshot',
        sections: [{ name: 'memory-context', text: '<user_memory/>' }],
        turn: 2,
        digest: 'sha256:abc',
        items,
      },
    },
  })

  const memoryReplaceEvent: SessionEvent<'user/message'> = {
    seq: SessionSeq(3),
    time: 102,
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: SessionSeq(2), endSeq: SessionSeq(2) },
    sourceEventSeqs: [SessionSeq(2)],
    data: {
      id: MSG_ID,
      role: 'user',
      content: [{ type: 'text', text: '<user_memory/>' }],
      source: {
        kind: 'memory-context',
        form: 'snapshot',
        sections: [{ name: 'memory-context', text: '<user_memory/>' }],
        turn: 2,
        digest: 'sha256:abc',
        items: [ITEM_A],
      },
    },
  }

  const humanMessageEvent: SessionEvent<'user/message'> = {
    seq: SessionSeq(4),
    time: 103,
    type: 'user/message',
    surfaceOp: 'append',
    data: {
      id: MSG_ID,
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    },
  }

  const turnEndEvent: SessionEvent<'turn/end'> = {
    seq: SessionSeq(5),
    time: 104,
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'completed' } },
  }

  it('matches turn/start and append memory-context user/message events only', () => {
    expect(memoryTurnDefinition.match(turnStartEvent)).toEqual({ id: '2', role: 'start' })
    expect(memoryTurnDefinition.match(memoryAppendEvent([ITEM_A]))).toEqual({ id: '2', role: 'update' })
    expect(memoryTurnDefinition.match(memoryReplaceEvent)).toBeNull()
    expect(memoryTurnDefinition.match(humanMessageEvent)).toBeNull()
    expect(memoryTurnDefinition.match(turnEndEvent)).toBeNull()
  })

  it('starts on turn/start and throws on unexpected start events', () => {
    const initial = memoryTurnDefinition.start?.(
      {} as never,
      { id: '2', role: 'start', seq: 1, event: turnStartEvent } as never,
      undefined as never,
    )
    expect(initial).toEqual({ turn: 2, items: [] })

    expect(() => memoryTurnDefinition.start?.(
      {} as never,
      { id: '2', role: 'start', seq: 5, event: turnEndEvent } as never,
      undefined as never,
    )).toThrow('memory-citations start requires turn/start')
  })

  it('deduplicates cited items across updates and preserves state when nothing new arrives', () => {
    const base = { turn: 2, items: [] as readonly MemoryCitationItem[] }

    // Non-matching update events leave state untouched.
    expect(memoryTurnDefinition.update?.(
      { state: base } as never,
      { id: '2', role: 'update', seq: 5, event: turnEndEvent } as never,
    )).toBe(base)
    expect(memoryTurnDefinition.update?.(
      { state: base } as never,
      { id: '2', role: 'update', seq: 4, event: humanMessageEvent } as never,
    )).toBe(base)

    // Empty incoming citation array leaves state untouched.
    expect(memoryTurnDefinition.update?.(
      { state: base } as never,
      { id: '2', role: 'update', seq: 2, event: memoryAppendEvent([]) } as never,
    )).toBe(base)

    // Duplicate IDs within a single incoming batch and across subsequent batches are deduplicated.
    const next = memoryTurnDefinition.update?.(
      { state: base } as never,
      { id: '2', role: 'update', seq: 2, event: memoryAppendEvent([ITEM_A, ITEM_A, ITEM_B]) } as never,
    )
    expect(next).toEqual({ turn: 2, items: [ITEM_A, ITEM_B] })

    const unchanged = memoryTurnDefinition.update?.(
      { state: next } as never,
      { id: '2', role: 'update', seq: 3, event: memoryAppendEvent([ITEM_A, ITEM_B]) } as never,
    )
    expect(unchanged).toBe(next)
  })

  it('builds Turn location data and reuses identical previous publication', () => {
    const state = { turn: 2, items: [ITEM_A] }
    expect(memoryTurnDefinition.buildLocationData?.({ state } as never, 'step', null)).toBeNull()
    expect(memoryTurnDefinition.buildLocationData?.({ state: undefined } as never, 'turn', null)).toBeNull()

    const published = memoryTurnDefinition.buildLocationData?.({ state } as never, 'turn', null) ?? null
    expect(published).toEqual({
      kind: 'turn',
      turn: 2,
      key: 'memory-citations',
      value: { items: state.items },
    })

    const reused = memoryTurnDefinition.buildLocationData?.({ state } as never, 'turn', published)
    expect(reused).toBe(published)

    const otherKey = memoryTurnDefinition.buildLocationData?.(
      { state } as never,
      'turn',
      { kind: 'turn', turn: 2, key: 'other-key', value: {} } as never,
    )
    expect(otherKey).toEqual(published)

    const freshAfterChange = memoryTurnDefinition.buildLocationData?.(
      { state: { turn: 2, items: [ITEM_A, ITEM_B] } } as never,
      'turn',
      published,
    )
    expect(freshAfterChange).not.toBe(published)
    expect(freshAfterChange).toEqual({
      kind: 'turn',
      turn: 2,
      key: 'memory-citations',
      value: { items: [ITEM_A, ITEM_B] },
    })
  })
})
