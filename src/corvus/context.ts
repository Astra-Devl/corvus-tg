/* eslint-disable @typescript-eslint/no-explicit-any */
import { Context } from '../context'
import * as tg from '../core/types/typegram'
import { Deunionize } from '../core/helpers/deunionize'
import { CorvusAI, AskOptions, CorvusAIError } from './ai/gemini'
import { RichInput, RichMessage, editRich, sendRich, sendRichDraft, toRich } from './rich'
import type { CorvusUserbot } from './userbot'

export class CorvusContext<U extends Deunionize<tg.Update> = tg.Update> extends Context<U> {
  /** Diisi oleh bot.useAI() */
  declare corvusAI?: CorvusAI
  /** Diisi oleh bot.createUserbot() */
  declare userbot?: CorvusUserbot

  /** Balas di chat saat ini lewat Bot API sendRichMessage (fallback HTML bila server belum mendukung). */
  richMessage(input: RichInput, extra: any = {}) {
    return sendRich(this.telegram, this.chat!.id, input, extra)
  }

  sendRichMessage(chatId: number | string, input: RichInput, extra: any = {}) {
    return sendRich(this.telegram, chatId, input, extra)
  }

  /** Edit lewat editMessageText + rich_message. */
  editRichMessage(messageId: number, input: RichInput, extra: any = {}) {
    return editRich(this.telegram, this.chat!.id, messageId, input, extra)
  }

  /** Draft streaming (chat privat saja). Akhiri dengan richMessage() agar tersimpan. */
  richDraft(draftId: number, input: RichInput, opts: { can_stop?: boolean; keep_on_stop?: boolean } = {}) {
    return sendRichDraft(this.telegram, this.chat!.id, draftId, input, opts)
  }

  /** Kartu dari URL (JSON/HTML/teks). */
  async richFromUrl(url: string, extra: any = {}) {
    return this.richMessage(await RichMessage.fromUrl(url), extra)
  }

  private get ai(): CorvusAI {
    if (!this.corvusAI) {
      throw new CorvusAIError('NO_API_KEY', 'AI belum aktif. Panggil bot.useAI({ apiKey: GEMINI_TOKEN }) dulu.')
    }
    return this.corvusAI
  }

  /** Tanya corvus-ai (Gemini) lalu balas dengan pesan berjudul "AI". */
  async aiMessage(prompt: string, opts: AskOptions & { extra?: any } = {}) {
    const ai = this.ai
    await this.sendChatAction('typing').catch(() => undefined)
    const answer = await ai.ask(prompt, { chatId: this.chat?.id, ...opts })
    const r = ai.toRich(answer)
    try {
      return await this.richMessage(r, opts.extra)
    } catch (e: any) {
      if (!/parse entities/i.test(String(e?.message))) throw e
      return this.reply(`✦ ${ai.opts.title}\n\n${answer}`, opts.extra)
    }
  }

  /** Diagnosis error corvus-tg lalu kirim sebagai pesan AI. */
  async aiDiagnose(err: unknown, note?: string) {
    const answer = await this.ai.diagnose(err, { note })
    return this.richMessage(this.ai.toRich(answer))
  }

  clearAIHistory() { this.corvusAI?.clearHistory(this.chat?.id) }
}

export { toRich }
