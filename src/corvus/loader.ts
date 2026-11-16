/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { Composer } from '../composer'
import { dynamicImport, errorText } from './util'

export interface HotReloadOptions {
  /** Folder plugin. Tiap file .js/.cjs/.mjs = satu fitur. File berawalan "_" = helper (ubah -> reload semua). */
  dir: string
  /** Folder/file tambahan yang dipantau (ubah -> reload semua). */
  watch?: string[]
  /** Interval polling ms (polling bekerja stabil di Docker/Pterodactyl). Default 700. */
  interval?: number
  extensions?: string[]
  silent?: boolean
  onReload?: (file: string, status: 'loaded' | 'reloaded' | 'removed' | 'error', err?: unknown) => void
}

type Cleanup = () => void | Promise<void>
interface Entry { composer: Composer<any>; cleanup?: Cleanup }
type Snapshot = Map<string, string>

/**
 * Plugin: `module.exports = (composer, bot) => { composer.command('ping', ...) }`
 * (boleh return fungsi cleanup untuk timer/interval) atau `{ setup(composer, bot) }`.
 */
export class HotLoader {
  private entries = new Map<string, Entry>()
  private snap: Snapshot = new Map()
  private composed: (ctx: any, next: () => Promise<void>) => any = (_c, n) => n()
  private timer?: NodeJS.Timeout
  private busy = false
  private roots: string[]

  constructor(private bot: any, private opts: HotReloadOptions) {
    this.opts.interval ??= 700
    this.opts.extensions ??= ['.js', '.cjs', '.mjs']
    this.roots = [opts.dir, ...(opts.watch ?? [])].map((p) => path.resolve(p))
  }

  private log(msg: string) { if (!this.opts.silent) console.log(`[corvus:hot] ${msg}`) }

  middleware() { return (ctx: any, next: () => Promise<void>) => this.composed(ctx, next) }

  async start() {
    const dir = path.resolve(this.opts.dir)
    fs.mkdirSync(dir, { recursive: true })
    await this.tick(true)
    this.timer = setInterval(() => void this.tick(false), this.opts.interval)
    this.timer.unref?.()
    return this
  }

  async stop() {
    if (this.timer) clearInterval(this.timer)
    for (const e of this.entries.values()) await this.runCleanup(e)
    this.entries.clear()
    this.rebuild()
  }

  private walk(root: string, out: Snapshot) {
    let st: fs.Stats
    try { st = fs.statSync(root) } catch { return }
    if (st.isFile()) { out.set(root, `${st.mtimeMs}:${st.size}`); return }
    for (const name of fs.readdirSync(root)) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const p = path.join(root, name)
      const s = fs.statSync(p)
      if (s.isDirectory()) this.walk(p, out)
      else if (this.opts.extensions!.includes(path.extname(p))) out.set(p, `${s.mtimeMs}:${s.size}`)
    }
  }

  private isPlugin(file: string) {
    const dir = path.resolve(this.opts.dir)
    return file.startsWith(dir + path.sep) && !path.basename(file).startsWith('_')
  }

  private async tick(first: boolean) {
    if (this.busy) return
    this.busy = true
    try {
      const next: Snapshot = new Map()
      for (const r of this.roots) this.walk(r, next)
      const changed: string[] = []
      const removed: string[] = []
      for (const [f, sig] of next) if (this.snap.get(f) !== sig) changed.push(f)
      for (const f of this.snap.keys()) if (!next.has(f)) removed.push(f)
      this.snap = next
      if (!changed.length && !removed.length) return

      const reloadAll = [...changed, ...removed].some((f) => !this.isPlugin(f)) && !first
      this.purgeCache()
      for (const f of removed) {
        const e = this.entries.get(f)
        if (e) { await this.runCleanup(e); this.entries.delete(f); this.opts.onReload?.(f, 'removed'); this.log(`dihapus: ${path.relative(process.cwd(), f)}`) }
      }
      const targets = reloadAll
        ? [...next.keys()].filter((f) => this.isPlugin(f))
        : changed.filter((f) => this.isPlugin(f))
      for (const f of targets) await this.load(f, first)
      this.rebuild()
    } finally { this.busy = false }
  }

  private purgeCache() {
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}node_modules${path.sep}`)) continue
      if (this.roots.some((r) => key === r || key.startsWith(r + path.sep))) delete require.cache[key]
    }
  }

  private async runCleanup(e: Entry) {
    try { await e.cleanup?.() } catch (err) { this.log(`cleanup error: ${errorText(err)}`) }
  }

  private async load(file: string, first: boolean) {
    const rel = path.relative(process.cwd(), file)
    const prev = this.entries.get(file)
    try {
      const mod = file.endsWith('.mjs')
        ? await dynamicImport(`${pathToFileURL(file).href}?v=${Date.now()}`)
        : require(file)
      const def = mod?.default ?? mod
      const setup = typeof def === 'function' ? def : def?.setup
      if (typeof setup !== 'function') {
        throw new Error(`Plugin ${rel} harus export function (composer, bot) atau { setup }`)
      }
      const composer = new Composer<any>()
      const ret = await setup.call(def, composer, this.bot)
      if (prev) await this.runCleanup(prev)
      this.entries.set(file, { composer, cleanup: typeof ret === 'function' ? ret : undefined })
      const status = prev ? 'reloaded' : 'loaded'
      this.opts.onReload?.(file, status)
      this.log(`${first || !prev ? 'dimuat' : 'direload'}: ${rel}`)
    } catch (err) {
      this.opts.onReload?.(file, 'error', err)
      this.log(`GAGAL ${rel} (versi lama tetap dipakai): ${errorText(err)}`)
    }
  }

  private rebuild() {
    this.composed = Composer.compose([...this.entries.values()].map((e) => e.composer)) as any
  }
}
