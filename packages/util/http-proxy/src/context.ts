/**
 * Per-call-tree outbound traffic attribution for dynamic proxy routing.
 *
 * Outbound callers (`llm`, `embedding`, `web`, `mcp`, `plugin`, `subscription`,
 * `diagnostics`) bind their traffic category and optional provider route around
 * async execution so the process-wide `undici` dispatcher can apply smart
 * split-tunneling rules without threading transport handles through third-party
 * SDK call stacks.
 * @module @deepseek-ai/dsh-http-proxy/context
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** Outbound capability family originating an HTTP(S) request. */
export type TrafficCategory =
  | 'llm'
  | 'embedding'
  | 'web'
  | 'mcp'
  | 'plugin'
  | 'subscription'
  | 'diagnostics'
  | 'general'

/**
 * Attribution attached to an async execution tree for dynamic proxy selection.
 */
export interface TrafficContext {
  /** Outbound capability family issuing the request. */
  readonly category: TrafficCategory
  /** Registered LLM or service provider route identifier when applicable. */
  readonly providerId?: string
  /**
   * When `true`, forces direct connection (bypassing any dynamic or environment
   * proxy) so direct-leg diagnostics and bootstrap probes never loop through a
   * tunnel under test.
   */
  readonly bypassProxy?: boolean
}

const trafficStorage = new AsyncLocalStorage<TrafficContext>()

/**
 * Read the {@link TrafficContext} bound to the current async execution frame.
 *
 * @returns the active context, or `undefined` when no caller tagged this frame.
 */
export function currentTrafficContext(): TrafficContext | undefined {
  return trafficStorage.getStore()
}

/**
 * Execute `fn` with `context` bound to the async execution tree. Nested calls
 * merge undefined fields from the enclosing context unless explicitly replaced.
 *
 * @param context - traffic category, optional provider route, and bypass flag.
 * @param fn - synchronous or asynchronous operation issuing outbound requests.
 * @returns the return value of `fn`.
 */
export function runWithTrafficContext<T>(context: TrafficContext, fn: () => T): T {
  const parent = trafficStorage.getStore()
  if (parent === undefined) return trafficStorage.run(context, fn)
  const providerId = context.providerId ?? parent.providerId
  const bypassProxy = context.bypassProxy ?? parent.bypassProxy
  const merged: TrafficContext = {
    category: context.category,
    ...(providerId !== undefined ? { providerId } : {}),
    ...(bypassProxy !== undefined ? { bypassProxy } : {}),
  }
  return trafficStorage.run(merged, fn)
}

/**
 * Wrap an `AsyncIterable` so every `.next()`, `.return()`, and `.throw()` turn
 * executes inside `context`. Streaming SDKs issue their underlying `fetch()`
 * lazily on the first `next()` pull rather than when the generator is created.
 *
 * @param context - traffic attribution to bind across stream pulls.
 * @param source - factory returning the underlying `AsyncIterable`.
 * @returns an `AsyncIterable` yielding identical items under `context`.
 */
export function streamWithTrafficContext<T>(
  context: TrafficContext,
  source: () => AsyncIterable<T>,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const iterator = runWithTrafficContext(context, () => source()[Symbol.asyncIterator]())
      const wrapped: AsyncIterator<T> = {
        next: () => runWithTrafficContext(context, () => iterator.next()),
      }
      if (iterator.return !== undefined) {
        const boundReturn = iterator.return.bind(iterator)
        wrapped.return = (value?: unknown) => runWithTrafficContext(context, () => boundReturn(value))
      }
      if (iterator.throw !== undefined) {
        const boundThrow = iterator.throw.bind(iterator)
        wrapped.throw = (error?: unknown) => runWithTrafficContext(context, () => boundThrow(error))
      }
      return wrapped
    },
  }
}
