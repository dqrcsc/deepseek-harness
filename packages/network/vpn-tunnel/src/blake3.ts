/**
 * Pure-TypeScript BLAKE3 cryptographic hash and `derive_key` implementation (RFC / official BLAKE3 specification).
 * Used by Shadowsocks 2022 (`2022-blake3-aes-128-gcm`, `2022-blake3-aes-256-gcm`, `2022-blake3-chacha20-poly1305`)
 * session subkey derivation and SIP023 Extended Identity Header (EIH) PSK hashing.
 */

const IV = new Uint32Array([
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19,
])

const MSG_PERMUTATION = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8] as const

const CHUNK_START = 1
const CHUNK_END = 2
const PARENT = 4
const ROOT = 8
const DERIVE_KEY_CONTEXT = 32
const DERIVE_KEY_MATERIAL = 64

const BLOCK_LEN = 64
const CHUNK_LEN = 1024

function rotr32(value: number, shift: number): number {
  return ((value >>> shift) | (value << (32 - shift))) >>> 0
}

function g(
  state: Uint32Array,
  a: number,
  b: number,
  c: number,
  d: number,
  mx: number,
  my: number,
): void {
  const sa0 = state[a] as number
  const sb0 = state[b] as number
  const sc0 = state[c] as number
  const sd0 = state[d] as number
  const sa1 = (sa0 + sb0 + mx) >>> 0
  const sd1 = rotr32(sd0 ^ sa1, 16)
  const sc1 = (sc0 + sd1) >>> 0
  const sb1 = rotr32(sb0 ^ sc1, 12)
  const sa2 = (sa1 + sb1 + my) >>> 0
  const sd2 = rotr32(sd1 ^ sa2, 8)
  const sc2 = (sc1 + sd2) >>> 0
  const sb2 = rotr32(sb1 ^ sc2, 7)
  state[a] = sa2
  state[b] = sb2
  state[c] = sc2
  state[d] = sd2
}

function roundFn(state: Uint32Array, m: Uint32Array): void {
  g(state, 0, 4, 8, 12, m[0] as number, m[1] as number)
  g(state, 1, 5, 9, 13, m[2] as number, m[3] as number)
  g(state, 2, 6, 10, 14, m[4] as number, m[5] as number)
  g(state, 3, 7, 11, 15, m[6] as number, m[7] as number)
  g(state, 0, 5, 10, 15, m[8] as number, m[9] as number)
  g(state, 1, 6, 11, 12, m[10] as number, m[11] as number)
  g(state, 2, 7, 8, 13, m[12] as number, m[13] as number)
  g(state, 3, 4, 9, 14, m[14] as number, m[15] as number)
}

function permute(m: Uint32Array): Uint32Array {
  const next = new Uint32Array(16)
  for (let i = 0; i < 16; i += 1) {
    next[i] = m[MSG_PERMUTATION[i] as number] as number
  }
  return next
}

function compress(
  chainingValue: Uint32Array,
  blockWords: Uint32Array,
  counter: bigint,
  blockLen: number,
  flags: number,
): Uint32Array {
  const state = new Uint32Array([
    chainingValue[0] as number,
    chainingValue[1] as number,
    chainingValue[2] as number,
    chainingValue[3] as number,
    chainingValue[4] as number,
    chainingValue[5] as number,
    chainingValue[6] as number,
    chainingValue[7] as number,
    IV[0] as number,
    IV[1] as number,
    IV[2] as number,
    IV[3] as number,
    Number(counter & 0xffffffffn) >>> 0,
    Number((counter >> 32n) & 0xffffffffn) >>> 0,
    blockLen >>> 0,
    flags >>> 0,
  ])

  let m = blockWords
  roundFn(state, m)
  for (let r = 0; r < 6; r += 1) {
    m = permute(m)
    roundFn(state, m)
  }

  for (let i = 0; i < 8; i += 1) {
    const lo = state[i] as number
    const hi = state[i + 8] as number
    state[i] = (lo ^ hi) >>> 0
    state[i + 8] = (hi ^ (chainingValue[i] as number)) >>> 0
  }
  return state
}

function wordsFromLittleEndianBlock(bytes: Uint8Array): Uint32Array {
  const padded = new Uint8Array(BLOCK_LEN)
  padded.set(bytes)
  const view = new DataView(padded.buffer, padded.byteOffset, BLOCK_LEN)
  const words = new Uint32Array(16)
  for (let i = 0; i < 16; i += 1) {
    words[i] = view.getUint32(i * 4, true)
  }
  return words
}

interface OutputNode {
  readonly inputChainingValue: Uint32Array
  readonly blockWords: Uint32Array
  readonly counter: bigint
  readonly blockLen: number
  readonly flags: number
}

function chainingValueOf(node: OutputNode): Uint32Array {
  return compress(node.inputChainingValue, node.blockWords, node.counter, node.blockLen, node.flags).subarray(0, 8)
}

function rootOutputBytes(node: OutputNode, outLen: number): Buffer {
  const out = Buffer.allocUnsafe(outLen)
  let offset = 0
  let outputBlockCounter = 0n
  while (offset < outLen) {
    const words = compress(
      node.inputChainingValue,
      node.blockWords,
      outputBlockCounter,
      node.blockLen,
      node.flags | ROOT,
    )
    const blockBytes = Buffer.allocUnsafe(BLOCK_LEN)
    for (let i = 0; i < 16; i += 1) {
      blockBytes.writeUInt32LE(words[i] as number, i * 4)
    }
    const take = Math.min(BLOCK_LEN, outLen - offset)
    blockBytes.copy(out, offset, 0, take)
    offset += take
    outputBlockCounter += 1n
  }
  return out
}

function parentOutput(leftCv: Uint32Array, rightCv: Uint32Array, keyWords: Uint32Array, flags: number): OutputNode {
  const blockWords = new Uint32Array(16)
  blockWords.set(leftCv, 0)
  blockWords.set(rightCv, 8)
  return {
    inputChainingValue: keyWords,
    blockWords,
    counter: 0n,
    blockLen: BLOCK_LEN,
    flags: flags | PARENT,
  }
}

function chunkOutput(chunkBytes: Uint8Array, chunkCounter: bigint, keyWords: Uint32Array, flags: number): OutputNode {
  let cv: Uint32Array = new Uint32Array(keyWords)
  if (chunkBytes.length === 0) {
    return {
      inputChainingValue: cv,
      blockWords: new Uint32Array(16),
      counter: chunkCounter,
      blockLen: 0,
      flags: flags | CHUNK_START | CHUNK_END,
    }
  }

  const totalBlocks = Math.ceil(chunkBytes.length / BLOCK_LEN)
  for (let blockIndex = 0; blockIndex < totalBlocks; blockIndex += 1) {
    const start = blockIndex * BLOCK_LEN
    const slice = chunkBytes.subarray(start, Math.min(start + BLOCK_LEN, chunkBytes.length))
    const words = wordsFromLittleEndianBlock(slice)
    let blockFlags = flags
    if (blockIndex === 0) blockFlags |= CHUNK_START
    if (blockIndex === totalBlocks - 1) {
      return {
        inputChainingValue: cv,
        blockWords: words,
        counter: chunkCounter,
        blockLen: slice.length,
        flags: blockFlags | CHUNK_END,
      }
    }
    cv = compress(cv, words, chunkCounter, slice.length, blockFlags).subarray(0, 8)
  }

  /* v8 ignore next -- totalBlocks >= 1 when chunkBytes.length > 0 */
  throw new Error('Unreachable empty BLAKE3 block loop')
}

function hashWithKeyWords(input: Uint8Array, keyWords: Uint32Array, flags: number, outLen: number): Buffer {
  if (input.length <= CHUNK_LEN) {
    return rootOutputBytes(chunkOutput(input, 0n, keyWords, flags), outLen)
  }

  const cvStack: Uint32Array[] = []
  let chunkCounter = 0n
  let offset = 0

  while (offset + CHUNK_LEN < input.length) {
    const chunk = input.subarray(offset, offset + CHUNK_LEN)
    let newCv = chainingValueOf(chunkOutput(chunk, chunkCounter, keyWords, flags))
    chunkCounter += 1n
    let totalChunks = chunkCounter
    while ((totalChunks & 1n) === 0n) {
      const leftCv = cvStack.pop() as Uint32Array
      newCv = chainingValueOf(parentOutput(leftCv, newCv, keyWords, flags))
      totalChunks >>= 1n
    }
    cvStack.push(newCv)
    offset += CHUNK_LEN
  }

  const finalChunk = input.subarray(offset)
  let output = chunkOutput(finalChunk, chunkCounter, keyWords, flags)
  while (cvStack.length > 0) {
    const leftCv = cvStack.pop() as Uint32Array
    output = parentOutput(leftCv, chainingValueOf(output), keyWords, flags)
  }
  return rootOutputBytes(output, outLen)
}

/**
 * Compute the unkeyed BLAKE3 digest (or XOF output) of `data`.
 * @param data - input byte buffer to hash.
 * @param outLen - desired output length in bytes (defaults to `32`).
 * @returns digest bytes of length `outLen`.
 */
export function blake3Hash(data: Uint8Array, outLen = 32): Buffer {
  return hashWithKeyWords(data, IV, 0, outLen)
}

/**
 * Derive a cryptographic subkey using BLAKE3 `derive_key` mode.
 * @param context - domain-separation context string (for example `"shadowsocks 2022 session subkey"`).
 * @param keyMaterial - input key material bytes (for example `PSK || salt`).
 * @param outLen - desired derived key length in bytes (defaults to `32`).
 * @returns derived key bytes of length `outLen`.
 */
export function blake3DeriveKey(context: string, keyMaterial: Uint8Array, outLen = 32): Buffer {
  const contextBytes = Buffer.from(context, 'utf8')
  const contextKeyBytes = hashWithKeyWords(contextBytes, IV, DERIVE_KEY_CONTEXT, 32)
  const contextKeyWords = new Uint32Array(8)
  for (let i = 0; i < 8; i += 1) {
    contextKeyWords[i] = contextKeyBytes.readUInt32LE(i * 4)
  }
  return hashWithKeyWords(keyMaterial, contextKeyWords, DERIVE_KEY_MATERIAL, outLen)
}
