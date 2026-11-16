# 🪶 corvus-tg

<div align="center">

**Framework bot Telegram modern dengan Rich Message, AI, Hot Reload, Userbot & Voice Call**

[![npm](https://img.shields.io/npm/v/corvus-tg?style=for-the-badge&logo=npm&color=cb3837)](https://www.npmjs.com/package/corvus-tg)
[![socket.dev](https://img.shields.io/badge/socket.dev-view-4a9eff?style=for-the-badge&logo=socketdotio)](https://socket.dev/npm/package/corvus-tg)
[![GitHub](https://img.shields.io/badge/github-Astra--Devl%2Fcorvus--tg-181717?style=for-the-badge&logo=github)](https://github.com/Astra-Devl/corvus-tg)
[![License](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)](LICENSE)

<br>

[**📦 NPM**](https://www.npmjs.com/package/corvus-tg) · [**🔒 Socket.dev**](https://socket.dev/npm/package/corvus-tg) · [**💻 GitHub**](https://github.com/Astra-Devl/corvus-tg)

</div>

---

## 📖 Tentang corvus-tg

**corvus-tg** adalah library framework untuk membangun bot Telegram yang **powerful**, **modern**, dan **developer-friendly**. Terinspirasi dari kemudahan Telegraf, tapi dengan fitur-fitur baru yang belum ada di library lain.

<table>
<tr>
<td width="50%" valign="top">

### ✨ Fitur Utama

- 🎨 **Rich Message** — tabel, checklist, folding, tombol berwarna
- 🤖 **AI Terintegrasi** — Gemini built-in + auto diagnosis error
- 🔥 **Hot Reload** — edit plugin, langsung aktif tanpa restart
- 👤 **Userbot** — kontrol akun Telegram pribadi (MTProto)
- 📞 **Voice Call** — panggilan suara/video + voice chat grup
- 🧩 **Middleware** — `logger`, `rateLimit`, `session`, `ownerOnly`
- 🎛️ **Tombol Berwarna** — keyboard inline dengan warna custom

</td>
<td width="50%" valign="top">

### 🎯 Cocok Untuk

- 🤖 Bot bisnis & customer service
- 📊 Bot laporan dengan tabel cantik
- 🧠 Bot AI & asisten pribadi
- 🎮 Bot game & interaktif
- 👥 Manajemen grup & komunitas
- 📞 Bot call center / voice chat

</td>
</tr>
</table>

---

## 🚀 Instalasi

### 📦 Via NPM

```bash
npm install corvus-tg@latest
```

<details>
<summary><b>Atau lewat package.json</b></summary>

```json
"dependencies": {
  "corvus-tg": "latest"
}
```
</details>

### 🐙 Via GitHub

```bash
npm install corvus-tg@github:Astra-Devl/corvus-tg
```

<details>
<summary><b>Atau lewat package.json</b></summary>

```json
"dependencies": {
  "corvus-tg": "github:Astra-Devl/corvus-tg"
}
```
</details>

---

## ⚡ Contoh Cepat

```js
const { Corvus, logger, rateLimit } = require('corvus-tg')

const bot = new Corvus(process.env.BOT_TOKEN)

bot.use(logger(), rateLimit({ window: 3000, limit: 4 }))
bot.start((ctx) => ctx.reply('Welcome'))
bot.command('start', (ctx) => ctx.reply('Halo dari corvus-tg 🪶'))
bot.help((ctx) => ctx.reply('Send me a sticker'))
bot.on(message('sticker'), (ctx) => ctx.reply('👍'))
bot.hears('hi', (ctx) => ctx.reply('Hey there'))
bot.action('help_menu', (ctx) => ctx.reply('hallo'))

bot.launch()
process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
```

---

## 🎨 Rich Message

Kirim pesan kaya dengan **tabel, checklist, folding, tombol berwarna** — semua dalam satu pesan.

<details open>
<summary><b>📋 Contoh Lengkap</b></summary>

```js
const { rich, rt, Btn } = require('corvus-tg')

await ctx.richMessage(
  rich()
    .title('Laporan Harian', '📊')
    .text(['Halo ', rt.bold('dunia'), ' — ', rt.url('docs', 'https://core.telegram.org/bots/api')])
    .table(['Nama', 'Skor'], [['Ani', 90], ['Budi', 75]], { striped: true })          // 📊 tabel
    .fold('Detail', (r) => r.text('isi yang bisa dilipat').list(['satu', 'dua'], true)) // 📂 folding block
    .checklist([{ text: 'Deploy', done: true }, 'Tulis docs'], 'Todo')                // ✅ checklist
    .pre('console.log("hi")', 'js')
    .divider()
    .buttons([Btn.cb('OK', 'ok', 'green'), Btn.cb('Ungu', 'p', 'purple')])             // 🔘 tombol dalam pesan
)
```
</details>

<details>
<summary><b>🔀 Mode Alternatif Pengiriman</b></summary>

```js
rich().markdown('# Halo\n- [x] selesai\n\n| A | B |\n|---|---|\n| 1 | 2 |')   // Rich Markdown
rich().html('<details><summary>Judul</summary>Isi</details>')                // Rich HTML
// ⚠️ mode markdown/html tidak bisa dicampur dengan blok

ctx.richMessage(rich, extra)              // balas di chat saat ini
ctx.sendRichMessage(chatId, rich, extra)  // kirim ke chat lain
ctx.editRichMessage(messageId, rich)      // editMessageText + rich_message
ctx.richDraft(1, rich().thinking('Berpikir…'), { can_stop: true })   // streaming draft (chat privat)
bot.telegram.sendRichMessage(chatId, rich)
await ctx.richFromUrl('https://api.example.com/data')               // kartu dari website: JSON/HTML/teks
```
</details>

<details>
<summary><b>🎨 Tombol Berwarna</b></summary>

```js
const { Btn, colorKeyboard } = require('corvus-tg')

await ctx.reply('Pilih warna:', colorKeyboard([
  Btn.cb('Hijau',  'g', 'green'),
  Btn.cb('Merah',  'r', 'red'),
  Btn.cb('Biru',   'b', 'blue'),
], { columns: 2 }))
```
</details>

---

## 🔥 Hot Reload

Edit plugin → simpan file → **langsung aktif**. Tanpa restart bot.

<details open>
<summary><b>📁 index.js (tidak ikut di-reload)</b></summary>

```js
const bot = new Corvus(process.env.BOT_TOKEN)
bot.hotReload({ dir: './plugins' })      // pasang sebelum handler lain agar urutan terjaga
bot.launch()
```
</details>

<details>
<summary><b>🧩 plugins/ping.js — simpan file, langsung aktif</b></summary>

```js
module.exports = (composer, bot) => {
  composer.command('ping', (ctx) => ctx.reply('pong 🏓'))

  const t = setInterval(() => console.log('tick'), 60_000)
  return () => clearInterval(t)          // (opsional) cleanup dipanggil saat reload/hapus
}
```
</details>

---

## 🤖 AI Terintegrasi

Powered by **Gemini** — balasan otomatis rapi, diagnosis error, dan penjelasan lokal tanpa API.

<details open>
<summary><b>💬 aiMessage & aiCatch</b></summary>

```js
bot.useAI({ apiKey: process.env.GEMINI_KEY, mode: 'default', prompt: 'Jawab singkat.' })

bot.command('ai', (ctx) => ctx.aiMessage(ctx.payload || 'Apa itu corvus-tg?'))
// → balasan berjudul "✦ AI" dalam rich message (tabel, daftar & kode dari Gemini tampil rapi)

bot.aiCatch(process.env.OWNER_ID)   // error runtime didiagnosis otomatis & dikirim ke owner

await ctx.aiMessage('Halo!', { mode: 'custom', system: 'Kamu kasir toko roti yang ramah.' })
```
</details>

<details>
<summary><b>🩺 Diagnosis Error</b></summary>

```js
const penjelasan = await bot.ai.diagnose(err, { code: kodeBermasalah })   // penyebab + perbaikan + contoh
bot.ai.explainLocal(err)                                                   // petunjuk instan tanpa API
await ctx.aiDiagnose(err)                                                  // kirim diagnosis ke chat
```
</details>

---

## 🧩 Middleware

```js
const { rateLimit, logger, ownerOnly, fileStore, session } = require('corvus-tg')

bot.use(logger())                                              // log update + durasi
bot.use(rateLimit({ window: 3000, limit: 3, onLimit: (ctx) => ctx.reply('Pelan-pelan 🐢') }))
bot.command('admin', ownerOnly([123456789], (ctx) => ctx.reply('Khusus owner')), (ctx) => ctx.reply('Halo bos'))
bot.use(session({ store: fileStore('./session.json') }))        // session tersimpan ke file JSON
```

---

## 👤 Userbot

Kontrol akun Telegram pribadi via **MTProto** — kirim pesan, RPC mentah, proxy.

<details open>
<summary><b>🔑 Setup & Handler</b></summary>

```js
const { Corvus } = require("corvus-tg")

const bot = new Corvus(config.bot.token)

const ub = bot.createUserbot({
  apiId: 123456,                   // dari https://my.telegram.org → API development tools
  apiHash: 'abcdef…',
  sessionFile: './ub.session',     // session "cv1…." tersimpan di sini
  phone: '+628123456789',
})

ub.onMessage(/^\.ping$/, (m) => m.reply('pong 🏓'))
ub.onMessage('halo', (m) => m.reply('hai!'))

await ub.start()                   // login lewat terminal: kode + (opsional) password 2FA
await ub.sendMessage('@username', 'Halo dari userbot')
await ub.invoke({ _: 'users.getUsers', id: [{ _: 'inputUserSelf' }] })   // RPC mentah apa pun
await ub.api.users.getUsers({ id: [{ _: 'inputUserSelf' }] })            // sintaks proxy
```
</details>

---

## 📞 Voice Call

Panggilan suara/video + voice chat grup.

<details open>
<summary><b>📲 Event & Kontrol</b></summary>

```js
ub.calls.on('incoming', (call) => call.accept())
ub.calls.on('ready', (info) => console.log('call siap', info.connections.length, 'relay'))
ub.calls.on('ended', () => console.log('selesai'))

const call = await ub.calls.start('@username', { video: false })   // panggil
await call.discard()                                                // akhiri

await ub.calls.createVoiceChat(chatId, { title: 'Ngobrol' })       // voice chat grup (signaling)
ub.calls.setEngine(engine)                                          // engine media (mis. ntgcalls)
```
</details>

---

## 🐛 Issues

Ada bug, saran, atau pertanyaan? Buka di **[GitHub Issues](https://github.com/Astra-Devl/corvus-tg/issues)** — kami responsif! 🚀

---

## 💖 Support

Kalau **corvus-tg** bermanfaat untukmu, dukung pengembangan berkelanjutan:

<div align="center">

[![Saweria](https://img.shields.io/badge/Saweria-Support-orange?style=for-the-badge&logo=ko-fi&logoColor=white)](https://-)

</div>

---

<div align="center">

**Made with ❤️ by [Astra-Devl](https://github.com/Astra-Devl)**

⭐ Jangan lupa **star** repo-nya kalau kamu suka!

[⬆️ Back to Top](#-corvus-tg)

</div>
