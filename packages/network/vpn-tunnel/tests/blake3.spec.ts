import { describe, expect, it } from 'vitest'
import { blake3DeriveKey, blake3Hash } from '../src/blake3.ts'
import { redactNetworkError, VPN_TUNNEL_ERROR_CODES, VpnTunnelError } from '../src/error.ts'

function patternedInput(length: number): Buffer {
  const buf = Buffer.allocUnsafe(length)
  for (let i = 0; i < length; i += 1) {
    buf[i] = i % 251
  }
  return buf
}

describe('VpnTunnelError and redactNetworkError', () => {
  it('constructs coded HarnessError instances and scrubs sensitive endpoints', () => {
    expect(VPN_TUNNEL_ERROR_CODES).toContain('VPN_PROTOCOL_ERROR')
    const cause = new Error('socket ECONNRESET')
    const err = new VpnTunnelError('VPN_CONNECT_FAILED', 'Dial failed at 203.0.113.42:8388 for https://sub.example.com/token123', { cause })
    expect(err.code).toBe('VPN_CONNECT_FAILED')
    expect(err.cause).toBe(cause)

    const redacted = redactNetworkError(err, ['token123', 'edge-secret.example.net', ''])
    expect(redacted).not.toContain('203.0.113.42')
    expect(redacted).not.toContain('sub.example.com')
    expect(redacted).not.toContain('token123')
    expect(redacted).toContain('[redacted-ip]')
    expect(redacted).toContain('[redacted-url]')

    expect(redactNetworkError('plain failure on edge-secret.example.net', ['edge-secret.example.net']))
      .toBe('plain failure on [redacted]')
    expect(redactNetworkError('   \n\t  ')).toBe('Network tunnel error')
  })
})

describe('BLAKE3 hash and derive_key', () => {
  it('matches official BLAKE3 specification test vectors across single-block, multi-block, and multi-chunk inputs', () => {
    expect(blake3Hash(Buffer.alloc(0)).toString('hex'))
      .toBe('af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262')
    expect(blake3Hash(Buffer.from('abc', 'utf8')).toString('hex'))
      .toBe('6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85')
    expect(blake3Hash(patternedInput(1)).toString('hex'))
      .toBe('2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213')
    expect(blake3Hash(patternedInput(64)).toString('hex'))
      .toBe('4eed7141ea4a5cd4b788606bd23f46e212af9cacebacdc7d1f4c6dc7f2511b98')
    expect(blake3Hash(patternedInput(65)).toString('hex'))
      .toBe('de1e5fa0be70df6d2be8fffd0e99ceaa8eb6e8c93a63f2d8d1c30ecb6b263dee')
    expect(blake3Hash(patternedInput(1024)).toString('hex'))
      .toBe('42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7')
    expect(blake3Hash(patternedInput(1025)).toString('hex'))
      .toBe('d00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444')
  })

  it('supports multi-chunk Merkle tree reduction and XOF outputs beyond 64 bytes', () => {
    const out131 = blake3Hash(patternedInput(1), 131)
    expect(out131.length).toBe(131)
    expect(out131.subarray(0, 32).toString('hex'))
      .toBe('2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213')
    expect(out131.subarray(0, 64).toString('hex'))
      .toBe(
        '2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213'
        + 'c3a6cb8bf623e20cdb535f8d1a5ffb86342d9c0b64aca3bce1d31f60adfa137b',
      )

    // 2048, 3072, and 4097 bytes exercise 2-chunk, 3-chunk, and 5-chunk Merkle tree parent reductions.
    expect(blake3Hash(patternedInput(2048)).toString('hex'))
      .toBe('e776b6028c7cd22a4d0ba182a8bf62205d2ef576467e838ed6f2529b85fba24a')
    expect(blake3Hash(patternedInput(3072)).toString('hex'))
      .toBe('b98cb0ff3623be03326b373de6b9095218513e64f1ee2edd2525c7ad1e5cffd2')
    expect(blake3Hash(patternedInput(4097), 96).toString('hex'))
      .toBe(
        '9b4052b38f1c5fc8b1f9ff7ac7b27cd242487b3d890d15c96a1c25b8aa0fb995'
        + '05f91b0b5600a11251652eacfa9497b31cd3c409ce2e45cfe6c0a016967316c4'
        + '26bd26f619eab5d70af9a418b845c608840390f361630bd497b1ab4401931635',
      )
  })

  it('matches official BLAKE3 derive_key specification vectors', () => {
    const context = 'BLAKE3 2019-12-27 16:29:52 test vectors context'
    expect(blake3DeriveKey(context, Buffer.alloc(0)).toString('hex'))
      .toBe('2cc39783c223154fea8dfb7c1b1660f2ac2dcbd1c1de8277b0b0dd39b7e50d7d')
    expect(blake3DeriveKey(context, patternedInput(65), 64).subarray(0, 32).toString('hex'))
      .toBe('51fd05c3c1cfbc8ed67d139ad76f5cf8236cd2acd26627a30c104dfd9d3ff8a8')

    const ssSubkey16 = blake3DeriveKey('shadowsocks 2022 session subkey', patternedInput(32), 16)
    const ssSubkey32 = blake3DeriveKey('shadowsocks 2022 session subkey', patternedInput(64))
    expect(ssSubkey16.length).toBe(16)
    expect(ssSubkey32.length).toBe(32)
    expect(ssSubkey16.equals(ssSubkey32.subarray(0, 16))).toBe(false)
  })
})
