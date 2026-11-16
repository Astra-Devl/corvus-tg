const { rich, rt, Btn } = require('corvus-tg')

module.exports = (composer) => {
  composer.command('rich', (ctx) =>
    ctx.richMessage(
      rich()
        .title('Laporan Harian', '📊')
        .text(['Halo ', rt.bold('dunia')])
        .table(['Nama', 'Skor'], [['Ani', 90], ['Budi', 75]], { striped: true })
        .fold('Detail', (r) => r.text('isi yang bisa dilipat').list(['satu', 'dua'], true))
        .checklist([{ text: 'Deploy', done: true }, 'Tulis docs'], 'Todo')
        .buttons([Btn.cb('Hijau', 'ok', 'green'), Btn.cb('Ungu', 'p', 'purple'), Btn.cb('Custom', 'c', '#ff6600')])
    )
  )
  composer.command('ai', (ctx) => ctx.aiMessage(ctx.payload || 'Apa itu corvus-tg?'))
  composer.action('ok', (ctx) => ctx.answerCbQuery('Hijau!'))
}
