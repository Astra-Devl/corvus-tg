import * as crypto from 'crypto'

export const sha1 = (...b: Buffer[]) => crypto.createHash('sha1').update(Buffer.concat(b)).digest()
export const sha256 = (...b: Buffer[]) => crypto.createHash('sha256').update(Buffer.concat(b)).digest()
export const rand = (n: number) => crypto.randomBytes(n)

export const toBig = (b: Buffer) => (b.length ? BigInt('0x' + b.toString('hex')) : 0n)
export function toBuf(n: bigint, len?: number): Buffer {
  let h = n.toString(16)
  if (h.length % 2) h = '0' + h
  const b = Buffer.from(h, 'hex')
  return len === undefined ? b : b.length >= len ? b.subarray(b.length - len) : Buffer.concat([Buffer.alloc(len - b.length), b])
}
export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n; base %= mod
  while (exp > 0n) { if (exp & 1n) r = (r * base) % mod; exp >>= 1n; base = (base * base) % mod }
  return r
}

/** AES-256-IGE */
export function igeEncrypt(data: Buffer, key: Buffer, iv: Buffer): Buffer {
  if (data.length % 16) throw new Error('IGE: panjang data harus kelipatan 16')
  const ecb = crypto.createCipheriv('aes-256-ecb', key, null); ecb.setAutoPadding(false)
  let y = iv.subarray(0, 16), x = iv.subarray(16, 32)
  const out = Buffer.alloc(data.length)
  for (let i = 0; i < data.length; i += 16) {
    const blk = data.subarray(i, i + 16)
    const t = Buffer.alloc(16); for (let j = 0; j < 16; j++) t[j] = blk[j]! ^ y[j]!
    const e = ecb.update(t)
    const c = Buffer.alloc(16); for (let j = 0; j < 16; j++) c[j] = e[j]! ^ x[j]!
    c.copy(out, i); y = c; x = blk
  }
  return out
}
export function igeDecrypt(data: Buffer, key: Buffer, iv: Buffer): Buffer {
  if (data.length % 16) throw new Error('IGE: panjang data harus kelipatan 16')
  const ecb = crypto.createDecipheriv('aes-256-ecb', key, null); ecb.setAutoPadding(false)
  let y = iv.subarray(0, 16), x = iv.subarray(16, 32)
  const out = Buffer.alloc(data.length)
  for (let i = 0; i < data.length; i += 16) {
    const blk = data.subarray(i, i + 16)
    const t = Buffer.alloc(16); for (let j = 0; j < 16; j++) t[j] = blk[j]! ^ x[j]!
    const d = ecb.update(t)
    const p = Buffer.alloc(16); for (let j = 0; j < 16; j++) p[j] = d[j]! ^ y[j]!
    p.copy(out, i); x = p; y = blk
  }
  return out
}

/** Faktorisasi pq (<= 64 bit) dengan Pollard-Brent. Mengembalikan [p, q], p < q. */
export function factorPQ(pq: bigint): [bigint, bigint] {
  if (pq % 2n === 0n) return [2n, pq / 2n]
  const gcd = (a: bigint, b: bigint) => { while (b) [a, b] = [b, a % b]; return a }
  for (let c = 1n; c < 50n; c++) {
    let x = 2n, y = 2n, d = 1n
    const f = (v: bigint) => (v * v + c) % pq
    while (d === 1n) { x = f(x); y = f(f(y)); d = gcd(x > y ? x - y : y - x, pq) }
    if (d !== pq && d !== 1n) { const o = pq / d; return d < o ? [d, o] : [o, d] }
  }
  throw new Error('Gagal memfaktorkan pq')
}

export interface RsaKey { n: bigint; e: bigint }
/** Public key produksi Telegram (fingerprint c3b42b02 6ce86b21). */
export const TELEGRAM_RSA_KEYS: RsaKey[] = [{
  n: BigInt('0xc150023e2f70db7985ded064759cfecf0af328e69a41daf4d6f01b538135a6f91f8f8b2a0ec9ba9720ce352efcf6c5680ffc424bd634864902de0b4bd6d49f4e580230e3ae97d95c8b19442b3c0a10d8f5633fecedd6926a7f6dab0ddb7d457f9ea81b8465fcd6fffeed114011df91c059caedaf97625f6c96ecc74725556934ef781d866b34f011fce4d835a090196e9a5f0e4449af7eb697ddb9076494ca5f81104a305b6dd27665722c46b60e5df680fb16b210607ef217652e60236c255f6a28315f4083a96791d7214bf64c1df4fd0db1944fb26a2a57031b32eee64ad15a8ba68885cde74a5bfc920f6abf59ba5c75506373e7130f9042da922179251f'),
  e: 65537n,
}]

const tlBytes = (b: Buffer) => {
  const l = b.length
  const h = l < 254 ? Buffer.from([l]) : Buffer.from([254, l & 255, (l >> 8) & 255, (l >> 16) & 255])
  return Buffer.concat([h, b, Buffer.alloc((4 - ((h.length + l) % 4)) % 4)])
}
/** fingerprint = 8 byte terakhir sha1(n || e) (TL bytes), sebagai signed int64 */
export function rsaFingerprint(k: RsaKey): bigint {
  return sha1(tlBytes(toBuf(k.n)), tlBytes(toBuf(k.e))).subarray(12, 20).readBigInt64LE(0)
}
/** RSA "raw" untuk p_q_inner_data: sha1(data)+data+padding hingga 255 byte. */
export function rsaEncrypt(data: Buffer, k: RsaKey): Buffer {
  if (data.length > 235) throw new Error('RSA: data terlalu panjang')
  const blk = Buffer.concat([sha1(data), data])
  const full = Buffer.concat([blk, rand(255 - blk.length)])
  return toBuf(modPow(toBig(full), k.e, k.n), 256)
}

/** Kunci & IV AES untuk pesan MTProto 2.0. x = 0 (client->server) atau 8 (server->client). */
export function msgKeys(authKey: Buffer, msgKey: Buffer, x: number) {
  const a = sha256(msgKey, authKey.subarray(x, x + 36))
  const b = sha256(authKey.subarray(40 + x, 76 + x), msgKey)
  return {
    key: Buffer.concat([a.subarray(0, 8), b.subarray(8, 24), a.subarray(24, 32)]),
    iv: Buffer.concat([b.subarray(0, 8), a.subarray(8, 24), b.subarray(24, 32)]),
  }
}
