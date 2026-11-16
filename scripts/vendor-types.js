#!/usr/bin/env node
/**
 * Menanamkan tipe Bot API (dulu paket @telegraf/types) ke dalam repo corvus-tg:
 *   -> src/core/types/botapi/*.ts
 * Setelah dijalankan sekali, corvus-tg tidak lagi bergantung pada @telegraf/types.
 * Skrip ini hanya memakai modul bawaan Node.
 *
 *   node scripts/vendor-types.js                 unduh dari registry npm (diverifikasi hash-nya)
 *   node scripts/vendor-types.js --if-missing    lewati bila sudah ada (dipakai otomatis oleh `npm run build`)
 *   node scripts/vendor-types.js --from FILE|DIR tgz hasil `npm pack @telegraf/types`, atau folder paketnya
 */
'use strict'
const fs = require('fs')
const path = require('path')
const https = require('https')
const zlib = require('zlib')
const crypto = require('crypto')

const VERSION = '7.1.0'
const URL_TGZ = `https://registry.npmjs.org/@telegraf/types/-/types-${VERSION}.tgz`
const INTEGRITY = 'sha512-kGevOIbpMcIlCDeorKGpwZmdH7kHbqlk/Yj6dEpJMKEQw5lk0KVQY0OLXaCswy8GqlIVLd5625OB+rAntP9xVw=='
const OUT = path.join(__dirname, '..', 'src', 'core', 'types', 'botapi')

const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'corvus-tg-vendor' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume(); return resolve(get(res.headers.location, redirects - 1))
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} untuk ${url}`)) }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    }).on('error', reject)
  })
}

/** Pembaca tar minimal: kembalikan [{ name, data }] untuk file biasa. */
function untar(buf) {
  const files = []
  let off = 0
  let longName
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512)
    if (h.every((b) => b === 0)) break
    const str = (a, b) => h.toString('utf8', a, b).replace(/\0.*$/s, '')
    let name = str(0, 100)
    const prefix = str(345, 500)
    if (prefix) name = prefix + '/' + name
    const size = parseInt(str(124, 136).trim() || '0', 8)
    const type = String.fromCharCode(h[156] || 48)
    off += 512
    const data = buf.subarray(off, off + size)
    off += Math.ceil(size / 512) * 512
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/s, ''); continue }
    if (longName) { name = longName; longName = undefined }
    if (type === '0' || type === '\0') files.push({ name, data })
  }
  return files
}

function readDir(dir) {
  const out = []
  const walk = (d, rel) => {
    for (const n of fs.readdirSync(d)) {
      if (n === 'node_modules') continue
      const p = path.join(d, n), r = rel ? rel + '/' + n : n
      if (fs.statSync(p).isDirectory()) walk(p, r)
      else out.push({ name: 'package/' + r, data: fs.readFileSync(p) })
    }
  }
  walk(dir, '')
  return out
}

/** Ganti rujukan ke paket asli menjadi path relatif di dalam folder botapi. */
function rewrite(src, relFile) {
  const depth = relFile.split('/').length - 1
  const up = depth ? '../'.repeat(depth) : './'
  const body = src.replace(/(from\s+|import\s*\(\s*|require\s*\(\s*)(['"])@telegraf\/types(?:\/([\w\-./]+))?\2/g,
    (_m, pre, q, sub) => `${pre}${q}${up}${(sub || 'index').replace(/\.d\.ts$/, '')}${q}`)
  return `// Disalin dari @telegraf/types ${VERSION} (MIT) - tipe Bot API bawaan corvus-tg.\n// Jangan diedit manual; jalankan ulang scripts/vendor-types.js bila perlu.\n` + body
}

async function main() {
  if (flag('--if-missing') && fs.existsSync(path.join(OUT, 'index.ts'))) return
  let files
  const from = val('--from')
  if (from) {
    const st = fs.statSync(from)
    if (st.isDirectory()) files = readDir(from)
    else {
      const raw = fs.readFileSync(from)
      if (!flag('--no-verify')) {
        const h = 'sha512-' + crypto.createHash('sha512').update(raw).digest('base64')
        if (h !== INTEGRITY) throw new Error('Hash tgz tidak cocok dengan @telegraf/types@' + VERSION + ' (pakai --no-verify bila versi lain disengaja)')
      }
      files = untar(zlib.gunzipSync(raw))
    }
  } else {
    console.log('[vendor-types] mengunduh', URL_TGZ)
    const raw = await get(URL_TGZ).catch((e) => {
      throw new Error(`${e.message}\nTidak ada internet? Jalankan: npm pack @telegraf/types@${VERSION} di tempat lain, lalu\n  node scripts/vendor-types.js --from types-${VERSION}.tgz`)
    })
    const h = 'sha512-' + crypto.createHash('sha512').update(raw).digest('base64')
    if (h !== INTEGRITY) throw new Error('Verifikasi integritas GAGAL: file unduhan tidak sama dengan @telegraf/types@' + VERSION)
    files = untar(zlib.gunzipSync(raw))
  }
  // cari index.d.ts paling dangkal; foldernya dijadikan akar (mendukung layout "package/" maupun "package/dist/")
  const idx = files
    .filter((f) => /^package\/(?:.+\/)?index\.d\.ts$/.test(f.name))
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0]
  if (!idx) throw new Error('index.d.ts tidak ditemukan di paket')
  const base = idx.name.replace(/index\.d\.ts$/, '')
  const decl = files.filter((f) => f.name.startsWith(base) && /\.d\.ts$/.test(f.name))
  const map = new Map(decl.map((f) => [f.name.slice(base.length).replace(/\.d\.ts$/, ''), f.data.toString('utf8')]))

  // Hanya salin file yang terjangkau dari modul utama (menghindari file tak terpakai seperti default.ts yang
  // merujuk ke berkas yang tidak ikut terpasang).
  const ROOTS = ['index', 'api', 'inline', 'manage', 'markup', 'message', 'methods', 'passport', 'payment', 'settings', 'update']
  const keep = new Set()
  const missing = new Set()
  const visit = (key) => {
    if (keep.has(key) || missing.has(key)) return
    const src = map.get(key)
    if (src === undefined) { missing.add(key); return }
    keep.add(key)
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(key), m[1])).replace(/\.(d\.ts|js|ts)$/, ''))
    }
  }
  ROOTS.forEach((r) => map.has(r) && visit(r))
  if (missing.size) throw new Error('Berkas yang dirujuk tidak ada di paket: ' + [...missing].join(', '))
  const skipped = [...map.keys()].filter((k) => !keep.has(k))

  fs.mkdirSync(OUT, { recursive: true })
  for (const key of keep) {
    const rel = key + '.ts'
    const dest = path.join(OUT, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, rewrite(map.get(key), rel))
  }
  if (skipped.length) console.log('[vendor-types] dilewati (tidak terpakai):', skipped.join(', '))
  const lic = files.find((f) => /^package\/LICENSE/i.test(f.name))
  if (lic) fs.writeFileSync(path.join(OUT, 'LICENSE'), lic.data)
  console.log(`[vendor-types] ${keep.size} file ditanam ke ${path.relative(process.cwd(), OUT)}. Selesai, tanpa dependensi @telegraf/types.`)
}

main().catch((e) => { console.error('[vendor-types] ' + e.message); process.exit(1) })
