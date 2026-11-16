/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as readline from 'readline'
import { CorvusCalls } from './call'
import { ClientOptions, MTClient, RpcError } from './mtproto/client'

export { RpcError }

export interface UserbotOptions extends Omit<ClientOptions, 'session'> {
  /** String session (cv1....) */
  session?: string
  /** File penyimpan session (dibaca saat start, ditulis setelah login) */
  sessionFile?: string
  /** Nomor HP (+62...) atau fungsi; kosong -> tanya di terminal */
  phone?: string | (() => string | Promise<string>)
  password?: string | (() => string | Promise<string>)
  code?: () => string | Promise<string>
  /** Login sebagai bot lewat MTProto (opsional) */
  botToken?: string
  /** Muat daftar dialog saat start agar balasan ke user lama bisa langsung dikirim (default true) */
  prefetchDialogs?: boolean
}

export interface UserMessage {
  raw: any
  id: number
  text: string
  chatId: string
  senderId: string
  out: boolean
  reply: (text: string, extra?: any) => Promise<any>
}

type Filter = string | RegExp | ((m: UserMessage) => boolean)

const ask = (q: string) =>
  new Promise<string>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(q, (a) => { rl.close(); resolve(a.trim()) })
  })

const peerKey = (p: any): string =>
  !p ? '' : p._ === 'peerUser' ? String(p.user_id) : p._ === 'peerChat' ? '-' + p.chat_id : '-100' + p.channel_id

/** Userbot MTProto native (tanpa GramJS/grammY): implementasi MTProto 2.0 ada di corvus-tg. */
export class CorvusUserbot extends EventEmitter {
  client: MTClient
  me: any
  calls: CorvusCalls

  constructor(readonly opts: UserbotOptions) {
    super()
    let saved = opts.session ?? ''
    if (!saved && opts.sessionFile) {
      try { saved = fs.readFileSync(opts.sessionFile, 'utf8').trim() } catch { /* belum ada */ }
    }
    this.client = new MTClient({ ...opts, session: saved || undefined })
    this.client.on('error', (e) => this.emit('error', e))
    this.client.on('reconnected', () => this.emit('reconnected'))
    this.client.on('message', (m: any) => this.dispatch(m))
    this.calls = new CorvusCalls(this)
  }

  /** client.api.messages.getHistory({...}) -> RPC langsung */
  get api() { return this.client.api }
  invoke<T = any>(req: any) { return this.client.invoke<T>(req) }

  /** Login (jika perlu), simpan session, mulai menerima update. */
  async start() {
    const o = this.opts
    await this.client.connect()
    this.me = await this.client.login({
      phone: o.phone ?? (() => ask('Nomor HP (+62...): ')),
      code: o.code ?? (() => ask('Kode login Telegram: ')),
      password: o.password ?? (() => ask('Password 2FA (kosongkan bila tidak ada): ')),
      botToken: o.botToken,
    })
    this.saveSession()
    await this.client.syncState()           // wajib agar server mengirim update
    if (o.prefetchDialogs !== false && !o.botToken) await this.client.prefetchDialogs()
    this.calls.attach()
    this.emit('ready', this.me)
    return this
  }

  saveSession() {
    const s = this.client.session()
    if (this.opts.sessionFile && s) fs.writeFileSync(this.opts.sessionFile, s, { mode: 0o600 })
    return s
  }

  private wrap(m: any): UserMessage | undefined {
    if (m?._ !== 'message') return undefined
    const chatId = peerKey(m.peer_id)
    return {
      raw: m, id: m.id, text: m.message ?? '', chatId,
      senderId: m.from_id ? peerKey(m.from_id) : chatId, out: !!m.out,
      reply: (text, extra) => this.client.sendMessage(chatId, text, { replyTo: m.id, ...extra }),
    }
  }

  private dispatch(m: any) {
    const w = this.wrap(m)
    if (w) this.emit('message', w)
  }

  /** Handler pesan dengan filter: string (prefix), RegExp, atau fungsi. */
  onMessage(filter: Filter, handler?: (m: UserMessage, match?: RegExpExecArray | null) => any) {
    const fn: any = handler ?? filter
    const test: any = handler ? filter : () => true
    this.on('message', async (m: UserMessage) => {
      let match: RegExpExecArray | null = null
      const ok = typeof test === 'string' ? m.text.startsWith(test)
        : test instanceof RegExp ? !!(match = test.exec(m.text)) : test(m)
      if (!ok) return
      try { await fn(m, match) } catch (e) { this.emit('error', e) }
    })
    return this
  }

  sendMessage(peer: any, text: string, extra: any = {}) { return this.client.sendMessage(peer, text, extra) }
  getEntity(peer: any) { return this.client.inputPeer(peer) }
  /** Alias kompatibilitas */
  getInputEntity(peer: any): Promise<any> { return this.client.inputPeer(peer) }

  async stop() {
    try { this.saveSession() } catch { /* ignore */ }
    this.calls.detach()
    await this.client.disconnect()
  }
}
