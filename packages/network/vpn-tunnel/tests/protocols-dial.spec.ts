import { createDecipheriv, createHash, randomBytes } from 'node:crypto'
import net from 'node:net'
import { PassThrough } from 'node:stream'
import tls from 'node:tls'
import { describe, expect, it } from 'vitest'
import { blake3DeriveKey, blake3Hash } from '../src/blake3.ts'
import { RealDnsResolver } from '../src/dns.ts'
import { parseSocks5TargetAddress } from '../src/protocols/address.ts'
import { aeadOpen, aeadSeal, nonce12LittleEndian } from '../src/protocols/aead.ts'
import { dialProxyNode } from '../src/protocols/dial.ts'
import { deriveSsSubkey, dialShadowsocksAead, evpBytesToKey } from '../src/protocols/ss-aead.ts'
import { dialShadowsocks2022 } from '../src/protocols/ss2022.ts'
import { BufferedStreamReader, writeAll } from '../src/protocols/stream-io.ts'
import { dialTrojan } from '../src/protocols/trojan.ts'
import { dialHttpConnectUpstream, dialSocks5Upstream } from '../src/protocols/upstream-proxy.ts'
import { dialVless, parseUuidBytes } from '../src/protocols/vless.ts'
import { dialVmess, vmessKdf } from '../src/protocols/vmess.ts'
import { vpnNodeId, vpnSubscriptionId, type ProxyNodeConfig } from '../src/types.ts'
import { createSelfSignedTlsCredentials } from './tls-fixture.ts'

const SUB_ID = vpnSubscriptionId('sub_test')
const TEST_UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811'
const VMESS_MAGIC = Buffer.from('c48619fe-8f02-49e0-b9e9-edf763e17e21', 'ascii')

function baseNode(overrides: Partial<ProxyNodeConfig>): ProxyNodeConfig {
  return {
    id: vpnNodeId('sub_test:node1'),
    subscriptionId: SUB_ID,
    name: 'Test Node',
    protocol: 'ss2022',
    server: '127.0.0.1',
    port: 1080,
    ...overrides,
  }
}

describe('SS-2022, SS-AEAD, Trojan, VLESS, VMess, SOCKS5, HTTP CONNECT, and dialProxyNode', () => {
  it('completes SS-2022 single-PSK and SIP023 Multi-PSK EIH handshakes and rejects replay/auth failures', async () => {
    const iPsk = randomBytes(16)
    const uPsk = randomBytes(16)
    const multiPassword = `${iPsk.toString('base64')}:${uPsk.toString('base64')}`

    // Loopback SS-2022 server verifying SIP023 EIH + echoing payload via firstChunkLen > 0 AND subsequent chunks
    const srv = net.createServer((sock) => {
      void (async () => {
        const r = new BufferedStreamReader(sock)
        const reqSalt = await r.readExact(16)
        const eihBlock = await r.readExact(16)
        const idSubkey = blake3DeriveKey('shadowsocks 2022 identity subkey', Buffer.concat([iPsk, reqSalt]), 16)
        const decipher = createDecipheriv('aes-128-ecb', idSubkey, null)
        decipher.setAutoPadding(false)
        const decryptedHash = Buffer.concat([decipher.update(eihBlock), decipher.final()])
        expect(decryptedHash).toEqual(blake3Hash(uPsk, 16))

        const c2sKey = blake3DeriveKey('shadowsocks 2022 session subkey', Buffer.concat([uPsk, reqSalt]), 16)
        const fixedHdr = aeadOpen('aes-128-gcm', c2sKey, nonce12LittleEndian(0n), await r.readExact(11 + 16))
        const varLen = fixedHdr.readUInt16BE(9)
        const varPlain = aeadOpen('aes-128-gcm', c2sKey, nonce12LittleEndian(1n), await r.readExact(varLen + 16))
        const target = parseSocks5TargetAddress(varPlain)
        expect(target?.host).toBe('api.openai.com')

        // Read client first data frame
        const dataLenPlain = aeadOpen('aes-128-gcm', c2sKey, nonce12LittleEndian(2n), await r.readExact(2 + 16))
        const dataPlain = aeadOpen(
          'aes-128-gcm',
          c2sKey,
          nonce12LittleEndian(3n),
          await r.readExact(dataLenPlain.readUInt16BE(0) + 16),
        )
        r.detach()

        // Reply with server salt + fixed resp header + inline firstChunk + second chunk
        const respSalt = randomBytes(16)
        const s2cKey = blake3DeriveKey('shadowsocks 2022 session subkey', Buffer.concat([uPsk, respSalt]), 16)
        const inlineReply = Buffer.from(`INLINE:${dataPlain.toString('utf8')}`)
        const respFixed = Buffer.allocUnsafe(1 + 8 + 16 + 2)
        respFixed[0] = 0x01
        respFixed.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)), 1)
        reqSalt.copy(respFixed, 9)
        respFixed.writeUInt16BE(inlineReply.length, 25)

        const encRespFixed = aeadSeal('aes-128-gcm', s2cKey, nonce12LittleEndian(0n), respFixed)
        const encFirst = aeadSeal('aes-128-gcm', s2cKey, nonce12LittleEndian(1n), inlineReply)
        const secondPlain = Buffer.from(':TAIL')
        const secondLen = Buffer.allocUnsafe(2)
        secondLen.writeUInt16BE(secondPlain.length, 0)
        const encSecondLen = aeadSeal('aes-128-gcm', s2cKey, nonce12LittleEndian(2n), secondLen)
        const encSecondPay = aeadSeal('aes-128-gcm', s2cKey, nonce12LittleEndian(3n), secondPlain)

        // Drip-feed response header in parts to exercise partial initDecoder returns
        const fullResp = Buffer.concat([respSalt, encRespFixed, encFirst, encSecondLen, encSecondPay])
        sock.write(fullResp.subarray(0, 10))
        sock.write(fullResp.subarray(10, 48))
        sock.end(fullResp.subarray(48))
      })()
    })
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve))
    const port = (srv.address() as net.AddressInfo).port
    const dnsResolver = new RealDnsResolver({ systemLookup: async () => '127.0.0.1' })

    try {
      const stream = await dialProxyNode(
        baseNode({
          protocol: 'ss2022',
          port,
          cipher: '2022-blake3-aes-128-gcm',
          password: multiPassword,
          clockOffsetSeconds: 0,
        }),
        'api.openai.com',
        443,
        { dnsResolver, timeoutMs: 2000 },
      )
      await writeAll(stream, Buffer.from('PING'))
      const chunks: Buffer[] = []
      for await (const c of stream) chunks.push(c as Buffer)
      expect(Buffer.concat(chunks).toString()).toBe('INLINE:PING:TAIL')
    } finally {
      srv.close()
    }

    // Also test firstChunkLen === 0, wrong salt rejection, clock-skew > 30s rejection, and config errors
    const psk32 = randomBytes(32).toString('base64')
    await expect(dialShadowsocks2022(new PassThrough(), baseNode({ cipher: 'unknown' }), 'a.com', 80))
      .rejects.toThrow(/Unsupported Shadowsocks 2022 cipher/)
    await expect(dialShadowsocks2022(new PassThrough(), baseNode({ cipher: '2022-blake3-aes-128-gcm', password: ':' }), 'a.com', 80))
      .rejects.toThrow(/contains no Base64 PSK/)
    await expect(dialShadowsocks2022(new PassThrough(), baseNode({ cipher: '2022-blake3-aes-256-gcm', password: iPsk.toString('base64') }), 'a.com', 80))
      .rejects.toThrow(/decoded to 16 bytes/)
    await expect(dialShadowsocks2022(new PassThrough(), baseNode({ cipher: '2022-blake3-chacha20-poly1305', password: `${psk32}:${psk32}` }), 'a.com', 80))
      .rejects.toThrow(/SIP023 EIH requires/)

    // firstChunkLen === 0 + clock-skew failure + bad echoed salt failure
    for (const mode of ['zero-first-chunk', 'bad-salt', 'bad-skew'] as const) {
      const c2s = new PassThrough()
      const s2c = new PassThrough()
      const carrier = new PassThrough()
      carrier.write = c2s.write.bind(c2s)
      s2c.on('data', d => carrier.push(d))
      s2c.on('end', () => carrier.push(null))

      const rawKey = randomBytes(32)
      const stream = await dialShadowsocks2022(
        carrier,
        baseNode({ cipher: '2022-blake3-aes-256-gcm', password: rawKey.toString('base64') }),
        'example.com',
        443,
      )
      const greeting = c2s.read() as Buffer
      const reqSalt = greeting.subarray(0, 32)
      const respSalt = randomBytes(32)
      const s2cKey = blake3DeriveKey('shadowsocks 2022 session subkey', Buffer.concat([rawKey, respSalt]), 32)
      const respFixed = Buffer.allocUnsafe(1 + 8 + 32 + 2)
      respFixed[0] = 0x01
      const ts = mode === 'bad-skew' ? Math.floor(Date.now() / 1000) - 120 : Math.floor(Date.now() / 1000)
      respFixed.writeBigUInt64BE(BigInt(ts), 1)
      if (mode === 'bad-salt') randomBytes(32).copy(respFixed, 9)
      else reqSalt.copy(respFixed, 9)
      respFixed.writeUInt16BE(0, 41)
      const encRespFixed = aeadSeal('aes-256-gcm', s2cKey, nonce12LittleEndian(0n), respFixed)

      if (mode === 'zero-first-chunk') {
        const msg = Buffer.from('OK-ZERO')
        const lenB = Buffer.allocUnsafe(2)
        lenB.writeUInt16BE(msg.length, 0)
        s2c.end(Buffer.concat([
          respSalt,
          encRespFixed,
          aeadSeal('aes-256-gcm', s2cKey, nonce12LittleEndian(1n), lenB),
          aeadSeal('aes-256-gcm', s2cKey, nonce12LittleEndian(2n), msg),
        ]))
        const out: Buffer[] = []
        for await (const c of stream) out.push(c as Buffer)
        expect(Buffer.concat(out).toString()).toBe('OK-ZERO')
      } else {
        const errP = new Promise<Error>(resolve => stream.once('error', resolve))
        s2c.write(Buffer.concat([respSalt, encRespFixed]))
        expect((await errP).message).toMatch(/Shadowsocks 2022/)
      }
    }
  })

  it('completes classic SS-AEAD, Trojan, VLESS, and VMess (AES-GCM & ChaCha20) handshakes', async () => {
    // Classic SS-AEAD
    expect(evpBytesToKey('secret-pass', 32).length).toBe(32)
    await expect(dialShadowsocksAead(new PassThrough(), baseNode({ protocol: 'ss', cipher: 'rc4-md5', password: 'x' }), 'a.com', 80))
      .rejects.toThrow(/Unsupported Shadowsocks AEAD/)
    await expect(dialShadowsocksAead(new PassThrough(), baseNode({ protocol: 'ss', cipher: 'aes-128-gcm', password: '' }), 'a.com', 80))
      .rejects.toThrow(/password must be non-empty/)

    const ssSrv = net.createServer((sock) => {
      void (async () => {
        const r = new BufferedStreamReader(sock)
        const master = evpBytesToKey('my-ss-pass', 16)
        const reqSalt = await r.readExact(16)
        const c2s = deriveSsSubkey(master, reqSalt, 16)
        const addrLen = aeadOpen('aes-128-gcm', c2s, nonce12LittleEndian(0n), await r.readExact(18)).readUInt16BE(0)
        const addrBuf = aeadOpen('aes-128-gcm', c2s, nonce12LittleEndian(1n), await r.readExact(addrLen + 16))
        expect(parseSocks5TargetAddress(addrBuf)?.host).toBe('github.com')
        r.detach()

        const respSalt = randomBytes(16)
        const s2c = deriveSsSubkey(master, respSalt, 16)
        const reply = Buffer.from('SS-OK')
        const lenB = Buffer.allocUnsafe(2)
        lenB.writeUInt16BE(reply.length, 0)
        sock.write(respSalt.subarray(0, 5))
        sock.end(Buffer.concat([
          respSalt.subarray(5),
          aeadSeal('aes-128-gcm', s2c, nonce12LittleEndian(0n), lenB),
          aeadSeal('aes-128-gcm', s2c, nonce12LittleEndian(1n), reply),
        ]))
      })()
    })
    await new Promise<void>(resolve => ssSrv.listen(0, '127.0.0.1', resolve))
    const ssPort = (ssSrv.address() as net.AddressInfo).port
    const dnsResolver = new RealDnsResolver({ systemLookup: async () => '127.0.0.1' })

    try {
      const s = await dialProxyNode(
        baseNode({ protocol: 'ss', port: ssPort, cipher: 'aes-128-gcm', password: 'my-ss-pass' }),
        'github.com',
        443,
        { dnsResolver, timeoutMs: 2000 },
      )
      const out: Buffer[] = []
      for await (const c of s) out.push(c as Buffer)
      expect(Buffer.concat(out).toString()).toBe('SS-OK')
    } finally {
      ssSrv.close()
    }

    // Trojan (over TLS via dialProxyNode + password validation)
    await expect(dialTrojan(new PassThrough(), baseNode({ protocol: 'trojan', password: '' }), 'a.com', 443))
      .rejects.toThrow(/Trojan node password/)

    const creds = createSelfSignedTlsCredentials()
    const trojanSrv = tls.createServer({ key: creds.key, cert: creds.cert }, (sock) => {
      void (async () => {
        const r = new BufferedStreamReader(sock)
        const hashLine = await r.readExact(58)
        expect(hashLine.subarray(0, 56).toString('ascii'))
          .toBe(createHash('sha224').update('trojan-pw', 'utf8').digest('hex'))
        const cmd = await r.readExact(1)
        expect(cmd[0]).toBe(0x01)
        r.detach()
        sock.end('TROJAN-OK')
      })()
    })
    await new Promise<void>(resolve => trojanSrv.listen(0, '127.0.0.1', resolve))
    const trojanPort = (trojanSrv.address() as net.AddressInfo).port
    try {
      const ts = await dialProxyNode(
        baseNode({ protocol: 'trojan', port: trojanPort, password: 'trojan-pw', tls: { enabled: true, skipCertVerify: true } }),
        '1.1.1.1',
        443,
        { dnsResolver, timeoutMs: 2000 },
      )
      const out: Buffer[] = []
      for await (const c of ts) out.push(c as Buffer)
      expect(Buffer.concat(out).toString()).toBe('TROJAN-OK')
    } finally {
      trojanSrv.close()
    }

    // VLESS: UUID validation, response addons stripping, truncated EOF error, and dialProxyNode
    expect(() => parseUuidBytes('not-a-uuid')).toThrow(/Invalid proxy node UUID/)
    const vlessSrv = net.createServer((sock) => {
      sock.once('data', () => {
        // Send [version=0x00, addonsLen=2, 0xaa, 0xbb] in two parts + payload
        sock.write(Buffer.from([0x00]))
        sock.write(Buffer.from([0x02, 0xaa]))
        sock.write(Buffer.from([0xbb, ...Buffer.from('VLESS-')]))
        sock.end(Buffer.from('OK'))
      })
    })
    await new Promise<void>(resolve => vlessSrv.listen(0, '127.0.0.1', resolve))
    const vlessPort = (vlessSrv.address() as net.AddressInfo).port
    try {
      const vs = await dialProxyNode(
        baseNode({ protocol: 'vless', port: vlessPort, uuid: TEST_UUID }),
        'example.com',
        443,
        { dnsResolver, timeoutMs: 2000 },
      )
      await writeAll(vs, Buffer.from('HI'))
      const out: Buffer[] = []
      for await (const c of vs) out.push(c as Buffer)
      expect(Buffer.concat(out).toString()).toBe('VLESS-OK')
      await new Promise<void>(resolve => vs.end(() => { resolve() }))
      vs.destroy()
    } finally {
      vlessSrv.close()
    }

    const ptVlessTrunc = new PassThrough()
    const vlessTrunc = await dialVless(ptVlessTrunc, baseNode({ protocol: 'vless', uuid: TEST_UUID }), 'a.com', 80)
    const vlessErrP = new Promise<Error>(resolve => vlessTrunc.once('error', resolve))
    ptVlessTrunc.write(Buffer.from([0x00]))
    ptVlessTrunc.end()
    expect((await vlessErrP).message).toMatch(/Truncated VLESS/)

    // VMess AEAD: KDF (>64B segment path), unsupported cipher, and full AES-128-GCM + ChaCha20-Poly1305 server round-trips
    expect(vmessKdf(Buffer.from('k'), [Buffer.alloc(80, 0x42)]).length).toBe(32)
    await expect(dialVmess(new PassThrough(), baseNode({ protocol: 'vmess', uuid: TEST_UUID, cipher: 'none' }), 'a.com', 80))
      .rejects.toThrow(/Unsupported VMess AEAD/)

    for (const cipher of ['aes-128-gcm', 'chacha20-poly1305'] as const) {
      const vmessSrv = net.createServer((sock) => {
        void (async () => {
          const r = new BufferedStreamReader(sock)
          const uuidBytes = parseUuidBytes(TEST_UUID)
          const cmdKey = createHash('md5').update(Buffer.concat([uuidBytes, VMESS_MAGIC])).digest()

          const authId = await r.readExact(16)
          const encLen = await r.readExact(18)
          const nonce8 = await r.readExact(8)
          const lenKey = vmessKdf(cmdKey, ['VMess Header AEAD Key_Length', authId, nonce8]).subarray(0, 16)
          const lenNonce = vmessKdf(cmdKey, ['VMess Header AEAD Nonce_Length', authId, nonce8]).subarray(0, 12)
          const cmdLen = aeadOpen('aes-128-gcm', lenKey, lenNonce, encLen, authId).readUInt16BE(0)

          const encCmd = await r.readExact(cmdLen + 16)
          const hdrKey = vmessKdf(cmdKey, ['VMess Header AEAD Key', authId, nonce8]).subarray(0, 16)
          const hdrNonce = vmessKdf(cmdKey, ['VMess Header AEAD Nonce', authId, nonce8]).subarray(0, 12)
          const cmdPlain = aeadOpen('aes-128-gcm', hdrKey, hdrNonce, encCmd, authId)

          const dataBodyIV = cmdPlain.subarray(1, 17)
          const dataBodyKey = cmdPlain.subarray(17, 33)
          const respAuthV = cmdPlain[33] as number

          // Read client's first chunk + EOF chunk
          const cChunkLen = (await r.readExact(2)).readUInt16BE(0)
          const cChunk = await r.readExact(cChunkLen)
          r.detach()

          const expand32 = (k16: Buffer): Buffer => {
            const m1 = createHash('md5').update(k16).digest()
            const m2 = createHash('md5').update(m1).digest()
            return Buffer.concat([m1, m2])
          }
          const mkNonce = (cnt: number, iv: Buffer): Buffer => {
            const n = Buffer.allocUnsafe(12)
            n.writeUInt16BE(cnt, 0)
            iv.subarray(2, 12).copy(n, 2)
            return n
          }
          const c2sKey = cipher === 'chacha20-poly1305' ? expand32(dataBodyKey) : dataBodyKey
          const clientMsg = aeadOpen(cipher, c2sKey, mkNonce(0, dataBodyIV), cChunk)

          // Build VMess AEAD response header + chunk + empty EOF chunk
          const respBodyKey = createHash('sha256').update(dataBodyKey).digest().subarray(0, 16)
          const respBodyIV = createHash('sha256').update(dataBodyIV).digest().subarray(0, 16)
          const s2cKey = cipher === 'chacha20-poly1305' ? expand32(respBodyKey) : respBodyKey

          const respHdrPlain = Buffer.from([respAuthV, 0x00, 0x00, 0x00])
          const respHdrLenBuf = Buffer.from([0x00, 0x04])
          const encRespLen = aeadSeal(
            'aes-128-gcm',
            vmessKdf(respBodyKey, ['AEAD Resp Header Len Key']).subarray(0, 16),
            vmessKdf(respBodyIV, ['AEAD Resp Header Len IV']).subarray(0, 12),
            respHdrLenBuf,
          )
          const encRespHdr = aeadSeal(
            'aes-128-gcm',
            vmessKdf(respBodyKey, ['AEAD Resp Header Key']).subarray(0, 16),
            vmessKdf(respBodyIV, ['AEAD Resp Header IV']).subarray(0, 12),
            respHdrPlain,
          )
          const replySealed = aeadSeal(cipher, s2cKey, mkNonce(0, respBodyIV), Buffer.from(`VMESS:${clientMsg.toString()}`))
          const replyPrefix = Buffer.allocUnsafe(2)
          replyPrefix.writeUInt16BE(replySealed.length, 0)
          const eofSealed = aeadSeal(cipher, s2cKey, mkNonce(1, respBodyIV), Buffer.alloc(0))
          const eofPrefix = Buffer.allocUnsafe(2)
          eofPrefix.writeUInt16BE(eofSealed.length, 0)

          const all = Buffer.concat([encRespLen, encRespHdr, replyPrefix, replySealed, eofPrefix, eofSealed])
          sock.write(all.subarray(0, 10))
          sock.write(all.subarray(10, 25))
          sock.end(all.subarray(25))
        })()
      })
      await new Promise<void>(resolve => vmessSrv.listen(0, '127.0.0.1', resolve))
      const vmessPort = (vmessSrv.address() as net.AddressInfo).port
      try {
        const vms = await dialProxyNode(
          baseNode({ protocol: 'vmess', port: vmessPort, uuid: TEST_UUID, cipher }),
          'claude.ai',
          443,
          { dnsResolver, timeoutMs: 2000, signal: new AbortController().signal },
        )
        await new Promise<void>(resolve => vms.write(Buffer.alloc(0), () => { resolve() }))
        await writeAll(vms, Buffer.from('HELLO'))
        const out: Buffer[] = []
        for await (const c of vms) out.push(c as Buffer)
        expect(Buffer.concat(out).toString()).toBe('VMESS:HELLO')
        await new Promise<void>(resolve => vms.end(() => { resolve() }))
        vms.destroy()
      } finally {
        vmessSrv.close()
      }
    }
  })

  it('completes upstream SOCKS5 and HTTP CONNECT handshakes and surfaces auth/protocol errors', async () => {
    const dnsResolver = new RealDnsResolver({ systemLookup: async () => '127.0.0.1' })

    // SOCKS5 server testing no-auth (IPv4 bind), user/pass auth (domain bind), IPv6 bind, and rejection paths
    let socksMode: 'noauth-v4' | 'auth-dom' | 'noauth-v6' | 'bad-ver' | 'no-method' | 'bad-auth' | 'fail-cmd' | 'bad-atyp' = 'noauth-v4'
    const socksSrv = net.createServer((sock) => {
      sock.on('error', () => {})
      void (async () => {
        const r = new BufferedStreamReader(sock)
        const greet = await r.readExact(2)
        await r.readExact(greet[1] as number)
        if (socksMode === 'bad-ver') {
          sock.end(Buffer.from([0x04, 0x00]))
          return
        }
        if (socksMode === 'no-method') {
          sock.end(Buffer.from([0x05, 0xff]))
          return
        }
        if (socksMode === 'auth-dom' || socksMode === 'bad-auth') {
          sock.write(Buffer.from([0x05, 0x02]))
          const uHdr = await r.readExact(2)
          await r.readExact(uHdr[1] as number)
          const pLen = await r.readExact(1)
          await r.readExact(pLen[0] as number)
          if (socksMode === 'bad-auth') {
            sock.end(Buffer.from([0x01, 0x01]))
            return
          }
          sock.write(Buffer.from([0x01, 0x00]))
        } else {
          sock.write(Buffer.from([0x05, 0x00]))
        }

        const reqHead = await r.readExact(4)
        if (reqHead[3] === 0x03) {
          const dLen = await r.readExact(1)
          await r.readExact((dLen[0] as number) + 2)
        }
        r.detach()

        if (socksMode === 'fail-cmd') {
          sock.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          return
        }
        if (socksMode === 'bad-atyp') {
          sock.end(Buffer.from([0x05, 0x00, 0x00, 0x99]))
          return
        }
        if (socksMode === 'auth-dom') {
          sock.end(Buffer.from([0x05, 0x00, 0x00, 0x03, 0x01, 0x61, 0x00, 0x50, ...Buffer.from('S5-DOM')]))
          return
        }
        if (socksMode === 'noauth-v6') {
          sock.end(Buffer.concat([Buffer.from([0x05, 0x00, 0x00, 0x04]), Buffer.alloc(18), Buffer.from('S5-V6')]))
          return
        }
        sock.end(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 80, ...Buffer.from('S5-V4')]))
      })().catch(() => {})
    })
    await new Promise<void>(resolve => socksSrv.listen(0, '127.0.0.1', resolve))
    const socksPort = (socksSrv.address() as net.AddressInfo).port

    try {
      const s1 = await dialProxyNode(baseNode({ protocol: 'socks5', port: socksPort }), 'a.com', 80, { dnsResolver, timeoutMs: 2000 })
      const out1: Buffer[] = []
      for await (const c of s1) out1.push(c as Buffer)
      expect(Buffer.concat(out1).toString()).toBe('S5-V4')

      socksMode = 'auth-dom'
      const s2 = await dialProxyNode(
        baseNode({ protocol: 'socks5', port: socksPort, username: 'u', password: 'p' }),
        'a.com',
        80,
        { dnsResolver, timeoutMs: 2000 },
      )
      const out2: Buffer[] = []
      for await (const c of s2) out2.push(c as Buffer)
      expect(Buffer.concat(out2).toString()).toBe('S5-DOM')

      socksMode = 'noauth-v6'
      const s3 = await dialProxyNode(baseNode({ protocol: 'socks5', port: socksPort }), 'a.com', 80, { dnsResolver, timeoutMs: 2000 })
      const out3: Buffer[] = []
      for await (const c of s3) out3.push(c as Buffer)
      expect(Buffer.concat(out3).toString()).toBe('S5-V6')

      // Oversized SOCKS5 credentials (>255B)
      socksMode = 'auth-dom'
      await expect(dialProxyNode(
        baseNode({ protocol: 'socks5', port: socksPort, username: 'u'.repeat(260), password: 'p' }),
        'a.com',
        80,
        { dnsResolver, timeoutMs: 2000 },
      )).rejects.toThrow(/exceed 255 bytes/)

      for (const [m, pattern] of [
        ['bad-ver', /Invalid SOCKS5 version/],
        ['no-method', /rejected offered authentication/],
        ['bad-auth', /authentication rejected/],
        ['fail-cmd', /CONNECT failed/],
        ['bad-atyp', /Unknown SOCKS5 bound address/],
      ] as const) {
        socksMode = m
        const creds = m === 'bad-auth' ? { username: 'u', password: 'wrong' } : {}
        await expect(dialProxyNode(baseNode({ protocol: 'socks5', port: socksPort, ...creds }), 'a.com', 80, { dnsResolver, timeoutMs: 2000 }))
          .rejects.toThrow(pattern)
      }
    } finally {
      socksSrv.close()
    }

    // HTTP CONNECT upstream: 200 OK (Basic auth + IPv6 target), 407 Auth failed, 502 error, malformed status, obfs/ws carriers
    let httpStatusLine = 'HTTP/1.1 200 Connection Established'
    const httpSrv = net.createServer((sock) => {
      sock.on('error', () => {})
      void (async () => {
        const r = new BufferedStreamReader(sock)
        const req = (await r.readUntil(Buffer.from('\r\n\r\n'), 4096)).toString('utf8')
        expect(req).toContain('Proxy-Authorization: Basic ')
        r.detach()
        sock.end(`${httpStatusLine}\r\n\r\nHTTP-TUNNEL-OK`)
      })().catch(() => {})
    })
    await new Promise<void>(resolve => httpSrv.listen(0, '127.0.0.1', resolve))
    const httpPort = (httpSrv.address() as net.AddressInfo).port

    try {
      const hs = await dialProxyNode(
        baseNode({ protocol: 'http', port: httpPort, username: 'u', password: 'p' }),
        '2001:db8::1',
        443,
        { dnsResolver, timeoutMs: 2000 },
      )
      const out: Buffer[] = []
      for await (const c of hs) out.push(c as Buffer)
      expect(Buffer.concat(out).toString()).toBe('HTTP-TUNNEL-OK')

      httpStatusLine = 'HTTP/1.1 407 Proxy Authentication Required'
      await expect(dialProxyNode(
        baseNode({ protocol: 'http', port: httpPort, username: 'u' }),
        'example.com',
        443,
        { dnsResolver, timeoutMs: 2000 },
      )).rejects.toThrow(/407/)

      httpStatusLine = 'HTTP/1.1 502 Bad Gateway'
      const rawHttpSock = net.connect({ host: '127.0.0.1', port: httpPort })
      rawHttpSock.on('error', () => {})
      await expect(dialHttpConnectUpstream(
        rawHttpSock,
        baseNode({ protocol: 'http', port: httpPort, password: 'p' }),
        'example.com',
        443,
      )).rejects.toThrow(/502/)
      rawHttpSock.destroy()

      httpStatusLine = 'GARBAGE'
      await expect(dialProxyNode(
        baseNode({ protocol: 'http', port: httpPort, password: 'p' }),
        'example.com',
        443,
        { dnsResolver, timeoutMs: 2000 },
      )).rejects.toThrow(/CONNECT failed/)
    } finally {
      httpSrv.close()
    }

    // Also cover dialProxyNode with obfs: http, obfs: tls, and ws failure cleanup
    const dummySrv = net.createServer((sock) => {
      sock.on('error', () => {})
      sock.end('HTTP/1.1 400 Bad\r\n\r\n')
    })
    await new Promise<void>(resolve => dummySrv.listen(0, '127.0.0.1', resolve))
    const dummyPort = (dummySrv.address() as net.AddressInfo).port
    try {
      const obfs1 = await dialProxyNode(
        baseNode({ protocol: 'trojan', port: dummyPort, password: 'pw', tls: { enabled: false }, obfs: { mode: 'http', host: 'a.com' } }),
        'example.com',
        80,
        { dnsResolver, timeoutMs: 2000 },
      )
      obfs1.destroy()
      const obfs2 = await dialProxyNode(
        baseNode({ protocol: 'trojan', port: dummyPort, password: 'pw', tls: { enabled: false }, obfs: { mode: 'tls', host: 'a.com' } }),
        'example.com',
        80,
        { dnsResolver, timeoutMs: 2000 },
      )
      obfs2.destroy()
      await expect(dialProxyNode(
        baseNode({ protocol: 'vless', port: dummyPort, uuid: TEST_UUID, ws: { path: '/ws' } }),
        'example.com',
        80,
        { dnsResolver, timeoutMs: 2000 },
      )).rejects.toThrow(/upgrade rejected/)
      // Trojan default tls ({ enabled: true }) when node.tls is omitted -> rejects TLS handshake against plain HTTP server
      await expect(dialProxyNode(
        baseNode({ protocol: 'trojan', port: dummyPort, password: 'pw' }),
        'example.com',
        443,
        { dnsResolver, timeoutMs: 2000 },
      )).rejects.toThrow()
    } finally {
      dummySrv.close()
    }
  })

  it('handles fragmented protocol headers, missing optional fields, and VMess final/mismatch branches', async () => {
    const makePair = () => {
      const c2s = new PassThrough()
      const s2c = new PassThrough()
      const carrier = new PassThrough()
      carrier.write = c2s.write.bind(c2s)
      carrier.end = ((...args: unknown[]) => {
        const cb = typeof args[args.length - 1] === 'function' ? (args[args.length - 1] as () => void) : undefined
        c2s.end(() => { cb?.() })
        return carrier
      }) as typeof carrier.end
      s2c.on('data', d => carrier.push(d))
      s2c.on('end', () => carrier.push(null))
      return { c2s, s2c, carrier }
    }

    // Undefined cipher/password/uuid validation branches
    await expect(dialShadowsocksAead(new PassThrough(), baseNode({ protocol: 'ss' }), 'a.com', 80))
      .rejects.toThrow(/Unsupported Shadowsocks AEAD/)
    await expect(dialShadowsocks2022(new PassThrough(), baseNode({ protocol: 'ss2022' }), 'a.com', 80))
      .rejects.toThrow(/Unsupported Shadowsocks 2022/)
    await expect(dialShadowsocks2022(new PassThrough(), baseNode({ protocol: 'ss2022', cipher: '2022-blake3-aes-128-gcm' }), 'a.com', 80))
      .rejects.toThrow(/contains no Base64 PSK/)
    await expect(dialVless(new PassThrough(), baseNode({ protocol: 'vless' }), 'a.com', 80))
      .rejects.toThrow(/Invalid proxy node UUID/)
    await expect(dialVmess(new PassThrough(), baseNode({ protocol: 'vmess' }), 'a.com', 80))
      .rejects.toThrow(/Invalid proxy node UUID/)

    // SS-AEAD drip-fed response salt (< 16B then rest)
    {
      const { s2c, carrier } = makePair()
      const stream = await dialShadowsocksAead(
        carrier,
        baseNode({ protocol: 'ss', cipher: 'aes-128-gcm', password: 'pw' }),
        'a.com',
        80,
      )
      const respSalt = randomBytes(16)
      const s2cKey = deriveSsSubkey(evpBytesToKey('pw', 16), respSalt, 16)
      const msg = Buffer.from('FRAG-SS')
      const lenB = Buffer.from([0, msg.length])
      s2c.write(respSalt.subarray(0, 5))
      s2c.end(Buffer.concat([
        respSalt.subarray(5),
        aeadSeal('aes-128-gcm', s2cKey, nonce12LittleEndian(0n), lenB),
        aeadSeal('aes-128-gcm', s2cKey, nonce12LittleEndian(1n), msg),
      ]))
      const out: Buffer[] = []
      for await (const c of stream) out.push(c as Buffer)
      expect(Buffer.concat(out).toString()).toBe('FRAG-SS')
    }

    // SS-2022 drip-fed response header (< minRespHeaderBytes, then < totalNeeded with inline firstChunk, then rest)
    {
      const { c2s, s2c, carrier } = makePair()
      const key16 = randomBytes(16)
      const stream = await dialShadowsocks2022(
        carrier,
        baseNode({ protocol: 'ss2022', cipher: '2022-blake3-aes-128-gcm', password: key16.toString('base64') }),
        'a.com',
        80,
      )
      const reqSalt = (c2s.read() as Buffer).subarray(0, 16)
      const respSalt = randomBytes(16)
      const s2cKey = blake3DeriveKey('shadowsocks 2022 session subkey', Buffer.concat([key16, respSalt]), 16)
      const inline = Buffer.from('INLINE-2022')
      const respFixed = Buffer.allocUnsafe(1 + 8 + 16 + 2)
      respFixed[0] = 0x01
      respFixed.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)), 1)
      reqSalt.copy(respFixed, 9)
      respFixed.writeUInt16BE(inline.length, 25)
      const full = Buffer.concat([
        respSalt,
        aeadSeal('aes-128-gcm', s2cKey, nonce12LittleEndian(0n), respFixed),
        aeadSeal('aes-128-gcm', s2cKey, nonce12LittleEndian(1n), inline),
      ])
      s2c.write(full.subarray(0, 10))
      s2c.write(full.subarray(10, 62))
      s2c.end(full.subarray(62))
      const out: Buffer[] = []
      for await (const c of stream) out.push(c as Buffer)
      expect(Buffer.concat(out).toString()).toBe('INLINE-2022')
    }

    // VLESS drip-fed response header (< 2 + addonsLen, 0 remainder, then subsequent chunk)
    {
      const { s2c, carrier } = makePair()
      const vs = await dialVless(carrier, baseNode({ protocol: 'vless', uuid: TEST_UUID }), 'a.com', 80)
      s2c.write(Buffer.from([0x00]))
      s2c.write(Buffer.from([0x02, 0xaa]))
      s2c.write(Buffer.from([0xbb]))
      s2c.end(Buffer.from('POST-ADDONS'))
      const out: Buffer[] = []
      for await (const c of vs) out.push(c as Buffer)
      expect(Buffer.concat(out).toString()).toBe('POST-ADDONS')
    }

    // Upstream SOCKS5 server requesting 0x02 when node has undefined username/password + HTTP CONNECT without auth
    {
      const { s2c, carrier } = makePair()
      s2c.end(Buffer.from([0x05, 0x02, 0x01, 0x01]))
      await expect(dialSocks5Upstream(carrier, baseNode({ protocol: 'socks5' }), 'a.com', 80))
        .rejects.toThrow(/authentication rejected/)

      const pHttp = makePair()
      pHttp.s2c.end('HTTP/1.1 200 OK\r\n\r\nPLAIN-HTTP')
      const hs = await dialHttpConnectUpstream(pHttp.carrier, baseNode({ protocol: 'http' }), 'a.com', 80)
      const out: Buffer[] = []
      for await (const c of hs) out.push(c as Buffer)
      expect(Buffer.concat(out).toString()).toBe('PLAIN-HTTP')
    }

    // VMess drip-fed response header + chunk + client .end() BEFORE reading + respAuthV mismatch
    for (const badAuth of [false, true]) {
      const { c2s, s2c, carrier } = makePair()
      const vms = await dialVmess(carrier, baseNode({ protocol: 'vmess', uuid: TEST_UUID }), 'a.com', 80)
      await new Promise<void>(resolve => vms.end(() => { resolve() }))

      const wire = c2s.read() as Buffer
      const cmdKey = createHash('md5').update(Buffer.concat([parseUuidBytes(TEST_UUID), VMESS_MAGIC])).digest()
      const authId = wire.subarray(0, 16)
      const encLen = wire.subarray(16, 34)
      const nonce8 = wire.subarray(34, 42)
      const cmdLen = aeadOpen(
        'aes-128-gcm',
        vmessKdf(cmdKey, ['VMess Header AEAD Key_Length', authId, nonce8]).subarray(0, 16),
        vmessKdf(cmdKey, ['VMess Header AEAD Nonce_Length', authId, nonce8]).subarray(0, 12),
        encLen,
        authId,
      ).readUInt16BE(0)
      const cmdPlain = aeadOpen(
        'aes-128-gcm',
        vmessKdf(cmdKey, ['VMess Header AEAD Key', authId, nonce8]).subarray(0, 16),
        vmessKdf(cmdKey, ['VMess Header AEAD Nonce', authId, nonce8]).subarray(0, 12),
        wire.subarray(42, 42 + cmdLen + 16),
        authId,
      )
      const dataBodyIV = cmdPlain.subarray(1, 17)
      const dataBodyKey = cmdPlain.subarray(17, 33)
      const respAuthV = cmdPlain[33] as number
      const respBodyKey = createHash('sha256').update(dataBodyKey).digest().subarray(0, 16)
      const respBodyIV = createHash('sha256').update(dataBodyIV).digest().subarray(0, 16)

      const encRespLen = aeadSeal(
        'aes-128-gcm',
        vmessKdf(respBodyKey, ['AEAD Resp Header Len Key']).subarray(0, 16),
        vmessKdf(respBodyIV, ['AEAD Resp Header Len IV']).subarray(0, 12),
        Buffer.from([0x00, 0x04]),
      )
      const encRespHdr = aeadSeal(
        'aes-128-gcm',
        vmessKdf(respBodyKey, ['AEAD Resp Header Key']).subarray(0, 16),
        vmessKdf(respBodyIV, ['AEAD Resp Header IV']).subarray(0, 12),
        Buffer.from([badAuth ? (respAuthV ^ 0xff) : respAuthV, 0, 0, 0]),
      )

      if (badAuth) {
        const errP = new Promise<Error>(resolve => vms.once('error', resolve))
        s2c.write(Buffer.concat([encRespLen, encRespHdr]))
        expect((await errP).message).toMatch(/verification byte mismatch/)
      } else {
        const mkNonce = (cnt: number): Buffer => {
          const n = Buffer.allocUnsafe(12)
          n.writeUInt16BE(cnt, 0)
          respBodyIV.subarray(2, 12).copy(n, 2)
          return n
        }
        const c1 = aeadSeal('aes-128-gcm', respBodyKey, mkNonce(0), Buffer.from('V1-'))
        const p1 = Buffer.from([c1.length >>> 8, c1.length & 0xff])
        const c2 = aeadSeal('aes-128-gcm', respBodyKey, mkNonce(1), Buffer.from('V2'))
        const p2 = Buffer.from([c2.length >>> 8, c2.length & 0xff])
        const eof = aeadSeal('aes-128-gcm', respBodyKey, mkNonce(2), Buffer.alloc(0))
        const pEof = Buffer.from([eof.length >>> 8, eof.length & 0xff])

        s2c.write(encRespLen.subarray(0, 5))
        s2c.write(encRespLen.subarray(5))
        s2c.write(Buffer.concat([encRespHdr, p1.subarray(0, 1)]))
        s2c.write(Buffer.concat([p1.subarray(1), c1.subarray(0, 4)]))
        s2c.end(Buffer.concat([c1.subarray(4), p2, c2, pEof, eof]))
        const out: Buffer[] = []
        for await (const c of vms) out.push(c as Buffer)
        expect(Buffer.concat(out).toString()).toBe('V1-V2')
      }
    }
  })
})
