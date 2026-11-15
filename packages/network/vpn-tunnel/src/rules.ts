/**
 * Clash-compatible smart-routing rule matcher (`DOMAIN`, `DOMAIN-SUFFIX`, `DOMAIN-KEYWORD`, `IP-CIDR`, `IP-CIDR6`, `MATCH`)
 * plus built-in direct/proxy defaults for developer and AI API endpoints.
 */

import { isIP } from 'node:net'
import { isPrivateNetworkHost } from '@deepseek-ai/dsh-http-proxy'
import { ipv4ToBytes, ipv6ToBytes } from './protocols/address.ts'
import type { RoutingRule, RuleAction } from './types.ts'

/** Built-in smart-routing rules applied when a subscription provides no Clash `rules:` list (or evaluated after custom user rules). */
export const DEFAULT_SMART_ROUTING_RULES: readonly RoutingRule[] = [
  { kind: 'DOMAIN-SUFFIX', pattern: 'deepseek.com', action: 'DIRECT' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'cn', action: 'DIRECT' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'anthropic.com', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'claude.ai', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'openai.com', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'chatgpt.com', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'googleapis.com', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'generativelanguage.googleapis.com', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'google.com', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'gstatic.com', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'openrouter.ai', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'groq.com', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'mistral.ai', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'cohere.com', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'x.ai', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'perplexity.ai', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'huggingface.co', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'hf.co', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'github.com', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'githubusercontent.com', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'githubassets.com', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'npmjs.org', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'pypi.org', action: 'PROXY' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'docker.io', action: 'PROXY' },
  { kind: 'MATCH', pattern: '', action: 'DIRECT' },
]

interface ParsedIpv4Cidr {
  readonly network: number
  readonly mask: number
  readonly raw: string
  readonly action: RuleAction
}

interface ParsedIpv6Cidr {
  readonly network: bigint
  readonly mask: bigint
  readonly raw: string
  readonly action: RuleAction
}

function bytesToUint128(bytes: Uint8Array): bigint {
  let out = 0n
  for (const byte of bytes) {
    out = (out << 8n) | BigInt(byte)
  }
  return out
}

function parseIpv4Cidr(pattern: string, action: RuleAction): ParsedIpv4Cidr | null {
  const slash = pattern.indexOf('/')
  if (slash <= 0) return null
  const ip = pattern.slice(0, slash)
  const prefix = Number(pattern.slice(slash + 1))
  if (isIP(ip) !== 4 || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  const addr = ipv4ToBytes(ip).readUInt32BE(0)
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0)
  return { network: (addr & mask) >>> 0, mask, raw: pattern, action }
}

function parseIpv6Cidr(pattern: string, action: RuleAction): ParsedIpv6Cidr | null {
  const slash = pattern.indexOf('/')
  if (slash <= 0) return null
  const ip = pattern.slice(0, slash)
  const prefix = Number(pattern.slice(slash + 1))
  if (isIP(ip) !== 6 || !Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null
  const addr = bytesToUint128(ipv6ToBytes(ip))
  const allOnes = (1n << 128n) - 1n
  const mask = prefix === 0 ? 0n : ((allOnes << BigInt(128 - prefix)) & allOnes)
  return { network: addr & mask, mask, raw: pattern, action }
}

/** Evaluated rule-match outcome with the rule expression that produced it. */
export interface RuleMatchResult {
  /** Matched disposition (`PROXY`, `DIRECT`, or `REJECT`). */
  readonly action: RuleAction
  /** Diagnostic label of the matched rule (for example `DOMAIN-SUFFIX:anthropic.com`). */
  readonly matchedRule: string
}

type CompiledRule =
  | { readonly kind: 'DOMAIN'; readonly pattern: string; readonly action: RuleAction }
  | { readonly kind: 'DOMAIN-SUFFIX'; readonly suffix: string; readonly action: RuleAction }
  | { readonly kind: 'DOMAIN-KEYWORD'; readonly pattern: string; readonly action: RuleAction }
  | { readonly kind: 'IP-CIDR'; readonly cidr: ParsedIpv4Cidr }
  | { readonly kind: 'IP-CIDR6'; readonly cidr: ParsedIpv6Cidr }
  | { readonly kind: 'MATCH'; readonly action: RuleAction }

/** Fast ordered Clash-compatible routing rule evaluator with private-LAN bypass protection. */
export class RuleMatcher {
  private readonly compiledRules: readonly CompiledRule[]

  constructor(rules: readonly RoutingRule[]) {
    const compiled: CompiledRule[] = []
    for (const rule of rules) {
      if (rule.kind === 'DOMAIN') {
        compiled.push({ kind: 'DOMAIN', pattern: rule.pattern, action: rule.action })
      } else if (rule.kind === 'DOMAIN-SUFFIX') {
        const suffix = rule.pattern.startsWith('.') ? rule.pattern.slice(1) : rule.pattern
        compiled.push({ kind: 'DOMAIN-SUFFIX', suffix, action: rule.action })
      } else if (rule.kind === 'DOMAIN-KEYWORD') {
        compiled.push({ kind: 'DOMAIN-KEYWORD', pattern: rule.pattern, action: rule.action })
      } else if (rule.kind === 'IP-CIDR') {
        const cidr = parseIpv4Cidr(rule.pattern, rule.action)
        if (cidr !== null) compiled.push({ kind: 'IP-CIDR', cidr })
      } else if (rule.kind === 'IP-CIDR6') {
        const cidr = parseIpv6Cidr(rule.pattern, rule.action)
        if (cidr !== null) compiled.push({ kind: 'IP-CIDR6', cidr })
      } else {
        compiled.push({ kind: 'MATCH', action: rule.action })
      }
    }
    this.compiledRules = compiled
  }

  /**
   * Match `host` against private-LAN bypass first, then evaluate rules in declaration order.
   * @param host - target hostname or IP literal.
   * @returns matched action and diagnostic rule label.
   */
  match(host: string): RuleMatchResult {
    const clean = (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host)
      .replace(/\.$/, '')
      .toLowerCase()

    if (isPrivateNetworkHost(clean)) {
      return { action: 'DIRECT', matchedRule: 'PRIVATE-NETWORK' }
    }

    const ipVersion = isIP(clean)
    const v4Int = ipVersion === 4 ? ipv4ToBytes(clean).readUInt32BE(0) : null
    const v6Int = ipVersion === 6 ? bytesToUint128(ipv6ToBytes(clean)) : null

    for (const rule of this.compiledRules) {
      if (rule.kind === 'DOMAIN') {
        if (clean === rule.pattern) {
          return { action: rule.action, matchedRule: `DOMAIN:${rule.pattern}` }
        }
        continue
      }
      if (rule.kind === 'DOMAIN-SUFFIX') {
        if (clean === rule.suffix || clean.endsWith(`.${rule.suffix}`)) {
          return { action: rule.action, matchedRule: `DOMAIN-SUFFIX:${rule.suffix}` }
        }
        continue
      }
      if (rule.kind === 'DOMAIN-KEYWORD') {
        if (clean.includes(rule.pattern)) {
          return { action: rule.action, matchedRule: `DOMAIN-KEYWORD:${rule.pattern}` }
        }
        continue
      }
      if (rule.kind === 'IP-CIDR') {
        if (v4Int !== null && ((v4Int & rule.cidr.mask) >>> 0) === rule.cidr.network) {
          return { action: rule.cidr.action, matchedRule: `IP-CIDR:${rule.cidr.raw}` }
        }
        continue
      }
      if (rule.kind === 'IP-CIDR6') {
        if (v6Int !== null && (v6Int & rule.cidr.mask) === rule.cidr.network) {
          return { action: rule.cidr.action, matchedRule: `IP-CIDR6:${rule.cidr.raw}` }
        }
        continue
      }
      return { action: rule.action, matchedRule: 'MATCH' }
    }

    return { action: 'DIRECT', matchedRule: 'FALLBACK-DIRECT' }
  }
}
