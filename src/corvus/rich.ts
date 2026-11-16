/* eslint-disable @typescript-eslint/no-explicit-any */
import { markdownToHTML } from './markdown'
import { InputRichMessage, RICH_LIMITS, RichText } from './richapi'
import { escapeAttr, escapeHTML, httpFetch } from './util'

export type { InputRichMessage, RichMessageButton, RichText } from './richapi'
export type ChecklistItem = string | { text: RichText; done?: boolean }
type Align = 'left' | 'center' | 'right'

/** Helper RichText inline: rt.bold('x'), rt.url('label', 'https://...') */
export const rt = {
  bold: (text: RichText) => ({ type: 'bold', text }),
  italic: (text: RichText) => ({ type: 'italic', text }),
  underline: (text: RichText) => ({ type: 'underline', text }),
  strike: (text: RichText) => ({ type: 'strikethrough', text }),
  spoiler: (text: RichText) => ({ type: 'spoiler', text }),
  code: (text: RichText) => ({ type: 'code', text }),
  mark: (text: RichText) => ({ type: 'marked', text }),
  sub: (text: RichText) => ({ type: 'subscript', text }),
  sup: (text: RichText) => ({ type: 'superscript', text }),
  url: (text: RichText, url: string) => ({ type: 'url', text, url }),
  mention: (text: RichText, username: string) => ({ type: 'mention', text, username }),
  userMention: (text: RichText, user: { id: number | string }) => ({ type: 'text_mention', text, user }),
  time: (text: RichText, unix: number, format = 'wDT') => ({ type: 'date_time', text, unix_time: unix, date_time_format: format }),
  emoji: (id: string, alt: string) => ({ type: 'custom_emoji', custom_emoji_id: id, alternative_text: alt }),
  math: (expression: string) => ({ type: 'mathematical_expression', expression }),
  anchor: (name: string) => ({ type: 'anchor', name }),
  anchorLink: (text: RichText, name: string) => ({ type: 'anchor_link', text, anchor_name: name }),
}

const para = (text: RichText) => ({ type: 'paragraph', text })

/**
 * Builder Rich Message native (Bot API 10.1+: sendRichMessage).
 * Blok: heading, paragraph, details (folding), table, list/checklist, pre, blockquote, buttons, media, ...
 * Mode alternatif: markdown() / html() (tidak bisa dicampur dengan blok).
 */
export class RichMessage {
  blocks: any[] = []
  markup?: any
  private raw?: { markdown?: string; html?: string }
  private flags: { is_rtl?: boolean; skip_entity_detection?: boolean } = {}
  private media: { id: string; media: any }[] = []

  static fromMarkdown(md: string) { return new RichMessage().markdown(md) }
  static fromHTML(html: string) { return new RichMessage().html(html) }

  private guard() {
    if (this.raw) throw new Error('RichMessage: mode markdown/html tidak bisa dicampur dengan blok')
    return this
  }
  private push(b: any) { this.guard(); this.blocks.push(b); return this }

  /** Isi dengan Rich Markdown (GFM + ekstensi Telegram). */
  markdown(md: string, media?: { id: string; media: any }[]) {
    if (this.blocks.length) throw new Error('RichMessage: sudah ada blok')
    this.raw = { markdown: md }; if (media) this.media = media; return this
  }
  /** Isi dengan Rich HTML. */
  html(html: string, media?: { id: string; media: any }[]) {
    if (this.blocks.length) throw new Error('RichMessage: sudah ada blok')
    this.raw = { html }; if (media) this.media = media; return this
  }
  rtl(v = true) { this.flags.is_rtl = v; return this }
  noEntityDetection(v = true) { this.flags.skip_entity_detection = v; return this }

  /* ---------- teks ---------- */
  heading(text: RichText, size = 2) { return this.push({ type: 'heading', text, size }) }
  title(text: RichText, emoji = '') { return this.heading(emoji ? [emoji + ' ', text] : text, 1) }
  subtitle(text: RichText) { return this.heading(text, 3) }
  paragraph(text: RichText) { return this.push(para(text)) }
  text(text: RichText) { return this.paragraph(text) }
  footer(text: RichText) { return this.push({ type: 'footer', text }) }
  divider() { return this.push({ type: 'divider' }) }
  pre(code: string, language?: string) { return this.push({ type: 'pre', text: code, ...(language ? { language } : {}) }) }
  code(code: string, language?: string) { return this.pre(code, language) }
  math(expression: string) { return this.push({ type: 'mathematical_expression', expression }) }
  anchor(name: string) { return this.push({ type: 'anchor', name }) }
  link(label: RichText, url: string) { return this.paragraph(rt.url(label, url)) }
  spoiler(text: RichText) { return this.paragraph(rt.spoiler(text)) }

  quote(body: RichText | ((r: RichMessage) => any), credit?: RichText) {
    return this.push({ type: 'blockquote', blocks: this.sub(body), ...(credit ? { credit } : {}) })
  }
  pullquote(text: RichText, credit?: RichText) {
    return this.push({ type: 'pullquote', text, ...(credit ? { credit } : {}) })
  }

  /** Folding block: judul selalu tampak, isi bisa dilipat. Isi boleh berupa fungsi builder (blok bersarang). */
  fold(summary: RichText, body: RichText | RichText[] | ((r: RichMessage) => any), opts: { open?: boolean } = {}) {
    const blocks = Array.isArray(body) && body.every((x) => typeof x === 'string')
      ? (body as string[]).map(para) : this.sub(body as any)
    return this.push({ type: 'details', summary, blocks, ...(opts.open ? { is_open: true } : {}) })
  }

  private sub(body: RichText | ((r: RichMessage) => any)): any[] {
    if (typeof body === 'function') { const r = new RichMessage(); body(r); return r.blocks }
    return [para(body)]
  }

  /* ---------- daftar ---------- */
  list(items: RichText[], ordered: boolean | '1' | 'a' | 'A' | 'i' | 'I' = false) {
    const type = ordered === true ? '1' : ordered || undefined
    return this.push({
      type: 'list',
      items: items.map((it, i) => ({ blocks: [para(it)], ...(type ? { value: i + 1, type } : {}) })),
    })
  }

  /** Checklist dengan checkbox native (☐/☑). */
  checklist(items: ChecklistItem[], title?: RichText) {
    if (title) this.paragraph(rt.bold(title))
    return this.push({
      type: 'list',
      items: items.map((it) => {
        const o = typeof it === 'string' ? { text: it, done: false } : it
        return { blocks: [para(o.text)], has_checkbox: true, ...(o.done ? { is_checked: true } : {}) }
      }),
    })
  }

  /** key: value */
  fields(obj: Record<string, unknown>) {
    this.guard()
    for (const [k, v] of Object.entries(obj)) this.blocks.push(para([rt.bold(k), ': ' + String(v)]))
    return this
  }

  /** Tabel native. */
  table(
    headers: RichText[] | null, rows: unknown[][],
    opts: { bordered?: boolean; striped?: boolean; compact?: boolean; caption?: RichText; align?: Align[] } = {}
  ) {
    const cols = Math.max(headers?.length ?? 0, ...rows.map((r) => r.length))
    if (cols > RICH_LIMITS.tableColumns) throw new Error(`Tabel maksimal ${RICH_LIMITS.tableColumns} kolom`)
    const cell = (text: any, i: number, head = false) => ({
      text: typeof text === 'object' && text !== null ? text : String(text ?? ''),
      align: head ? 'center' : opts.align?.[i] ?? 'left', valign: 'middle', ...(head ? { is_header: true } : {}),
    })
    const cells = [
      ...(headers ? [headers.map((h, i) => cell(h, i, true))] : []),
      ...rows.map((r) => Array.from({ length: cols }, (_, i) => cell(r[i], i))),
    ]
    return this.push({
      type: 'table', cells,
      ...(opts.bordered !== false ? { is_bordered: true } : {}),
      ...(opts.striped ? { is_striped: true } : {}),
      ...(opts.compact ? { is_compact: true } : {}),
      ...(opts.caption ? { caption: opts.caption } : {}),
    })
  }

  /** Tombol di dalam pesan (1-8 per baris). Terima hasil Btn.cb()/Btn.url() (warna native/emoji). */
  buttons(buttons: any[], align: Align = 'left') {
    this.guard()
    for (let i = 0; i < buttons.length; i += RICH_LIMITS.buttonsPerRow) {
      this.blocks.push({ type: 'buttons', buttons: buttons.slice(i, i + RICH_LIMITS.buttonsPerRow), align })
    }
    return this
  }

  /* ---------- media (hanya URL http/https atau file_id) ---------- */
  photo(url: string, caption?: RichText, spoiler = false) {
    return this.push({ type: 'photo', photo: { type: 'photo', media: url, ...(spoiler ? { has_spoiler: true } : {}) }, ...(caption ? { caption: { text: caption } } : {}) })
  }
  video(url: string, caption?: RichText) {
    return this.push({ type: 'video', video: { type: 'video', media: url }, ...(caption ? { caption: { text: caption } } : {}) })
  }
  audio(url: string, caption?: RichText) {
    return this.push({ type: 'audio', audio: { type: 'audio', media: url }, ...(caption ? { caption: { text: caption } } : {}) })
  }
  map(latitude: number, longitude: number, zoom = 14, caption?: RichText) {
    return this.push({ type: 'map', location: { latitude, longitude }, zoom, ...(caption ? { caption: { text: caption } } : {}) })
  }
  /** Placeholder "Thinking…" (khusus sendRichMessageDraft) */
  thinking(text: RichText) { return this.push({ type: 'thinking', text }) }

  /** reply_markup (inline keyboard dsb.) */
  keyboard(markup: any) { this.markup = markup?.reply_markup ?? markup; return this }

  /* ---------- output ---------- */
  toInput(): InputRichMessage {
    const base: InputRichMessage = { ...this.flags }
    if (this.raw) { Object.assign(base, this.raw); if (this.media.length) base.media = this.media }
    else base.blocks = this.blocks
    return base
  }

  /** Cek batas resmi; mengembalikan daftar masalah (kosong = aman). */
  validate(): string[] {
    const out: string[] = []
    const n = this.blocks.reduce((s, b) => s + count(b), 0)
    if (n > RICH_LIMITS.blocks) out.push(`blok ${n} > ${RICH_LIMITS.blocks}`)
    const len = JSON.stringify(this.raw ?? this.blocks).length
    if (len > RICH_LIMITS.chars * 3) out.push('isi sangat panjang (batas 32.768 karakter)')
    if (depth(this.blocks) > RICH_LIMITS.depth) out.push(`kedalaman > ${RICH_LIMITS.depth}`)
    return out
  }

  /** Pecah per blok bila melewati batas (500 blok / ~30 ribu karakter) */
  toChunks(): InputRichMessage[] {
    if (this.raw) return [this.toInput()]
    const parts: any[][] = []
    let cur: any[] = [], nCur = 0, sCur = 0
    for (const b of this.blocks) {
      const n = count(b), s = JSON.stringify(b).length
      if (cur.length && (nCur + n > 450 || sCur + s > 30000)) { parts.push(cur); cur = []; nCur = 0; sCur = 0 }
      cur.push(b); nCur += n; sCur += s
    }
    parts.push(cur)
    return parts.map((blocks) => ({ ...this.flags, blocks }))
  }

  /* ---------- cadangan: HTML biasa (server Bot API tanpa sendRichMessage) ---------- */
  legacyBlocks(): string[] {
    if (this.raw?.markdown !== undefined) return [markdownToHTML(this.raw.markdown)]
    if (this.raw?.html !== undefined) return [this.raw.html]
    return this.blocks.map(blockHTML).filter((x) => x !== '')
  }
  toLegacyHTML() { return this.legacyBlocks().join('\n') }
  legacyKeyboard(): any {
    if (this.markup) return this.markup
    const rows = this.blocks.filter((b) => b.type === 'buttons').map((b) => b.buttons)
    return rows.length ? { inline_keyboard: rows } : undefined
  }

  /** Kartu dari URL: JSON -> tabel/field, HTML -> judul + deskripsi, teks -> kode. */
  static async fromUrl(url: string, opts: { timeoutMs?: number; maxRows?: number; images?: boolean } = {}) {
    if (!/^https?:\/\//i.test(url)) throw new Error('richFromUrl: hanya http(s) yang didukung')
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : undefined
    const t = setTimeout(() => ctl?.abort(), opts.timeoutMs ?? 10000)
    try {
      const res = await httpFetch(url, { signal: ctl?.signal, headers: { 'user-agent': 'corvus-tg' } })
      const type = String(res.headers.get('content-type') ?? '')
      const body = await res.text()
      const r = new RichMessage()
      const host = new URL(url).hostname
      if (type.includes('json')) {
        const data = JSON.parse(body)
        const flat = (v: any) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : v)
        if (Array.isArray(data) && data.length && typeof data[0] === 'object') {
          const keys = Object.keys(data[0]).slice(0, 6)
          r.title(host, '🌐').table(keys, data.slice(0, opts.maxRows ?? 10).map((o) => keys.map((k) => flat(o[k]))), { striped: true })
        } else if (data && typeof data === 'object' && !Array.isArray(data)) {
          r.title(host, '🌐').fields(Object.fromEntries(Object.entries(data).slice(0, 20).map(([k, v]) => [k, flat(v)])))
        } else r.title(host, '🌐').pre(JSON.stringify(data, null, 2).slice(0, 3000), 'json')
      } else if (type.includes('html')) {
        const meta = (re: RegExp) => re.exec(body)?.[1]?.trim()
        const title = meta(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)/i) ?? meta(/<title[^>]*>([^<]*)/i) ?? url
        const desc = meta(/<meta[^>]+(?:property=["']og:description["']|name=["']description["'])[^>]+content=["']([^"']*)/i)
        const img = meta(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)/i)
        r.title(decodeEntities(title), '🔗')
        if (opts.images && img && /^https?:\/\//i.test(img)) r.photo(img)
        if (desc) r.fold('Deskripsi', decodeEntities(desc), { open: true })
        r.link('Buka halaman', url)
      } else r.title(host, '🌐').pre(body.slice(0, 3000))
      return r
    } finally { clearTimeout(t) }
  }
}

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")

function count(b: any): number {
  let n = 1
  for (const x of b.blocks ?? []) n += count(x)
  for (const it of b.items ?? []) for (const x of it.blocks ?? []) n += 1 + count(x)
  for (const row of b.cells ?? []) n += row.length
  return n
}
function depth(bs: any[]): number {
  let d = 0
  for (const b of bs) {
    const inner = [...(b.blocks ?? []), ...(b.items ?? []).flatMap((i: any) => i.blocks ?? [])]
    d = Math.max(d, 1 + depth(inner))
  }
  return d
}

/* ---------- RichText / blok -> HTML Telegram biasa ---------- */
export function rtHTML(t: RichText | undefined): string {
  if (t === undefined || t === null) return ''
  if (typeof t === 'string') return escapeHTML(t)
  if (Array.isArray(t)) return t.map(rtHTML).join('')
  const inner = rtHTML(t.text)
  switch (t.type) {
    case 'bold': return `<b>${inner}</b>`
    case 'italic': return `<i>${inner}</i>`
    case 'underline': return `<u>${inner}</u>`
    case 'strikethrough': return `<s>${inner}</s>`
    case 'spoiler': return `<tg-spoiler>${inner}</tg-spoiler>`
    case 'code': return `<code>${inner}</code>`
    case 'url': return `<a href="${escapeAttr(t.url)}">${inner}</a>`
    case 'custom_emoji': return escapeHTML(t.alternative_text ?? '')
    case 'mathematical_expression': return `<code>${escapeHTML(t.expression)}</code>`
    default: return inner
  }
}
/** Teks mentah (tanpa format & tanpa escape) */
export function rtText(t: RichText | undefined): string {
  if (t === undefined || t === null) return ''
  if (typeof t === 'string') return t
  if (Array.isArray(t)) return t.map(rtText).join('')
  if (t.type === 'custom_emoji') return t.alternative_text ?? ''
  if (t.type === 'mathematical_expression') return t.expression ?? ''
  return rtText(t.text)
}
const plain = rtText

function blockHTML(b: any): string {
  switch (b.type) {
    case 'paragraph': return rtHTML(b.text)
    case 'heading': return `<b>${rtHTML(b.text)}</b>`
    case 'footer': return `<i>${rtHTML(b.text)}</i>`
    case 'divider': return '──────────'
    case 'pre': return b.language
      ? `<pre><code class="language-${escapeAttr(b.language)}">${escapeHTML(plain(b.text))}</code></pre>`
      : `<pre>${escapeHTML(plain(b.text))}</pre>`
    case 'mathematical_expression': return `<code>${escapeHTML(b.expression)}</code>`
    case 'blockquote': return `<blockquote>${b.blocks.map(blockHTML).join('\n')}${b.credit ? '\n— ' + rtHTML(b.credit) : ''}</blockquote>`
    case 'pullquote': return `<blockquote>${rtHTML(b.text)}${b.credit ? '\n— ' + rtHTML(b.credit) : ''}</blockquote>`
    case 'details': return `<blockquote expandable><b>${rtHTML(b.summary)}</b>\n${b.blocks.map(blockHTML).join('\n')}</blockquote>`
    case 'list': return b.items.map((it: any) =>
      `${it.has_checkbox ? (it.is_checked ? '☑' : '☐') : it.value ? it.value + '.' : '•'} ${it.blocks.map(blockHTML).join(' ')}`).join('\n')
    case 'table': {
      const rows: string[][] = b.cells.map((row: any[]) => row.map((c) => plain(c.text)))
      const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => [...(r[i] ?? '')].length)))
      const line = (r: string[]) => '│ ' + w.map((n, i) => (r[i] ?? '') + ' '.repeat(n - [...(r[i] ?? '')].length)).join(' │ ') + ' │'
      const bar = '├' + w.map((n) => '─'.repeat(n + 2)).join('┼') + '┤'
      return `<pre>${escapeHTML([line(rows[0]!), bar, ...rows.slice(1).map(line)].join('\n'))}</pre>`
    }
    case 'photo': case 'video': case 'audio': case 'animation': return `<a href="${escapeAttr(b[b.type]?.media ?? '')}">${escapeHTML(b.type)}</a>${b.caption ? ' ' + rtHTML(b.caption.text) : ''}`
    case 'map': return `📍 ${b.location.latitude}, ${b.location.longitude}`
    case 'thinking': return `<i>${rtHTML(b.text)}</i>`
    default: return ''
  }
}

export const rich = () => new RichMessage()
export type RichInput = RichMessage | string | ((r: RichMessage) => RichMessage | void)

export function toRich(input: RichInput): RichMessage {
  if (input instanceof RichMessage) return input
  const r = new RichMessage()
  if (typeof input === 'string') return r.text(input)
  const ret = input(r)
  return ret instanceof RichMessage ? ret : r
}

const unsupported = (e: any) => (e?.code ?? e?.response?.error_code) === 404 || /method not found/i.test(String(e?.description ?? e?.message))

function legacyChunks(r: RichMessage, limit = 4096): string[] {
  const out: string[] = []
  let cur = ''
  for (const b of r.legacyBlocks()) {
    const piece = b.length > limit ? b.slice(0, limit - 1) + '…' : b
    if (cur && cur.length + piece.length + 1 > limit) { out.push(cur); cur = '' }
    cur = cur ? cur + '\n' + piece : piece
  }
  if (cur) out.push(cur)
  return out.length ? out : ['​']
}

/**
 * Kirim lewat Bot API `sendRichMessage` (api.telegram.org/bot<TOKEN>/sendRichMessage).
 * Otomatis dipecah bila melewati batas. Bila server tidak mengenal method (404),
 * jatuh ke HTML biasa kecuali extra.fallback === false.
 */
export async function sendRich(tg: any, chatId: number | string, input: RichInput, extra: any = {}) {
  const r = toRich(input)
  const { fallback = true, ...rest } = extra
  const parts = r.toChunks()
  let msg: any
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1
    const params: any = { chat_id: chatId, rich_message: parts[i], ...rest }
    const markup = last ? rest.reply_markup ?? r.markup : undefined
    if (markup) params.reply_markup = markup; else delete params.reply_markup
    if (i > 0) { delete params.reply_parameters; delete params.message_effect_id }
    try { msg = await tg.callApi('sendRichMessage', params) } catch (e) {
      if (fallback && unsupported(e)) return sendLegacy(tg, chatId, r, rest)
      throw e
    }
  }
  return msg
}

async function sendLegacy(tg: any, chatId: number | string, r: RichMessage, rest: any) {
  const chunks = legacyChunks(r)
  let msg: any
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1
    const extra: any = { parse_mode: 'HTML', ...rest }
    const markup = last ? rest.reply_markup ?? r.legacyKeyboard() : undefined
    if (markup) extra.reply_markup = markup; else delete extra.reply_markup
    msg = await tg.sendMessage(chatId, chunks[i], extra)
  }
  return msg
}

/** Edit pesan rich lewat editMessageText + rich_message (tidak ada method editRichMessage). */
export async function editRich(tg: any, chatId: number | string, messageId: number, input: RichInput, extra: any = {}) {
  const r = toRich(input)
  const { fallback = true, ...rest } = extra
  const markup = rest.reply_markup ?? r.markup
  try {
    return await tg.callApi('editMessageText', {
      chat_id: chatId, message_id: messageId, rich_message: r.toChunks()[0], ...rest, ...(markup ? { reply_markup: markup } : {}),
    })
  } catch (e) {
    if (fallback && unsupported(e)) {
      return tg.editMessageText(chatId, messageId, undefined, legacyChunks(r)[0], { parse_mode: 'HTML', ...rest, ...(markup ? { reply_markup: markup } : {}) })
    }
    throw e
  }
}

/** Streaming draft (hanya chat privat). Selesai? kirim hasil akhir dengan sendRich. */
export function sendRichDraft(
  tg: any, chatId: number, draftId: number, input: RichInput,
  opts: { can_stop?: boolean; keep_on_stop?: boolean; message_thread_id?: number } = {}
) {
  if (!draftId) throw new Error('draftId harus bukan nol')
  return tg.callApi('sendRichMessageDraft', { chat_id: chatId, draft_id: draftId, rich_message: toRich(input).toChunks()[0], ...opts })
}

/** Untuk hasil inline query: { rich_message } (InputRichMessageContent). */
export const richContent = (input: RichInput) => ({ rich_message: toRich(input).toInput() })

/** Checklist native lama (sendChecklist, business). */
export function sendNativeChecklist(
  tg: any, businessConnectionId: string, chatId: number, title: string, tasks: string[], extra: any = {}
) {
  return tg.callApi('sendChecklist', {
    business_connection_id: businessConnectionId, chat_id: chatId,
    checklist: { title, tasks: tasks.map((text, i) => ({ id: i + 1, text })), ...extra.checklist }, ...extra.options,
  })
}
