import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  ReasoningEffortId,
  createAssistantMessage,
  createUserMessage,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import MemoryService from '@deepseek-ai/dsh-memory'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageSqlitePlugin from '@deepseek-ai/dsh-storage-sqlite'
import { describe, expect, it } from 'vitest'
import * as extractorPlugin from '../src/index.ts'
import {
  buildExtractionInput,
  parseExtractionResponse,
  resolveExtractedScope,
  truncateUtf8Bytes,
} from '../src/parser.ts'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  handler: (options: GenerateOptions) => AsyncIterable<StreamChunk>

  constructor(
    handler: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
    private readonly reasoningEfforts?: readonly string[],
  ) {
    super()
    this.handler = handler
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...(this.reasoningEfforts === undefined
        ? {}
        : { reasoning: { efforts: this.reasoningEfforts.map(id => ({ id: ReasoningEffortId(id), name: id })) } }),
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * this.handler(options)
  }
}

function chunksFromText(text: string, finishKind: 'stop' | 'max-tokens' = 'stop'): AsyncIterable<StreamChunk> {
  return (async function * () {
    if (text.length > 0) {
      yield { type: 'text-delta', index: 0, text }
    }
    yield { type: 'finish', reason: { kind: finishKind } }
  })()
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('memory-extractor parser helpers', () => {
  it('truncates UTF-8 cleanly, builds bounded prompts, resolves scopes, and parses JSON or fenced JSON', () => {
    expect(truncateUtf8Bytes('hello', 10)).toBe('hello')
    expect(truncateUtf8Bytes('你好世界', 7)).toBe('你好')

    const input = buildExtractionInput(
      [{ user: 'I prefer Markdown tables.', assistant: 'Noted.' }],
      [],
      true,
      512,
    )
    expect(Buffer.byteLength(input, 'utf8')).toBeLessThanOrEqual(512)
    expect(buildExtractionInput([], [], false, 256).length).toBeGreaterThan(0)

    expect(resolveExtractedScope('workspace', '/repo/a')).toEqual({ kind: 'workspace', workspacePath: '/repo/a' })
    expect(resolveExtractedScope('workspace', '   ')).toEqual({ kind: 'global' })
    expect(resolveExtractedScope('workspace', undefined)).toEqual({ kind: 'global' })
    expect(resolveExtractedScope('global', '/repo/a')).toEqual({ kind: 'global' })

    const fenced = [
      '```json',
      JSON.stringify({
        operations: [
          { op: 'NOOP' },
          { op: 'ADD', content: 'Use metric units.', category: 'preference', scope: 'global' },
        ],
      }),
      '```',
    ].join('\n')
    expect(parseExtractionResponse(fenced)).toEqual([
      { op: 'ADD', content: 'Use metric units.', category: 'preference', scope: 'global' },
    ])
    expect(() => parseExtractionResponse('not-json')).toThrow()
  })
})

describe('dsh-memory-extractor plugin', () => {
  it('validates config overrides and skips missing-memory or subagent/incognito sessions', async () => {
    const badCtx1 = new Context()
    await badCtx1.plugin(LlmRuntime)
    await badCtx1.plugin(SessionStore)
    expect(() => {
      extractorPlugin.apply(badCtx1, { provider: 'only-provider' })
    }).toThrow('provider and model must be supplied together')
    expect(() => {
      extractorPlugin.apply(badCtx1, { model: 'only-model' })
    }).toThrow('provider and model must be supplied together')
    expect(() => {
      extractorPlugin.apply(badCtx1, { provider: '  ', model: 'm' })
    }).toThrow('provider and model overrides must be non-empty strings')
    expect(() => {
      extractorPlugin.apply(badCtx1, { provider: 'p', model: '  ' })
    }).toThrow('provider and model overrides must be non-empty strings')
    await badCtx1.fiber.dispose()

    // Without MemoryService mounted, events are safely ignored (also exercises apply() default config).
    const noMemCtx = new Context()
    await noMemCtx.plugin(LlmRuntime)
    await noMemCtx.plugin(SessionStore)
    extractorPlugin.apply(noMemCtx)
    const sNoMem = noMemCtx.sessions.create(SessionId('s-nomem'))
    sNoMem.append('turn/start', { turn: 1 })
    sNoMem.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await noMemCtx.fiber.dispose()
  })

  it('debounces rapid turns, executes ADD/UPDATE/SUPERSEDE, filters secrets, and handles errors and cancellation', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageSqlitePlugin, { path: ':memory:' })
    await ctx.plugin(storageDomainPlugin, { backend: 'sqlite' })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(MemoryService, { maxEntries: 3 })

    const adapter = new ScriptedAdapter(
      () => chunksFromText(JSON.stringify({ operations: [] })),
      ['low', 'high'],
    )
    ctx.llm.registerAdapter(['ext-route'], adapter)
    await ctx.plugin(extractorPlugin, {
      debounceMs: 15,
      minUserChars: 6,
      maxInputBytes: 2048,
      maxOutputTokens: 256,
      timeoutMs: 5_000,
    })

    try {
      const existing = await ctx.memory.create({
        content: 'Write weekly reports in Word.',
        category: 'preference',
        scope: { kind: 'global' },
      })
      const toSupersede = await ctx.memory.create({
        content: 'Target audience is internal engineers.',
        category: 'fact',
        scope: { kind: 'workspace', workspacePath: '/ws/proj' },
      })

      // Subagent sessions are ignored.
      const subSess = ctx.sessions.create(SessionId('s-sub'), { meta: { origin: 'subagent', delegationDepth: 1 } })
      subSess.append('turn/start', { turn: 1 })
      subSess.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      const depthSess = ctx.sessions.create(SessionId('s-depth'), { meta: { delegationDepth: 1 } })
      depthSess.append('turn/start', { turn: 1 })

      // Unopened turn/end and short prompts are ignored.
      const sess = ctx.sessions.create(SessionId('s-main'), { meta: { cwd: '/ws/proj' } })
      sess.append('turn/end', { turn: 0, reason: { kind: 'completed' } })

      sess.append('turn/start', { turn: 1 })
      sess.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '   ' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      sess.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      sess.append('assistant/message', {
        turn: 1,
        step: 1,
        stream: [],
        message: createAssistantMessage({
          content: [{ type: 'text', text: '   ' }],
          source: { provider: 'ext-route', model: 'm1' },
        }),
      }, { surfaceOp: 'append' })
      sess.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      // Turn without route clears exchanges harmlessly when timer fires.
      sess.append('turn/start', { turn: 2 })
      sess.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Remember that I work in product strategy.' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      sess.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      await wait(35)
      expect(adapter.requests).toHaveLength(0)

      // Rapid >4 turns coalesce on debounce timer and execute ADD + UPDATE (live + missing fallback) + SUPERSEDE + secret filter.
      adapter.handler = () => chunksFromText(JSON.stringify({
        operations: [
          {
            op: 'ADD',
            content: 'sk-secretkey1234567890abcdef',
            category: 'fact',
            scope: 'global',
          },
          {
            op: 'UPDATE',
            targetId: existing.id,
            content: 'Write weekly reports in Markdown.',
            category: 'preference',
            scope: 'global',
          },
          {
            op: 'SUPERSEDE',
            targetId: toSupersede.id,
            content: 'Target audience is executive leadership.',
            category: 'fact',
            scope: 'workspace',
          },
          {
            op: 'UPDATE',
            targetId: 'mem-nonexistent',
            content: 'Include executive summary bullets at the top.',
            category: 'workflow',
            scope: 'global',
          },
          {
            op: 'ADD',
            content: 'Fifth live entry triggers capacity warning.',
            category: 'fact',
            scope: 'global',
          },
        ],
      }))

      sess.append('request/header', {
        reason: 'initial',
        header: {
          config: { provider: 'ext-route', model: 'ext-model' },
        },
      })
      for (let t = 3; t <= 8; t += 1) {
        sess.append('turn/start', { turn: t })
        sess.append('user/message', createUserMessage({
          content: [{ type: 'text', text: `Turn ${String(t)}: update our reporting preferences and audience.` }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        sess.append('assistant/message', {
          turn: t,
          step: 1,
          stream: [],
          message: createAssistantMessage({
            content: [{ type: 'text', text: `Acknowledged turn ${String(t)}.` }],
            source: { provider: 'ext-route', model: 'ext-model' },
          }),
        }, { surfaceOp: 'append' })
        sess.append('turn/end', { turn: t, reason: { kind: 'completed' } })
      }

      await wait(60)
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.reasoningEffort).toBe('low')

      const catalog = await ctx.memory.catalog({ includeSuperseded: true })
      const contents = catalog.items.map(item => item.content)
      expect(contents).toContain('Write weekly reports in Markdown.')
      expect(contents).toContain('Target audience is executive leadership.')
      expect(contents).toContain('Include executive summary bullets at the top.')
      expect(contents.some(text => text.includes('sk-secretkey'))).toBe(false)
      expect(catalog.items.find(item => item.id === toSupersede.id)?.status).toBe('superseded')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('handles explicit route config, non-stop/empty/NOOP responses, mid-flight policy toggles, overlapping turns, and stop abort', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageSqlitePlugin, { path: ':memory:' })
    await ctx.plugin(storageDomainPlugin, { backend: 'sqlite' })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(MemoryService)

    const adapter = new ScriptedAdapter(() => chunksFromText('', 'max-tokens'))
    ctx.llm.registerAdapter(['pinned-provider'], adapter)
    await ctx.plugin(extractorPlugin, {
      debounceMs: 10,
      minUserChars: 4,
      provider: 'pinned-provider',
      model: 'pinned-model',
    })

    const emitTurn = (session: Session, turn: number, text: string) => {
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }

    try {
      const s1 = ctx.sessions.create(SessionId('s-pinned'))

      // 1) max-tokens finish is ignored.
      emitTurn(s1, 1, 'First turn with max-tokens')
      await wait(30)

      // 2) empty text response is ignored.
      adapter.handler = () => chunksFromText('   ', 'stop')
      emitTurn(s1, 2, 'Second turn with blank text')
      await wait(30)

      // 3) NOOP-only response is ignored.
      adapter.handler = () => chunksFromText(JSON.stringify({ operations: [{ op: 'NOOP' }] }), 'stop')
      emitTurn(s1, 3, 'Third turn with NOOP')
      await wait(30)

      // 4) Malformed JSON logs warning without throwing.
      adapter.handler = () => chunksFromText('{broken json', 'stop')
      emitTurn(s1, 4, 'Fourth turn with invalid JSON')
      await wait(30)

      // 5) Incognito toggled before timer fires clears buffer without calling LLM.
      const beforeCalls = adapter.requests.length
      emitTurn(s1, 5, 'Turn scheduled right before incognito')
      await ctx.memory.setSessionPolicy({ sessionId: s1.id, incognito: true })
      await wait(30)
      expect(adapter.requests.length).toBe(beforeCalls)
      await ctx.memory.setSessionPolicy({ sessionId: s1.id, incognito: false })

      // 6) Policy disabled mid-stream skips applying operations.
      adapter.handler = async function * () {
        await ctx.memory.setPreferences({ autoExtractEnabled: false })
        yield {
          type: 'text-delta',
          index: 0,
          text: JSON.stringify({
            operations: [{ op: 'ADD', content: 'Should not save', category: 'fact', scope: 'global' }],
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      emitTurn(s1, 6, 'Turn where preference flips mid-stream')
      await wait(35)
      expect((await ctx.memory.catalog()).items).toHaveLength(0)
      await ctx.memory.setPreferences({ autoExtractEnabled: true })

      // 7) Operation failure on mid-loop abort exits silently, and overlapping extraction + ctx.fiber.dispose() clean up.
      const abortOnCreateController = new AbortController()
      const origCreate = ctx.memory.create.bind(ctx.memory)
      let abortNextCreate = true
      ctx.memory.create = async (req, sig) => {
        if (abortNextCreate) {
          abortNextCreate = false
          s1.append('turn/start', { turn: 99 })
          s1.append('user/message', createUserMessage({
            content: [{ type: 'text', text: 'Superseding turn aborts active create' }],
            source: { kind: 'user' },
          }), { surfaceOp: 'append' })
          s1.append('turn/end', { turn: 99, reason: { kind: 'completed' } })
          await wait(15)
          sig?.throwIfAborted()
        }
        return origCreate(req, sig)
      }
      adapter.handler = () => chunksFromText(JSON.stringify({
        operations: [{ op: 'ADD', content: 'Aborted during create', category: 'fact', scope: 'global' }],
      }), 'stop')
      emitTurn(s1, 7, 'Turn that aborts inside create')
      await wait(45)
      void abortOnCreateController

      adapter.handler = async function * (options) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 200)
          options.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
          }, { once: true })
        })
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      emitTurn(s1, 100, 'Slow turn one')
      await wait(18)
      emitTurn(s1, 101, 'Slow turn two superseding one')
      await wait(18)
      const s2 = ctx.sessions.create(SessionId('s-timer-stop'))
      emitTurn(s2, 1, 'Pending timer turn on stop')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
