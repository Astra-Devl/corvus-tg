/* eslint-disable @typescript-eslint/no-explicit-any */

/** HTTP fetch: pakai global fetch (Node 18+) atau fallback ke node-fetch. */
export async function httpFetch(url: string, init?: any): Promise<any> {
  const g = (globalThis as any).fetch
  if (typeof g === 'function') return g(url, init)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('node-fetch')(url, init)
}

export function escapeHTML(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function escapeAttr(s: unknown): string {
  return escapeHTML(s).replace(/"/g, '&quot;')
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Import ESM dari kode CommonJS tanpa ditranspile menjadi require(). */
export const dynamicImport: (spec: string) => Promise<any> = new Function(
  'spec',
  'return import(spec)'
) as any

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`
  return String(err)
}
