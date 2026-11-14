/**
 * Silent background post-turn memory extractor and conflict resolver.
 *
 * Observes completed turns on non-subagent, non-incognito sessions, debounces
 * rapid consecutive turns per session, executes a bounded low-reasoning auxiliary
 * model call, and reconciles `ADD`, `UPDATE`, and `SUPERSEDE` memory operations
 * while blocking sensitive credentials.
 *
 * @module @deepseek-ai/dsh-memory-extractor
 */

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    /** Background post-turn durable memory extraction and conflict resolution. */
    'memory-extract': true
  }
}

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  BlockAssembler,
  createUserMessage,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type Message,
  type ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type { MemoryId, MemoryService } from '@deepseek-ai/dsh-memory'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionInput,
  parseExtractionResponse,
  resolveExtractedScope,
  truncateUtf8Bytes,
} from './parser.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'memory-extractor'

/** Host services required to observe session events and dispatch auxiliary model calls. */
export const inject = ['llm', 'sessions']

const DEFAULT_DEBOUNCE_MS = 1_500
const DEFAULT_MIN_USER_CHARS = 8
const DEFAULT_MAX_INPUT_BYTES = 8_192
const DEFAULT_MAX_OUTPUT_TOKENS = 1_024
const DEFAULT_TIMEOUT_MS = 30_000
const MEMORY_EXTRACT_TIMEOUT_CODE = 'MEMORY_EXTRACT_TIMEOUT'

/** Execution and debounce controls for background post-turn memory extraction. */
export interface Config {
  /** Per-session quiet window in milliseconds before running extraction; defaults to 1500. */
  debounceMs?: number
  /** Minimum trimmed user-prompt character length required to schedule extraction; defaults to 8. */
  minUserChars?: number
  /** Maximum UTF-8 bytes sent to the auxiliary extraction model; defaults to 8192. */
  maxInputBytes?: number
  /** Maximum output tokens allowed for the auxiliary extraction model; defaults to 1024. */
  maxOutputTokens?: number
  /** End-to-end deadline in milliseconds for one extraction model call; defaults to 30000. */
  timeoutMs?: number
  /** Optional explicit provider override; must be supplied together with `model`. */
  provider?: string
  /** Optional explicit model override; must be supplied together with `provider`. */
  model?: string
}

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  debounceMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(DEFAULT_DEBOUNCE_MS),
  minUserChars: z.number().step(1).min(1).max(1_000).default(DEFAULT_MIN_USER_CHARS),
  maxInputBytes: z.number().step(1).min(256).max(65_536).default(DEFAULT_MAX_INPUT_BYTES),
  maxOutputTokens: z.number().step(1).min(64).max(8_192).default(DEFAULT_MAX_OUTPUT_TOKENS),
  timeoutMs: z.number().step(1).min(100).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TIMEOUT_MS),
  provider: z.string(),
  model: z.string(),
})

interface ResolvedConfig {
  readonly debounceMs: number
  readonly minUserChars: number
  readonly maxInputBytes: number
  readonly maxOutputTokens: number
  readonly timeoutMs: number
  readonly provider?: string
  readonly model?: string
}

interface TurnBuffer {
  userParts: string[]
  assistantParts: string[]
  completedExchanges: Array<{ readonly user: string; readonly assistant: string }>
  timer?: ReturnType<typeof setTimeout>
  activeController?: AbortController
}

function resolveConfig(config: Config = {}): ResolvedConfig {
  const base = {
    debounceMs: config.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    minUserChars: config.minUserChars ?? DEFAULT_MIN_USER_CHARS,
    maxInputBytes: config.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
    maxOutputTokens: config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  const { provider, model } = config
  if (provider === undefined && model === undefined) return base
  if (provider === undefined || model === undefined) {
    throw new Error('memory-extractor: provider and model must be supplied together')
  }
  const trimmedProvider = provider.trim()
  const trimmedModel = model.trim()
  if (trimmedProvider.length === 0 || trimmedModel.length === 0) {
    throw new Error('memory-extractor: provider and model overrides must be non-empty strings')
  }
  return { ...base, provider: trimmedProvider, model: trimmedModel }
}

const selectLeastReasoning = (model: Readonly<LlmResolvedModelInfo>): ReasoningEffortId | undefined =>
  model.reasoning?.efforts[0]?.id

function joinTextBlocks(blocks: Message['content']): string {
  return blocks
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

async function runExtraction(
  ctx: Context,
  memory: MemoryService,
  session: Session,
  exchanges: readonly { readonly user: string; readonly assistant: string }[],
  route: { readonly provider: string; readonly model: string },
  config: ResolvedConfig,
  signal: AbortSignal,
): Promise<void> {
  const workspacePath = session.header.cwd
  const catalog = await memory.catalog({
    scopeKind: 'applicable',
    ...(workspacePath === undefined ? {} : { workspacePath }),
  })
  signal.throwIfAborted()

  const input = buildExtractionInput(
    exchanges,
    catalog.items,
    workspacePath !== undefined && workspacePath.trim().length > 0,
    config.maxInputBytes,
  )
  const messages = [
    createUserMessage({
      content: [{ type: 'text', text: input }],
      source: { kind: 'user' },
    }),
  ]

  using callDeadline = deadline(signal, config.timeoutMs, MEMORY_EXTRACT_TIMEOUT_CODE)
  const call = await ctx.llm.prepareCall(
    { ...route, maxTokens: config.maxOutputTokens },
    callDeadline.signal,
    (controls, model) => {
      const effort = selectLeastReasoning(model)
      return { ...controls, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
    },
  )
  const options: GenerateOptions = deepFreeze({
    ...call.config,
    messages,
    system: EXTRACTION_SYSTEM_PROMPT,
    sessionId: session.id,
    purpose: 'memory-extract',
    signal: callDeadline.signal,
  })

  const assembler = new BlockAssembler()
  for await (const chunk of call.stream(options)) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  if (assembler.finish.kind !== 'stop') return

  const rawText = assembler.blocks()
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  if (rawText.trim().length === 0) return

  const operations = parseExtractionResponse(rawText)
  if (operations.length === 0) return
  if (!memory.getPreferences().autoExtractEnabled || memory.isSessionIncognito(session.id)) return

  const autoSource = { kind: 'auto' as const, sessionId: session.id }
  for (const op of operations) {
    if (memory.containsSensitiveContent(op.content)) continue
    const scope = resolveExtractedScope(op.scope, workspacePath)
    try {
      if (op.op === 'ADD') {
        await memory.create({ content: op.content, category: op.category, scope, source: autoSource }, signal)
      } else if (op.op === 'UPDATE') {
        const targetId = brandString<MemoryId>(op.targetId)
        const updated = await memory.update({
          id: targetId,
          patch: { content: op.content, category: op.category, scope },
        }, signal)
        if ('code' in updated) {
          await memory.create({ content: op.content, category: op.category, scope, source: autoSource }, signal)
        }
      } else {
        const targetId = brandString<MemoryId>(op.targetId)
        await memory.supersede({
          targetId,
          content: op.content,
          category: op.category,
          scope,
          source: autoSource,
        }, signal)
      }
    } catch (error: unknown) {
      if (signal.aborted) return
      ctx.logger.warn(`memory-extractor: skipped operation ${op.op} in session "${session.id}": ${String(error)}`)
    }
  }
}

/**
 * Mount the post-turn background memory extraction listener.
 * @param ctx - Host plugin context.
 * @param config - validated debounce, byte, token, timeout, and optional route settings.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const buffers = new Map<Session, TurnBuffer>()
  const inflight = new Set<Promise<void>>()
  let stopping = false

  const stateFor = (session: Session): TurnBuffer => {
    let existing = buffers.get(session)
    if (existing === undefined) {
      existing = { userParts: [], assistantParts: [], completedExchanges: [] }
      buffers.set(session, existing)
    }
    return existing
  }

  const scheduleSession = (session: Session, state: TurnBuffer): void => {
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      delete state.timer
      const memory = ctx.get('memory')
      if (memory === undefined || !memory.getPreferences().autoExtractEnabled || memory.isSessionIncognito(session.id)) {
        state.completedExchanges.length = 0
        return
      }
      const headerRoute = session.requestHeader()?.config
      const route = resolved.provider !== undefined && resolved.model !== undefined
        ? { provider: resolved.provider, model: resolved.model }
        : (headerRoute === undefined ? undefined : { provider: headerRoute.provider, model: headerRoute.model })
      if (route === undefined || state.completedExchanges.length === 0) {
        state.completedExchanges.length = 0
        return
      }
      state.activeController?.abort()
      const controller = new AbortController()
      state.activeController = controller
      const exchanges = state.completedExchanges.splice(0, state.completedExchanges.length)
      const task = runExtraction(ctx, memory, session, exchanges, route, resolved, controller.signal)
        .catch((error: unknown) => {
          if (!controller.signal.aborted && !stopping) {
            ctx.logger.warn(`memory-extractor: extraction failed for session "${session.id}": ${String(error)}`)
          }
        })
        .finally(() => {
          if (state.activeController === controller) delete state.activeController
          inflight.delete(task)
          if (state.completedExchanges.length === 0 && state.timer === undefined && state.activeController === undefined) {
            buffers.delete(session)
          }
        })
      inflight.add(task)
    }, resolved.debounceMs)
  }

  const offEvent = ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (stopping || session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0) return
    const memory = ctx.get('memory')
    if (memory === undefined || !memory.getPreferences().autoExtractEnabled || memory.isSessionIncognito(session.id)) {
      return
    }

    if (event.type === 'turn/start') {
      const state = stateFor(session)
      state.userParts = []
      state.assistantParts = []
      return
    }
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      const text = joinTextBlocks(event.data.content)
      if (text.length > 0) {
        stateFor(session).userParts.push(truncateUtf8Bytes(text, resolved.maxInputBytes))
      }
      return
    }
    if (event.type === 'assistant/message') {
      const text = joinTextBlocks(event.data.message.content)
      if (text.length > 0) {
        stateFor(session).assistantParts.push(truncateUtf8Bytes(text, resolved.maxInputBytes))
      }
      return
    }
    if (event.type === 'turn/end') {
      const state = buffers.get(session)
      if (state === undefined) return
      const userText = state.userParts.join('\n').trim()
      const assistantText = state.assistantParts.join('\n').trim()
      state.userParts = []
      state.assistantParts = []
      if (userText.length < resolved.minUserChars) return
      state.completedExchanges.push({ user: userText, assistant: assistantText })
      if (state.completedExchanges.length > 4) state.completedExchanges.shift()
      scheduleSession(session, state)
    }
  })

  ctx.effect(() => async () => {
    stopping = true
    offEvent()
    for (const state of buffers.values()) {
      if (state.timer !== undefined) clearTimeout(state.timer)
      state.activeController?.abort()
    }
    buffers.clear()
    await Promise.allSettled([...inflight])
  })
}
