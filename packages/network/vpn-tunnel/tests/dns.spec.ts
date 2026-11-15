import dgram from 'node:dgram'
import { describe, expect, it, vi } from 'vitest'
import {
  buildDnsARecordQuery,
  DEFAULT_CLEAN_DNS_SERVERS,
  isFakeIpAddress,
  parseDnsARecordResponse,
  RealDnsResolver,
} from '../src/dns.ts'

function makeDnsResponse(spec: {
  readonly txId: number
  readonly flags?: number
  readonly qname?: Buffer
  readonly answers: readonly {
    readonly nameBytes: Buffer
    readonly type: number
    readonly classCode?: number
    readonly ttl: number
    readonly rdata: Buffer
  }[]
}): Buffer {
  const qname = spec.qname ?? Buffer.from([
    0x04, 0x65, 0x64, 0x67, 0x65,
    0x07, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65,
    0x03, 0x63, 0x6f, 0x6d, 0x00,
  ])
  const header = Buffer.alloc(12)
  header.writeUInt16BE(spec.txId & 0xffff, 0)
  header.writeUInt16BE(spec.flags ?? 0x8180, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(spec.answers.length, 6)

  const question = Buffer.alloc(qname.length + 4)
  qname.copy(question, 0)
  question.writeUInt16BE(1, qname.length)
  question.writeUInt16BE(1, qname.length + 2)

  const answerBuffers = spec.answers.map((ans) => {
    const meta = Buffer.alloc(10)
    meta.writeUInt16BE(ans.type, 0)
    meta.writeUInt16BE(ans.classCode ?? 1, 2)
    meta.writeUInt32BE(ans.ttl >>> 0, 4)
    meta.writeUInt16BE(ans.rdata.length, 8)
    return Buffer.concat([ans.nameBytes, meta, ans.rdata])
  })

  return Buffer.concat([header, question, ...answerBuffers])
}

describe('Anti-FakeIP DNS utilities and RealDnsResolver', () => {
  it('identifies RFC 2544 / Clash FakeIP addresses in 198.18.0.0/15', () => {
    expect(DEFAULT_CLEAN_DNS_SERVERS.length).toBeGreaterThanOrEqual(3)
    expect(isFakeIpAddress('198.18.0.1')).toBe(true)
    expect(isFakeIpAddress('198.19.255.254')).toBe(true)
    expect(isFakeIpAddress('198.17.255.255')).toBe(false)
    expect(isFakeIpAddress('198.20.0.1')).toBe(false)
    expect(isFakeIpAddress('1.1.1.1')).toBe(false)
    expect(isFakeIpAddress('2001:4860:4860::8888')).toBe(false)
    expect(isFakeIpAddress('not-an-ip')).toBe(false)
  })

  it('builds RFC 1035 A-record queries and rejects empty or oversized labels', () => {
    const query = buildDnsARecordQuery('edge.example.com.', 0x1234)
    expect(query.readUInt16BE(0)).toBe(0x1234)
    expect(query.readUInt16BE(2)).toBe(0x0100)
    expect(query.readUInt16BE(4)).toBe(1)

    expect(() => buildDnsARecordQuery('.', 1)).toThrow(/Invalid DNS query hostname/)
    expect(() => buildDnsARecordQuery(`${'a'.repeat(64)}.com`, 1)).toThrow(/Invalid DNS query hostname/)
  })

  it('parses clean DNS A records while skipping CNAMEs, FakeIPs, and malformed packets', () => {
    expect(parseDnsARecordResponse(Buffer.alloc(5), 1)).toBeNull()

    // Wrong txId
    const goodPacket = makeDnsResponse({
      txId: 0x2222,
      answers: [
        { nameBytes: Buffer.from([0xc0, 0x0c]), type: 1, ttl: 5, rdata: Buffer.from([93, 184, 216, 34]) },
      ],
    })
    expect(parseDnsARecordResponse(goodPacket, 0x1111)).toBeNull()

    // Non-response or RCODE != 0
    const nxdomain = makeDnsResponse({ txId: 0x2222, flags: 0x8183, answers: [] })
    expect(parseDnsARecordResponse(nxdomain, 0x2222)).toBeNull()
    const queryNotResp = makeDnsResponse({ txId: 0x2222, flags: 0x0100, answers: [] })
    expect(parseDnsARecordResponse(queryNotResp, 0x2222)).toBeNull()

    // Skips CNAME + FakeIP A record, returns clean A record with clamped TTL [30, 3600]
    const multiAnswer = makeDnsResponse({
      txId: 0x3333,
      answers: [
        { nameBytes: Buffer.from([0xc0, 0x0c]), type: 5, ttl: 120, rdata: Buffer.from([0x03, 0x63, 0x64, 0x6e, 0x00]) },
        { nameBytes: Buffer.from([0xc0, 0x0c]), type: 1, ttl: 120, rdata: Buffer.from([198, 18, 0, 99]) },
        { nameBytes: Buffer.from([0xc0, 0x0c]), type: 1, ttl: 99_999, rdata: Buffer.from([93, 184, 216, 34]) },
      ],
    })
    expect(parseDnsARecordResponse(multiAnswer, 0x3333)).toEqual({
      ip: '93.184.216.34',
      ttlSeconds: 3600,
    })

    // Minimum TTL clamp to 30s
    expect(parseDnsARecordResponse(goodPacket, 0x2222)).toEqual({
      ip: '93.184.216.34',
      ttlSeconds: 30,
    })

    // No clean A records -> null
    const onlyFake = makeDnsResponse({
      txId: 0x4444,
      answers: [{ nameBytes: Buffer.from([0xc0, 0x0c]), type: 1, ttl: 60, rdata: Buffer.from([198, 19, 1, 2]) }],
    })
    expect(parseDnsARecordResponse(onlyFake, 0x4444)).toBeNull()

    // Malformed DNS label types & truncated sections
    const badLabelBits = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x81, 0x80, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      Buffer.from([0x40, 0x01]), // reserved 01xx_xxxx compression bits
    ])
    expect(parseDnsARecordResponse(badLabelBits, 1)).toBeNull()

    const truncatedPointer = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x81, 0x80, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      Buffer.from([0xc0]), // 1-byte pointer at packet end
    ])
    expect(parseDnsARecordResponse(truncatedPointer, 1)).toBeNull()

    const truncatedLabel = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x81, 0x80, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      Buffer.from([0x09, 0x61, 0x62]), // claims 9 bytes, only 2 remain
    ])
    expect(parseDnsARecordResponse(truncatedLabel, 1)).toBeNull()

    const unterminatedName = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x81, 0x80, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      Buffer.alloc(0), // offset == packet.length immediately
    ])
    expect(parseDnsARecordResponse(unterminatedName, 1)).toBeNull()

    const truncatedAnswerHeader = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x81, 0x80, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
      Buffer.from([0x01, 0x61, 0x00, 0x00, 0x01, 0x00, 0x01]),
      Buffer.from([0xc0, 0x0c, 0x00, 0x01]), // answer missing 10-byte RR header
    ])
    expect(parseDnsARecordResponse(truncatedAnswerHeader, 1)).toBeNull()

    const truncatedRdata = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x81, 0x80, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
      Buffer.from([0x01, 0x61, 0x00, 0x00, 0x01, 0x00, 0x01]),
      Buffer.from([0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x3c, 0x00, 0x04, 0x01, 0x02]),
    ])
    expect(parseDnsARecordResponse(truncatedRdata, 1)).toBeNull()
  })

  it('resolves IP literals, caches clean system lookups, and falls back to UDP DNS when FakeIP is returned', async () => {
    // Start a local UDP DNS mock server
    const udpServer = dgram.createSocket('udp4')
    await new Promise<void>((resolve) => {
      udpServer.bind(0, '127.0.0.1', () => { resolve() })
    })
    const udpPort = udpServer.address().port

    udpServer.on('message', (msg, rinfo) => {
      const txId = msg.readUInt16BE(0)
      const qnameEnd = msg.length - 4
      const qname = msg.subarray(12, qnameEnd)
      // Send an unrelated txId packet first to verify non-matching UDP datagrams are ignored
      const decoy = makeDnsResponse({
        txId: (txId + 1) & 0xffff,
        qname,
        answers: [{ nameBytes: Buffer.from([0xc0, 0x0c]), type: 1, ttl: 60, rdata: Buffer.from([1, 2, 3, 4]) }],
      })
      udpServer.send(decoy, rinfo.port, rinfo.address)
      const response = makeDnsResponse({
        txId,
        qname,
        answers: [{ nameBytes: Buffer.from([0xc0, 0x0c]), type: 1, ttl: 120, rdata: Buffer.from([203, 0, 113, 77]) }],
      })
      udpServer.send(response, rinfo.port, rinfo.address)
    })

    // Silent UDP server to exercise timeout fallback to second server
    const silentServer = dgram.createSocket('udp4')
    await new Promise<void>((resolve) => {
      silentServer.bind(0, '127.0.0.1', () => { resolve() })
    })
    const silentPort = silentServer.address().port

    try {
      let lookupCalls = 0
      const resolver = new RealDnsResolver({
        servers: [`127.0.0.1:${String(silentPort)}`, `127.0.0.1:${String(udpPort)}`, '127.0.0.1:0'],
        timeoutMs: 60,
        systemLookup: async (host) => {
          lookupCalls += 1
          if (host === 'clean.example.com') return '93.184.216.34'
          if (host === 'fakeip.example.com') return '198.18.0.42'
          throw new Error('ENOTFOUND')
        },
      })

      // Direct IPv4 and bracketed IPv6 literals bypass DNS completely
      expect(await resolver.resolveHost('8.8.8.8')).toBe('8.8.8.8')
      expect(await resolver.resolveHost('[2001:4860:4860::8888]')).toBe('2001:4860:4860::8888')
      expect(lookupCalls).toBe(0)

      // Clean system lookup + cache hit
      expect(await resolver.resolveHost('CLEAN.EXAMPLE.COM')).toBe('93.184.216.34')
      expect(await resolver.resolveHost('clean.example.com')).toBe('93.184.216.34')
      expect(lookupCalls).toBe(1)

      // Clear cache forces re-lookup
      resolver.clearCache()
      expect(await resolver.resolveHost('clean.example.com')).toBe('93.184.216.34')
      expect(lookupCalls).toBe(2)

      // FakeIP triggers UDP fallback (times out on silentServer, succeeds on udpServer)
      expect(await resolver.resolveHost('fakeip.example.com')).toBe('203.0.113.77')
      // Subsequent call hits cache
      expect(await resolver.resolveHost('fakeip.example.com')).toBe('203.0.113.77')

      // System lookup throws -> UDP fallback resolves
      expect(await resolver.resolveHost('throw.example.com')).toBe('203.0.113.77')

      // Default options constructor + default systemLookup resolving 'localhost'
      const defaultResolver = new RealDnsResolver()
      expect(await defaultResolver.resolveHost('localhost')).toBe('127.0.0.1')

      // All servers fail -> throws VPN_DNS_FAILED (includes UDP socket error event + timeout)
      const realCreateSocket = dgram.createSocket.bind(dgram)
      const spy = vi.spyOn(dgram, 'createSocket').mockImplementationOnce(() => {
        const sock = realCreateSocket('udp4')
        queueMicrotask(() => {
          sock.emit('error', new Error('EACCES'))
        })
        return sock
      })
      try {
        const failingResolver = new RealDnsResolver({
          servers: [`127.0.0.1:${String(silentPort)}`, `127.0.0.1:${String(silentPort)}`],
          timeoutMs: 40,
          systemLookup: async () => '198.19.0.5',
        })
        await expect(failingResolver.resolveHost('dead.example.com')).rejects.toThrow(/Unable to resolve/)
      } finally {
        spy.mockRestore()
      }
    } finally {
      udpServer.close()
      silentServer.close()
    }
  })
})
