/**
 * Binary target address encoders and decoders for SOCKS5 (`ss`, `ss2022`, `trojan`, `socks5`)
 * and VLESS/VMess (`port || atyp || address`) wire headers.
 */

import { isIP } from 'node:net'
import { VpnTunnelError } from '../error.ts'

function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new VpnTunnelError('VPN_PROTOCOL_ERROR', `Invalid target port: ${String(port)}`)
  }
}

/**
 * Convert an IPv4 dotted-quad string into 4 raw network-order bytes.
 * @param ip - validated IPv4 string.
 * @returns 4-byte IPv4 buffer.
 */
export function ipv4ToBytes(ip: string): Buffer {
  const parts = ip.split('.')
  return Buffer.from([
    Number(parts[0]) & 0xff,
    Number(parts[1]) & 0xff,
    Number(parts[2]) & 0xff,
    Number(parts[3]) & 0xff,
  ])
}

/**
 * Convert an IPv6 string (including `::` compression and optional IPv4-mapped suffix) into 16 network-order bytes.
 * @param ip - validated IPv6 string without brackets.
 * @returns 16-byte IPv6 buffer.
 */
export function ipv6ToBytes(ip: string): Buffer {
  let normalized = ip
  const lastColon = normalized.lastIndexOf(':')
  if (lastColon >= 0 && normalized.slice(lastColon + 1).includes('.')) {
    const v4 = ipv4ToBytes(normalized.slice(lastColon + 1))
    const hi = (((v4[0] as number) << 8) | (v4[1] as number)).toString(16)
    const lo = (((v4[2] as number) << 8) | (v4[3] as number)).toString(16)
    normalized = `${normalized.slice(0, lastColon)}:${hi}:${lo}`
  }

  const halves = normalized.split('::')
  const left = halves[0] && halves[0].length > 0 ? halves[0].split(':') : []
  const right = halves.length > 1 && halves[1] && halves[1].length > 0 ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  const groups = halves.length > 1
    ? [...left, ...Array.from({ length: missing }, () => '0'), ...right]
    : left

  const out = Buffer.allocUnsafe(16)
  for (let i = 0; i < 8; i += 1) {
    out.writeUInt16BE(Number.parseInt(groups[i] ?? '0', 16) & 0xffff, i * 2)
  }
  return out
}

/**
 * Format 16 network-order bytes into a canonical lowercase hex-group IPv6 string.
 * @param bytes - 16-byte IPv6 slice.
 * @returns colon-joined 8-group IPv6 literal.
 */
export function bytesToIpv6(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, 16)
  const parts: string[] = []
  for (let i = 0; i < 8; i += 1) {
    parts.push(view.getUint16(i * 2, false).toString(16))
  }
  return parts.join(':')
}

interface AddressWireTags {
  readonly ipv4: number
  readonly domain: number
  readonly ipv6: number
}

function encodeAddressAndPort(
  host: string,
  port: number,
  tags: AddressWireTags,
): { readonly addressBuf: Buffer; readonly portBuf: Buffer } {
  validatePort(port)
  const clean = stripIpv6Brackets(host)
  const portBuf = Buffer.allocUnsafe(2)
  portBuf.writeUInt16BE(port, 0)

  const ipFamily = isIP(clean)
  if (ipFamily === 4) {
    return { addressBuf: Buffer.concat([Buffer.from([tags.ipv4]), ipv4ToBytes(clean)]), portBuf }
  }
  if (ipFamily === 6) {
    return { addressBuf: Buffer.concat([Buffer.from([tags.ipv6]), ipv6ToBytes(clean)]), portBuf }
  }

  const domainBytes = Buffer.from(clean, 'utf8')
  if (domainBytes.length === 0 || domainBytes.length > 255) {
    throw new VpnTunnelError('VPN_PROTOCOL_ERROR', 'Domain target length must be between 1 and 255 bytes')
  }
  return { addressBuf: Buffer.concat([Buffer.from([tags.domain, domainBytes.length]), domainBytes]), portBuf }
}

/**
 * Encode `host` and `port` in RFC 1928 SOCKS5 target-address wire format (`ATYP || DST.ADDR || DST.PORT`).
 * @param host - IPv4 literal, IPv6 literal, or domain name.
 * @param port - TCP port (`1..65535`).
 * @returns encoded SOCKS5 address buffer.
 */
export function encodeSocks5TargetAddress(host: string, port: number): Buffer {
  const { addressBuf, portBuf } = encodeAddressAndPort(host, port, { ipv4: 0x01, domain: 0x03, ipv6: 0x04 })
  return Buffer.concat([addressBuf, portBuf])
}

/**
 * Parse a SOCKS5 target address (`ATYP || DST.ADDR || DST.PORT`) from `buf` starting at `offset`.
 * @param buf - byte buffer containing a SOCKS5 address header.
 * @param offset - starting byte index (defaults to `0`).
 * @returns parsed host, port, and consumed byte count, or `null` when `buf` is incomplete or invalid.
 */
export function parseSocks5TargetAddress(
  buf: Uint8Array,
  offset = 0,
): { readonly host: string; readonly port: number; readonly bytesRead: number } | null {
  if (offset >= buf.length) return null
  const atyp = buf[offset] as number
  if (atyp === 0x01) {
    if (offset + 7 > buf.length) return null
    const host = `${String(buf[offset + 1])}.${String(buf[offset + 2])}.${String(buf[offset + 3])}.${String(buf[offset + 4])}`
    const port = ((buf[offset + 5] as number) << 8) | (buf[offset + 6] as number)
    return { host, port, bytesRead: 7 }
  }
  if (atyp === 0x03) {
    if (offset + 2 > buf.length) return null
    const len = buf[offset + 1] as number
    if (len === 0 || offset + 2 + len + 2 > buf.length) return null
    const host = Buffer.from(buf.subarray(offset + 2, offset + 2 + len)).toString('utf8')
    const portOffset = offset + 2 + len
    const port = ((buf[portOffset] as number) << 8) | (buf[portOffset + 1] as number)
    return { host, port, bytesRead: 4 + len }
  }
  if (atyp === 0x04) {
    if (offset + 19 > buf.length) return null
    const host = bytesToIpv6(buf.subarray(offset + 1, offset + 17))
    const port = ((buf[offset + 17] as number) << 8) | (buf[offset + 18] as number)
    return { host, port, bytesRead: 19 }
  }
  return null
}

/**
 * Encode `host` and `port` in VLESS / VMess target-address wire format (`PORT(2B BE) || ATYP || ADDR`).
 * VLESS and VMess share `0x01` = IPv4, `0x02` = domain (`len || utf8`), and `0x03` = IPv6.
 * @param host - IPv4 literal, IPv6 literal, or domain name.
 * @param port - TCP port (`1..65535`).
 * @returns encoded `port || atyp || addr` buffer.
 */
export function encodePortFirstTargetAddress(host: string, port: number): Buffer {
  const { addressBuf, portBuf } = encodeAddressAndPort(host, port, { ipv4: 0x01, domain: 0x02, ipv6: 0x03 })
  return Buffer.concat([portBuf, addressBuf])
}
