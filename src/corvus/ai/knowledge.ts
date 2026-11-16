/** Basis pengetahuan bawaan corvus-ai tentang corvus-tg. Diperbarui bersama library. */
export const CORVUS_KNOWLEDGE = `
# corvus-tg
corvus-tg adalah fork Telegraf 4 (Node.js/TypeScript) dengan fitur tambahan. Semua API Telegraf
(Telegraf, Composer, Markup, Scenes, session, filters, format) tetap bisa dipakai. Class utama: Corvus (extends Telegraf).

## Dasar
const { Corvus } = require('corvus-tg')
const bot = new Corvus(process.env.BOT_TOKEN)
bot.command('start', ctx => ctx.reply('halo'))
bot.launch()

## richMessage (Bot API native: sendRichMessage, Bot API 10.1+)
const { rich, rt } = require('corvus-tg')
Mengirim lewat https://api.telegram.org/bot<TOKEN>/sendRichMessage dengan rich_message = InputRichMessage (blocks).
Builder blok: .title/.heading(text,size) .text/.paragraph .footer .divider .pre(code,lang) .math .quote .pullquote
 .list(items, ordered) .checklist([{text,done}], title) (checkbox native) .table(headers, rows, {striped,bordered,compact,caption,align})
 .fold(summary, body|fn(r), {open}) (blok details = folding) .buttons([Btn...], align) .photo/.video/.audio(url) .map(lat,lng,zoom)
 .fields(obj) .thinking(text) (khusus draft) .keyboard(markup)
Teks inline (RichText): string | array | rt.bold/italic/underline/strike/spoiler/code/mark/url/mention/time/emoji/math.
Mode alternatif: rich().markdown('# ...') atau rich().html('...') (tidak bisa dicampur dengan blok).
ctx.richMessage(rich|string|fn, extra) ; ctx.sendRichMessage(chatId, rich, extra) ; ctx.editRichMessage(msgId, rich) (editMessageText+rich_message)
ctx.richDraft(draftId, rich, {can_stop}) = sendRichMessageDraft (streaming, chat privat saja; akhiri dengan richMessage).
bot.telegram.sendRichMessage(chatId, rich, extra); RichMessage.fromUrl(url) -> kartu dari website (JSON/HTML/teks).
Batas: 32.768 karakter, 500 blok, kedalaman 16, 50 media, tabel maks 20 kolom, 1-8 tombol per baris. r.validate() mengecek batas.
Pesan terlalu besar dipecah otomatis. Bila server Bot API belum mengenal method (404) otomatis jatuh ke HTML biasa (fallback:false untuk mematikan).
Error umum: 404 Not Found pada sendRichMessage = server Bot API lama (self-hosted) -> perbarui atau pakai fallback.
Sel tabel hanya boleh teks inline; semua sel butuh align & valign (builder mengisi otomatis).

## Tombol berwarna
const { Btn, colorKeyboard } = require('corvus-tg')
Btn.cb(text, data, 'purple'|'yellow'|'green'|'blue'|'red'|'#ff8800'|[r,g,b]); Btn.url; Btn.webApp; Btn.copy
Telegram native hanya mendukung style primary(biru)/success(hijau)/danger(merah) (juga di .buttons() dalam rich message). Warna lain
(ungu, kuning, oranye, RGB, dll) dirender dengan emoji kotak berwarna (🟪🟨🟧...) sebagai prefix teks.
Opsi mode: 'auto' | 'native' | 'emoji'. ctx.reply('x', colorKeyboard([[Btn.cb('A','a','purple')]])).

## Hot reload (auto loader)
bot.hotReload({ dir: './plugins' }) -> pasang SEBELUM handler lain bila ingin urutan tertentu.
Tiap file plugin: module.exports = (composer, bot) => { composer.command('ping', ctx => ctx.reply('pong')) }
Boleh return fungsi cleanup (clearInterval, dll). File berawalan "_" = helper; ubah helper -> semua plugin reload.
Polling mtime, jadi aman untuk Pterodactyl/Docker. Jika file error, versi lama tetap berjalan dan error dilog.
File utama (yang memanggil new Corvus) TIDAK di-reload; taruh fitur di folder plugin.

## aiMessage (Gemini)
const bot = new Corvus(token); bot.useAI({ apiKey: GEMINI_KEY, model, mode: 'default'|'custom', system, prompt })
ctx.aiMessage('pertanyaan', { mode, system, prompt }) -> balasan berjudul "AI". 
mode default: system bawaan corvus-ai (tahu semua tentang corvus-tg); prompt hanya tambahan.
mode custom: system dari pengguna dipatuhi; tetap bernama corvus-ai dan tahu corvus-tg; prompt hanya tambahan.
bot.aiCatch(ownerChatId) -> error runtime didiagnosis otomatis oleh corvus-ai. ai.diagnose(err) untuk manual.
Tanpa apiKey Gemini fitur AI melempar error CorvusAIError('NO_API_KEY').

## Userbot (MTProto native, tanpa GramJS/grammY)
Implementasi MTProto 2.0 ada di dalam corvus-tg (src/corvus/mtproto): TL engine, AES-IGE, RSA, DH auth key,
msg_id/seqno/ack/salt, gzip, login kode + 2FA (SRP), reconnect, FLOOD_WAIT otomatis, DC migrate.
const ub = bot.createUserbot({ apiId, apiHash, sessionFile: './ub.session', phone: '+62...' })
await ub.start()   // login lewat terminal (kode/2FA), session "cv1...." tersimpan
ub.onMessage(/halo/i, m => m.reply('hai')); await ub.invoke({ _: 'messages.getHistory', ... }) atau ub.api.messages.getHistory({...})
ub.sendMessage('@user', 'teks'). Tidak perlu npm i telegram.
Skema API (api.tl) diunduh otomatis sekali ke ./.corvus-tg/api.tl (atau opsi schemaFile). Layer dibaca dari "// LAYER N".
Error umum: "api.tl ... gagal diunduh" (server tanpa internet: taruh api.tl manual di .corvus-tg/api.tl),
API_ID_INVALID (apiId/apiHash salah), AUTH_KEY_DUPLICATED (session dipakai dua proses), PHONE_CODE_INVALID,
PASSWORD_HASH_INVALID (2FA salah), "Konstruktor tidak dikenal" (api.tl tidak cocok dengan layer server),
-404 transport (session tidak valid: hapus file session dan login ulang). Debug: set env CORVUS_DEBUG=1.

## Call (voice & video)
ub.calls.start(userIdOrUsername, { video:true }) ; ub.calls.on('incoming', c => c.accept()); c.discard().
Bot API TIDAK bisa melakukan panggilan; call hanya lewat userbot (MTProto). corvus-tg mengurus signaling +
pertukaran kunci DH; audio/video memerlukan engine media (ub.calls.setEngine(engine), mis. ntgcalls).
Tanpa engine: panggilan berdering/tersambung secara signaling tetapi tidak ada media.

## Middleware tambahan
rateLimit({ window, limit }), logger(), ownerOnly([ids]), fileStore('./session.json') untuk session().

## Error umum
- 401 Unauthorized: token salah. - 409 Conflict: ada instance bot lain polling/webhook aktif.
- 400 can't parse entities: HTML/Markdown rusak; pakai RichMessage (escape otomatis).
- 429 Too Many Requests: tunggu retry_after. - 403: bot diblokir user / bukan admin.
- Plugin hot reload "harus export function": module.exports bukan function.
`

export const CORE_RULES = `
Kamu adalah corvus-ai, asisten AI resmi library corvus-tg. Jika ditanya namamu, jawab "corvus-ai".
Jawab dalam bahasa yang dipakai pengguna. Ringkas, akurat, dan siap dipakai di Telegram.
Jangan mengarang API corvus-tg yang tidak ada di pengetahuanmu; jika tidak yakin, katakan tidak yakin.
Saat diminta mendiagnosis error: sebutkan penyebab paling mungkin, lalu perbaikan konkret dengan contoh kode singkat.
Format keluaran: Markdown sederhana (**tebal**, \`kode\`, blok kode \`\`\`).
`
