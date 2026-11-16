/* eslint-disable @typescript-eslint/no-explicit-any */
import { Telegraf } from '../telegraf'
import { CorvusContext } from './context'
import { AIOptions, CorvusAI } from './ai/gemini'
import { HotLoader, HotReloadOptions } from './loader'
import { CorvusUserbot, UserbotOptions } from './userbot'
import { RichInput, RichMessage, editRich, sendNativeChecklist, sendRich, sendRichDraft } from './rich'
import { errorText } from './util'

/**
 * Corvus = Telegraf + rich message, hot reload, AI, userbot, call.
 * Semua API Telegraf tetap tersedia.
 */
export class Corvus<C extends CorvusContext = CorvusContext> extends Telegraf<C> {
  ai?: CorvusAI
  loader?: HotLoader
  userbot?: CorvusUserbot
  declare telegram: Telegraf<C>['telegram'] & {
    sendRichMessage(chatId: number | string, input: RichInput, extra?: any): Promise<any>
    editRichMessage(chatId: number | string, messageId: number, input: RichInput, extra?: any): Promise<any>
    sendRichMessageDraft(chatId: number, draftId: number, input: RichInput, opts?: any): Promise<any>
    sendNativeChecklist(bcId: string, chatId: number, title: string, tasks: string[], extra?: any): Promise<any>
    richFromUrl(chatId: number | string, url: string, extra?: any): Promise<any>
    aiMessage(chatId: number | string, prompt: string, opts?: any): Promise<any>
  }

  constructor(
    token: string,
    options?: Partial<Telegraf.Options<C>> & { ai?: AIOptions }
  ) {
    const { ai, ...rest } = options ?? {}
    super(token, { ...rest, contextType: (rest as any).contextType ?? CorvusContext } as any)
    const tg: any = this.telegram
    tg.sendRichMessage = (chatId: any, input: RichInput, extra?: any) => sendRich(tg, chatId, input, extra)
    tg.editRichMessage = (chatId: any, id: number, input: RichInput, extra?: any) => editRich(tg, chatId, id, input, extra)
    tg.sendRichMessageDraft = (chatId: number, draftId: number, input: RichInput, o?: any) => sendRichDraft(tg, chatId, draftId, input, o)
    tg.sendNativeChecklist = (bc: string, chatId: number, title: string, tasks: string[], extra?: any) =>
      sendNativeChecklist(tg, bc, chatId, title, tasks, extra)
    tg.richFromUrl = async (chatId: any, url: string, extra?: any) =>
      sendRich(tg, chatId, await RichMessage.fromUrl(url), extra)
    tg.aiMessage = async (chatId: any, prompt: string, o: any = {}) => {
      if (!this.ai) throw new Error('Panggil bot.useAI({ apiKey }) dulu')
      return sendRich(tg, chatId, this.ai.toRich(await this.ai.ask(prompt, { chatId, ...o })), o.extra)
    }
    if (ai) this.useAI(ai)
  }

  /** Aktifkan folder plugin dengan hot reload. Pasang di urutan middleware yang diinginkan. */
  hotReload(opts: HotReloadOptions | string) {
    const o = typeof opts === 'string' ? { dir: opts } : opts
    this.loader = new HotLoader(this, o)
    this.use(this.loader.middleware() as any)
    // start() async tetapi middleware sudah aktif; plugin pertama termuat sebelum polling dimulai
    this.loaderReady = this.loader.start().then(() => undefined)
    return this
  }
  private loaderReady?: Promise<void>

  /** Aktifkan corvus-ai (Gemini). Wajib apiKey Gemini. */
  useAI(opts: AIOptions) {
    this.ai = new CorvusAI(opts)
    ;(this.context as any).corvusAI = this.ai
    return this.ai
  }

  /** Buat userbot MTProto (butuh `npm i telegram`). Panggil `await userbot.start()`. */
  createUserbot(opts: UserbotOptions) {
    this.userbot = new CorvusUserbot(opts)
    ;(this.context as any).userbot = this.userbot
    return this.userbot
  }

  /** Error handler: diagnosis otomatis oleh corvus-ai, dikirim ke chat owner (dan dilog). */
  aiCatch(ownerChatId?: number | string, extraHandler?: (err: unknown, ctx: C) => any) {
    return this.catch(async (err, ctx) => {
      console.error('[corvus] error:', errorText(err))
      try {
        if (this.ai && ownerChatId !== undefined) {
          const text = await this.ai.diagnose(err, { note: `update: ${ctx.updateType}` })
          await sendRich(this.telegram, ownerChatId, this.ai.toRich(text))
        } else {
          const hint = CorvusAI.prototype.explainLocal.call({}, err)
          if (hint) console.error('[corvus] hint:', hint)
        }
      } catch (e) { console.error('[corvus] gagal diagnosis:', errorText(e)) }
      await extraHandler?.(err, ctx)
    })
  }

  /** Jalankan bot setelah plugin pertama termuat. */
  async launch(...args: any[]): Promise<void> {
    await this.loaderReady
    return (super.launch as any)(...args)
  }

  stop(reason?: string) {
    void this.loader?.stop()
    void this.userbot?.stop()
    return super.stop(reason)
  }
}
