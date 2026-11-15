import { describe, expect, it } from 'vitest'
import {
  currentTrafficContext,
  runWithTrafficContext,
  streamWithTrafficContext,
  type TrafficContext,
} from '../src/index.ts'

describe('TrafficContext propagation', () => {
  it('returns undefined outside a tagged execution tree', () => {
    expect(currentTrafficContext()).toBeUndefined()
  })

  it('propagates category, providerId, and bypassProxy across async continuations and merges nested overrides', async () => {
    const observed: (TrafficContext | undefined)[] = []
    await runWithTrafficContext({ category: 'llm', providerId: 'openai', bypassProxy: false }, async () => {
      await Promise.resolve()
      observed.push(currentTrafficContext())
      await runWithTrafficContext({ category: 'web' }, async () => {
        await Promise.resolve()
        observed.push(currentTrafficContext())
      })
      await runWithTrafficContext({ category: 'diagnostics', providerId: 'gemini', bypassProxy: true }, async () => {
        await Promise.resolve()
        observed.push(currentTrafficContext())
      })
    })
    await runWithTrafficContext({ category: 'mcp' }, async () => {
      await runWithTrafficContext({ category: 'plugin' }, async () => {
        observed.push(currentTrafficContext())
      })
    })
    expect(observed).toEqual([
      { category: 'llm', providerId: 'openai', bypassProxy: false },
      { category: 'web', providerId: 'openai', bypassProxy: false },
      { category: 'diagnostics', providerId: 'gemini', bypassProxy: true },
      { category: 'plugin' },
    ])
    expect(currentTrafficContext()).toBeUndefined()
  })

  it('binds TrafficContext across lazy AsyncIterable next, return, and throw turns', async () => {
    const seen: (TrafficContext | undefined)[] = []
    let cleanedUp = false

    async function* generator(): AsyncGenerator<number> {
      seen.push(currentTrafficContext())
      try {
        yield 1
        seen.push(currentTrafficContext())
        yield 2
      } finally {
        cleanedUp = currentTrafficContext()?.providerId === 'anthropic'
      }
    }

    const wrapped = streamWithTrafficContext(
      { category: 'llm', providerId: 'anthropic' },
      () => generator(),
    )

    const iter = wrapped[Symbol.asyncIterator]()
    expect(await iter.next()).toEqual({ value: 1, done: false })
    expect(await iter.return?.('stop')).toEqual({ value: 'stop', done: true })
    expect(cleanedUp).toBe(true)
    expect(seen).toEqual([{ category: 'llm', providerId: 'anthropic' }])

    let caughtContext: TrafficContext | undefined
    async function* throwingTarget(): AsyncGenerator<number> {
      try {
        yield 10
      } catch {
        caughtContext = currentTrafficContext()
      }
    }
    const throwStream = streamWithTrafficContext({ category: 'embedding', providerId: 'voyage' }, () => throwingTarget())
    const throwIter = throwStream[Symbol.asyncIterator]()
    expect(await throwIter.next()).toEqual({ value: 10, done: false })
    expect(await throwIter.throw?.(new Error('boom'))).toEqual({ value: undefined, done: true })
    expect(caughtContext).toEqual({ category: 'embedding', providerId: 'voyage' })
  })

  it('handles bare AsyncIterators without return or throw methods', async () => {
    let observedInNext: TrafficContext | undefined
    const bare: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        let done = false
        return {
          async next() {
            observedInNext = currentTrafficContext()
            if (done) return { value: undefined, done: true }
            done = true
            return { value: 'ok', done: false }
          },
        }
      },
    }
    const wrapped = streamWithTrafficContext({ category: 'subscription' }, () => bare)
    const items: string[] = []
    for await (const item of wrapped) items.push(item)
    expect(items).toEqual(['ok'])
    expect(observedInNext).toEqual({ category: 'subscription' })
  })
})
