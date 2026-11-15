/**
 * End-to-end 1-click connectivity diagnostics runner for representative domestic and overseas endpoints.
 * @module @deepseek-ai/dsh-network-proxy/diagnostics
 */

import { runWithTrafficContext, type TrafficContext } from '@deepseek-ai/dsh-http-proxy'
import type { DiagnosticTargetResult, NetworkDiagnosticReport, NetworkProxyMode } from './types.ts'

/** Specification of one diagnostic endpoint probed by {@link runConnectivityDiagnostics}. */
export interface DiagnosticTargetSpec {
  /** Stable target identifier (`deepseek`, `openai`, `anthropic`, `gemini`, `github`, `google`). */
  readonly id: string
  /** Human-readable target label. */
  readonly label: string
  /** HTTP(S) URL requested during diagnostics. */
  readonly url: string
  /** Outbound traffic attribution passed through `runWithTrafficContext`. */
  readonly trafficContext: TrafficContext
}

/** Default diagnostic targets covering domestic DeepSeek plus overseas LLM, GitHub, and Google endpoints. */
export const DEFAULT_DIAGNOSTIC_TARGETS: readonly DiagnosticTargetSpec[] = Object.freeze([
  {
    id: 'deepseek',
    label: 'DeepSeek API',
    url: 'https://api.deepseek.com/models',
    trafficContext: { category: 'llm', providerId: 'deepseek-official' },
  },
  {
    id: 'openai',
    label: 'OpenAI API',
    url: 'https://api.openai.com/v1/models',
    trafficContext: { category: 'llm', providerId: 'openai' },
  },
  {
    id: 'anthropic',
    label: 'Anthropic API',
    url: 'https://api.anthropic.com/v1/messages',
    trafficContext: { category: 'llm', providerId: 'anthropic' },
  },
  {
    id: 'gemini',
    label: 'Google Gemini API',
    url: 'https://generativelanguage.googleapis.com/',
    trafficContext: { category: 'llm', providerId: 'google' },
  },
  {
    id: 'github',
    label: 'GitHub API',
    url: 'https://api.github.com/zen',
    trafficContext: { category: 'web' },
  },
  {
    id: 'google',
    label: 'Google 204',
    url: 'https://www.google.com/generate_204',
    trafficContext: { category: 'web' },
  },
])

/** Resolved routing attribution for one diagnostic target. */
export interface EvaluatedDiagnosticRoute {
  /** Effective route disposition (`direct`, `proxy`, or `reject`). */
  readonly route: 'direct' | 'proxy' | 'reject'
  /** Active proxy node label when `route === 'proxy'`. */
  readonly nodeName?: string
}

/** Parameters for {@link runConnectivityDiagnostics}. */
export interface RunDiagnosticsOptions {
  /** Active routing mode at the start of the diagnostic run. */
  readonly mode: NetworkProxyMode
  /** Currently selected proxy node label, or `null` when unavailable. */
  readonly selectedNodeName: string | null
  /** Targets to probe concurrently. */
  readonly targets: readonly DiagnosticTargetSpec[]
  /** Per-target request timeout in milliseconds. */
  readonly timeoutMs: number
  /** Synchronous route evaluator matching the active dynamic proxy router. */
  readonly evaluateRoute: (url: URL, context: TrafficContext) => EvaluatedDiagnosticRoute
  /** Error redactor stripping secret URLs, hostnames, and IP literals. */
  readonly redactError: (error: unknown) => string
  /** Optional cancellation signal. */
  readonly signal?: AbortSignal
}

async function probeSingleTarget(
  target: DiagnosticTargetSpec,
  options: RunDiagnosticsOptions,
): Promise<DiagnosticTargetResult> {
  const parsedUrl = new URL(target.url)
  const evaluated = options.evaluateRoute(parsedUrl, target.trafficContext)
  if (evaluated.route === 'reject') {
    return {
      id: target.id,
      label: target.label,
      url: target.url,
      route: 'reject',
      ok: false,
      latencyMs: null,
      error: 'Rejected by routing rule',
    }
  }

  const timeoutSignal = AbortSignal.timeout(options.timeoutMs)
  const combinedSignal = options.signal !== undefined
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal

  const startedAt = performance.now()
  try {
    const response = await runWithTrafficContext(target.trafficContext, () =>
      fetch(target.url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': 'dsh-network-diagnostics/1.0',
          accept: '*/*',
        },
        signal: combinedSignal,
      }))
    await response.body?.cancel()
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt))
    const ok = response.status > 0 && response.status < 500 && response.status !== 407
    return {
      id: target.id,
      label: target.label,
      url: target.url,
      route: evaluated.route,
      ...(evaluated.nodeName !== undefined ? { nodeName: evaluated.nodeName } : {}),
      ok,
      statusCode: response.status,
      latencyMs,
      ...(ok ? {} : { error: `HTTP ${String(response.status)}` }),
    }
  } catch (error: unknown) {
    return {
      id: target.id,
      label: target.label,
      url: target.url,
      route: evaluated.route,
      ...(evaluated.nodeName !== undefined ? { nodeName: evaluated.nodeName } : {}),
      ok: false,
      latencyMs: null,
      error: options.redactError(error),
    }
  }
}

/**
 * Probe all configured diagnostic endpoints concurrently through the active process-wide `fetch()` dispatcher.
 * @param options - diagnostic targets, timeout, route evaluator, and error redactor.
 * @returns structured {@link NetworkDiagnosticReport}.
 */
export async function runConnectivityDiagnostics(options: RunDiagnosticsOptions): Promise<NetworkDiagnosticReport> {
  const targets = await Promise.all(options.targets.map(target => probeSingleTarget(target, options)))
  return {
    checkedAt: new Date().toISOString(),
    mode: options.mode,
    selectedNodeName: options.selectedNodeName,
    targets,
  }
}
