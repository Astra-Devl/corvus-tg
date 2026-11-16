/* eslint-disable @typescript-eslint/no-explicit-any */
import * as crypto from 'crypto'
import { modPow, rand, sha256, toBig, toBuf } from './crypto'

const pad = (n: bigint) => toBuf(n, 256)
const SH = (d: Buffer, salt: Buffer) => sha256(salt, d, salt)

/** Password 2FA -> inputCheckPasswordSRP (algoritma resmi Telegram). */
export function srpCheck(pwd: any, password: string) {
  const algo = pwd.current_algo
  if (!algo || algo._ !== 'passwordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow') {
    throw new Error('Algoritma password 2FA tidak didukung: ' + algo?._)
  }
  const salt1: Buffer = algo.salt1, salt2: Buffer = algo.salt2
  const p = toBig(algo.p), g = BigInt(algo.g), B = toBig(pwd.srp_B)
  if (B <= 0n || B >= p) throw new Error('SRP: B tidak valid')
  const pw = Buffer.from(password, 'utf8')
  const ph1 = SH(SH(pw, salt1), salt2)
  const x = toBig(SH(crypto.pbkdf2Sync(ph1, salt1, 100000, 64, 'sha512'), salt2))
  const v = modPow(g, x, p)
  const k = toBig(sha256(pad(p), pad(g)))
  const a = toBig(rand(256))
  const A = modPow(g, a, p)
  const u = toBig(sha256(pad(A), pad(B)))
  const t = (((B - ((k * v) % p)) % p) + p) % p
  const S = modPow(t, a + u * x, p)
  const K = sha256(pad(S))
  const hp = sha256(pad(p)), hg = sha256(pad(g))
  const xor = Buffer.alloc(32); for (let i = 0; i < 32; i++) xor[i] = hp[i]! ^ hg[i]!
  const M1 = sha256(xor, sha256(salt1), sha256(salt2), pad(A), pad(B), K)
  return { _: 'inputCheckPasswordSRP', srp_id: pwd.srp_id, A: pad(A), M1 }
}
