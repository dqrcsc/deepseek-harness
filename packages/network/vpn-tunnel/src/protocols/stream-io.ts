/**
 * Exact-byte buffered stream reader and TCP/TLS dialer with anti-FakeIP resolution, deadlines, and cancellation.
 */

import net from 'node:net'
import { Duplex } from 'node:stream'
import tls from 'node:tls'
import type { RealDnsResolver } from '../dns.ts'
import { VpnTunnelError } from '../error.ts'
import type { TlsTransportConfig } from '../types.ts'

/** Exact-byte and delimiter-based async reader temporarily attached to a `Duplex` during protocol handshakes. */
export class BufferedStreamReader {
  private buffer: Buffer = Buffer.alloc(0)
  private ended = false
  private failure: Error | null = null
  private waiter: (() => void) | null = null
  private detached = false

  private readonly onData = (chunk: Buffer): void => {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    this.wake()
  }

  private readonly onEnd = (): void => {
    this.ended = true
    this.wake()
  }

  private readonly onError = (err: Error): void => {
    this.failure = err
    this.wake()
  }

  private readonly onClose = (): void => {
    this.ended = true
    this.wake()
  }

  constructor(private readonly stream: Duplex) {
    stream.on('data', this.onData)
    stream.on('end', this.onEnd)
    stream.on('error', this.onError)
    stream.on('close', this.onClose)
  }

  private wake(): void {
    const fn = this.waiter
    if (fn !== null) {
      this.waiter = null
      fn()
    }
  }

  private waitNext(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new VpnTunnelError('VPN_CONNECT_FAILED', 'Tunnel handshake aborted'))
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.waiter = null
        reject(new VpnTunnelError('VPN_CONNECT_FAILED', 'Tunnel handshake aborted'))
      }
      const finish = (): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiter = finish
    })
  }

  /**
   * Read at least `1` and up to `maxBytes` bytes once available, or return empty `Buffer` on clean EOF.
   * @param maxBytes - maximum byte count to consume.
   * @param signal - optional cancellation signal.
   * @returns non-empty chunk, or empty buffer on EOF.
   */
  async readSome(maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    while (this.buffer.length === 0) {
      if (this.failure !== null) throw this.failure
      if (this.ended) return Buffer.alloc(0)
      await this.waitNext(signal)
    }
    const take = Math.min(maxBytes, this.buffer.length)
    const out = this.buffer.subarray(0, take)
    this.buffer = this.buffer.subarray(take)
    return out
  }

  /**
   * Read an exact number of bytes, rejecting with `VPN_PROTOCOL_ERROR` if EOF arrives early.
   * @param length - exact byte count required.
   * @param signal - optional cancellation signal.
   * @returns buffer of `length` bytes.
   */
  async readExact(length: number, signal?: AbortSignal): Promise<Buffer> {
    if (length === 0) return Buffer.alloc(0)
    while (this.buffer.length < length) {
      if (this.failure !== null) throw this.failure
      if (this.ended) {
        throw new VpnTunnelError('VPN_PROTOCOL_ERROR', `Unexpected EOF while waiting for ${String(length)} bytes`)
      }
      await this.waitNext(signal)
    }
    const out = this.buffer.subarray(0, length)
    this.buffer = this.buffer.subarray(length)
    return out
  }

  /**
   * Read up to and including `delimiter`, rejecting if `maxBytes` is exceeded or EOF arrives first.
   * @param delimiter - byte sequence marking end of header (for example `\r\n\r\n`).
   * @param maxBytes - maximum allowed header size in bytes.
   * @param signal - optional cancellation signal.
   * @returns slice ending with `delimiter`.
   */
  async readUntil(delimiter: Buffer, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    while (true) {
      const idx = this.buffer.indexOf(delimiter)
      if (idx >= 0) {
        const end = idx + delimiter.length
        const out = this.buffer.subarray(0, end)
        this.buffer = this.buffer.subarray(end)
        return out
      }
      if (this.buffer.length > maxBytes) {
        throw new VpnTunnelError('VPN_PROTOCOL_ERROR', `Header exceeded ${String(maxBytes)} bytes without delimiter`)
      }
      if (this.failure !== null) throw this.failure
      if (this.ended) {
        throw new VpnTunnelError('VPN_PROTOCOL_ERROR', 'Unexpected EOF before protocol header completed')
      }
      await this.waitNext(signal)
    }
  }

  /**
   * Detach handshake listeners from the underlying stream and return any unread trailing bytes.
   * @returns unread buffered bytes that arrived alongside the handshake response.
   */
  detach(): Buffer {
    if (!this.detached) {
      this.detached = true
      this.stream.off('data', this.onData)
      this.stream.off('end', this.onEnd)
      this.stream.off('error', this.onError)
      this.stream.off('close', this.onClose)
    }
    const remainder = this.buffer
    this.buffer = Buffer.alloc(0)
    return remainder
  }
}

/**
 * Write a complete `Buffer` to `stream`, awaiting flush or stream error.
 * @param stream - target writable duplex.
 * @param data - bytes to write.
 */
export function writeAll(stream: Duplex, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(err)
    }
    stream.once('error', onError)
    stream.write(data, (err) => {
      stream.off('error', onError)
      if (err) reject(err)
      else resolve()
    })
  })
}

/** Framing hooks used by {@link createCarrierTransformDuplex} to wrap a transport `Duplex` with backpressure and teardown forwarding. */
export interface CarrierTransformHooks {
  /** Encode a non-empty outbound plaintext chunk into wire bytes written to `transport`. */
  readonly encodeChunk: (chunk: Buffer) => Buffer
  /** Optional closing wire frame emitted on `.end()`; `'already-closed'` skips ending `transport` again. */
  readonly buildFinalFrame?: () => Buffer | 'already-closed'
  /** Decode an incoming wire chunk, pushing plaintext slices (or `null` on protocol EOF). Throwing destroys the duplex. */
  readonly onData: (chunk: Buffer, push: (plain: Buffer | null) => void) => void
  /** Optional validation hook invoked before pushing `null` when `transport` emits `'end'`. Throwing destroys the duplex. */
  readonly onEnd?: () => void
}

/**
 * Wrap `transport` in a bidirectional `Duplex` sharing unified backpressure (`drain`/`pause`), `final`,
 * `destroy`, `error`, and `close` propagation.
 * @param transport - underlying carrier duplex.
 * @param hooks - protocol-specific framing and deframing callbacks.
 * @param initialIncoming - optional unread wire bytes buffered alongside an earlier handshake header.
 * @returns transformed `Duplex` stream.
 */
export function createCarrierTransformDuplex(
  transport: Duplex,
  hooks: CarrierTransformHooks,
  initialIncoming?: Buffer,
): Duplex {
  const duplex = new Duplex({
    read() {
      transport.resume()
    },
    write(chunk: Buffer, _encoding, callback) {
      if (chunk.length === 0) {
        callback()
        return
      }
      try {
        const wire = hooks.encodeChunk(chunk)
        if (!transport.write(wire)) {
          transport.once('drain', () => { callback() })
          return
        }
        callback()
      } catch (err) {
        callback(err as Error)
      }
    },
    final(callback) {
      if (hooks.buildFinalFrame !== undefined) {
        const finalFrame = hooks.buildFinalFrame()
        if (finalFrame === 'already-closed') {
          callback()
          return
        }
        transport.write(finalFrame, () => {
          transport.end(() => { callback() })
        })
        return
      }
      transport.end(() => { callback() })
    },
    destroy(err, callback) {
      transport.destroy()
      callback(err)
    },
  })

  const push = (plain: Buffer | null): void => {
    if (plain === null) {
      duplex.push(null)
      return
    }
    if (!duplex.push(plain)) {
      transport.pause()
    }
  }

  const deliver = (chunk: Buffer): void => {
    try {
      hooks.onData(chunk, push)
    } catch (err) {
      duplex.destroy(err as Error)
    }
  }

  const handleEnd = (): void => {
    try {
      hooks.onEnd?.()
      duplex.push(null)
    } catch (err) {
      duplex.destroy(err as Error)
    }
  }

  transport.on('data', deliver)
  transport.on('end', handleEnd)
  transport.on('error', (err) => {
    duplex.destroy(err)
  })
  transport.on('close', () => {
    if (!duplex.destroyed) duplex.destroy()
  })

  if (initialIncoming !== undefined && initialIncoming.length > 0) {
    deliver(initialIncoming)
  }
  if (transport.readableEnded) {
    handleEnd()
  }

  return duplex
}

/**
 * Wrap an established `Duplex` while injecting `initialIncoming` bytes before subsequent live `'data'` chunks.
 * @param upstream - underlying transport duplex after handshake completion.
 * @param initialIncoming - unread bytes buffered past the handshake header.
 * @returns passthrough `Duplex` delivering `initialIncoming` followed by live `upstream` traffic.
 */
export function wrapWithBufferedPrefix(upstream: Duplex, initialIncoming: Buffer): Duplex {
  if (initialIncoming.length === 0) return upstream
  return createCarrierTransformDuplex(
    upstream,
    {
      encodeChunk: chunk => chunk,
      onData: (chunk, push) => { push(chunk) },
    },
    initialIncoming,
  )
}

/** Options controlling outbound TCP/TLS transport connection setup. */
export interface ConnectTransportOptions {
  /** Remote server hostname or IP literal. */
  readonly host: string
  /** Remote server TCP port. */
  readonly port: number
  /** Anti-FakeIP DNS resolver. */
  readonly dnsResolver: RealDnsResolver
  /** Connection and TLS handshake deadline in milliseconds. */
  readonly timeoutMs: number
  /** Optional TLS configuration when connecting to a TLS-wrapped endpoint. */
  readonly tls?: TlsTransportConfig
  /** Optional caller cancellation signal. */
  readonly signal?: AbortSignal
}

/**
 * Connect a TCP (or TLS) socket to `options.host:options.port` using anti-FakeIP DNS resolution and bounded deadlines.
 * @param options - host, port, DNS resolver, timeout, optional TLS settings, and cancellation signal.
 * @returns connected `net.Socket` or `tls.TLSSocket` with `TCP_NODELAY` enabled.
 */
export async function connectTransportSocket(options: ConnectTransportOptions): Promise<Duplex> {
  if (options.signal?.aborted) {
    throw new VpnTunnelError('VPN_CONNECT_FAILED', 'Connection aborted before dial')
  }

  const connectIp = await options.dnsResolver.resolveHost(options.host)

  return new Promise((resolve, reject) => {
    let socket: net.Socket | tls.TLSSocket | null = null

    const cleanup = (): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      socket?.off('error', fail)
    }

    const fail = (err: Error): void => {
      cleanup()
      socket?.destroy()
      reject(err instanceof VpnTunnelError ? err : new VpnTunnelError('VPN_CONNECT_FAILED', err.message, { cause: err }))
    }

    const onAbort = (): void => {
      fail(new VpnTunnelError('VPN_CONNECT_FAILED', 'Connection aborted during dial'))
    }

    const timer = setTimeout(() => {
      fail(new VpnTunnelError('VPN_CONNECT_FAILED', `Connection timed out after ${String(options.timeoutMs)}ms`))
    }, options.timeoutMs)
    timer.unref()

    options.signal?.addEventListener('abort', onAbort, { once: true })

    if (options.tls?.enabled) {
      const servername = options.tls.servername ?? (net.isIP(options.host) === 0 ? options.host : undefined)
      const tlsSocket = tls.connect({
        host: connectIp,
        port: options.port,
        ...(servername !== undefined ? { servername } : {}),
        rejectUnauthorized: !(options.tls.skipCertVerify ?? false),
        ...(options.tls.alpn && options.tls.alpn.length > 0 ? { ALPNProtocols: [...options.tls.alpn] } : {}),
      })
      socket = tlsSocket
      tlsSocket.setNoDelay(true)
      tlsSocket.once('secureConnect', () => {
        cleanup()
        resolve(tlsSocket)
      })
      tlsSocket.once('error', fail)
      return
    }

    const rawSocket = net.connect({ host: connectIp, port: options.port })
    socket = rawSocket
    rawSocket.setNoDelay(true)
    rawSocket.once('connect', () => {
      cleanup()
      resolve(rawSocket)
    })
    rawSocket.once('error', fail)
  })
}
