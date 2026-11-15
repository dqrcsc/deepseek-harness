import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { describe, expect, it } from 'vitest'
import { RealDnsResolver } from '../src/dns.ts'
import {
  computeClockOffsetSeconds,
  discoverEnvSubscriptionCandidates,
  fetchSubscription,
  maskSubscriptionUrl,
  parseClashRuleLine,
  parseDotEnvSubscriptions,
  parseSubscriptionContent,
  parseSubscriptionUserInfo,
  unwrapSubconverterRawUrl,
} from '../src/subscription.ts'
import { vpnSubscriptionId } from '../src/types.ts'
import { createSelfSignedTlsCredentials } from './tls-fixture.ts'

const SUB_ID = vpnSubscriptionId('sub_unit')
const TEST_UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811'

describe('Subscription URL redaction, headers, Subconverter unwrapping, and .env discovery', () => {
  it('masks URLs, calibrates clock skew, parses userinfo quotas, and unwraps Subconverter URLs', () => {
    expect(maskSubscriptionUrl('https://user:secret@sub.provider.example:8443/api/v1?token=xyz#main'))
      .toBe('https://sub.provider.example:8443/***')
    expect(maskSubscriptionUrl('https://sub.provider.example/path?token=xyz'))
      .toBe('https://sub.provider.example/***')
    expect(maskSubscriptionUrl('not a url')).toBe('invalid-url/***')

    const refNow = Date.parse('2026-11-15T12:00:00Z')
    expect(computeClockOffsetSeconds(null, refNow)).toBe(0)
    expect(computeClockOffsetSeconds('not-a-date', refNow)).toBe(0)
    expect(computeClockOffsetSeconds('Sun, 15 Nov 2026 12:00:12 GMT', refNow)).toBe(12)
    expect(computeClockOffsetSeconds('Sun, 10 Nov 2026 12:00:00 GMT', refNow)).toBe(0)

    expect(parseSubscriptionUserInfo(undefined)).toBeUndefined()
    expect(parseSubscriptionUserInfo('garbage; =123; upload=-5; download=abc; unknown=9')).toBeUndefined()
    expect(parseSubscriptionUserInfo('upload=1024; download=2048; total=1048576; expire=1893456000')).toEqual({
      uploadBytes: 1024,
      downloadBytes: 2048,
      totalBytes: 1_048_576,
      expireUnixSeconds: 1_893_456_000,
    })
    expect(parseSubscriptionUserInfo('total=500; expire=1893456000')).toEqual({
      totalBytes: 500,
      expireUnixSeconds: 1_893_456_000,
    })

    const inner = 'https://raw.upstream.example/s/secret-token'
    const conv = `https://subconv.example/sub?target=clash&url=${encodeURIComponent(`${inner}|${inner}|https://second.example/sub`)}`
    expect(unwrapSubconverterRawUrl(conv)).toBe(inner)
    const selfUrl = 'https://subconv.example/sub'
    expect(unwrapSubconverterRawUrl(`${selfUrl}?url=${encodeURIComponent(`${selfUrl}?url=...`)}`)).not.toBeNull()
    expect(unwrapSubconverterRawUrl('https://subconv.example/sub?target=clash')).toBeNull()
    expect(unwrapSubconverterRawUrl('https://subconv.example/sub?url=ss%3A%2F%2Ffoo')).toBeNull()
    expect(unwrapSubconverterRawUrl(':::invalid')).toBeNull()
  })

  it('discovers and deduplicates SUB_VPN_* and VPN_SUB_* across process env and .env layers', () => {
    const dshEnv = '\ufeff# comment\nexport SUB_VPN_1="https://dsh.example/sub1"\nSUB_VPN_2=\'http://dsh.example/sub2\'\nINVALID_LINE\nOTHER_KEY=https://ignored.example\nSUB_VPN_NONHTTP=ftp://bad\n'
    const userEnv = 'SUB_VPN_2=https://user.example/override-ignored\nVPN_SUB_3=https://user.example/sub3\n'

    expect(parseDotEnvSubscriptions(dshEnv, 'dsh-env').map(c => c.envKey)).toEqual(['SUB_VPN_1', 'SUB_VPN_2'])

    const merged = discoverEnvSubscriptionCandidates(
      {
        SUB_VPN_1: '  https://env.example/sub1  ',
        SUB_VPN_EMPTY: '',
        SUB_VPN_BAD: 'ss://not-http',
        PATH: '/usr/bin',
      },
      [
        { source: 'dsh-env', content: dshEnv },
        { source: 'user-env', content: userEnv },
      ],
    )
    expect(merged).toEqual([
      {
        envKey: 'SUB_VPN_1',
        source: 'env',
        url: 'https://env.example/sub1',
        maskedUrl: 'https://env.example/***',
      },
      {
        envKey: 'SUB_VPN_2',
        source: 'dsh-env',
        url: 'http://dsh.example/sub2',
        maskedUrl: 'http://dsh.example/***',
      },
      {
        envKey: 'VPN_SUB_3',
        source: 'user-env',
        url: 'https://user.example/sub3',
        maskedUrl: 'https://user.example/***',
      },
    ])
  })
})

describe('parseClashRuleLine and parseSubscriptionContent (Clash YAML & Base64/URI lists)', () => {
  it('parses Clash rules and full Clash YAML documents across all 7 protocols and transport plugins', () => {
    expect(parseClashRuleLine('   ')).toBeNull()
    expect(parseClashRuleLine('# comment')).toBeNull()
    expect(parseClashRuleLine('FINAL')).toBeNull()
    expect(parseClashRuleLine('FINAL,DIRECT')).toEqual({ kind: 'MATCH', pattern: '', action: 'DIRECT' })
    expect(parseClashRuleLine('MATCH,🚀 节点选择')).toEqual({ kind: 'MATCH', pattern: '', action: 'PROXY' })
    expect(parseClashRuleLine('DOMAIN-SUFFIX,deepseek.com,🎯 全球直连')).toEqual({
      kind: 'DOMAIN-SUFFIX',
      pattern: 'deepseek.com',
      action: 'DIRECT',
    })
    expect(parseClashRuleLine('DOMAIN-KEYWORD,adservice,🛑 广告拦截')).toEqual({
      kind: 'DOMAIN-KEYWORD',
      pattern: 'adservice',
      action: 'REJECT',
    })
    expect(parseClashRuleLine('IP-CIDR,198.51.100.0/24,REJECT-DROP,no-resolve')).toEqual({
      kind: 'IP-CIDR',
      pattern: '198.51.100.0/24',
      action: 'REJECT',
    })
    expect(parseClashRuleLine('DOMAIN,,PROXY')).toBeNull()
    expect(parseClashRuleLine('GEOIP,CN,DIRECT')).toBeNull()

    expect(() => parseSubscriptionContent('\ufeff   ', { subscriptionId: SUB_ID })).toThrow(/empty/)
    expect(() => parseSubscriptionContent('proxies: [unclosed', { subscriptionId: SUB_ID })).toThrow(/Malformed Clash YAML/)
    expect(() => parseSubscriptionContent('proxies: "not-an-array"', { subscriptionId: SUB_ID })).toThrow(/no proxies list/)
    expect(() => parseSubscriptionContent('proxies:\n  - name: bad\n    type: unknown\n    server: a.com\n    port: 443\n', { subscriptionId: SUB_ID }))
      .toThrow(/No supported proxy nodes/)

    const yamlText = `
proxies:
  - "not-a-record"
  - { name: "missing-type-and-server", port: 443 }
  - { name: "missing-port", type: "ss", server: "a.com", port: 0 }
  - { name: "ss-missing-cipher", type: "ss", server: "a.com", port: 8388, password: "p" }
  - { name: "ss-missing-pw", type: "ss", server: "a.com", port: 8388, cipher: "aes-128-gcm" }
  - name: "美国 SS2022"
    type: ss
    server: us.node.example
    port: 8388
    cipher: 2022-blake3-aes-128-gcm
    password: "psk1:psk2"
    udp: true
    plugin: obfs
    plugin-opts:
      mode: http
      host: cdn.example.com
      path: /v1
  - name: "新加坡 SS-ObfsDefault"
    type: ss
    server: sg0.node.example
    port: 8387
    cipher: aes-256-gcm
    password: "pw"
    plugin: obfs
  - name: "新加坡 SS-ObfsTLS"
    type: ss
    server: sg.node.example
    port: 8389
    cipher: aes-256-gcm
    password: 12345
    plugin: simple-obfs
    plugin-opts:
      mode: tls
  - name: "SS-UnknownPluginMode"
    type: ss
    server: sg2.node.example
    port: 8390
    cipher: aes-128-gcm
    password: true
    plugin: obfs-local
    plugin-opts:
      mode: quic
  - { name: "trojan-no-pw", type: "trojan", server: "t.example", port: 443 }
  - name: "日本 Trojan WS"
    type: trojan
    server: jp.node.example
    port: 443
    password: "tpw"
    sni: sni.jp.example
    skip-cert-verify: true
    alpn: ["h2", "http/1.1", {}]
    network: ws
    ws-opts:
      path: /trojan-ws
      headers:
        Host: ws.jp.example
        X-Bool: true
        X-Ignored: []
  - { name: "vless-no-uuid", type: "vless", server: "v.example", port: 443 }
  - name: "VLESS TLS"
    type: vless
    server: vl.node.example
    port: 443
    uuid: "${TEST_UUID}"
    tls: true
    servername: vl-sni.example
    network: ws
  - { name: "vmess-no-uuid", type: "vmess", server: "vm.example", port: 443 }
  - name: "VMess AEAD"
    type: vmess
    server: vm.node.example
    port: 443
    uuid: "${TEST_UUID}"
    alterId: 0
  - name: "VMess DefaultAlterId"
    type: vmess
    server: vm2.node.example
    port: 443
    uuid: "${TEST_UUID}"
  - type: socks5
    server: s5.node.example
    port: 1080
    username: u
    password: p
  - name: "HTTP Upstream"
    type: http
    server: http.node.example
    port: 8080
    tls: true
rules:
  - 12345
  - GEOIP,CN,DIRECT
  - DOMAIN-SUFFIX,anthropic.com,PROXY
  - MATCH,DIRECT
`
    const parsed = parseSubscriptionContent(yamlText, {
      subscriptionId: SUB_ID,
      dateHeader: new Date(Date.now() + 5000).toUTCString(),
      userInfoHeader: 'upload=10; download=20',
    })
    const parsedNoUserInfo = parseSubscriptionContent('proxies:\n  - { name: "n", type: "socks5", server: "127.0.0.1", port: 1080 }\n', {
      subscriptionId: SUB_ID,
    })
    expect(parsedNoUserInfo.userInfo).toBeUndefined()
    expect(parsed.nodes.length).toBe(10)
    expect(parsed.nodes[0]?.protocol).toBe('ss2022')
    expect(parsed.nodes[0]?.obfs).toEqual({ mode: 'http', host: 'cdn.example.com', uri: '/v1' })
    expect(parsed.nodes[2]?.obfs).toEqual({ mode: 'tls', host: 'www.bing.com' })
    expect(parsed.nodes[4]?.protocol).toBe('trojan')
    expect(parsed.nodes[4]?.ws?.headers).toEqual({ Host: 'ws.jp.example', 'X-Bool': 'true' })
    expect(parsed.rules.length).toBe(2)
    expect(parsed.userInfo).toEqual({ uploadBytes: 10, downloadBytes: 20 })
  })

  it('parses Base64 and plain URI lists (ss, vmess, trojan, vless, socks5, http, https) and rejects empty/garbage bodies', () => {
    const vmessJson = Buffer.from(JSON.stringify({
      v: '2',
      ps: '美国 VMess WS',
      add: 'vm.example.com',
      port: '443',
      id: TEST_UUID,
      aid: '0',
      scy: 'auto',
      net: 'ws',
      tls: 'tls',
      host: 'cdn.vm.example.com',
      path: '/vmws',
    })).toString('base64url')

    const vmessMinimal = Buffer.from(JSON.stringify({
      add: 'vm2.example.com',
      port: 8080,
      id: TEST_UUID,
      net: 'ws',
      tls: 'tls',
    })).toString('base64')

    const vmessTcp = Buffer.from(JSON.stringify({
      add: 'vm3.example.com',
      port: 8081,
      id: TEST_UUID,
    })).toString('base64')

    const ssSip002User = Buffer.from('2022-blake3-aes-128-gcm:base64psk', 'utf8').toString('base64url')
    const ssLegacyWhole = Buffer.from('aes-128-gcm:legacy-pw@legacy.example.com:8388', 'utf8').toString('base64')

    const uriLines = [
      `vmess://${vmessJson}`,
      `vmess://${vmessMinimal}`,
      `vmess://${vmessTcp}`,
      'vmess://***invalid-b64***',
      `vmess://${Buffer.from('{bad-json').toString('base64')}`,
      `vmess://${Buffer.from('[]').toString('base64')}`,
      `vmess://${Buffer.from(JSON.stringify({})).toString('base64')}`,
      `vmess://${Buffer.from(JSON.stringify({ add: 'a.com', port: 443 })).toString('base64')}`,
      `ss://${ssSip002User}@ss.example.com:8388/?plugin=${encodeURIComponent('obfs-local;obfs=tls;obfs-host=bing.com;obfs-uri=/p;extra=1;badseg')}#%E7%BE%8E%E5%9B%BD%20SS`,
      `ss://${ssSip002User}@ss2.example.com:8388/?plugin=${encodeURIComponent('obfs-local;mode=http;host=bing.com')}`,
      `ss://${ssLegacyWhole}`,
      'ss://aes-128-gcm:plainpw@plain.example.com:8388/?plugin=v2ray-plugin',
      'ss://not-base64',
      `ss://${Buffer.from('no-colon').toString('base64')}@bad.example.com:8388`,
      'ss://aes-128-gcm:pw@noport.example.com',
      'ss://aes-128-gcm:pw@[::zzzz]:443',
      'trojan://tpw@tr.example.com?peer=peer.example.com&allowInsecure=1&type=ws&host=wshost.example.com#TrojanNode',
      'trojan://tpw@tr2.example.com',
      'trojan://@tr.example.com:443',
      `vless://${TEST_UUID}@vl.example.com:8443?security=tls&sni=vlsni.example.com&allowInsecure=1&type=ws&path=%2Fvl&host=vlh.example.com`,
      `vless://${TEST_UUID}@vl2.example.com:8443?type=ws`,
      'vless://@vl.example.com:443',
      'socks5://user:pass@s5.example.com:1080#SocksNode',
      'socks5:///missing-host',
      'http://http.example.com',
      'https://u:p@https.example.com',
      'ftp://unsupported.example.com:21',
      '://bad-uri',
      'http://bad.example.com:99999',
    ].join('\r\n')

    // Parse both as plain URI list and as Base64-encoded subscription payload
    const plainParsed = parseSubscriptionContent(uriLines, { subscriptionId: SUB_ID })
    const b64Parsed = parseSubscriptionContent(Buffer.from(uriLines, 'utf8').toString('base64'), { subscriptionId: SUB_ID })
    expect(plainParsed.nodes.length).toBe(14)
    expect(b64Parsed.nodes.length).toBe(14)

    expect(() => parseSubscriptionContent('$$$not-base64-and-no-scheme$$$', { subscriptionId: SUB_ID }))
      .toThrow(/No supported proxy nodes/)
  })
})

describe('fetchSubscription direct HTTP/HTTPS client, chunked transfer, redirects, and Subconverter fallback', () => {
  it('follows redirects, decodes chunked responses, supports HTTPS, falls back via Subconverter url=, and redacts errors', async () => {
    const dnsResolver = new RealDnsResolver({
      servers: ['127.0.0.1:1'],
      timeoutMs: 20,
      systemLookup: async () => '127.0.0.1',
    })
    const sampleUriBody = Buffer.from('socks5://127.0.0.1:1080#LocalSocks\n', 'utf8').toString('base64')

    let mode: 'redirect' | 'chunked' | '502' | 'overflow' = 'redirect'
    const httpSrv = http.createServer((req, res) => {
      if (req.url?.startsWith('/outer-fail')) {
        res.writeHead(502)
        res.end('bad gateway')
        return
      }
      if (req.url === '/redirect-hop') {
        res.writeHead(302, { Location: '/final-chunked' })
        res.end()
        return
      }
      if (req.url === '/loop') {
        res.writeHead(302, { Location: '/loop' })
        res.end()
        return
      }
      if (mode === 'overflow') {
        res.writeHead(200, { 'Content-Length': '5000' })
        res.end('A'.repeat(5000))
        return
      }
      res.writeHead(200, {
        'Transfer-Encoding': 'chunked',
        'Subscription-Userinfo': 'upload=1; download=2; total=100',
        Date: new Date().toUTCString(),
      })
      res.write(sampleUriBody.slice(0, 10))
      res.end(sampleUriBody.slice(10))
    })
    await new Promise<void>(resolve => httpSrv.listen(0, '127.0.0.1', resolve))
    const httpPort = (httpSrv.address() as net.AddressInfo).port

    const creds = createSelfSignedTlsCredentials()
    const httpsSrv = https.createServer({ key: creds.key, cert: creds.cert }, (_req, res) => {
      res.writeHead(200)
      res.end(sampleUriBody)
    })
    await new Promise<void>(resolve => httpsSrv.listen(0, '127.0.0.1', resolve))
    const httpsPort = (httpsSrv.address() as net.AddressInfo).port

    // Raw TCP server for malformed status line & malformed/truncated/oversized chunked wire frames
    let rawReply = 'GARBAGE\r\n\r\n'
    const rawSrv = net.createServer((sock) => {
      sock.once('data', () => {
        sock.end(rawReply)
      })
    })
    await new Promise<void>(resolve => rawSrv.listen(0, '127.0.0.1', resolve))
    const rawPort = (rawSrv.address() as net.AddressInfo).port

    try {
      // 302 redirect -> chunked 200
      const okSub = await fetchSubscription(`http://sub.secret.example:${httpPort}/redirect-hop`, {
        subscriptionId: SUB_ID,
        dnsResolver,
        timeoutMs: 3000,
        maxBytes: 1024 * 1024,
        signal: new AbortController().signal,
      })
      expect(okSub.nodes.length).toBe(1)
      expect(okSub.userInfo?.totalBytes).toBe(100)

      // Self-signed HTTPS fetch
      const httpsSub = await fetchSubscription(`https://localhost:${httpsPort}/sub`, {
        subscriptionId: SUB_ID,
        dnsResolver,
        timeoutMs: 3000,
        maxBytes: 1024 * 1024,
        skipCertVerify: true,
      })
      expect(httpsSub.nodes.length).toBe(1)

      // Subconverter outer 502 -> automatic fallback to unwrapped inner url=
      const innerUrl = `http://inner.secret.example:${httpPort}/final-chunked`
      const outerUrl = `http://outer.secret.example:${httpPort}/outer-fail?url=${encodeURIComponent(innerUrl)}`
      const fallbackSub = await fetchSubscription(outerUrl, {
        subscriptionId: SUB_ID,
        dnsResolver,
        timeoutMs: 3000,
        maxBytes: 1024 * 1024,
      })
      expect(fallbackSub.nodes.length).toBe(1)

      // Redirect loop (>5 hops) & redaction of secret hostname
      await expect(fetchSubscription(`http://secret-loop.example:${httpPort}/loop`, {
        subscriptionId: SUB_ID,
        dnsResolver,
        timeoutMs: 3000,
        maxBytes: 1024 * 1024,
      })).rejects.toSatisfy((err: Error) => !err.message.includes('secret-loop.example') && /redirect hops/.test(err.message))

      // Unchunked maxBytes overflow & giant stream overflow
      mode = 'overflow'
      await expect(fetchSubscription(`http://127.0.0.1:${httpPort}/over`, {
        subscriptionId: SUB_ID,
        dnsResolver,
        timeoutMs: 3000,
        maxBytes: 1024,
      })).rejects.toThrow(/exceeded maximum byte limit/)

      // Raw wire edge cases: malformed status, chunk extension, invalid hex, truncated chunk, and maxBytes overflows
      await expect(fetchSubscription(`http://127.0.0.1:${rawPort}/bad`, {
        subscriptionId: SUB_ID,
        dnsResolver,
        timeoutMs: 3000,
        maxBytes: 2048,
      })).rejects.toThrow(/Malformed HTTP status/)

      rawReply = `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${sampleUriBody.length.toString(16)};ext=1\r\n${sampleUriBody}\r\ntrailing-without-crlf`
      const extSub = await fetchSubscription(`http://127.0.0.1:${rawPort}/ext`, {
        subscriptionId: SUB_ID,
        dnsResolver,
        timeoutMs: 3000,
        maxBytes: 2048,
      })
      expect(extSub.nodes.length).toBe(1)

      rawReply = `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${sampleUriBody.length.toString(16)}\r\n${sampleUriBody}\r\n0\r\n\r\n`
      const zeroChunkSub = await fetchSubscription(`http://127.0.0.1:${rawPort}/zero`, {
        subscriptionId: SUB_ID,
        dnsResolver,
        timeoutMs: 3000,
        maxBytes: 2048,
      })
      expect(zeroChunkSub.nodes.length).toBe(1)

      // Default HTTP (80) and HTTPS (443) port branches + default strict TLS verification
      const failingLookup = new RealDnsResolver({
        servers: ['127.0.0.1:1'],
        timeoutMs: 15,
        systemLookup: async () => { throw new Error('dns-offline') },
      })
      await expect(fetchSubscription('http://default-http.example/sub', {
        subscriptionId: SUB_ID,
        dnsResolver: failingLookup,
        timeoutMs: 500,
        maxBytes: 2048,
      })).rejects.toThrow()
      await expect(fetchSubscription('https://default-https.example/sub', {
        subscriptionId: SUB_ID,
        dnsResolver: failingLookup,
        timeoutMs: 500,
        maxBytes: 2048,
      })).rejects.toThrow()

      rawReply = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZZZ\r\n'
      await expect(fetchSubscription(`http://127.0.0.1:${rawPort}/badhex`, {
        subscriptionId: SUB_ID,
        dnsResolver,
        timeoutMs: 3000,
        maxBytes: 2048,
      })).rejects.toThrow(/Invalid HTTP chunked/)

      rawReply = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10\r\nabc'
      await expect(fetchSubscription(`http://127.0.0.1:${rawPort}/trunc`, {
        subscriptionId: SUB_ID,
        dnsResolver,
        timeoutMs: 3000,
        maxBytes: 2048,
      })).rejects.toThrow(/Truncated HTTP chunked/)

      rawReply = `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n400\r\n${'A'.repeat(0x400)}\r\n0\r\n\r\n`
      await expect(fetchSubscription(`http://127.0.0.1:${rawPort}/chunkover`, {
        subscriptionId: SUB_ID,
        dnsResolver,
        timeoutMs: 3000,
        maxBytes: 512,
      })).rejects.toThrow(/exceeded maximum byte limit/)

      rawReply = `HTTP/1.1 200 OK\r\n\r\n${'B'.repeat(80_000)}`
      await expect(fetchSubscription(`http://127.0.0.1:${rawPort}/streamover`, {
        subscriptionId: SUB_ID,
        dnsResolver,
        timeoutMs: 3000,
        maxBytes: 1024,
      })).rejects.toThrow(/exceeded maximum byte limit/)

      // Transient socket EOF/reset on attempt 1 -> automatic retry succeeds on attempt 2
      let transientDropCount = 0
      const flakySrv = net.createServer((sock) => {
        sock.once('data', () => {
          transientDropCount += 1
          if (transientDropCount === 1) {
            sock.destroy()
            return
          }
          sock.end(`HTTP/1.1 200 OK\r\nContent-Length: ${String(sampleUriBody.length)}\r\n\r\n${sampleUriBody}`)
        })
      })
      await new Promise<void>(resolve => flakySrv.listen(0, '127.0.0.1', resolve))
      const flakyPort = (flakySrv.address() as net.AddressInfo).port
      try {
        const recovered = await fetchSubscription(`http://127.0.0.1:${flakyPort}/flaky`, {
          subscriptionId: SUB_ID,
          dnsResolver,
          timeoutMs: 1000,
          maxBytes: 2048,
          maxRetries: 2,
          retryDelayMs: 5,
        })
        expect(recovered.nodes.length).toBe(1)
        expect(transientDropCount).toBe(2)

        // Caller abort during retry backoff exits immediately without waiting full retryDelayMs
        transientDropCount = 0
        const abortRetry = new AbortController()
        const retryPromise = fetchSubscription(`http://127.0.0.1:${flakyPort}/abort-backoff`, {
          subscriptionId: SUB_ID,
          dnsResolver,
          timeoutMs: 1000,
          maxBytes: 2048,
          maxRetries: 2,
          retryDelayMs: 5000,
          signal: abortRetry.signal,
        })
        setTimeout(() => { abortRetry.abort() }, 20)
        await expect(retryPromise).rejects.toThrow()
      } finally {
        flakySrv.close()
      }

      // Unsupported scheme & completely invalid URL
      await expect(fetchSubscription('ftp://secret.example/sub', {
        subscriptionId: SUB_ID,
        dnsResolver,
        timeoutMs: 1000,
        maxBytes: 2048,
      })).rejects.toThrow(/http: or https:/)

      await expect(fetchSubscription(':::not-a-url', {
        subscriptionId: SUB_ID,
        dnsResolver,
        timeoutMs: 1000,
        maxBytes: 2048,
      })).rejects.toThrow()
    } finally {
      httpSrv.close()
      httpsSrv.close()
      rawSrv.close()
    }
  })
})
