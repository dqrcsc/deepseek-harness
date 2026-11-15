/** Coded error definitions for the pure-TypeScript VPN tunnel runtime. */

import { HarnessError } from '@deepseek-ai/dsh-error'

/** Stable machine-routable error codes emitted by `@deepseek-ai/dsh-vpn-tunnel`. */
export const VPN_TUNNEL_ERROR_CODES = [
  'VPN_SUBSCRIPTION_FETCH_FAILED',
  'VPN_SUBSCRIPTION_PARSE_FAILED',
  'VPN_UNSUPPORTED_PROTOCOL',
  'VPN_PROTOCOL_ERROR',
  'VPN_AUTH_FAILED',
  'VPN_CONNECT_FAILED',
  'VPN_DNS_FAILED',
  'VPN_NO_HEALTHY_NODE',
  'VPN_GATEWAY_CLOSED',
  'VPN_INVALID_CONFIG',
] as const

/** Union of coded failure identifiers emitted by {@link VpnTunnelError}. */
export type VpnTunnelErrorCode = (typeof VPN_TUNNEL_ERROR_CODES)[number]

/** Structured error thrown by subscription parsers, tunnel handshakes, DNS resolvers, and the loopback gateway. */
export class VpnTunnelError extends HarnessError {
  override readonly code: VpnTunnelErrorCode

  constructor(code: VpnTunnelErrorCode, message: string, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}

/**
 * Produce a single-line diagnostic summary from `err` with HTTP(S) URLs, IPv4 literals, and caller-supplied
 * sensitive hostnames or credentials replaced by `[redacted]`.
 * @param err - caught failure value.
 * @param sensitiveLiterals - optional raw hostnames, URLs, or credentials to scrub.
 * @returns redacted single-line message safe for health snapshots and UI diagnostics.
 */
export function redactNetworkError(err: unknown, sensitiveLiterals: readonly string[] = []): string {
  let msg = err instanceof Error ? err.message : String(err)
  for (const secret of sensitiveLiterals) {
    if (secret.length > 0) {
      msg = msg.replaceAll(secret, '[redacted]')
    }
  }
  msg = msg
    .replaceAll(/https?:\/\/\S+/gi, '[redacted-url]')
    .replaceAll(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[redacted-ip]')
  return msg.replaceAll(/\s+/g, ' ').trim() || 'Network tunnel error'
}
