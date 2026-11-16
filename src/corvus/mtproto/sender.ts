/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from 'events'
import * as zlib from 'zlib'
import {
  RsaKey, TELEGRAM_RSA_KEYS, factorPQ, igeDecrypt, igeEncrypt, modPow, msgKeys,
  rand, rsaEncrypt, rsaFingerprint, sha1, sha256, toBig, toBuf,
} from './crypto'
import { ID_CONTAINER, ID_GZIP, ID_RPC_RESULT, Reader, Schema, TLError, Writer } from './tl'
import { Transport } from './transport'

export class RpcError extends Error {
  constructor(public code: number, public errorMessage: string, public request?: string) {
    super(`${errorMessage} (${code})${request ? ' pada ' + request : ''}`)
    this.name = 'RpcError'
  }
  /** FLOOD_WAIT_x -> x, selain itu undefined */
  get seconds() { const m = /_(\d+)$/.exec(this.errorMessage); return m && /FLOOD|SLOWMODE/.test(this.errorMessage) ? Number(m[1]) : undefined }
  /** *_MIGRATE_x -> x */
  get migrateTo() { const m = /MIGRATE_(\d+)$/.exec(this.errorMessage); return m ? Number(m[1]) : undefined }
}

interface Pending {
  msgId: bigint; body: Buffer; name: string; resultCtor: any
  resolve: (v: any) => void; reject: (e: any) => void; timer?: NodeJS.Timeout; tries: number
}

export interface SenderOptions {
  schema: Schema
  host: string; port: number; dcId: number
  authKey?: Buffer
  rsaKeys?: RsaKey[]
  requestTimeoutMs?: number
  pingIntervalMs?: number
  log?: (...a: any[]) => void
}

/** Pengirim MTProto 2.0: auth key, enkripsi, msg id/seqno, ack, salt, resend, container. */
export class MTProtoSender extends EventEmitter {
  authKey?: Buffer
  authKeyId?: Buffer
  salt = 0n
  timeOffset = 0
  private transport = new Transport()
  private sessionId = rand(8)
  private seq = 0
  private lastMsgId = 0n
  private pending = new Map<string, Pending>()
  private acks: bigint[] = []
  private ackTimer?: NodeJS.Timeout
  private pingTimer?: NodeJS.Timeout
  private waiter?: (b: Buffer) => void
  private plainQueue: Buffer[] = []
  private closed = false
  private log: (...a: any[]) => void

  constructor(private o: SenderOptions) {
    super()
    this.log = o.log ?? (() => undefined)
    if (o.authKey) this.setAuthKey(o.authKey)
  }

  get dcId() { return this.o.dcId }
  get connected() { return this.transport.connected }
  private get schema() { return this.o.schema }

  setAuthKey(k: Buffer) { this.authKey = k; this.authKeyId = sha1(k).subarray(12, 20) }

  async connect() {
    this.closed = false
    this.transport = new Transport()
    this.transport.on('packet', (p: Buffer) => this.onPacket(p))
    this.transport.on('transportError', (c: number) => this.emit('transportError', c))
    this.transport.on('error', (e: Error) => this.log('transport error', e.message))
    this.transport.on('close', () => this.onClose())
    await this.transport.connect(this.o.host, this.o.port)
    this.plainQueue = []
    if (!this.authKey) await this.createAuthKey()
    this.sessionId = rand(8); this.seq = 0
    const t = this.o.pingIntervalMs ?? 60000
    if (t > 0) { this.pingTimer = setInterval(() => this.ping(), t); this.pingTimer.unref?.() }
  }

  private onClose() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.closed) return
    this.emit('disconnected')
  }

  disconnect() {
    this.closed = true
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.transport.close()
    for (const p of this.pending.values()) { if (p.timer) clearTimeout(p.timer); p.reject(new Error('Koneksi ditutup')) }
    this.pending.clear()
  }

  /** Request yang tertunda saat koneksi putus, untuk dikirim ulang oleh pemanggil. */
  takePending() {
    const list = [...this.pending.values()]
    for (const p of list) if (p.timer) clearTimeout(p.timer)
    this.pending.clear()
    return list
  }

  /* ---------------- ID pesan ---------------- */
  private newMsgId(): bigint {
    const now = Date.now() / 1000 + this.timeOffset
    const sec = Math.floor(now)
    const nano = Math.floor((now - sec) * 1e9)
    let id = (BigInt(sec) << 32n) | (BigInt(nano) << 2n)
    if (id <= this.lastMsgId) id = this.lastMsgId + 4n
    this.lastMsgId = id
    return id
  }
  private nextSeq(content: boolean) {
    const s = this.seq * 2 + (content ? 1 : 0)
    if (content) this.seq++
    return s
  }

  /* ---------------- Auth key (DH) ---------------- */
  private plainPacket(body: Buffer) {
    const w = new Writer().raw(Buffer.alloc(8)).long(this.newMsgId()).int(body.length).raw(body)
    return w.done()
  }
  private recvPlain(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout handshake')), 20000)
      this.waiter = (b) => { clearTimeout(t); resolve(b) }
      const q = this.plainQueue.shift()
      if (q) this.waiter(q)
    })
  }
  private async plainCall(obj: any): Promise<any> {
    this.transport.send(this.plainPacket(this.schema.serialize(obj)))
    const p = await this.recvPlain()
    const r = new Reader(p)
    if (r.raw(8).some((x) => x !== 0)) throw new TLError('Handshake: auth_key_id bukan 0')
    r.long(); const len = r.int()
    return this.schema.deserialize(Buffer.from(r.raw(len)))
  }

  async createAuthKey() {
    const keys = this.o.rsaKeys ?? TELEGRAM_RSA_KEYS
    const nonce = rand(16)
    const res = await this.plainCall({ _: 'req_pq_multi', nonce })
    if (res._ !== 'resPQ' || !res.nonce.equals(nonce)) throw new TLError('Handshake: resPQ tidak valid')
    const key = keys.find((k) => res.server_public_key_fingerprints.includes(rsaFingerprint(k)))
    if (!key) throw new TLError('Handshake: tidak ada public key RSA yang cocok dengan server')
    const pq = toBig(res.pq)
    const [p, q] = factorPQ(pq)
    const newNonce = rand(32)
    const inner = this.schema.serialize({
      _: 'p_q_inner_data_dc', pq: res.pq, p: toBuf(p), q: toBuf(q),
      nonce, server_nonce: res.server_nonce, new_nonce: newNonce, dc: this.o.dcId,
    })
    const dh = await this.plainCall({
      _: 'req_DH_params', nonce, server_nonce: res.server_nonce, p: toBuf(p), q: toBuf(q),
      public_key_fingerprint: rsaFingerprint(key), encrypted_data: rsaEncrypt(inner, key),
    })
    if (dh._ !== 'server_DH_params_ok') throw new TLError('Handshake: server_DH_params_fail')
    const sn = res.server_nonce as Buffer
    const tmpKey = Buffer.concat([sha1(newNonce, sn), sha1(sn, newNonce).subarray(0, 12)])
    const tmpIv = Buffer.concat([sha1(sn, newNonce).subarray(12, 20), sha1(newNonce, newNonce), newNonce.subarray(0, 4)])
    const answer = igeDecrypt(dh.encrypted_answer, tmpKey, tmpIv)
    const ar = new Reader(answer.subarray(20))
    const info = this.schema.readObject(ar)
    if (info._ !== 'server_DH_inner_data') throw new TLError('Handshake: server_DH_inner_data tidak valid')
    if (!sha1(answer.subarray(20, 20 + ar.o)).equals(answer.subarray(0, 20))) throw new TLError('Handshake: hash jawaban DH salah')
    if (!info.nonce.equals(nonce) || !info.server_nonce.equals(sn)) throw new TLError('Handshake: nonce tidak cocok')
    const prime = toBig(info.dh_prime), g = BigInt(info.g), gA = toBig(info.g_a)
    const lim = 1n << (2048n - 64n)
    if (!(gA > 1n && gA < prime - 1n && gA > lim && gA < prime - lim)) throw new TLError('Handshake: g_a tidak aman')
    this.timeOffset = info.server_time - Math.floor(Date.now() / 1000)

    for (let retry = 0n; ; ) {
      const b = toBig(rand(256))
      const gB = modPow(g, b, prime)
      const cinner = this.schema.serialize({
        _: 'client_DH_inner_data', nonce, server_nonce: sn, retry_id: retry, g_b: toBuf(gB),
      })
      const withHash = Buffer.concat([sha1(cinner), cinner])
      const padded = Buffer.concat([withHash, rand((16 - (withHash.length % 16)) % 16)])
      const set = await this.plainCall({
        _: 'set_client_DH_params', nonce, server_nonce: sn, encrypted_data: igeEncrypt(padded, tmpKey, tmpIv),
      })
      const authKey = toBuf(modPow(gA, b, prime), 256)
      const aux = sha1(authKey).subarray(0, 8)
      const hash = (n: number) => sha1(newNonce, Buffer.from([n]), aux).subarray(4, 20)
      if (set._ === 'dh_gen_ok') {
        if (!set.new_nonce_hash1.equals(hash(1))) throw new TLError('Handshake: new_nonce_hash1 salah')
        this.setAuthKey(authKey)
        const s = Buffer.alloc(8)
        for (let i = 0; i < 8; i++) s[i] = newNonce[i]! ^ sn[i]!
        this.salt = s.readBigInt64LE(0)
        return
      }
      if (set._ === 'dh_gen_retry') { retry = aux.readBigInt64LE(0); continue }
      throw new TLError('Handshake gagal: ' + set._)
    }
  }

  /* ---------------- Enkripsi ---------------- */
  private encrypt(body: Buffer, seq: number, msgId: bigint): Buffer {
    const head = new Writer().long(this.salt).raw(this.sessionId).long(msgId).int(seq).int(body.length).done()
    const base = head.length + body.length
    const pad = 12 + ((16 - ((base + 12) % 16)) % 16)
    const plain = Buffer.concat([head, body, rand(pad)])
    const msgKey = sha256(this.authKey!.subarray(88, 120), plain).subarray(8, 24)
    const { key, iv } = msgKeys(this.authKey!, msgKey, 0)
    return Buffer.concat([this.authKeyId!, msgKey, igeEncrypt(plain, key, iv)])
  }

  private decrypt(pkt: Buffer) {
    if (!pkt.subarray(0, 8).equals(this.authKeyId!)) throw new TLError('auth_key_id tidak cocok')
    const msgKey = pkt.subarray(8, 24)
    const { key, iv } = msgKeys(this.authKey!, msgKey, 8)
    const plain = igeDecrypt(pkt.subarray(24, 24 + Math.floor((pkt.length - 24) / 16) * 16), key, iv)
    if (!sha256(this.authKey!.subarray(96, 128), plain).subarray(8, 24).equals(msgKey)) throw new TLError('msg_key tidak valid')
    const r = new Reader(plain)
    r.long() // salt
    const session = r.raw(8)
    const msgId = r.long()
    const seq = r.int()
    const len = r.int()
    if (!session.equals(this.sessionId)) throw new TLError('session_id tidak cocok')
    return { msgId, seq, body: Buffer.from(r.raw(len)) }
  }

  private write(body: Buffer, content: boolean, msgId = this.newMsgId()) {
    this.transport.send(this.encrypt(body, this.nextSeq(content), msgId))
    return msgId
  }

  /* ---------------- Kirim request ---------------- */
  send<T = any>(obj: any, timeoutMs = this.o.requestTimeoutMs ?? 30000): Promise<T> {
    const c = this.schema.byName.get(obj._)
    const body = this.schema.serialize(obj)
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { msgId: 0n, body, name: obj._, resultCtor: c?.result, resolve, reject, tries: 0 }
      this.dispatch(p, timeoutMs)
    })
  }

  private dispatch(p: Pending, timeoutMs = this.o.requestTimeoutMs ?? 30000) {
    if (p.timer) clearTimeout(p.timer)
    if (p.msgId) this.pending.delete(String(p.msgId))
    p.msgId = this.newMsgId()
    p.timer = setTimeout(() => {
      this.pending.delete(String(p.msgId)); p.reject(new Error(`Timeout menunggu ${p.name}`))
    }, timeoutMs)
    this.pending.set(String(p.msgId), p)
    const bodyOut = p.body.length > 512 ? this.gzipWrap(p.body) : p.body
    this.write(bodyOut, true, p.msgId)
  }

  /** Kirim ulang request yang tertunda (setelah reconnect) */
  resubmit(list: Pending[]) { for (const p of list) this.dispatch(p) }

  private gzipWrap(body: Buffer) {
    const z = zlib.gzipSync(body)
    if (z.length >= body.length) return body
    return new Writer().uint(ID_GZIP).bytes(z).done()
  }

  ping() {
    if (!this.connected || !this.authKey) return
    this.send({ _: 'ping_delay_disconnect', ping_id: BigInt(Date.now()), disconnect_delay: 75 }, 15000).catch(() => undefined)
  }

  /* ---------------- Terima ---------------- */
  private onPacket(pkt: Buffer) {
    if (!this.authKey || (this.waiter || this.plainQueue.length) || pkt.subarray(0, 8).every((x) => x === 0)) {
      if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(pkt) } else this.plainQueue.push(pkt)
      return
    }
    try {
      const m = this.decrypt(pkt)
      if (!this.timeSynced) { this.timeSynced = true; this.syncTime(m.msgId) }
      this.handle(m.msgId, m.seq, m.body)
    } catch (e) { this.log('gagal memproses paket:', (e as Error).message) }
  }
  private timeSynced = false
  private syncTime(serverMsgId: bigint) {
    this.timeOffset = Number(serverMsgId >> 32n) - Math.floor(Date.now() / 1000)
  }

  private handle(msgId: bigint, seq: number, body: Buffer): void {
    if (seq & 1) { this.acks.push(msgId); this.scheduleAck() }
    const id = body.readUInt32LE(0)
    if (id === ID_CONTAINER) {
      const r = new Reader(body); r.uint()
      const n = r.int()
      for (let i = 0; i < n; i++) {
        const mid = r.long(); const s = r.int(); const len = r.int()
        this.handle(mid, s, Buffer.from(r.raw(len)))
      }
      return
    }
    if (id === ID_GZIP) {
      const r = new Reader(body); r.uint()
      this.handle(msgId, 0, zlib.gunzipSync(r.bytes())); return
    }
    if (id === ID_RPC_RESULT) { this.onRpcResult(body); return }
    let obj: any
    try { obj = this.schema.deserialize(body) } catch (e) {
      this.log('objek tidak dapat di-parse:', (e as Error).message); return
    }
    switch (obj._) {
      case 'new_session_created': this.salt = obj.server_salt; this.emit('newSession', obj); return
      case 'bad_server_salt': this.salt = obj.new_server_salt; this.resend(obj.bad_msg_id); return
      case 'bad_msg_notification': {
        const c = obj.error_code
        if (c === 16 || c === 17) this.syncTime(msgId)
        if ([16, 17, 32, 33, 34, 35].includes(c)) { if (c === 32 || c === 33) this.seq += 64; this.resend(obj.bad_msg_id) }
        else this.failPending(obj.bad_msg_id, new TLError(`bad_msg_notification code ${c}`))
        return
      }
      case 'pong': case 'msgs_ack': case 'msg_detailed_info': case 'msg_new_detailed_info': return
      default: this.emit('update', obj)
    }
  }

  private resend(oldId: bigint) {
    const p = this.pending.get(String(oldId))
    if (!p) return
    if (++p.tries > 5) return this.failPending(oldId, new TLError('Terlalu banyak resend'))
    this.dispatch(p)
  }
  private failPending(id: bigint, e: any) {
    const p = this.pending.get(String(id)); if (!p) return
    if (p.timer) clearTimeout(p.timer); this.pending.delete(String(id)); p.reject(e)
  }

  private onRpcResult(body: Buffer) {
    const r = new Reader(body); r.uint()
    const reqId = r.long()
    const p = this.pending.get(String(reqId))
    if (!p) return
    if (p.timer) clearTimeout(p.timer)
    this.pending.delete(String(reqId))
    let rr = r
    const first = r.peekUint()
    if (first === ID_GZIP) { r.uint(); rr = new Reader(zlib.gunzipSync(r.bytes())) }
    if (rr.peekUint() === 0x2144ca19) {
      const e = this.schema.readObject(rr)
      return p.reject(new RpcError(e.error_code, e.error_message, p.name))
    }
    const start = rr.o
    try { p.resolve(this.schema.read(rr, p.resultCtor)) } catch (e) {
      const err: any = new TLError(`Gagal parse hasil ${p.name}: ${(e as Error).message}`)
      err.raw = Buffer.from(rr.b.subarray(start)); p.reject(err)
    }
  }

  private scheduleAck() {
    if (this.ackTimer) return
    this.ackTimer = setTimeout(() => {
      this.ackTimer = undefined
      const ids = this.acks.splice(0)
      if (ids.length && this.connected) this.write(this.schema.serialize({ _: 'msgs_ack', msg_ids: ids }), false)
    }, 150)
  }
}
