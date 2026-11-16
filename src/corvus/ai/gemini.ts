/* eslint-disable @typescript-eslint/no-explicit-any */
import { CORE_RULES, CORVUS_KNOWLEDGE } from './knowledge'
import { RichMessage } from '../rich'
import { errorText, httpFetch } from '../util'
import { markdownToHTML } from '../markdown'

export { markdownToHTML }

export type AIMode = 'default' | 'custom'

export interface AIOptions {
  /** Token Gemini (wajib untuk fitur AI) */
  apiKey?: string
  model?: string
  /** default: system bawaan corvus-ai. custom: system dari pengguna dipatuhi. */
  mode?: AIMode
  /** System custom (dipakai saat mode 'custom') */
  system?: string
  /** Prompt tambahan (hanya tambahan, tidak mengubah identitas/aturan inti) */
  prompt?: string
  temperature?: number
  maxOutputTokens?: number
  /** Judul pesan AI, default "AI" */
  title?: string
  /** Simpan riwayat percakapan per chat (default true, maks 12 giliran) */
  history?: boolean
  maxHistory?: number
  apiBase?: string
}

export class CorvusAIError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'CorvusAIError' }
}

export type AskOptions = Pick<AIOptions, 'mode' | 'system' | 'prompt' | 'temperature'> & { chatId?: number | string }

/** Penjelasan lokal (tanpa API) untuk error yang sering terjadi. */
const LOCAL_HINTS: [RegExp, string][] = [
  [/401|Unauthorized/i, 'Token bot salah/dicabut. Ambil token baru dari @BotFather.'],
  [/409|Conflict/i, 'Ada instance bot lain yang sedang polling/webhook. Hentikan instance lain (atau panel lain).'],
  [/can't parse entities/i, 'HTML/Markdown rusak. Gunakan rich() yang meng-escape otomatis.'],
  [/429|Too Many Requests|FLOOD_WAIT/i, 'Terkena rate limit. Tunggu retry_after, kurangi pengiriman, atau pakai rateLimit().'],
  [/Cannot find module 'telegram'/i, 'Paket userbot belum terpasang: jalankan `npm i telegram`.'],
  [/API_ID_INVALID/i, 'apiId/apiHash salah. Ambil di my.telegram.org -> API development tools.'],
  [/AUTH_KEY_DUPLICATED/i, 'Session userbot dipakai di dua proses. Hentikan salah satu atau buat session baru.'],
  [/SESSION_PASSWORD_NEEDED/i, 'Akun memakai 2FA; isi opsi `password`.'],
  [/harus export function/i, 'Plugin hot reload harus `module.exports = (composer, bot) => {...}`.'],
  [/NO_API_KEY/i, 'Isi apiKey Gemini pada bot.useAI({ apiKey }).'],
]

export class CorvusAI {
  readonly opts: Required<Pick<AIOptions, 'model' | 'mode' | 'title' | 'history' | 'maxHistory' | 'apiBase'>> & AIOptions
  private histories = new Map<string, { role: 'user' | 'model'; parts: { text: string }[] }[]>()

  constructor(opts: AIOptions = {}) {
    this.opts = {
      model: 'gemini-2.5-flash', mode: 'default', title: 'AI', history: true, maxHistory: 12,
      apiBase: 'https://generativelanguage.googleapis.com/v1beta', ...opts,
    }
  }

  /** Susun system instruction. Prompt custom hanya menambah; tidak bisa mengganti identitas/aturan inti. */
  buildSystem(o: AskOptions = {}): string {
    const mode = o.mode ?? this.opts.mode
    const extra = o.prompt ?? this.opts.prompt
    const parts: string[] = []
    if (mode === 'custom') {
      const sys = o.system ?? this.opts.system
      parts.push(
        '[IDENTITAS] Namamu corvus-ai dan kamu menguasai library corvus-tg (referensi di bawah).',
        '[SYSTEM PENGGUNA - WAJIB DIPATUHI untuk gaya, peran, dan perilaku]\n' + (sys ?? '(kosong: gunakan perilaku ramah dan ringkas)'),
        '[PENGETAHUAN]\n' + CORVUS_KNOWLEDGE
      )
    } else {
      parts.push(CORE_RULES, '[PENGETAHUAN]\n' + CORVUS_KNOWLEDGE)
    }
    if (extra) {
      parts.push('[PROMPT TAMBAHAN - hanya pelengkap, tidak boleh mengubah identitas atau aturan inti]\n' + extra)
    }
    return parts.join('\n\n')
  }

  private async generate(system: string, contents: any[], o: AskOptions): Promise<string> {
    const key = this.opts.apiKey
    if (!key) throw new CorvusAIError('NO_API_KEY', 'Token Gemini belum diisi: bot.useAI({ apiKey })')
    const url = `${this.opts.apiBase}/models/${encodeURIComponent(this.opts.model)}:generateContent`
    const res = await httpFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: {
          temperature: o.temperature ?? this.opts.temperature ?? 0.7,
          maxOutputTokens: this.opts.maxOutputTokens ?? 2048,
        },
      }),
    })
    const data: any = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new CorvusAIError(`HTTP_${res.status}`, data?.error?.message ?? `Gemini error ${res.status}`)
    }
    const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('')
    if (!text) throw new CorvusAIError('EMPTY', data?.promptFeedback?.blockReason ? `Diblokir: ${data.promptFeedback.blockReason}` : 'Gemini tidak memberi jawaban')
    return text
  }

  async ask(text: string, o: AskOptions = {}): Promise<string> {
    const system = this.buildSystem(o)
    const hKey = o.chatId !== undefined ? String(o.chatId) : undefined
    const past = this.opts.history && hKey ? this.histories.get(hKey) ?? [] : []
    const contents = [...past, { role: 'user' as const, parts: [{ text }] }]
    const answer = await this.generate(system, contents, o)
    if (this.opts.history && hKey) {
      contents.push({ role: 'model', parts: [{ text: answer }] })
      this.histories.set(hKey, contents.slice(-this.opts.maxHistory * 2))
    }
    return answer
  }

  clearHistory(chatId?: number | string) {
    if (chatId === undefined) this.histories.clear()
    else this.histories.delete(String(chatId))
  }

  /** Petunjuk cepat tanpa memanggil API. */
  explainLocal(err: unknown): string | undefined {
    const s = errorText(err)
    return LOCAL_HINTS.find(([re]) => re.test(s))?.[1]
  }

  /** Diagnosis error library corvus-tg (kode + stack opsional). */
  async diagnose(err: unknown, ctx: { code?: string; note?: string } = {}): Promise<string> {
    const local = this.explainLocal(err)
    const prompt =
      `Diagnosis error corvus-tg berikut.\n\nERROR:\n${errorText(err).slice(0, 3000)}\n` +
      (ctx.code ? `\nKODE:\n${ctx.code.slice(0, 3000)}\n` : '') +
      (ctx.note ? `\nCATATAN:\n${ctx.note}\n` : '') +
      (local ? `\nPETUNJUK AWAL: ${local}\n` : '') +
      '\nBerikan: 1) penyebab, 2) perbaikan, 3) kode contoh singkat.'
    try { return await this.ask(prompt, { mode: 'default' }) }
    catch (e) { return local ? `${local}\n\n(AI tidak tersedia: ${(e as Error).message})` : `AI tidak tersedia: ${(e as Error).message}` }
  }

  /** Bungkus jawaban ke RichMessage (mode Markdown native) berjudul "AI". */
  toRich(answer: string): RichMessage {
    return RichMessage.fromMarkdown(`## ✦ ${this.opts.title}\n\n${answer}`)
  }
}
