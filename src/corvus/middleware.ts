/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs'

/** Anti-flood per user. */
export function rateLimit(o: { window?: number; limit?: number; onLimit?: (ctx: any) => any } = {}) {
  const windowMs = o.window ?? 3000
  const limit = o.limit ?? 3
  const hits = new Map<number, number[]>()
  return async (ctx: any, next: () => Promise<void>) => {
    const id = ctx.from?.id
    if (id === undefined) return next()
    const now = Date.now()
    const arr = (hits.get(id) ?? []).filter((t) => now - t < windowMs)
    arr.push(now)
    hits.set(id, arr)
    if (arr.length > limit) return o.onLimit?.(ctx)
    return next()
  }
}

/** Log update + durasi. */
export function logger(log: (s: string) => void = console.log) {
  return async (ctx: any, next: () => Promise<void>) => {
    const t = Date.now()
    await next()
    const who = ctx.from?.username ? '@' + ctx.from.username : ctx.from?.id ?? '-'
    log(`[corvus] ${ctx.updateType} dari ${who} (${Date.now() - t}ms)`)
  }
}

/** Hanya id tertentu yang boleh lewat. */
export function ownerOnly(ids: number | number[], onDeny?: (ctx: any) => any) {
  const set = new Set(Array.isArray(ids) ? ids : [ids])
  return (ctx: any, next: () => Promise<void>) =>
    ctx.from && set.has(ctx.from.id) ? next() : onDeny?.(ctx)
}

/** Store session berbasis file JSON untuk `session({ store })`. */
export function fileStore<T = any>(file: string) {
  let data: Record<string, T> = {}
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* file baru */ }
  let t: NodeJS.Timeout | undefined
  const flush = () => {
    clearTimeout(t as any)
    t = setTimeout(() => fs.writeFile(file, JSON.stringify(data), () => undefined), 200)
  }
  return {
    get: (k: string) => data[k],
    set: (k: string, v: T) => { data[k] = v; flush() },
    delete: (k: string) => { delete data[k]; flush() },
  }
}
