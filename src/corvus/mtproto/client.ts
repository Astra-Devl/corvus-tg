/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from 'events'
import { RsaKey, rand, toBig } from './crypto'
import { SchemaOptions, loadSchema } from './schema'
import { MTProtoSender, RpcError } from './sender'
import { srpCheck } from './srp'
import { Schema } from './tl'
import { errorText, sleep } from '../util'

export { RpcError }

export const PROD_DCS: Record<number, string> = { 1: '149.154.175.53', 2: '149.154.167.51', 3: '149.154.175.100', 4: '149.154.167.91', 5: '91.108.56.130' }
export const TEST_DCS: Record<number, string> = { 1: '149.154.175.10', 2: '149.154.167.40', 3: '149.154.175.117' }

export interface ClientOptions extends SchemaOptions {
  apiId: number
  apiHash: string
  /** String session hasil session() */
  session?: string
  dc?: number
  testMode?: boolean
  deviceModel?: string
  systemVersion?: string
  appVersion?: string
  langCode?: string
  rsaKeys?: RsaKey[]
  autoReconnect?: boolean
  /** FLOOD_WAIT <= nilai ini (detik) ditunggu otomatis */
  floodSleepThreshold?: number
  requestTimeoutMs?: number
  /** Override alamat DC {id: host} (mis. untuk server uji/proxy) */
  hosts?: Record<number, string>
  port?: number
}

const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64u = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

/** Klien MTProto native corvus-tg (tanpa GramJS/grammY). */
export class MTClient extends EventEmitter {
  schema!: Schema
  sender!: MTProtoSender
  dcId: number
  me?: any
  private authKey?: Buffer
  private needInit = true
  private reconnecting = false
  private stopped = false
  users = new Map<string, { hash: bigint; username?: string }>()
  channels = new Map<string, { hash: bigint }>()
  usernames = new Map<string, string>()

  constructor(readonly opts: ClientOptions) {
    super()
    if (!opts.apiId || !opts.apiHash) throw new Error('apiId dan apiHash wajib (my.telegram.org)')
    this.dcId = opts.dc ?? 2
    this.on('error', (e) => this.log('error:', errorText(e))) // listener bawaan agar tidak crash
    if (opts.session) this.loadSession(opts.session)
  }

  private log = (...a: any[]) => { if (process.env.CORVUS_DEBUG) console.log('[corvus:mt]', ...a) }

  /* ---------- session ---------- */
  loadSession(s: string) {
    const m = /^cv1\.(.+)$/.exec(s.trim())
    if (!m) throw new Error('Format session tidak dikenal (harus berawalan "cv1.")')
    const j = JSON.parse(unb64u(m[1]!).toString('utf8'))
    this.dcId = j.dc; this.authKey = Buffer.from(j.key, 'base64')
    if (j.test) this.opts.testMode = true
  }
  session(): string {
    const key = this.sender?.authKey ?? this.authKey
    if (!key) return ''
    return 'cv1.' + b64u(Buffer.from(JSON.stringify({ dc: this.dcId, key: key.toString('base64'), test: !!this.opts.testMode })))
  }

  /* ---------- koneksi ---------- */
  private hostFor(dc: number) {
    const h = this.opts.hosts?.[dc] ?? (this.opts.testMode ? TEST_DCS : PROD_DCS)[dc]
    if (!h) throw new Error('DC tidak dikenal: ' + dc)
    return h
  }

  async connect() {
    this.stopped = false
    if (!this.schema) this.schema = await loadSchema({ ...this.opts, log: this.log })
    this.makeSender(this.authKey)
    await this.sender.connect()
    this.authKey = this.sender.authKey
    this.needInit = true
  }

  private makeSender(authKey?: Buffer) {
    this.sender?.removeAllListeners()
    this.sender = new MTProtoSender({
      schema: this.schema, host: this.hostFor(this.dcId), port: this.opts.port ?? 443, dcId: this.dcId,
      authKey, rsaKeys: this.opts.rsaKeys, requestTimeoutMs: this.opts.requestTimeoutMs, log: this.log,
    })
    this.sender.on('update', (u: any) => this.handleUpdates(u))
    this.sender.on('newSession', () => this.emit('newSession'))
    this.sender.on('transportError', (code: number) => {
      this.emit('error', new Error(code === -404 ? 'Server menolak auth key (-404): session tidak valid, hapus file session lalu login ulang' : `Transport error ${code}`))
    })
    this.sender.on('disconnected', () => void this.reconnect())
  }

  private async reconnect() {
    if (this.reconnecting || this.stopped || this.opts.autoReconnect === false) return
    this.reconnecting = true
    const pend = this.sender.takePending()
    for (let i = 0; !this.stopped; i++) {
      try {
        await sleep(Math.min(1000 * 2 ** i, 15000))
        await this.sender.connect()
        this.needInit = true
        this.sender.resubmit(pend)
        this.reconnecting = false
        this.emit('reconnected')
        void this.syncState().catch(() => undefined)
        return
      } catch (e) { this.log('reconnect gagal', errorText(e)) }
    }
    this.reconnecting = false
  }

  async disconnect() { this.stopped = true; this.sender?.disconnect() }

  private async switchDc(dc: number) {
    this.sender.disconnect()
    this.dcId = dc; this.authKey = undefined
    this.makeSender(undefined)
    await this.sender.connect()
    this.authKey = this.sender.authKey
    this.needInit = true
  }

  /* ---------- RPC ---------- */
  /** invoke({ _: 'messages.sendMessage', ... }) */
  async invoke<T = any>(req: any, retries = 3): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        const wrapped = this.needInit ? this.wrapInit(req) : req
        const res = await this.sender.send<T>(wrapped)
        this.needInit = false
        this.cache(res)
        return res
      } catch (e: any) {
        if (e instanceof RpcError && i < retries) {
          const th = this.opts.floodSleepThreshold ?? 60
          if (e.seconds !== undefined && e.seconds <= th) { await sleep((e.seconds + 1) * 1000); continue }
          if (e.migrateTo) { await this.switchDc(e.migrateTo); continue }
        }
        throw e
      }
    }
  }

  private wrapInit(req: any) {
    const o = this.opts
    return {
      _: 'invokeWithLayer', layer: this.schema.layer,
      query: {
        _: 'initConnection', api_id: o.apiId,
        device_model: o.deviceModel ?? 'corvus-tg', system_version: o.systemVersion ?? process.platform,
        app_version: o.appVersion ?? '1.0.0', system_lang_code: o.langCode ?? 'id',
        lang_pack: '', lang_code: o.langCode ?? 'id', query: req,
      },
    }
  }

  /** Proxy: client.api.messages.getHistory({...}) */
  get api(): any {
    const mk = (path: string[]): any =>
      new Proxy(() => undefined, {
        get: (_t, k: string) => mk([...path, k]),
        apply: (_t, _s, args) => this.invoke({ _: path.join('.'), ...(args[0] ?? {}) }),
      })
    return mk([])
  }

  /* ---------- login ---------- */
  async isAuthorized() {
    try { this.me = (await this.invoke({ _: 'users.getUsers', id: [{ _: 'inputUserSelf' }] }))[0]; return this.me?._ === 'user' }
    catch (e: any) { if (e instanceof RpcError && /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED/.test(e.errorMessage)) return false; throw e }
  }

  async login(o: {
    phone?: string | (() => string | Promise<string>)
    code?: () => string | Promise<string>
    password?: string | (() => string | Promise<string>)
    botToken?: string
  }) {
    if (await this.isAuthorized()) return this.me
    const val = async (v: any) => (typeof v === 'function' ? v() : v)
    const api = { api_id: this.opts.apiId, api_hash: this.opts.apiHash }
    let auth: any
    if (o.botToken) {
      auth = await this.invoke({ _: 'auth.importBotAuthorization', flags: 0, ...api, bot_auth_token: o.botToken })
    } else {
      const phone = String(await val(o.phone)).replace(/[^\d+]/g, '')
      let sent = await this.invoke({ _: 'auth.sendCode', phone_number: phone, ...api, settings: { _: 'codeSettings' } })
      if (sent._ === 'auth.sentCodeSuccess') auth = sent.authorization
      for (let tries = 0; !auth; tries++) {
        if (tries > 5) throw new Error('Terlalu banyak percobaan kode')
        if (!o.code) throw new Error('Opsi `code` (fungsi) diperlukan')
        const code = String(await o.code()).trim()
        try {
          auth = await this.invoke({ _: 'auth.signIn', phone_number: phone, phone_code_hash: sent.phone_code_hash, phone_code: code })
        } catch (e: any) {
          if (!(e instanceof RpcError)) throw e
          if (e.errorMessage === 'SESSION_PASSWORD_NEEDED') { auth = await this.checkPassword(o.password); break }
          if (e.errorMessage === 'PHONE_CODE_EXPIRED') {
            sent = await this.invoke({ _: 'auth.resendCode', phone_number: phone, phone_code_hash: sent.phone_code_hash }); continue
          }
          if (e.errorMessage === 'PHONE_CODE_INVALID') { console.error('Kode salah, coba lagi.'); continue }
          throw e
        }
      }
    }
    if (auth._ === 'auth.authorizationSignUpRequired') throw new Error('Nomor ini belum terdaftar. Daftar dulu lewat aplikasi Telegram resmi.')
    this.me = auth.user
    return this.me
  }

  private async checkPassword(password: any) {
    for (let i = 0; i < 4; i++) {
      const pw = await (typeof password === 'function' ? password() : password)
      if (pw === undefined || pw === '') throw new Error('Akun memakai 2FA: isi opsi `password`')
      const info = await this.invoke({ _: 'account.getPassword' })
      try { return await this.invoke({ _: 'auth.checkPassword', password: srpCheck(info, String(pw)) }) }
      catch (e: any) {
        if (e instanceof RpcError && e.errorMessage === 'PASSWORD_HASH_INVALID' && typeof password === 'function') { console.error('Password salah.'); continue }
        throw e
      }
    }
    throw new Error('Password 2FA salah')
  }

  /* ---------- entity & peer ---------- */
  cache(obj: any, depth = 0) {
    if (!obj || typeof obj !== 'object' || Buffer.isBuffer(obj) || depth > 8) return
    if (Array.isArray(obj)) { for (const x of obj) this.cache(x, depth + 1); return }
    switch (obj._) {
      case 'user': if (obj.access_hash !== undefined) {
        this.users.set(String(obj.id), { hash: obj.access_hash, username: obj.username })
        if (obj.username) this.usernames.set(String(obj.username).toLowerCase(), String(obj.id))
      } break
      case 'channel': case 'channelForbidden': if (obj.access_hash !== undefined) this.channels.set(String(obj.id), { hash: obj.access_hash }); break
    }
    for (const k in obj) { const v = obj[k]; if (v && typeof v === 'object') this.cache(v, depth + 1) }
  }

  /** id numerik: user >0, chat <0, channel -100xxxxxxxxxx */
  async inputPeer(peer: any): Promise<any> {
    if (peer && typeof peer === 'object' && peer._) return peer
    if (peer === 'me' || peer === 'self') return { _: 'inputPeerSelf' }
    const s = String(peer)
    if (/^-?\d+$/.test(s)) {
      const id = BigInt(s)
      if (id > 0n) {
        const u = this.users.get(s)
        if (u) return { _: 'inputPeerUser', user_id: id, access_hash: u.hash }
        throw new Error(`Peer ${s} belum dikenal (belum pernah terlihat). Gunakan @username atau tunggu pesan dari user tersebut.`)
      }
      const abs = (-id).toString()
      if (abs.startsWith('100') && abs.length > 10) {
        const cid = abs.slice(3)
        const c = this.channels.get(cid)
        if (c) return { _: 'inputPeerChannel', channel_id: BigInt(cid), access_hash: c.hash }
        throw new Error(`Channel/grup ${s} belum dikenal.`)
      }
      return { _: 'inputPeerChat', chat_id: BigInt(abs) }
    }
    const name = s.replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '')
    const known = this.usernames.get(name.toLowerCase())
    if (known) return this.inputPeer(known)
    const r = await this.invoke({ _: 'contacts.resolveUsername', username: name })
    const p = r.peer
    if (p._ === 'peerUser') return this.inputPeer(String(p.user_id))
    if (p._ === 'peerChannel') return this.inputPeer('-100' + p.channel_id)
    return { _: 'inputPeerChat', chat_id: p.chat_id }
  }

  async inputUser(peer: any): Promise<any> {
    if (peer && typeof peer === 'object' && peer._) return peer
    if (peer === 'me' || peer === 'self') return { _: 'inputUserSelf' }
    const ip = await this.inputPeer(peer)
    if (ip._ !== 'inputPeerUser' && ip._ !== 'inputPeerSelf') throw new Error('Peer bukan user')
    return ip._ === 'inputPeerSelf' ? { _: 'inputUserSelf' } : { _: 'inputUser', user_id: ip.user_id, access_hash: ip.access_hash }
  }

  /** Kirim pesan teks. */
  async sendMessage(peer: any, text: string, o: { replyTo?: number; silent?: boolean; noWebpage?: boolean; entities?: any[] } = {}) {
    const fn = this.schema.byName.get('messages.sendMessage')
    const has = (n: string) => !!fn?.params.some((p) => p.name === n)
    const req: any = {
      _: 'messages.sendMessage', peer: await this.inputPeer(peer), message: text,
      random_id: toBig(rand(8)) - (1n << 63n), silent: o.silent, no_webpage: o.noWebpage, entities: o.entities,
    }
    if (o.replyTo) {
      if (has('reply_to')) req.reply_to = { _: 'inputReplyToMessage', reply_to_msg_id: o.replyTo }
      else req.reply_to_msg_id = o.replyTo
    }
    return this.invoke(req)
  }

  /* ---------- updates ---------- */
  async syncState() { return this.invoke({ _: 'updates.getState' }) }

  /** Isi cache entity dari daftar dialog. */
  async prefetchDialogs(limit = 100) {
    try {
      await this.invoke({ _: 'messages.getDialogs', offset_date: 0, offset_id: 0, offset_peer: { _: 'inputPeerEmpty' }, limit, hash: 0n })
    } catch (e) { this.log('prefetch dialog gagal', errorText(e)) }
  }

  private handleUpdates(u: any) {
    try {
      this.cache(u)
      switch (u._) {
        case 'updates': case 'updatesCombined': for (const x of u.updates) this.dispatchUpdate(x); break
        case 'updateShort': this.dispatchUpdate(u.update); break
        case 'updateShortMessage': this.emit('message', {
          _: 'message', out: u.out, id: u.id, message: u.message, date: u.date, entities: u.entities,
          peer_id: { _: 'peerUser', user_id: u.user_id },
          from_id: u.out ? { _: 'peerUser', user_id: this.me?.id } : { _: 'peerUser', user_id: u.user_id },
        }); break
        case 'updateShortChatMessage': this.emit('message', {
          _: 'message', out: u.out, id: u.id, message: u.message, date: u.date,
          peer_id: { _: 'peerChat', chat_id: u.chat_id }, from_id: { _: 'peerUser', user_id: u.from_id },
        }); break
        case 'updatesTooLong': void this.syncState().catch(() => undefined); break
      }
    } catch (e) { this.emit('error', e) }
  }

  private dispatchUpdate(x: any) {
    this.emit('update', x)
    if (x._ === 'updateNewMessage' || x._ === 'updateNewChannelMessage') this.emit('message', x.message)
    else if (x._ === 'updatePhoneCall') this.emit('phoneCall', x.phone_call)
  }
}
