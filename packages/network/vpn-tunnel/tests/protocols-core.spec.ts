import { createHash, randomBytes } from 'node:crypto'
import net from 'node:net'
import { Duplex, PassThrough } from 'node:stream'
import tls from 'node:tls'
import { describe, expect, it } from 'vitest'
import { RealDnsResolver } from '../src/dns.ts'
import {
  bytesToIpv6,
  encodePortFirstTargetAddress,
  encodeSocks5TargetAddress,
  ipv4ToBytes,
  ipv6ToBytes,
  parseSocks5TargetAddress,
} from '../src/protocols/address.ts'
import {
  AEAD_NONCE_LEN,
  AEAD_TAG_LEN,
  aeadOpen,
  aeadSeal,
  createShadowsocksAeadDuplex,
  nonce12LittleEndian,
} from '../src/protocols/aead.ts'
import { wrapSimpleObfsHttp, wrapSimpleObfsTls } from '../src/protocols/obfs.ts'
import {
  BufferedStreamReader,
  connectTransportSocket,
  wrapWithBufferedPrefix,
  writeAll,
} from '../src/protocols/stream-io.ts'
import { connectWebSocketStream } from '../src/protocols/ws-stream.ts'
import { createSelfSignedTlsCredentials } from './tls-fixture.ts'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function createDuplexPair(): { readonly clientSide: Duplex; readonly serverSide: Duplex } {
  const c2s = new PassThrough()
  const s2c = new PassThrough()
  const makeSide = (readable: PassThrough, writable: PassThrough): Duplex => {
    const d = new Duplex({
      read() {
        readable.resume()
      },
      write(chunk: Buffer, _enc, cb) {
        if (!writable.write(chunk)) {
          writable.once('drain', () => { cb() })
          return
        }
        cb()
      },
      final(cb) {
        writable.end(() => { cb() })
      },
      destroy(err, cb) {
        readable.destroy()
        writable.destroy()
        cb(err)
      },
    })
    readable.on('data', (chunk: Buffer) => {
      if (!d.push(chunk)) readable.pause()
    })
    readable.on('end', () => { d.push(null) })
    readable.on('error', err => d.destroy(err))
    return d
  }
  return {
    clientSide: makeSide(s2c, c2s),
    serverSide: makeSide(c2s, s2c),
  }
}

function buildServerWsFrame(
  opcode: number,
  payload: Buffer,
  options: { readonly fin?: boolean; readonly masked?: boolean } = {},
): Buffer {
  const finBit = (options.fin ?? true) ? 0x80 : 0x00
  const maskBit = (options.masked ?? false) ? 0x80 : 0x00
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.from([finBit | opcode, maskBit | payload.length])
  } else if (payload.length <= 0xffff) {
    header = Buffer.allocUnsafe(4)
    header[0] = finBit | opcode
    header[1] = maskBit | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[0] = finBit | opcode
    header[1] = maskBit | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  if (!options.masked) {
    return Buffer.concat([header, payload])
  }
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
  const maskedPayload = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i += 1) {
    maskedPayload[i] = (payload[i] as number) ^ (mask[i & 3] as number)
  }
  return Buffer.concat([header, mask, maskedPayload])
}

describe('Target address wire codecs', () => {
  it('encodes and decodes IPv4, IPv6, IPv4-mapped IPv6, and domain addresses across SOCKS5 and VLESS/VMess layouts', () => {
    expect([...ipv4ToBytes('203.0.113.9')]).toEqual([203, 0, 113, 9])
    expect(bytesToIpv6(ipv6ToBytes('::1'))).toBe('0:0:0:0:0:0:0:1')
    expect(bytesToIpv6(ipv6ToBytes('fe80::'))).toBe('fe80:0:0:0:0:0:0:0')
    expect(bytesToIpv6(ipv6ToBytes('::'))).toBe('0:0:0:0:0:0:0:0')
    expect(bytesToIpv6(ipv6ToBytes('2001:db8::ff00:42:8329'))).toBe('2001:db8:0:0:0:ff00:42:8329')
    expect(bytesToIpv6(ipv6ToBytes('2001:db8:1:2:3:4:5:6'))).toBe('2001:db8:1:2:3:4:5:6')
    expect(bytesToIpv6(ipv6ToBytes('::ffff:192.0.2.128'))).toBe('0:0:0:0:0:ffff:c000:280')

    const v4Socks = encodeSocks5TargetAddress('1.2.3.4', 443)
    expect(parseSocks5TargetAddress(v4Socks)).toEqual({ host: '1.2.3.4', port: 443, bytesRead: 7 })

    const v6Socks = encodeSocks5TargetAddress('[2001:db8::1]', 8443)
    expect(parseSocks5TargetAddress(v6Socks)).toEqual({ host: '2001:db8:0:0:0:0:0:1', port: 8443, bytesRead: 19 })

    const domSocks = encodeSocks5TargetAddress('api.openai.com', 443)
    const prefixed = Buffer.concat([Buffer.from([0xff, 0xff]), domSocks])
    expect(parseSocks5TargetAddress(prefixed, 2)).toEqual({
      host: 'api.openai.com',
      port: 443,
      bytesRead: 4 + 'api.openai.com'.length,
    })

    // Incomplete or malformed SOCKS5 buffers
    expect(parseSocks5TargetAddress(Buffer.alloc(0))).toBeNull()
    expect(parseSocks5TargetAddress(Buffer.from([0x01, 1, 2]))).toBeNull()
    expect(parseSocks5TargetAddress(Buffer.from([0x03]))).toBeNull()
    expect(parseSocks5TargetAddress(Buffer.from([0x03, 0x00, 0x01, 0xbb]))).toBeNull()
    expect(parseSocks5TargetAddress(Buffer.from([0x03, 0x05, 0x61]))).toBeNull()
    expect(parseSocks5TargetAddress(Buffer.from([0x04, 1, 2, 3]))).toBeNull()
    expect(parseSocks5TargetAddress(Buffer.from([0x99, 1, 2, 3, 4]))).toBeNull()

    // Port-first VLESS/VMess layout
    expect(encodePortFirstTargetAddress('1.2.3.4', 80)[2]).toBe(0x01)
    expect(encodePortFirstTargetAddress('[2001:db8::1]', 80)[2]).toBe(0x03)
    expect(encodePortFirstTargetAddress('example.com', 80)[2]).toBe(0x02)

    expect(() => encodeSocks5TargetAddress('example.com', 0)).toThrow(/Invalid target port/)
    expect(() => encodePortFirstTargetAddress('example.com', 70_000)).toThrow(/Invalid target port/)
    expect(() => encodeSocks5TargetAddress('', 443)).toThrow(/Domain target length/)
    expect(() => encodePortFirstTargetAddress('a'.repeat(256), 443)).toThrow(/Domain target length/)
  })
})

describe('AEAD primitives and Shadowsocks AEAD duplex', () => {
  it('seals, opens, authenticates AAD, rejects tampered tags, and streams chunked frames with backpressure', async () => {
    expect(AEAD_TAG_LEN).toBe(16)
    expect(AEAD_NONCE_LEN).toBe(12)
    const nonce = nonce12LittleEndian(42n)
    expect(nonce.readBigUInt64LE(0)).toBe(42n)

    for (const [alg, keyLen] of [
      ['aes-128-gcm', 16],
      ['aes-256-gcm', 32],
      ['chacha20-poly1305', 32],
    ] as const) {
      const key = randomBytes(keyLen)
      const aad = Buffer.from('auth-header', 'ascii')
      const plain = Buffer.from('hello-pure-ts-vpn', 'utf8')
      const sealed = aeadSeal(alg, key, nonce, plain, aad)
      expect(aeadOpen(alg, key, nonce, sealed, aad)).toEqual(plain)
      expect(() => aeadOpen(alg, key, nonce, Buffer.alloc(8))).toThrow(/shorter than 16-byte/)
      const tampered = Buffer.from(sealed)
      tampered[tampered.length - 1] = ((tampered[tampered.length - 1] as number) ^ 0xff)
      expect(() => aeadOpen(alg, key, nonce, tampered, aad)).toThrow(/verification failed/)
    }

    // Duplex framing: firstWritePrefix, multi-chunk splitting, drain backpressure, initialPlaintext, empty chunk, and errors
    const key = randomBytes(16)
    let drainHook: (() => void) | null = null
    const rawTransport = new Duplex({
      highWaterMark: 16,
      read() {},
      write(chunk: Buffer, _enc, cb) {
        wireChunks.push(chunk)
        if (forceBackpressure) {
          forceBackpressure = false
          drainHook = () => { dEmitDrain() }
          cb()
          return
        }
        cb()
      },
      final(cb) {
        cb()
      },
    })
    const wireChunks: Buffer[] = []
    let forceBackpressure = true
    const origWrite = rawTransport.write.bind(rawTransport)
    rawTransport.write = ((chunk: Buffer) => {
      const shouldPause = forceBackpressure
      origWrite(chunk)
      return !shouldPause
    }) as typeof rawTransport.write
    const dEmitDrain = (): void => {
      rawTransport.emit('drain')
    }

    const tunnel = createShadowsocksAeadDuplex({
      transport: rawTransport,
      algorithm: 'aes-128-gcm',
      encodeKey: key,
      initialEncodeCounter: 0n,
      maxChunkPayload: 8,
      lengthMask: 0x3fff,
      firstWritePrefix: Buffer.from('SALT', 'ascii'),
      initDecoder(buf) {
        if (buf.length < 4) return null
        return {
          decodeKey: key,
          initialDecodeCounter: 0n,
          consumedBytes: 4,
          initialPlaintext: Buffer.from('INIT!', 'ascii'),
        }
      },
    })
    // Set tiny readableHighWaterMark on tunnel to exercise push() === false pause + read() resume
    Object.defineProperty(tunnel, 'readableHighWaterMark', { value: 2 })

    // Empty write returns immediately
    await new Promise<void>((resolve, reject) => {
      tunnel.write(Buffer.alloc(0), (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // Backpressured multi-chunk write (> 8 bytes) with firstWritePrefix
    const writeDone = new Promise<void>((resolve, reject) => {
      tunnel.write(Buffer.from('0123456789AB', 'ascii'), (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    if (drainHook !== null) (drainHook as () => void)()
    queueMicrotask(() => { rawTransport.emit('drain') })
    await writeDone
    // Second write skips firstWritePrefix
    await new Promise<void>((resolve, reject) => {
      tunnel.write(Buffer.from('CD', 'ascii'), (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    expect(Buffer.concat(wireChunks).subarray(0, 4).toString('ascii')).toBe('SALT')

    // Feed partial response salt (2 bytes), then rest + zero-length chunk + normal chunk split across events
    rawTransport.push(Buffer.from('SA', 'ascii'))
    const zeroLen = aeadSeal('aes-128-gcm', key, nonce12LittleEndian(0n), Buffer.from([0, 0]))
    const zeroPay = aeadSeal('aes-128-gcm', key, nonce12LittleEndian(1n), Buffer.alloc(0))
    const msgPlain = Buffer.from('PONG-DATA', 'ascii')
    const msgLen = Buffer.allocUnsafe(2)
    msgLen.writeUInt16BE(msgPlain.length, 0)
    const encMsgLen = aeadSeal('aes-128-gcm', key, nonce12LittleEndian(2n), msgLen)
    const encMsgPay = aeadSeal('aes-128-gcm', key, nonce12LittleEndian(3n), msgPlain)

    rawTransport.push(Buffer.concat([Buffer.from('LT', 'ascii'), zeroLen, zeroPay, encMsgLen.subarray(0, 5)]))
    rawTransport.push(Buffer.concat([encMsgLen.subarray(5), encMsgPay.subarray(0, 4)]))
    rawTransport.push(encMsgPay.subarray(4))

    const received: Buffer[] = []
    tunnel.on('data', (c: Buffer) => received.push(c))
    rawTransport.push(null)
    await new Promise<void>(resolve => tunnel.once('end', resolve))
    expect(Buffer.concat(received).toString('ascii')).toBe('INIT!PONG-DATA')

    await new Promise<void>(resolve => tunnel.end(() => { resolve() }))
    tunnel.destroy()

    // Invalid key triggers write callback error; tampered incoming triggers tunnel error; transport error/close propagate
    const badTransport = new PassThrough()
    const badTunnel = createShadowsocksAeadDuplex({
      transport: badTransport,
      algorithm: 'aes-128-gcm',
      encodeKey: Buffer.alloc(5), // invalid AES key length
      initialEncodeCounter: 0n,
      maxChunkPayload: 64,
      lengthMask: 0xffff,
      initDecoder: () => ({ decodeKey: key, initialDecodeCounter: 0n, consumedBytes: 0 }),
    })
    const writeErr = await new Promise<Error | null | undefined>((resolve) => {
      badTunnel.on('error', () => {})
      badTunnel.write(Buffer.from('x'), (err) => { resolve(err) })
    })
    expect(writeErr).toBeInstanceOf(Error)

    const corruptTransport = new PassThrough()
    const corruptTunnel = createShadowsocksAeadDuplex({
      transport: corruptTransport,
      algorithm: 'aes-128-gcm',
      encodeKey: key,
      initialEncodeCounter: 0n,
      maxChunkPayload: 64,
      lengthMask: 0xffff,
      initDecoder: () => ({ decodeKey: key, initialDecodeCounter: 0n, consumedBytes: 0 }),
    })
    const corruptPromise = new Promise<Error>(resolve => corruptTunnel.once('error', resolve))
    corruptTransport.write(Buffer.alloc(24, 0xaa))
    expect(await corruptPromise).toBeInstanceOf(Error)

    const errTransport = new PassThrough()
    const errTunnel = createShadowsocksAeadDuplex({
      transport: errTransport,
      algorithm: 'aes-128-gcm',
      encodeKey: key,
      initialEncodeCounter: 0n,
      maxChunkPayload: 64,
      lengthMask: 0xffff,
      initDecoder: () => null,
    })
    const transErrPromise = new Promise<Error>(resolve => errTunnel.once('error', resolve))
    errTransport.emit('error', new Error('boom'))
    expect((await transErrPromise).message).toBe('boom')

    const closeTransport = new PassThrough()
    const closeTunnel = createShadowsocksAeadDuplex({
      transport: closeTransport,
      algorithm: 'aes-128-gcm',
      encodeKey: key,
      initialEncodeCounter: 0n,
      maxChunkPayload: 64,
      lengthMask: 0xffff,
      initDecoder: () => null,
    })
    closeTransport.emit('close')
    expect(closeTunnel.destroyed).toBe(true)
    closeTransport.emit('close')
  })
})

describe('BufferedStreamReader, wrapWithBufferedPrefix, and connectTransportSocket', () => {
  it('handles exact/delimiter reads, aborts, prefix replay, and TCP/TLS socket dialing', async () => {
    const pt = new PassThrough()
    const reader = new BufferedStreamReader(pt)

    expect(await reader.readExact(0)).toEqual(Buffer.alloc(0))
    const pSome = reader.readSome(4)
    pt.write(Buffer.from('abcdef'))
    expect((await pSome).toString()).toBe('abcd')
    expect((await reader.readExact(2)).toString()).toBe('ef')

    const pDelim = reader.readUntil(Buffer.from('\r\n\r\n'), 32)
    pt.write(Buffer.from('HTTP/1.1 200 OK\r\n'))
    pt.write(Buffer.from('X: 1\r\n\r\nTRAIL'))
    expect((await pDelim).toString()).toContain('200 OK')
    expect(reader.detach().toString()).toBe('TRAIL')
    // Second detach is idempotent
    expect(reader.detach().length).toBe(0)

    // Pre-aborted and mid-wait abort
    const ptAbort = new PassThrough()
    const rAbort = new BufferedStreamReader(ptAbort)
    const preAborted = AbortSignal.abort()
    await expect(rAbort.readSome(4, preAborted)).rejects.toThrow(/aborted/)
    const ac = new AbortController()
    const pendingRead = rAbort.readExact(4, ac.signal)
    ac.abort()
    await expect(pendingRead).rejects.toThrow(/aborted/)
    rAbort.detach()

    // Header overflow, early EOF, stream error, and close event
    const ptOverflow = new PassThrough()
    const rOverflow = new BufferedStreamReader(ptOverflow)
    ptOverflow.write(Buffer.alloc(20, 0x41))
    await expect(rOverflow.readUntil(Buffer.from('\r\n\r\n'), 10)).rejects.toThrow(/Header exceeded/)
    rOverflow.detach()

    const ptEof = new PassThrough()
    const rEof = new BufferedStreamReader(ptEof)
    ptEof.end()
    expect(await rEof.readSome(8)).toEqual(Buffer.alloc(0))
    await expect(rEof.readExact(2)).rejects.toThrow(/Unexpected EOF/)
    await expect(rEof.readUntil(Buffer.from('\r\n'), 16)).rejects.toThrow(/Unexpected EOF/)

    const ptClose = new PassThrough()
    const rClose = new BufferedStreamReader(ptClose)
    ptClose.emit('close')
    expect(await rClose.readSome(4)).toEqual(Buffer.alloc(0))

    const ptErr = new PassThrough()
    const rErr = new BufferedStreamReader(ptErr)
    const errRead = rErr.readSome(4)
    ptErr.emit('error', new Error('sock-fail'))
    await expect(errRead).rejects.toThrow('sock-fail')
    await expect(rErr.readExact(2)).rejects.toThrow('sock-fail')
    await expect(rErr.readUntil(Buffer.from('\n'), 10)).rejects.toThrow('sock-fail')

    // writeAll error handling
    const badWritable = new Duplex({
      read() {},
      write(_c, _e, cb) {
        cb(new Error('write-boom'))
      },
    })
    badWritable.on('error', () => {})
    await expect(writeAll(badWritable, Buffer.from('x'))).rejects.toThrow('write-boom')

    const emitErrWritable = new Duplex({
      read() {},
      write() {
        queueMicrotask(() => this.emit('error', new Error('async-err')))
      },
    })
    await expect(writeAll(emitErrWritable, Buffer.from('x'))).rejects.toThrow('async-err')

    // wrapWithBufferedPrefix: empty returns same stream; pull, data-push, and end-before-read paths
    const base = new PassThrough()
    expect(wrapWithBufferedPrefix(base, Buffer.alloc(0))).toBe(base)

    const up1 = new PassThrough()
    const w1 = wrapWithBufferedPrefix(up1, Buffer.from('PRE-'))
    up1.write(Buffer.from('LIVE'))
    up1.end()
    const chunks1: Buffer[] = []
    for await (const c of w1) chunks1.push(c as Buffer)
    expect(Buffer.concat(chunks1).toString()).toBe('PRE-LIVE')

    const up2 = new PassThrough()
    const w2 = wrapWithBufferedPrefix(up2, Buffer.from('ONLY'))
    up2.end()
    const chunks2: Buffer[] = []
    for await (const c of w2) chunks2.push(c as Buffer)
    expect(Buffer.concat(chunks2).toString()).toBe('ONLY')

    // Backpressure on wrapWithBufferedPrefix write + read pull + close/error
    let up3Pause = true
    const up3 = new Duplex({
      read() {},
      write(_c, _e, cb) { cb() },
      final(cb) { cb() },
    })
    const origUp3Write = up3.write.bind(up3)
    up3.write = ((c: Buffer) => {
      const pause = up3Pause
      up3Pause = false
      origUp3Write(c)
      queueMicrotask(() => up3.emit('drain'))
      return !pause
    }) as typeof up3.write
    const w3 = wrapWithBufferedPrefix(up3, Buffer.from('0123456789'))
    Object.defineProperty(w3, 'readableHighWaterMark', { value: 2 })
    w3.read(1)
    await new Promise<void>(resolve => w3.write(Buffer.from('hi'), () => { resolve() }))
    await new Promise<void>(resolve => w3.write(Buffer.from('ok'), () => { resolve() }))
    await new Promise<void>(resolve => w3.end(() => { resolve() }))
    up3.emit('close')
    w3.destroy()

    const up4 = new PassThrough()
    const w4 = wrapWithBufferedPrefix(up4, Buffer.from('P'))
    const w4Err = new Promise<Error>(resolve => w4.once('error', resolve))
    up4.emit('error', new Error('up4-err'))
    expect((await w4Err).message).toBe('up4-err')

    // connectTransportSocket: TCP + TLS + abort + timeout + ECONNREFUSED
    const dnsResolver = new RealDnsResolver({ systemLookup: async () => '127.0.0.1' })
    await expect(connectTransportSocket({
      host: '127.0.0.1',
      port: 1,
      dnsResolver,
      timeoutMs: 500,
      signal: AbortSignal.abort(),
    })).rejects.toThrow(/aborted before dial/)

    const tcpServer = net.createServer((sock) => {
      sock.end('tcp-ok')
    })
    await new Promise<void>(resolve => tcpServer.listen(0, '127.0.0.1', resolve))
    const tcpPort = (tcpServer.address() as net.AddressInfo).port

    const creds = createSelfSignedTlsCredentials()
    const tlsServer = tls.createServer({ key: creds.key, cert: creds.cert, ALPNProtocols: ['http/1.1'] }, (sock) => {
      sock.end('tls-ok')
    })
    await new Promise<void>(resolve => tlsServer.listen(0, '127.0.0.1', resolve))
    const tlsPort = (tlsServer.address() as net.AddressInfo).port

    try {
      const tcpSock = await connectTransportSocket({ host: '127.0.0.1', port: tcpPort, dnsResolver, timeoutMs: 2000 })
      const tcpReader = new BufferedStreamReader(tcpSock)
      expect((await tcpReader.readSome(16)).toString()).toBe('tcp-ok')
      tcpReader.detach()
      tcpSock.destroy()

      // TLS with domain host + skipCertVerify + ALPN
      const tlsSock = await connectTransportSocket({
        host: 'edge.example.com',
        port: tlsPort,
        dnsResolver,
        timeoutMs: 2000,
        tls: { enabled: true, skipCertVerify: true, alpn: ['http/1.1'] },
      })
      const tlsReader = new BufferedStreamReader(tlsSock)
      expect((await tlsReader.readSome(16)).toString()).toBe('tls-ok')
      tlsReader.detach()
      tlsSock.destroy()

      // TLS with IP host + explicit servername, and strict verification failure against self-signed cert
      const tlsIpSock = await connectTransportSocket({
        host: '127.0.0.1',
        port: tlsPort,
        dnsResolver,
        timeoutMs: 2000,
        tls: { enabled: true, skipCertVerify: true },
      })
      tlsIpSock.destroy()

      await expect(connectTransportSocket({
        host: 'edge.example.com',
        port: tlsPort,
        dnsResolver,
        timeoutMs: 2000,
        tls: { enabled: true, servername: 'edge.example.com' },
      })).rejects.toThrow()
    } finally {
      tcpServer.close()
      tlsServer.close()
    }

    // Short IPv6 group fallback & CarrierTransformDuplex readable backpressure pause
    expect(ipv6ToBytes('1:2:3').readUInt16BE(6)).toBe(0)
    const bpStream = new PassThrough()
    const bpWrapped = wrapWithBufferedPrefix(bpStream, Buffer.alloc(131_072, 0x33))
    expect(bpStream.isPaused()).toBe(true)
    bpWrapped.destroy()

    // Closed port -> ECONNREFUSED wrapped in VpnTunnelError
    const closedSrv = net.createServer()
    await new Promise<void>(resolve => closedSrv.listen(0, '127.0.0.1', resolve))
    const closedPort = (closedSrv.address() as net.AddressInfo).port
    await new Promise<void>(resolve => closedSrv.close(() => { resolve() }))
    await expect(connectTransportSocket({
      host: '127.0.0.1',
      port: closedPort,
      dnsResolver,
      timeoutMs: 1000,
    })).rejects.toThrow()

    // Stalled TLS server (accepts TCP, never sends TLS ServerHello) covers both mid-dial abort and timeoutMs
    const stalledTls = net.createServer(() => {
      // Intentionally stalls TLS handshake
    })
    await new Promise<void>(resolve => stalledTls.listen(0, '127.0.0.1', resolve))
    const stalledPort = (stalledTls.address() as net.AddressInfo).port
    try {
      const midAc = new AbortController()
      setTimeout(() => { midAc.abort() }, 10)
      await expect(connectTransportSocket({
        host: '127.0.0.1',
        port: stalledPort,
        dnsResolver,
        timeoutMs: 2000,
        tls: { enabled: true, skipCertVerify: true },
        signal: midAc.signal,
      })).rejects.toThrow(/aborted/)

      await expect(connectTransportSocket({
        host: '127.0.0.1',
        port: stalledPort,
        dnsResolver,
        timeoutMs: 40,
        tls: { enabled: true, skipCertVerify: true },
      })).rejects.toThrow(/timed out/)
    } finally {
      stalledTls.close()
    }
  })
})

describe('SIP003 simple-obfs (http & tls) and RFC 6455 WebSocket carrier', () => {
  it('wraps simple-obfs http and tls frames bidirectionally and handles error cases', async () => {
    // simple-obfs HTTP
    const pair1 = createDuplexPair()
    const obfsHttp = wrapSimpleObfsHttp(pair1.clientSide, 'cdn.example.com', 8388, 'ws-path')
    await new Promise<void>(resolve => obfsHttp.write(Buffer.alloc(0), () => { resolve() }))
    await new Promise<void>(resolve => obfsHttp.write(Buffer.from('HELLO-1'), () => { resolve() }))
    await new Promise<void>(resolve => obfsHttp.write(Buffer.from('-2'), () => { resolve() }))

    const serverReader1 = new BufferedStreamReader(pair1.serverSide)
    const reqHdr = await serverReader1.readUntil(Buffer.from('\r\n\r\n'), 4096)
    expect(reqHdr.toString()).toContain('GET /ws-path HTTP/1.1\r\nHost: cdn.example.com:8388\r\n')
    const body1 = await serverReader1.readExact(9)
    expect(body1.toString()).toBe('HELLO-1-2')
    serverReader1.detach()
    pair1.serverSide.resume()

    pair1.serverSide.write(Buffer.from('HTTP/1.1 101 Switching\r\n'))
    pair1.serverSide.write(Buffer.from('Upgrade: websocket\r\n\r\nRESP-A'))
    pair1.serverSide.write(Buffer.from('-RESP-B'))
    pair1.serverSide.end()
    const clientOut1: Buffer[] = []
    for await (const c of obfsHttp) clientOut1.push(c as Buffer)
    expect(Buffer.concat(clientOut1).toString()).toBe('RESP-A-RESP-B')
    await new Promise<void>(resolve => obfsHttp.end(() => { resolve() }))
    obfsHttp.destroy()

    // Port 443 Host header + oversized header + truncated header on EOF + close/error
    const pair443 = createDuplexPair()
    const obfs443 = wrapSimpleObfsHttp(pair443.clientSide, 'cdn.example.com', 443, '/ok')
    await new Promise<void>(resolve => obfs443.write(Buffer.from('X'), () => { resolve() }))
    const reader443 = new BufferedStreamReader(pair443.serverSide)
    expect((await reader443.readUntil(Buffer.from('\r\n\r\n'), 4096)).toString()).toContain('Host: cdn.example.com\r\n')
    reader443.detach()
    const overErr = new Promise<Error>(resolve => obfs443.once('error', resolve))
    pair443.serverSide.write(Buffer.alloc(17_000, 0x41))
    expect((await overErr).message).toMatch(/exceeded 16 KiB/)

    const ptTrunc = new PassThrough()
    const obfsTrunc = wrapSimpleObfsHttp(ptTrunc, 'a.com', 80)
    const truncErr = new Promise<Error>(resolve => obfsTrunc.once('error', resolve))
    ptTrunc.write(Buffer.from('HTTP/1.1 101 Partial'))
    ptTrunc.end()
    expect((await truncErr).message).toMatch(/before obfs-http response header/)

    const ptCleanEnd = new PassThrough()
    const obfsCleanEnd = wrapSimpleObfsHttp(ptCleanEnd, 'a.com', 80)
    ptCleanEnd.write(Buffer.from('HTTP/1.1 101 Switching\r\n\r\n'))
    ptCleanEnd.end()
    const emptyChunks: Buffer[] = []
    for await (const c of obfsCleanEnd) emptyChunks.push(c as Buffer)
    expect(emptyChunks).toEqual([])

    const ptNoResp = new PassThrough()
    const obfsNoResp = wrapSimpleObfsHttp(ptNoResp, 'a.com', 80)
    ptNoResp.end()
    const noRespChunks: Buffer[] = []
    for await (const c of obfsNoResp) noRespChunks.push(c as Buffer)
    expect(noRespChunks).toEqual([])

    const ptClose = new PassThrough()
    const obfsClose = wrapSimpleObfsHttp(ptClose, 'a.com', 80)
    ptClose.emit('close')
    expect(obfsClose.destroyed).toBe(true)

    // simple-obfs TLS (including >8192B initial write, subsequent write, stage state machine, and truncated record)
    const pairTls = createDuplexPair()
    pairTls.serverSide.resume()
    const obfsTls = wrapSimpleObfsTls(pairTls.clientSide, '')
    await new Promise<void>(resolve => obfsTls.write(Buffer.alloc(0), () => { resolve() }))
    const bigInitial = Buffer.alloc(9000, 0x42)
    await new Promise<void>(resolve => obfsTls.write(bigInitial, () => { resolve() }))
    await new Promise<void>(resolve => obfsTls.write(Buffer.from('SECOND'), () => { resolve() }))

    const mkTlsRec = (type: number, payload: Buffer): Buffer => {
      const h = Buffer.allocUnsafe(5)
      h[0] = type
      h[1] = 0x03
      h[2] = 0x03
      h.writeUInt16BE(payload.length, 3)
      return Buffer.concat([h, payload])
    }
    pairTls.serverSide.write(mkTlsRec(0x16, Buffer.from('srv-hello')))
    pairTls.serverSide.write(mkTlsRec(0x14, Buffer.from([0x01])))
    pairTls.serverSide.write(mkTlsRec(0x16, Buffer.from('FIRST-')))
    pairTls.serverSide.write(mkTlsRec(0x15, Buffer.from('ignored-alert')))
    pairTls.serverSide.write(mkTlsRec(0x17, Buffer.alloc(0)))
    const secondRec = mkTlsRec(0x17, Buffer.from('DATA'))
    pairTls.serverSide.write(secondRec.subarray(0, 3))
    pairTls.serverSide.write(secondRec.subarray(3, 6))
    pairTls.serverSide.write(secondRec.subarray(6))
    pairTls.serverSide.end()

    const tlsOut: Buffer[] = []
    for await (const c of obfsTls) tlsOut.push(c as Buffer)
    expect(Buffer.concat(tlsOut).toString()).toBe('FIRST-DATA')
    await new Promise<void>(resolve => obfsTls.end(() => { resolve() }))
    obfsTls.destroy()

    // obfs-tls post-ccs receiving 0x17 with empty payload
    const ptPostCcs = new PassThrough()
    const obfsPostCcs = wrapSimpleObfsTls(ptPostCcs, 'custom.host')
    ptPostCcs.write(mkTlsRec(0x14, Buffer.from([0x01])))
    ptPostCcs.write(mkTlsRec(0x17, Buffer.alloc(0)))
    ptPostCcs.end(mkTlsRec(0x17, Buffer.from('OK')))
    const postCcsOut: Buffer[] = []
    for await (const c of obfsPostCcs) postCcsOut.push(c as Buffer)
    expect(Buffer.concat(postCcsOut).toString()).toBe('OK')

    const ptTlsTrunc = new PassThrough()
    const obfsTlsTrunc = wrapSimpleObfsTls(ptTlsTrunc, 'custom.host')
    const tlsTruncErr = new Promise<Error>(resolve => obfsTlsTrunc.once('error', resolve))
    ptTlsTrunc.write(Buffer.from([0x17, 0x03, 0x03]))
    ptTlsTrunc.end()
    expect((await tlsTruncErr).message).toMatch(/Truncated obfs-tls/)

    const ptTlsClose = new PassThrough()
    const obfsTlsClose = wrapSimpleObfsTls(ptTlsClose, 'custom.host')
    ptTlsClose.emit('close')
    expect(obfsTlsClose.destroyed).toBe(true)
  })

  it('negotiates RFC 6455 WebSocket streams with 7/16/64-bit frames, fragmentation, ping/pong, and error checks', async () => {
    const pair = createDuplexPair()
    let resolveClientWrites!: () => void
    const clientWritesDone = new Promise<void>((resolve) => { resolveClientWrites = resolve })
    // Server handles Upgrade and exchanges frames (trailing frame inside 101, fragmented frames, 65536B ping -> pong)
    const serverTask = (async () => {
      const r = new BufferedStreamReader(pair.serverSide)
      const hdr = (await r.readUntil(Buffer.from('\r\n\r\n'), 4096)).toString('utf8')
      expect(hdr).toContain('GET /tunnel HTTP/1.1')
      expect(hdr).toContain('Host: custom-ws.example.com')
      expect(hdr).toContain('X-Custom: 1')
      const keyMatch = /Sec-WebSocket-Key:\s*(\S+)/i.exec(hdr)
      const accept = createHash('sha1').update(`${keyMatch?.[1] ?? ''}${WS_GUID}`).digest('base64')
      const initialFrame = buildServerWsFrame(0x02, Buffer.from('EARLY-'), { masked: true })
      await writeAll(
        pair.serverSide,
        Buffer.concat([
          Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`),
          initialFrame,
        ]),
      )
      r.detach()
      pair.serverSide.resume()

      // Send Pong (ignored), 65536B Ping (64-bit length read + 64-bit masked client Pong), 200B frame, and fragments
      const bigPingPayload = Buffer.alloc(65_536, 0x55)
      pair.serverSide.write(buildServerWsFrame(0x0a, Buffer.from('pong')))
      const bigPing = buildServerWsFrame(0x09, bigPingPayload)
      // Split 64-bit header across chunks to cover <10B wait
      pair.serverSide.write(bigPing.subarray(0, 5))
      pair.serverSide.write(bigPing.subarray(5))

      const medFrame = buildServerWsFrame(0x02, Buffer.alloc(200, 0x41))
      pair.serverSide.write(medFrame.subarray(0, 3))
      pair.serverSide.write(medFrame.subarray(3, 10))
      pair.serverSide.write(medFrame.subarray(10))

      // Reserved non-control opcode (0x03) and empty binary message (0B)
      pair.serverSide.write(buildServerWsFrame(0x03, Buffer.from('ignored')))
      pair.serverSide.write(buildServerWsFrame(0x02, Buffer.alloc(0)))

      pair.serverSide.write(buildServerWsFrame(0x02, Buffer.from('FRAG1-'), { fin: false }))
      pair.serverSide.write(buildServerWsFrame(0x00, Buffer.from('FRAG2'), { fin: true }))
      await clientWritesDone
      pair.serverSide.write(buildServerWsFrame(0x08, Buffer.alloc(0)))
    })()

    const ws = await connectWebSocketStream(pair.clientSide, 'fallback.example.com', 8080, {
      path: 'tunnel',
      headers: { Host: 'custom-ws.example.com', 'X-Custom': '1' },
    })
    await new Promise<void>(resolve => ws.write(Buffer.alloc(0), () => { resolve() }))
    await new Promise<void>(resolve => ws.write(Buffer.from('short'), () => { resolve() }))
    await new Promise<void>(resolve => ws.write(Buffer.alloc(40_000, 0x42), () => { resolve() }))
    resolveClientWrites()

    const wsReceived: Buffer[] = []
    for await (const c of ws) wsReceived.push(c as Buffer)
    await serverTask
    const combined = Buffer.concat(wsReceived)
    expect(combined.subarray(0, 6).toString()).toBe('EARLY-')
    expect(combined.subarray(combined.length - 11).toString()).toBe('FRAG1-FRAG2')
    await new Promise<void>(resolve => ws.end(() => { resolve() }))
    ws.destroy()

    // Client-initiated close followed by server echo close, plus server-first close before client .end()
    const pairClientClose = createDuplexPair()
    const clientCloseServer = (async () => {
      const r = new BufferedStreamReader(pairClientClose.serverSide)
      const hdr = (await r.readUntil(Buffer.from('\r\n\r\n'), 4096)).toString('utf8')
      const keyMatch = /Sec-WebSocket-Key:\s*(\S+)/i.exec(hdr)
      const accept = createHash('sha1').update(`${keyMatch?.[1] ?? ''}${WS_GUID}`).digest('base64')
      r.detach()
      pairClientClose.serverSide.resume()
      pairClientClose.serverSide.write(`HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    })()
    const wsClientClose = await connectWebSocketStream(pairClientClose.clientSide, 'example.com', 443, { path: '' })
    await clientCloseServer
    await new Promise<void>(resolve => wsClientClose.end(() => { resolve() }))
    pairClientClose.serverSide.write(buildServerWsFrame(0x08, Buffer.alloc(0)))
    wsClientClose.destroy()

    const pairSrvFirst = createDuplexPair()
    const srvFirstTask = (async () => {
      const r = new BufferedStreamReader(pairSrvFirst.serverSide)
      const hdr = (await r.readUntil(Buffer.from('\r\n\r\n'), 4096)).toString('utf8')
      const keyMatch = /Sec-WebSocket-Key:\s*(\S+)/i.exec(hdr)
      const accept = createHash('sha1').update(`${keyMatch?.[1] ?? ''}${WS_GUID}`).digest('base64')
      r.detach()
      pairSrvFirst.serverSide.resume()
      pairSrvFirst.serverSide.write(Buffer.concat([
        Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`),
        buildServerWsFrame(0x08, Buffer.alloc(0)),
      ]))
    })()
    const wsSrvFirst = await connectWebSocketStream(pairSrvFirst.clientSide, 'example.com', 443, { path: '/ws' })
    await srvFirstTask
    await new Promise<void>(resolve => wsSrvFirst.end(() => { resolve() }))
    wsSrvFirst.destroy()

    // Rejection cases: non-101 status, bad Sec-WebSocket-Accept, and >16 MiB server frame
    const p403 = createDuplexPair()
    p403.serverSide.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    await expect(connectWebSocketStream(p403.clientSide, 'example.com', 443, { path: '/ws' }))
      .rejects.toThrow(/upgrade rejected/)

    const pBadAccept = createDuplexPair()
    pBadAccept.serverSide.write('HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: wrong\r\n\r\n')
    await expect(connectWebSocketStream(pBadAccept.clientSide, 'example.com', 8080, { path: '/ws' }))
      .rejects.toThrow(/Accept mismatch/)

    const pGiant = createDuplexPair()
    const giantServer = (async () => {
      const r = new BufferedStreamReader(pGiant.serverSide)
      const hdr = (await r.readUntil(Buffer.from('\r\n\r\n'), 4096)).toString('utf8')
      const keyMatch = /Sec-WebSocket-Key:\s*(\S+)/i.exec(hdr)
      const accept = createHash('sha1').update(`${keyMatch?.[1] ?? ''}${WS_GUID}`).digest('base64')
      pGiant.serverSide.write(`HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      const badHdr = Buffer.alloc(10)
      badHdr[0] = 0x82
      badHdr[1] = 127
      badHdr.writeBigUInt64BE(32_000_000n, 2)
      pGiant.serverSide.write(badHdr)
      r.detach()
    })()
    const wsGiant = await connectWebSocketStream(pGiant.clientSide, 'example.com', 443, { path: '/ws' })
    const giantErr = new Promise<Error>(resolve => wsGiant.once('error', resolve))
    await giantServer
    expect((await giantErr).message).toMatch(/exceeds 16 MiB/)
  })
})
