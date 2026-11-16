/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from 'events'
import { modPow, rand, sha1, sha256, toBig, toBuf } from './mtproto/crypto'
import type { CorvusUserbot } from './userbot'

/**
 * Voice/video call 1-1 lewat MTProto (hanya akun userbot; Bot API tidak punya call).
 * Dikerjakan: signaling (request/accept/confirm/discard), pertukaran kunci Diffie-Hellman
 * & fingerprint, event 'ready' berisi kunci + server relay, serta voice chat grup (create/end).
 * Media (encode/decode audio-video, tgvoip/tgcalls) disediakan engine eksternal lewat setEngine().
 */
export interface CallEngine {
  start(info: CallInfo): void | Promise<void>
  stop(call: CorvusCall): void | Promise<void>
  [k: string]: any // mis. play(file), record(file) milik engine
}
export interface CallInfo {
  call: CorvusCall
  key: Buffer
  keyFingerprint: bigint
  connections: any[]
  protocol: any
  outgoing: boolean
  video: boolean
}
export type CallState = 'requesting' | 'ringing' | 'accepted' | 'ready' | 'ended'

export class CorvusCallEngineMissing extends Error {
  constructor() {
    super('Engine media belum dipasang. Panggilan hanya tersambung di level signaling. Pakai calls.setEngine(engine) (mis. ntgcalls).')
    this.name = 'CorvusCallEngineMissing'
  }
}

const randomId = () => Number(toBig(rand(4)) & 0x7fffffffn)
const LIM = 1n << (2048n - 64n)
function checkG(g: bigint, p: bigint) {
  if (!(g > 1n && g < p - 1n && g > LIM && g < p - LIM)) throw new Error('DH: nilai g_a/g_b tidak valid')
}

export class CorvusCall extends EventEmitter {
  state: CallState = 'requesting'
  id: bigint = 0n; accessHash: bigint = 0n
  peerId: any; video = false; outgoing = true
  key?: Buffer; keyFingerprint?: bigint; connections: any[] = []
  /** internal */
  _secret?: bigint; _gA?: Buffer; _gAHash?: Buffer; _protocol?: any

  constructor(private mgr: CorvusCalls) { super() }

  get inputCall() { return { _: 'inputPhoneCall', id: this.id, access_hash: this.accessHash } }

  /** Terima panggilan masuk. */
  accept() { return this.mgr._accept(this) }

  /** Akhiri / tolak panggilan. */
  discard(reason: 'hangup' | 'busy' | 'missed' | 'disconnect' = 'hangup') {
    return this.mgr._discard(this, reason)
  }
}

export class CorvusCalls extends EventEmitter {
  private calls = new Map<string, CorvusCall>()
  private handler?: (pc: any) => void
  private engine?: CallEngine
  /** Versi protokol; ubah bila engine Anda memerlukan layer/library berbeda. */
  protocol = { min_layer: 92, max_layer: 92, library_versions: ['11.0.0', '10.0.0'], udp_p2p: true, udp_reflector: true }

  constructor(private ub: CorvusUserbot) { super() }

  setEngine(engine: CallEngine) { this.engine = engine; return this }
  get hasEngine() { return !!this.engine }

  attach() {
    if (this.handler) return
    this.handler = (pc: any) => void this.onCall(pc).catch((e) => this.emit('error', e))
    this.ub.client.on('phoneCall', this.handler)
  }
  detach() {
    if (this.handler) this.ub.client.off('phoneCall', this.handler)
    this.handler = undefined
  }

  private mkProtocol() { return { _: 'phoneCallProtocol', ...this.protocol } }

  private async dh() {
    const r = await this.ub.invoke({ _: 'messages.getDhConfig', version: 0, random_length: 0 })
    return { g: BigInt(r.g), p: toBig(Buffer.from(r.p)) }
  }

  /** Mulai panggilan keluar. peer: @username / id / entity. */
  async start(peer: any, opts: { video?: boolean } = {}): Promise<CorvusCall> {
    const user = await this.ub.client.inputUser(peer)
    const { g, p } = await this.dh()
    const a = toBig(rand(256))
    const gA = modPow(g, a, p)
    checkG(gA, p)
    const call = new CorvusCall(this)
    call.outgoing = true; call.video = !!opts.video; call.peerId = user.user_id
    call._secret = a; call._gA = toBuf(gA, 256); call._gAHash = sha256(call._gA); call._protocol = this.mkProtocol()
    const res: any = await this.ub.invoke({
      _: 'phone.requestCall', user_id: user, random_id: randomId(), g_a_hash: call._gAHash,
      protocol: call._protocol, video: !!opts.video,
    })
    this.track(call, res.phone_call)
    this.emit('outgoing', call)
    return call
  }

  private track(call: CorvusCall, pc: any) {
    call.id = pc.id; call.accessHash = pc.access_hash
    this.calls.set(String(pc.id), call)
  }

  async _accept(call: CorvusCall) {
    const { g, p } = await this.dh()
    const b = toBig(rand(256))
    const gB = modPow(g, b, p)
    checkG(gB, p)
    call._secret = b
    await this.ub.invoke({ _: 'phone.acceptCall', peer: call.inputCall, g_b: toBuf(gB, 256), protocol: call._protocol ?? this.mkProtocol() })
    call.state = 'accepted'
    return call
  }

  async _discard(call: CorvusCall, reason: string) {
    const map: any = {
      hangup: 'phoneCallDiscardReasonHangup', busy: 'phoneCallDiscardReasonBusy',
      missed: 'phoneCallDiscardReasonMissed', disconnect: 'phoneCallDiscardReasonDisconnect',
    }
    try {
      await this.ub.invoke({ _: 'phone.discardCall', peer: call.inputCall, duration: 0, reason: { _: map[reason] }, connection_id: 0n, video: call.video })
    } finally { await this.finish(call) }
  }

  private async finish(call: CorvusCall) {
    if (call.state === 'ended') return
    call.state = 'ended'
    this.calls.delete(String(call.id))
    try { await this.engine?.stop(call) } catch (e) { this.emit('error', e) }
    call.emit('ended'); this.emit('ended', call)
  }

  private fingerprint(key: Buffer): bigint { return sha1(key).readBigInt64LE(12) }

  private async onCall(pc: any) {
    const name: string = pc._
    if (name === 'phoneCallRequested') {
      const call = new CorvusCall(this)
      call.outgoing = false; call.video = !!pc.video; call.state = 'ringing'
      call.peerId = pc.admin_id; call._gAHash = Buffer.from(pc.g_a_hash); call._protocol = pc.protocol
      this.track(call, pc)
      try { await this.ub.invoke({ _: 'phone.receivedCall', peer: call.inputCall }) } catch { /* abaikan */ }
      this.emit('incoming', call)
      return
    }
    const call = this.calls.get(String(pc.id))
    if (!call) return
    if (name === 'phoneCallWaiting') { call.state = 'ringing'; call.emit('ringing'); return }
    if (name === 'phoneCallDiscarded') { await this.finish(call); return }
    if (name === 'phoneCallAccepted' && call.outgoing) {
      const { p } = await this.dh()
      const gB = toBig(Buffer.from(pc.g_b)); checkG(gB, p)
      const key = toBuf(modPow(gB, call._secret!, p), 256)
      call.key = key; call.keyFingerprint = this.fingerprint(key); call.state = 'accepted'
      const res: any = await this.ub.invoke({
        _: 'phone.confirmCall', peer: call.inputCall, g_a: call._gA!,
        key_fingerprint: call.keyFingerprint, protocol: call._protocol,
      })
      await this.ready(call, res.phone_call ?? pc)
      return
    }
    if (name === 'phoneCall') {
      if (!call.outgoing) {
        const { p } = await this.dh()
        const gA = Buffer.from(pc.g_a_or_b)
        if (call._gAHash && !sha256(gA).equals(call._gAHash)) throw new Error('DH: g_a_hash tidak cocok')
        const A = toBig(gA); checkG(A, p)
        const key = toBuf(modPow(A, call._secret!, p), 256)
        call.key = key; call.keyFingerprint = this.fingerprint(key)
        if (call.keyFingerprint !== BigInt(pc.key_fingerprint)) throw new Error('DH: key_fingerprint tidak cocok')
      }
      await this.ready(call, pc)
    }
  }

  private async ready(call: CorvusCall, pc: any) {
    if (call.state === 'ready') return
    call.connections = pc.connections ?? call.connections
    call.state = 'ready'
    const info: CallInfo = {
      call, key: call.key!, keyFingerprint: call.keyFingerprint!, connections: call.connections,
      protocol: pc.protocol ?? call._protocol ?? this.protocol, outgoing: call.outgoing, video: call.video,
    }
    if (this.engine) await this.engine.start(info)
    call.emit('ready', info); this.emit('ready', info)
  }

  /** Voice chat / video chat grup: buat dan akhiri (signaling). */
  async createVoiceChat(peer: any, opts: { title?: string; rtmp?: boolean } = {}) {
    return this.ub.invoke({
      _: 'phone.createGroupCall', peer: await this.ub.client.inputPeer(peer), random_id: randomId(),
      title: opts.title, rtmp_stream: opts.rtmp,
    })
  }
  async endVoiceChat(groupCall: { id: bigint; access_hash: bigint }) {
    return this.ub.invoke({ _: 'phone.discardGroupCall', call: { _: 'inputGroupCall', id: groupCall.id, access_hash: groupCall.access_hash } })
  }

  /** Putar audio/video lewat engine (mis. calls.play(call, 'lagu.mp3')). */
  async play(call: CorvusCall, source: string, opts: any = {}) {
    if (!this.engine || typeof this.engine.play !== 'function') throw new CorvusCallEngineMissing()
    return this.engine.play(call, source, opts)
  }
}
