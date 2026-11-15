import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { RealDnsResolver } from '../src/dns.ts'
import { LoopbackProxyGateway, type LoopbackGatewayRoutePlan } from '../src/gateway.ts'
import VpnTunnelRuntime, { type ProxyNodeConfig } from '../src/index.ts'
import { probeNodeThroughTunnel } from '../src/probe.ts'
import { parseSocks5TargetAddress } from '../src/protocols/address.ts'
import { BufferedStreamReader, writeAll } from '../src/protocols/stream-io.ts'
import { vpnNodeId, vpnSubscriptionId } from '../src/types.ts'
import { createSelfSignedTlsCredentials } from './tls-fixture.ts'

const SUB_ID = vpnSubscriptionId('sub_gw')

async function startMockSocks5Upstream(
  behavior: 'normal' | 'early-eof' = 'normal',
  portMap: Readonly<Record<number, number>> = {},
): Promise<{
  readonly port: number
  readonly close: () => Promise<void>
}> {
  const srv = net.createServer((sock) => {
    sock.on('error', () => {})
    void (async () => {
      const r = new BufferedStreamReader(sock)
      const greet = await r.readExact(2)
      await r.readExact(greet[1] as number)
      sock.write(Buffer.from([0x05, 0x00]))
      const head = await r.readExact(4)
      let addrBuf: Buffer
      if (head[3] === 0x01) {
        addrBuf = Buffer.concat([Buffer.from([0x01]), await r.readExact(6)])
      } else if (head[3] === 0x03) {
        const l = await r.readExact(1)
        addrBuf = Buffer.concat([Buffer.from([0x03]), l, await r.readExact((l[0] as number) + 2)])
      } else {
        addrBuf = Buffer.concat([Buffer.from([0x04]), await r.readExact(18)])
      }
      const target = parseSocks5TargetAddress(addrBuf)
      const tail = r.detach()
      await writeAll(sock, Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 80]))

      if (behavior === 'early-eof') {
        sock.once('data', () => { sock.end() })
        return
      }

      const rawPort = target?.port ?? 80
      const mappedPort = portMap[rawPort] ?? rawPort
      const targetSocket = net.connect({ host: '127.0.0.1', port: mappedPort })
      targetSocket.on('error', () => { sock.destroy() })
      if (tail.length > 0) targetSocket.write(tail)
      sock.pipe(targetSocket)
      targetSocket.pipe(sock)
    })().catch(() => { sock.destroy() })
  })
  await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve))
  return {
    port: (srv.address() as net.AddressInfo).port,
    close: () => new Promise<void>(resolve => srv.close(() => { resolve() })),
  }
}

async function rawSendAndRead(port: number, payload: Buffer): Promise<Buffer> {
  const sock = net.connect({ host: '127.0.0.1', port })
  await new Promise<void>(resolve => sock.once('connect', resolve))
  await writeAll(sock, payload)
  const chunks: Buffer[] = []
  for await (const c of sock) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

describe('LoopbackProxyGateway, probeNodeThroughTunnel, and VpnTunnelRuntime service', () => {
  it('speaks SOCKS5, HTTP CONNECT, and plain HTTP proxy with direct/reject/proxy failover and error isolation', async () => {
    const dnsResolver = new RealDnsResolver({
      servers: ['127.0.0.1:1'],
      timeoutMs: 20,
      systemLookup: async () => '127.0.0.1',
    })

    // Target HTTP echo server
    const targetHttp = http.createServer((req, res) => {
      const bodyChunks: Buffer[] = []
      req.on('data', c => bodyChunks.push(c as Buffer))
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(`ECHO:${req.method}:${req.url}:${req.headers['proxy-authorization'] ?? 'stripped'}:${Buffer.concat(bodyChunks).toString()}`)
      })
    })
    await new Promise<void>(resolve => targetHttp.listen(0, '127.0.0.1', resolve))
    const targetPort = (targetHttp.address() as net.AddressInfo).port

    const upstreamGood = await startMockSocks5Upstream('normal')
    const upstreamEarlyEof = await startMockSocks5Upstream('early-eof')

    // Closed port for dead candidate #1
    const closedTmp = net.createServer()
    await new Promise<void>(resolve => closedTmp.listen(0, '127.0.0.1', resolve))
    const deadPort = (closedTmp.address() as net.AddressInfo).port
    await new Promise<void>(resolve => closedTmp.close(() => { resolve() }))

    const deadNode: ProxyNodeConfig = {
      id: vpnNodeId('sub_gw:dead'),
      subscriptionId: SUB_ID,
      name: 'Dead Node',
      protocol: 'socks5',
      server: '127.0.0.1',
      port: deadPort,
    }
    const goodNode: ProxyNodeConfig = {
      id: vpnNodeId('sub_gw:good'),
      subscriptionId: SUB_ID,
      name: '美国 Good Node',
      protocol: 'socks5',
      server: '127.0.0.1',
      port: upstreamGood.port,
    }
    const earlyEofNode: ProxyNodeConfig = {
      id: vpnNodeId('sub_gw:eof'),
      subscriptionId: SUB_ID,
      name: 'EOF Node',
      protocol: 'socks5',
      server: '127.0.0.1',
      port: upstreamEarlyEof.port,
    }

    let currentPlan: LoopbackGatewayRoutePlan = { action: 'proxy', candidates: [deadNode, goodNode] }
    const dialSuccesses: string[] = []
    const dialFailures: string[] = []
    let openCount = 0
    let closeCount = 0

    const gw = new LoopbackProxyGateway({
      dnsResolver,
      connectTimeoutMs: 2000,
      decideTarget: () => currentPlan,
      onNodeDialSuccess: (id) => { dialSuccesses.push(id) },
      onNodeDialFailure: (id) => { dialFailures.push(id) },
      onConnectionOpen: () => { openCount += 1 },
      onConnectionClose: () => { closeCount += 1 },
    })

    expect(gw.endpoint()).toBeNull()
    const ep = await gw.start()
    expect(await gw.start()).toEqual(ep) // idempotent start

    // Occupied port bind failure -> VPN_GATEWAY_CLOSED
    const conflictGw = new LoopbackProxyGateway({
      bindPort: ep.port,
      dnsResolver,
      decideTarget: () => ({ action: 'direct' }),
    })
    await expect(conflictGw.start()).rejects.toThrow()

    try {
      // 1. Plain HTTP POST through proxy plan (deadNode fails -> fails over to goodNode!)
      const plainResp = await rawSendAndRead(
        ep.port,
        Buffer.from(
          `POST http://target.example:${targetPort}/hello?x=1 HTTP/1.1\r\n`
          + `Host: target.example:${targetPort}\r\n`
          + 'Proxy-Connection: keep-alive\r\n'
          + 'Proxy-Authorization: Basic secret\r\n'
          + 'Connection: keep-alive\r\n'
          + 'Content-Length: 4\r\n'
          + 'X-Malformed-Header-Line\r\n\r\nBODY',
        ),
      )
      expect(plainResp.toString()).toContain('ECHO:POST:/hello?x=1:stripped:BODY')
      expect(dialFailures).toContain(deadNode.id)
      expect(dialSuccesses).toContain(goodNode.id)

      // Plain HTTP GET without body + default path + error branches (400 relative URL, 400 https URL, 403 reject, 502 empty candidates)
      currentPlan = { action: 'direct' }
      const getResp = await rawSendAndRead(
        ep.port,
        Buffer.from(`GET http://127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`),
      )
      expect(getResp.toString()).toContain('ECHO:GET:/:stripped:')

      expect((await rawSendAndRead(ep.port, Buffer.from(' \r\n\r\n'))).toString()).toContain('400 Bad Request')
      expect((await rawSendAndRead(ep.port, Buffer.from('GET\r\n\r\n'))).toString()).toContain('400 Bad Request')
      expect((await rawSendAndRead(ep.port, Buffer.from('GET /relative HTTP/1.1\r\n\r\n'))).toString()).toContain('400 Bad Request')
      expect((await rawSendAndRead(ep.port, Buffer.from('GET https://a.com/ HTTP/1.1\r\n\r\n'))).toString()).toContain('400 Bad Request')

      currentPlan = { action: 'reject' }
      expect((await rawSendAndRead(ep.port, Buffer.from('GET http://example.com/ HTTP/1.1\r\n\r\n'))).toString())
        .toContain('403 Forbidden')
      expect((await rawSendAndRead(ep.port, Buffer.from(`GET http://127.0.0.1:${targetPort}/ HTTP/1.1\r\n\r\n`))).toString())
        .toContain('403 Forbidden')

      currentPlan = { action: 'proxy', candidates: [] }
      expect((await rawSendAndRead(ep.port, Buffer.from(`GET http://127.0.0.1:${targetPort}/ HTTP/1.1\r\n\r\n`))).toString())
        .toContain('502 Bad Gateway')

      // 2. HTTP CONNECT: authority variants, 400, 403, 502, 200 + bidirectional data + early-EOF node failure
      expect((await rawSendAndRead(ep.port, Buffer.from('CONNECT [bad HTTP/1.1\r\n\r\n'))).toString()).toContain('400 Bad Request')
      expect((await rawSendAndRead(ep.port, Buffer.from('CONNECT [::1]:0 HTTP/1.1\r\n\r\n'))).toString()).toContain('400 Bad Request')
      expect((await rawSendAndRead(ep.port, Buffer.from('CONNECT :443 HTTP/1.1\r\n\r\n'))).toString()).toContain('400 Bad Request')

      currentPlan = { action: 'reject' }
      expect((await rawSendAndRead(ep.port, Buffer.from('CONNECT example.com HTTP/1.1\r\n\r\n'))).toString()).toContain('403 Forbidden')
      expect((await rawSendAndRead(ep.port, Buffer.from('CONNECT [::1] HTTP/1.1\r\n\r\n'))).toString()).toContain('403 Forbidden')

      currentPlan = { action: 'proxy', candidates: [deadNode] }
      expect((await rawSendAndRead(ep.port, Buffer.from(`CONNECT [::1]:${targetPort} HTTP/1.1\r\n\r\n`))).toString())
        .toContain('502 Bad Gateway')

      currentPlan = { action: 'direct' }
      const connectSock = net.connect({ host: '127.0.0.1', port: ep.port })
      const cr = new BufferedStreamReader(connectSock)
      await writeAll(connectSock, Buffer.from(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\n\r\n`))
      expect((await cr.readUntil(Buffer.from('\r\n\r\n'), 1024)).toString()).toContain('200 Connection Established')
      await writeAll(connectSock, Buffer.from(`GET /tun HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nConnection: close\r\n\r\n`))
      const tunResp = await cr.readUntil(Buffer.from('\r\n\r\n'), 4096)
      expect(tunResp.toString()).toContain('200 OK')
      cr.detach()
      connectSock.end()

      // Early-EOF after CONNECT (proxy accepts SOCKS5 handshake, then closes before replying to client payload)
      currentPlan = { action: 'proxy', candidates: [earlyEofNode] }
      const eofSock = net.connect({ host: '127.0.0.1', port: ep.port })
      const er = new BufferedStreamReader(eofSock)
      await writeAll(eofSock, Buffer.from(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\n\r\n`))
      await er.readUntil(Buffer.from('\r\n\r\n'), 1024)
      er.detach()
      await writeAll(eofSock, Buffer.from('GET / HTTP/1.1\r\n\r\n'))
      await new Promise<void>(resolve => eofSock.once('close', () => { resolve() }))
      expect(dialFailures).toContain(earlyEofNode.id)

      // Upstream stream error after handshake (corrupt AEAD server bytes trigger deterministic stream error)
      const corruptSsSrv = net.createServer((s) => {
        s.on('error', () => {})
        s.once('data', () => {
          s.write(Buffer.alloc(64, 0xff))
        })
      })
      await new Promise<void>(resolve => corruptSsSrv.listen(0, '127.0.0.1', resolve))
      const corruptSsNode: ProxyNodeConfig = {
        id: vpnNodeId('sub_gw:corrupt'),
        subscriptionId: SUB_ID,
        name: 'Corrupt AEAD Node',
        protocol: 'ss',
        server: '127.0.0.1',
        port: (corruptSsSrv.address() as net.AddressInfo).port,
        cipher: 'aes-128-gcm',
        password: 'pw',
      }
      currentPlan = { action: 'proxy', candidates: [corruptSsNode] }
      const errSock = net.connect({ host: '127.0.0.1', port: ep.port })
      const errReader = new BufferedStreamReader(errSock)
      await writeAll(errSock, Buffer.from(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\n\r\n`))
      await errReader.readUntil(Buffer.from('\r\n\r\n'), 1024)
      errReader.detach()
      await writeAll(errSock, Buffer.from('GET / HTTP/1.1\r\n\r\n'))
      await new Promise<void>(resolve => errSock.once('close', () => { resolve() }))
      corruptSsSrv.close()
      expect(dialFailures).toContain(corruptSsNode.id)

      // Multi-candidate CONNECT first-byte verification + transparent payload replay failover:
      // 1) First candidate (goodNode) succeeds immediately when plan has multiple candidates
      currentPlan = { action: 'proxy', candidates: [goodNode, deadNode] }
      const multiOkSock = net.connect({ host: '127.0.0.1', port: ep.port })
      const multiOkReader = new BufferedStreamReader(multiOkSock)
      await writeAll(multiOkSock, Buffer.from(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\n\r\n`))
      await multiOkReader.readUntil(Buffer.from('\r\n\r\n'), 1024)
      await writeAll(multiOkSock, Buffer.from(`GET /multi-ok HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nConnection: close\r\n\r\n`))
      expect((await multiOkReader.readUntil(Buffer.from('\r\n\r\n'), 4096)).toString()).toContain('200 OK')
      multiOkReader.detach()
      multiOkSock.end()

      // 2) Client closes with 0 payload bytes right after 200 Connection Established on multi-candidate plan
      const multiIdleSock = net.connect({ host: '127.0.0.1', port: ep.port })
      const multiIdleReader = new BufferedStreamReader(multiIdleSock)
      await writeAll(multiIdleSock, Buffer.from(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\n\r\n`))
      await multiIdleReader.readUntil(Buffer.from('\r\n\r\n'), 1024)
      multiIdleReader.detach()
      multiIdleSock.end()
      await new Promise<void>(resolve => multiIdleSock.once('close', () => { resolve() }))

      // 3) First candidate (earlyEofNode) closes before replying -> gateway replays initial payload to goodNode!
      const corruptReplaySrv = net.createServer((s) => {
        s.on('error', () => {})
        s.once('data', () => { s.write(Buffer.alloc(64, 0xff)) })
      })
      await new Promise<void>(resolve => corruptReplaySrv.listen(0, '127.0.0.1', resolve))
      const corruptReplayNode: ProxyNodeConfig = {
        id: vpnNodeId('sub_gw:corrupt_replay'),
        subscriptionId: SUB_ID,
        name: 'Corrupt Replay Node',
        protocol: 'ss',
        server: '127.0.0.1',
        port: (corruptReplaySrv.address() as net.AddressInfo).port,
        cipher: 'aes-128-gcm',
        password: 'pw',
      }
      try {
        currentPlan = { action: 'proxy', candidates: [earlyEofNode, corruptReplayNode, goodNode] }
        const replaySock = net.connect({ host: '127.0.0.1', port: ep.port })
        const replayReader = new BufferedStreamReader(replaySock)
        await writeAll(replaySock, Buffer.from(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\n\r\n`))
        await replayReader.readUntil(Buffer.from('\r\n\r\n'), 1024)
        await writeAll(replaySock, Buffer.from(`GET /replayed HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nConnection: close\r\n\r\n`))
        const replayedHead = await replayReader.readUntil(Buffer.from('\r\n\r\n'), 4096)
        expect(replayedHead.toString()).toContain('200 OK')
        replayReader.detach()
        replaySock.end()

        // 4) All candidates in remaining list also fail after first candidate drops post-200
        currentPlan = { action: 'proxy', candidates: [earlyEofNode, deadNode] }
        const allFailSock = net.connect({ host: '127.0.0.1', port: ep.port })
        const allFailReader = new BufferedStreamReader(allFailSock)
        await writeAll(allFailSock, Buffer.from(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\n\r\n`))
        await allFailReader.readUntil(Buffer.from('\r\n\r\n'), 1024)
        allFailReader.detach()
        await writeAll(allFailSock, Buffer.from('GET /fail HTTP/1.1\r\n\r\n'))
        await new Promise<void>(resolve => allFailSock.once('close', () => { resolve() }))
      } finally {
        corruptReplaySrv.close()
      }

      // 5) Short-timeout gateway tears down stalled multi-candidate CONNECT client that never sends initial payload
      const shortTimeoutGw = new LoopbackProxyGateway({
        dnsResolver,
        connectTimeoutMs: 40,
        decideTarget: () => ({ action: 'proxy', candidates: [goodNode, deadNode] }),
      })
      const shortEp = await shortTimeoutGw.start()
      try {
        const stallClient = net.connect({ host: '127.0.0.1', port: shortEp.port })
        const stallReader = new BufferedStreamReader(stallClient)
        await writeAll(stallClient, Buffer.from(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\n\r\n`))
        await stallReader.readUntil(Buffer.from('\r\n\r\n'), 1024)
        stallReader.detach()
        await new Promise<void>(resolve => stallClient.once('close', () => { resolve() }))
      } finally {
        await shortTimeoutGw.close()
      }

      // 6) SOCKS5 client routed through proxy node (covers unbuffered bridgeStreams onNodeDialSuccess)
      currentPlan = { action: 'proxy', candidates: [goodNode] }
      const s5PortHi = (targetPort >>> 8) & 0xff
      const s5PortLo = targetPort & 0xff
      const s5ProxySock = net.connect({ host: '127.0.0.1', port: ep.port })
      const s5ProxyReader = new BufferedStreamReader(s5ProxySock)
      await writeAll(s5ProxySock, Buffer.from([0x05, 0x01, 0x00, 0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, s5PortHi, s5PortLo]))
      await s5ProxyReader.readExact(12)
      await writeAll(s5ProxySock, Buffer.from(`GET /s5-proxy HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nConnection: close\r\n\r\n`))
      expect((await s5ProxyReader.readUntil(Buffer.from('\r\n\r\n'), 4096)).toString()).toContain('200 OK')
      s5ProxyReader.detach()
      s5ProxySock.end()

      // 3. SOCKS5 client: auth/cmd/atyp/port rejections, reject plan, upstream fail, and IPv4/domain/IPv6 success
      expect(await rawSendAndRead(ep.port, Buffer.from([0x05, 0x01, 0x02]))).toEqual(Buffer.from([0x05, 0xff]))
      expect(await rawSendAndRead(ep.port, Buffer.from([0x05, 0x01, 0x00, 0x05, 0x02, 0x00, 0x01]))).toEqual(
        Buffer.from([0x05, 0x00, 0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
      )
      expect(await rawSendAndRead(ep.port, Buffer.from([0x05, 0x01, 0x00, 0x05, 0x01, 0x00, 0x99]))).toEqual(
        Buffer.from([0x05, 0x00, 0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
      )
      expect(await rawSendAndRead(ep.port, Buffer.from([0x05, 0x01, 0x00, 0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0, 0]))).toEqual(
        Buffer.from([0x05, 0x00, 0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
      )

      currentPlan = { action: 'reject' }
      expect(await rawSendAndRead(ep.port, Buffer.from([0x05, 0x01, 0x00, 0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0, 80]))).toEqual(
        Buffer.from([0x05, 0x00, 0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
      )

      currentPlan = { action: 'proxy', candidates: [] }
      expect(await rawSendAndRead(ep.port, Buffer.from([0x05, 0x01, 0x00, 0x05, 0x01, 0x00, 0x04, ...Buffer.alloc(16), 0, 80]))).toEqual(
        Buffer.from([0x05, 0x00, 0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
      )

      currentPlan = { action: 'direct' }
      const portHi = (targetPort >>> 8) & 0xff
      const portLo = targetPort & 0xff
      const domReq = Buffer.from([
        0x05, 0x01, 0x00,
        0x05, 0x01, 0x00, 0x03, 0x09, ...Buffer.from('localhost'), portHi, portLo,
        ...Buffer.from(`GET /s5 HTTP/1.1\r\nHost: localhost:${targetPort}\r\nConnection: close\r\n\r\n`),
      ])
      const s5Resp = await rawSendAndRead(ep.port, domReq)
      expect(s5Resp.subarray(12).toString()).toContain('ECHO:GET:/s5')

      // CONNECT tunnel closed cleanly with zero payload bytes sent (clientBytesSent === 0)
      const idleConnect = net.connect({ host: '127.0.0.1', port: ep.port })
      const idleReader = new BufferedStreamReader(idleConnect)
      await writeAll(idleConnect, Buffer.from(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\n\r\n`))
      await idleReader.readUntil(Buffer.from('\r\n\r\n'), 1024)
      idleReader.detach()
      idleConnect.end()
      await new Promise<void>(resolve => idleConnect.once('close', () => { resolve() }))

      // Abrupt client EOF mid-handshake (triggers catch block in handleClientSocket)
      const abrupt = net.connect({ host: '127.0.0.1', port: ep.port })
      await new Promise<void>(resolve => abrupt.once('connect', resolve))
      abrupt.end(Buffer.from([0x05]))
      await new Promise<void>(resolve => abrupt.once('close', () => { resolve() }))

      expect(openCount).toBeGreaterThan(0)
      expect(closeCount).toBeGreaterThan(0)
    } finally {
      await gw.close()
      await gw.close() // idempotent close
      await upstreamGood.close()
      await upstreamEarlyEof.close()
      targetHttp.close()
    }
  })

  it('probes HTTP/HTTPS targets through encrypted tunnels and orchestrates VpnTunnelRuntime lifecycle', async () => {
    const dnsResolver = new RealDnsResolver({
      servers: ['127.0.0.1:1'],
      timeoutMs: 20,
      systemLookup: async () => '127.0.0.1',
    })
    const creds = createSelfSignedTlsCredentials()

    let statusToReturn = 204
    const httpTarget = http.createServer((_req, res) => {
      res.writeHead(statusToReturn)
      res.end()
    })
    await new Promise<void>(resolve => httpTarget.listen(0, '127.0.0.1', resolve))
    const httpTargetPort = (httpTarget.address() as net.AddressInfo).port

    const httpsTarget = https.createServer({ key: creds.key, cert: creds.cert }, (_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    await new Promise<void>(resolve => httpsTarget.listen(0, '127.0.0.1', resolve))
    const httpsTargetPort = (httpsTarget.address() as net.AddressInfo).port

    const garbageTarget = net.createServer(sock => sock.end('NOT_HTTP\r\n\r\n'))
    await new Promise<void>(resolve => garbageTarget.listen(0, '127.0.0.1', resolve))
    const garbagePort = (garbageTarget.address() as net.AddressInfo).port

    const stallTlsTarget = net.createServer((sock) => {
      sock.on('error', () => {})
    })
    await new Promise<void>(resolve => stallTlsTarget.listen(0, '127.0.0.1', resolve))
    const stallTlsPort = (stallTlsTarget.address() as net.AddressInfo).port

    const upstream = await startMockSocks5Upstream('normal', {
      80: httpTargetPort,
      443: httpsTargetPort,
    })
    const node: ProxyNodeConfig = {
      id: vpnNodeId('sub_gw:probe1'),
      subscriptionId: SUB_ID,
      name: '美国 Probe 01',
      protocol: 'socks5',
      server: '127.0.0.1',
      port: upstream.port,
    }

    try {
      // Direct probeNodeThroughTunnel edge cases + default port 80 / 443 + stalled TLS handshake abort
      expect((await probeNodeThroughTunnel(node, ':::bad-url', { dnsResolver, timeoutMs: 1000 })).ok).toBe(false)
      expect((await probeNodeThroughTunnel(node, 'ftp://example.com/file', { dnsResolver, timeoutMs: 1000 })).error)
        .toMatch(/http: or https:/)

      const resDefaultHttp = await probeNodeThroughTunnel(node, 'http://probe.example/generate_204?x=1', {
        dnsResolver,
        timeoutMs: 2000,
      })
      expect(resDefaultHttp.ok).toBe(true)
      expect(resDefaultHttp.statusCode).toBe(204)

      statusToReturn = 503
      const res503 = await probeNodeThroughTunnel(node, `http://127.0.0.1:${httpTargetPort}`, {
        dnsResolver,
        timeoutMs: 2000,
        signal: new AbortController().signal,
      })
      expect(res503.ok).toBe(false)
      expect(res503.statusCode).toBe(503)

      const resDefaultHttps = await probeNodeThroughTunnel(node, 'https://probe.example/ok', {
        dnsResolver,
        timeoutMs: 2000,
        skipTargetCertVerify: true,
      })
      expect(resDefaultHttps.ok).toBe(true)

      const resHttpsIpStrict = await probeNodeThroughTunnel(node, `https://127.0.0.1:${httpsTargetPort}/ok`, {
        dnsResolver,
        timeoutMs: 2000,
      })
      expect(resHttpsIpStrict.ok).toBe(false)

      const resStallTlsAbort = await probeNodeThroughTunnel(node, `https://probe.example:${stallTlsPort}/ok`, {
        dnsResolver,
        timeoutMs: 60,
        skipTargetCertVerify: true,
      })
      expect(resStallTlsAbort.ok).toBe(false)
      expect(resStallTlsAbort.error).toMatch(/aborted/)

      const preAborted = new AbortController()
      preAborted.abort()
      const resAborted = await probeNodeThroughTunnel(node, `https://127.0.0.1:${httpsTargetPort}/ok`, {
        dnsResolver,
        timeoutMs: 2000,
        signal: preAborted.signal,
      })
      expect(resAborted.ok).toBe(false)

      const resGarbage = await probeNodeThroughTunnel(node, `http://127.0.0.1:${garbagePort}/`, {
        dnsResolver,
        timeoutMs: 2000,
      })
      expect(resGarbage.error).toMatch(/Malformed HTTP status/)

      // Cordis VpnTunnelRuntime lifecycle
      statusToReturn = 204
      const ctx = new Context()
      const scope = await ctx.plugin(VpnTunnelRuntime, {
        defaultProbeUrl: `http://127.0.0.1:${httpTargetPort}/generate_204`,
      })

      try {
        expect(ctx.vpnTunnel.state().gateway).toBeNull()
        await expect(ctx.vpnTunnel.probeUrl(`http://127.0.0.1:${httpTargetPort}/`)).rejects.toThrow(/No proxy node/)
        expect(await ctx.vpnTunnel.probeNodes()).toEqual([])

        // Fetch subscription through runtime
        const subHttp = http.createServer((_req, res) => {
          res.writeHead(200)
          res.end(`socks5://127.0.0.1:${upstream.port}#%E7%BE%8E%E5%9B%BD%20Live\nsocks5://127.0.0.1:1#%E6%97%A5%E6%9C%AC%20Dead\n`)
        })
        await new Promise<void>(resolve => subHttp.listen(0, '127.0.0.1', resolve))
        const subPort = (subHttp.address() as net.AddressInfo).port
        const fetched = await ctx.vpnTunnel.fetchSubscription(`http://127.0.0.1:${subPort}/sub`, SUB_ID)
        const fetchedWithSig = await ctx.vpnTunnel.fetchSubscription(
          `http://127.0.0.1:${subPort}/sub`,
          SUB_ID,
          new AbortController().signal,
        )
        subHttp.close()
        expect(fetched.nodes.length).toBe(2)
        expect(fetchedWithSig.nodes.length).toBe(2)

        ctx.vpnTunnel.setSubscriptions([
          {
            ...fetched,
            rules: [
              { kind: 'DOMAIN', pattern: 'blocked.example.com', action: 'REJECT' },
              { kind: 'DOMAIN-SUFFIX', pattern: 'cn.example.com', action: 'DIRECT' },
              { kind: 'MATCH', pattern: '', action: 'PROXY' },
            ],
          },
        ])

        // Routing decisions across private, direct, smart, and global modes (with custom rules)
        expect(ctx.vpnTunnel.decideRoute('127.0.0.1')).toEqual({ action: 'direct', matchedRule: 'PRIVATE-NETWORK' })
        expect(ctx.vpnTunnel.decideRoute('openai.com', 'direct')).toEqual({ action: 'direct', matchedRule: 'MODE-DIRECT' })
        expect(ctx.vpnTunnel.decideRoute('blocked.example.com', 'smart').action).toBe('reject')
        expect(ctx.vpnTunnel.decideRoute('api.cn.example.com', 'smart').action).toBe('direct')
        expect(ctx.vpnTunnel.decideRoute('api.openai.com', 'smart').action).toBe('proxy')

        ctx.vpnTunnel.setRoutingPolicy({ gatewayMode: 'smart' })
        ctx.vpnTunnel.setRoutingPolicy({
          gatewayMode: 'global',
          preferRegion: '美国',
        })
        ctx.vpnTunnel.setRoutingPolicy({
          maxPreferredLatencyMs: 3500,
          customRules: [
            { kind: 'DOMAIN', pattern: 'ads.example.com', action: 'REJECT' },
            { kind: 'DOMAIN', pattern: 'intranet.example.com', action: 'DIRECT' },
            { kind: 'DOMAIN', pattern: 'vip.example.com', action: 'PROXY' },
          ],
        })
        expect(ctx.vpnTunnel.decideRoute('ads.example.com', 'global').action).toBe('reject')
        expect(ctx.vpnTunnel.decideRoute('intranet.example.com', 'global').action).toBe('direct')
        expect(ctx.vpnTunnel.decideRoute('vip.example.com', 'global').action).toBe('proxy')
        expect(ctx.vpnTunnel.decideRoute('anything.else.example', 'global').matchedRule).toBe('MODE-GLOBAL')

        // Probe nodes (ranked & explicit subset & HTTP 503 failure without error field) + probeUrl
        const batchResults = await ctx.vpnTunnel.probeNodes({ limit: 2, signal: new AbortController().signal })
        expect(batchResults.length).toBe(2)
        const liveNodeId = (fetched.nodes[0] as ProxyNodeConfig).id
        const deadNodeId = (fetched.nodes[1] as ProxyNodeConfig).id
        const subsetResults = await ctx.vpnTunnel.probeNodes({
          nodeIds: [liveNodeId],
          skipTargetCertVerify: true,
        })
        expect(subsetResults[0]?.ok).toBe(true)

        const singleOk = await ctx.vpnTunnel.probeUrl(`https://127.0.0.1:${httpsTargetPort}/ok`, {
          skipTargetCertVerify: true,
          signal: new AbortController().signal,
        })
        expect(singleOk.ok).toBe(true)

        const singleFail = await ctx.vpnTunnel.probeUrl(`http://127.0.0.1:${httpTargetPort}/`, {
          nodeId: deadNodeId,
        })
        expect(singleFail.ok).toBe(false)

        statusToReturn = 503
        expect((await ctx.vpnTunnel.probeNodes({ nodeIds: [liveNodeId] }))[0]?.ok).toBe(false)
        expect((await ctx.vpnTunnel.probeUrl(`http://127.0.0.1:${httpTargetPort}/`, { nodeId: liveNodeId })).ok).toBe(false)
        statusToReturn = 204

        // Gateway start (idempotent), proxy failure callback on dead pinned node, proxy success on live node, stopGateway
        const gwEp = await ctx.vpnTunnel.ensureGateway()
        expect(await ctx.vpnTunnel.ensureGateway()).toEqual(gwEp)
        expect(ctx.vpnTunnel.state().gateway?.port).toBe(gwEp.port)

        ctx.vpnTunnel.selectNode(deadNodeId)
        const viaGwDeadPin = await rawSendAndRead(
          gwEp.port,
          Buffer.from(`GET http://vip.example.com:${httpTargetPort}/generate_204 HTTP/1.1\r\nHost: vip.example.com\r\n\r\n`),
        )
        expect(viaGwDeadPin.toString()).toContain('502 Bad Gateway')
        await ctx.vpnTunnel.probeUrl(`http://127.0.0.1:${httpTargetPort}/generate_204`, { nodeId: liveNodeId })

        ctx.vpnTunnel.selectNode(liveNodeId)
        expect(ctx.vpnTunnel.state().pinnedNodeId).toBe(liveNodeId)

        const viaGwReject = await rawSendAndRead(gwEp.port, Buffer.from('CONNECT ads.example.com:443 HTTP/1.1\r\n\r\n'))
        expect(viaGwReject.toString()).toContain('403 Forbidden')

        const viaGwDirect = await rawSendAndRead(
          gwEp.port,
          Buffer.from(`GET http://127.0.0.1:${httpTargetPort}/generate_204 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`),
        )
        expect(viaGwDirect.toString()).toContain('204')

        const viaGwProxy = await rawSendAndRead(
          gwEp.port,
          Buffer.from(`GET http://vip.example.com:${httpTargetPort}/generate_204 HTTP/1.1\r\nHost: vip.example.com\r\n\r\n`),
        )
        expect(viaGwProxy.toString()).toContain('204')

        await ctx.vpnTunnel.stopGateway()
        await ctx.vpnTunnel.stopGateway()
        expect(ctx.vpnTunnel.state().gateway).toBeNull()

        // Empty subscriptions fallback to DEFAULT_SMART_ROUTING_RULES + global mode with no nodes
        ctx.vpnTunnel.setSubscriptions([])
        expect(ctx.vpnTunnel.decideRoute('api.openai.com', 'smart').action).toBe('proxy')
        expect(ctx.vpnTunnel.decideRoute('vip.example.com', 'global')).toEqual({
          action: 'proxy',
          matchedRule: 'DOMAIN:vip.example.com',
        })
        expect(ctx.vpnTunnel.decideRoute('anything.else.example', 'global')).toEqual({
          action: 'proxy',
          matchedRule: 'MODE-GLOBAL',
        })

        // Verify pure helper delegations on VpnTunnelRuntime
        const brandedSub = ctx.vpnTunnel.subscriptionId('sub_helper')
        expect(brandedSub).toBe('sub_helper')
        expect(ctx.vpnTunnel.nodeId('sub_helper:1')).toBe('sub_helper:1')
        expect(ctx.vpnTunnel.maskUrl('https://sub.example.com/api/v1?token=secret')).toBe('https://sub.example.com/***')
        expect(ctx.vpnTunnel.redactError(new Error('connect ECONNREFUSED 198.51.100.9:443'))).not.toContain('198.51.100.9')
        expect(ctx.vpnTunnel.parseRuleLine('DOMAIN-SUFFIX,openai.com,PROXY')).toEqual({
          kind: 'DOMAIN-SUFFIX',
          pattern: 'openai.com',
          action: 'PROXY',
        })
        expect(ctx.vpnTunnel.discoverEnvSubscriptions({ SUB_VPN_1: 'https://sub.example.com/s/abc' })).toHaveLength(1)
        const offlineParsed = ctx.vpnTunnel.parseSubscription('socks5://127.0.0.1:1080#local', {
          subscriptionId: brandedSub,
        })
        expect(offlineParsed.nodes).toHaveLength(1)
      } finally {
        await scope.dispose()
      }
    } finally {
      await upstream.close()
      httpTarget.close()
      httpsTarget.close()
      garbageTarget.close()
      stallTlsTarget.close()
    }
  })
})
