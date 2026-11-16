/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs'
import * as path from 'path'
import { httpFetch } from '../util'
import { SERVICE_TL } from './service.tl'
import { Schema } from './tl'

export interface SchemaOptions {
  /** Path ke api.tl lokal (prioritas tertinggi) */
  schemaFile?: string
  /** Folder cache (default ./.corvus-tg) */
  cacheDir?: string
  /** Layer, dipakai bila api.tl tidak memuat komentar "// LAYER N" */
  layer?: number
  urls?: string[]
  log?: (...a: any[]) => void
}

export const DEFAULT_SCHEMA_URLS = [
  'https://raw.githubusercontent.com/telegramdesktop/tdesktop/dev/Telegram/SourceFiles/mtproto/scheme/api.tl',
  'https://raw.githubusercontent.com/LonamiWebs/Telethon/v1/telethon_generator/data/api.tl',
]

function build(apiText: string, layer?: number) {
  const s = new Schema().load(SERVICE_TL)
  s.load(apiText)
  s.layer ??= layer
  return s
}

/**
 * Muat skema: service MTProto (tertanam) + api.tl resmi.
 * api.tl dicari di: opsi schemaFile -> cache -> unduh otomatis sekali lalu di-cache.
 */
export async function loadSchema(o: SchemaOptions = {}): Promise<Schema> {
  const log = o.log ?? (() => undefined)
  const bundled = path.join(__dirname, 'api.tl')
  const cache = path.join(o.cacheDir ?? path.join(process.cwd(), '.corvus-tg'), 'api.tl')
  for (const f of [o.schemaFile, cache, bundled]) {
    if (f && fs.existsSync(f)) {
      const s = build(fs.readFileSync(f, 'utf8'), o.layer)
      if (s.layer) { log('skema dari', f, 'layer', s.layer); return s }
      throw new Error(`${f} tidak memuat "// LAYER N". Isi opsi { layer } sesuai versi api.tl.`)
    }
  }
  const errs: string[] = []
  for (const url of o.urls ?? DEFAULT_SCHEMA_URLS) {
    try {
      const res = await httpFetch(url)
      if (!res.ok) { errs.push(`${url}: HTTP ${res.status}`); continue }
      const text = await res.text()
      const s = build(text, o.layer)
      if (!s.layer) { errs.push(`${url}: tanpa LAYER`); continue }
      fs.mkdirSync(path.dirname(cache), { recursive: true })
      fs.writeFileSync(cache, text)
      log('skema diunduh', url, 'layer', s.layer)
      return s
    } catch (e) { errs.push(`${url}: ${(e as Error).message}`) }
  }
  throw new Error(
    'api.tl (skema API Telegram) tidak ditemukan dan gagal diunduh.\n' +
    errs.join('\n') +
    `\nSolusi: simpan api.tl resmi di ${cache} atau berikan opsi { schemaFile }.`
  )
}

export { build as buildSchema }
