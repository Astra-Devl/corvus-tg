const { spawnSync } = require('child_process')
for (const f of ['features.js', 'mtproto-mock.js']) {
  const r = spawnSync(process.execPath, [require('path').join(__dirname, f)], { stdio: 'inherit' })
  if (r.status) process.exit(r.status)
}
