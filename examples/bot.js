// node examples/bot.js   (BOT_TOKEN, GEMINI_KEY di environment)
const { Corvus, logger, rateLimit } = require('corvus-tg')

const bot = new Corvus(process.env.BOT_TOKEN)
bot.use(logger(), rateLimit({ window: 3000, limit: 4 }))

if (process.env.GEMINI_KEY) {
  bot.useAI({ apiKey: process.env.GEMINI_KEY, mode: 'default', prompt: 'Jawab singkat.' })
  bot.aiCatch(process.env.OWNER_ID) // error otomatis didiagnosis corvus-ai
}

// Semua file di ./plugins di-reload otomatis saat disimpan, tanpa restart.
bot.hotReload({ dir: './examples/plugins' })

bot.launch().then(() => console.log('corvus-tg jalan'))
process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
