// (tidak perlu paket tambahan)   (apiId & apiHash dari my.telegram.org)
const { Corvus } = require('corvus-tg')
const bot = new Corvus(process.env.BOT_TOKEN)
const ub = bot.createUserbot({ apiId: +process.env.API_ID, apiHash: process.env.API_HASH, sessionFile: './ub.session', phone: process.env.PHONE })

ub.onMessage(/^\.ping$/, (m) => m.reply('pong'))
ub.calls.on('incoming', (call) => { console.log('panggilan masuk'); call.accept() })
ub.calls.on('ready', (info) => console.log('call siap, relay:', info.connections.length))

ub.start().then(() => console.log('userbot login sebagai', ub.me.username))
// panggil: const call = await ub.calls.start('@username', { video: false })
