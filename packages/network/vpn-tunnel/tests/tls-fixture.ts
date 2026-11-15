import { generateKeyPairSync, sign } from 'node:crypto'

function derLength(len: number): Buffer {
  if (len < 128) return Buffer.from([len])
  const hex = len.toString(16).padStart(len > 255 ? 4 : 2, '0')
  const bytes = Buffer.from(hex, 'hex')
  return Buffer.concat([Buffer.from([0x80 | bytes.length]), bytes])
}

function derSeq(...items: readonly Buffer[]): Buffer {
  const body = Buffer.concat(items)
  return Buffer.concat([Buffer.from([0x30]), derLength(body.length), body])
}

function derSet(...items: readonly Buffer[]): Buffer {
  const body = Buffer.concat(items)
  return Buffer.concat([Buffer.from([0x31]), derLength(body.length), body])
}

function derOid(bytes: readonly number[]): Buffer {
  return Buffer.concat([Buffer.from([0x06, bytes.length]), Buffer.from(bytes)])
}

function derUtf8(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8')
  return Buffer.concat([Buffer.from([0x0c]), derLength(bytes.length), bytes])
}

function derUtcTime(text: string): Buffer {
  const bytes = Buffer.from(text, 'ascii')
  return Buffer.concat([Buffer.from([0x17, bytes.length]), bytes])
}

/**
 * Mint an ephemeral Ed25519 self-signed X.509 certificate in pure `node:crypto` (no external `openssl` binary).
 * @returns PEM-encoded private key and certificate for loopback TLS servers.
 */
export function createSelfSignedTlsCredentials(): { readonly key: string; readonly cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const algId = derSeq(derOid([0x2b, 0x65, 0x70]))
  const subject = derSeq(derSet(derSeq(derOid([0x55, 0x04, 0x03]), derUtf8('localhost'))))
  const validity = derSeq(derUtcTime('240101000000Z'), derUtcTime('350101000000Z'))
  const tbs = derSeq(
    Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02]),
    Buffer.from([0x02, 0x01, 0x01]),
    algId,
    subject,
    validity,
    subject,
    spki,
  )
  const signature = sign(null, tbs, privateKey)
  const bitString = Buffer.concat([Buffer.from([0x03]), derLength(signature.length + 1), Buffer.from([0x00]), signature])
  const certDer = derSeq(tbs, algId, bitString)
  const cert = `-----BEGIN CERTIFICATE-----\n${certDer.toString('base64')}\n-----END CERTIFICATE-----\n`
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' })
  return { key: typeof key === 'string' ? key : key.toString('utf8'), cert }
}
