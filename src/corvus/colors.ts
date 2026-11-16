/* eslint-disable @typescript-eslint/no-explicit-any */
import * as MarkupApi from '../markup'

/**
 * Tombol berwarna.
 *
 * Telegram Bot API (>= 9.4) secara native hanya mendukung 3 warna tombol
 * lewat field `style`: primary (biru), success (hijau), danger (merah).
 * Warna lain (ungu, kuning, oranye, RGB/hex, dll) dirender memakai emoji
 * kotak berwarna sebagai penanda di depan teks tombol.
 *   mode 'auto'   : native jika warnanya cocok, selain itu emoji (default)
 *   mode 'native' : hanya style native (warna lain -> tanpa warna)
 *   mode 'emoji'  : selalu emoji
 */
export type NativeStyle = 'primary' | 'success' | 'danger'
export type ColorName =
  | 'blue' | 'green' | 'red' | 'purple' | 'yellow'
  | 'orange' | 'brown' | 'black' | 'white'
  | 'primary' | 'success' | 'danger'
export type ColorInput = ColorName | `#${string}` | [number, number, number]
export type ColorMode = 'auto' | 'native' | 'emoji'

interface Swatch { emoji: string; rgb: [number, number, number]; native?: NativeStyle }

const PALETTE: Record<string, Swatch> = {
  red: { emoji: '🟥', rgb: [221, 46, 68], native: 'danger' },
  orange: { emoji: '🟧', rgb: [244, 144, 12] },
  yellow: { emoji: '🟨', rgb: [253, 203, 88] },
  green: { emoji: '🟩', rgb: [120, 177, 89], native: 'success' },
  blue: { emoji: '🟦', rgb: [85, 172, 238], native: 'primary' },
  purple: { emoji: '🟪', rgb: [170, 142, 214] },
  brown: { emoji: '🟫', rgb: [193, 105, 79] },
  black: { emoji: '⬛', rgb: [49, 55, 61] },
  white: { emoji: '⬜', rgb: [230, 231, 232] },
}
const ALIAS: Record<string, string> = {
  primary: 'blue', success: 'green', danger: 'red',
  ungu: 'purple', kuning: 'yellow', hijau: 'green', merah: 'red',
  biru: 'blue', oranye: 'orange', coklat: 'brown', hitam: 'black', putih: 'white',
}

export function parseColor(c: ColorInput): [number, number, number] | undefined {
  if (Array.isArray(c)) return c
  if (typeof c === 'string' && c.startsWith('#')) {
    let h = c.slice(1)
    if (h.length === 3) h = h.split('').map((x) => x + x).join('')
    if (!/^[0-9a-f]{6}$/i.test(h)) return undefined
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as any
  }
  return undefined
}

export function resolveColor(color: ColorInput): { name: string; swatch: Swatch } {
  if (typeof color === 'string' && !color.startsWith('#')) {
    const name = ALIAS[color.toLowerCase()] ?? color.toLowerCase()
    const swatch = PALETTE[name]
    if (swatch) return { name, swatch }
  }
  const rgb = parseColor(color) ?? [85, 172, 238]
  const name = nearestName(rgb)
  return { name, swatch: PALETTE[name]! }
}

/** Cocokkan RGB ke nama warna lewat hue/saturasi/lightness (lebih akurat dari jarak RGB). */
function nearestName([r0, g0, b0]: [number, number, number]): string {
  const r = r0 / 255, g = g0 / 255, b = b0 / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  if (s < 0.18 || l < 0.1 || l > 0.92) return l < 0.5 ? 'black' : 'white'
  let h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h = (h * 60 + 360) % 360
  if (h < 12 || h >= 345) return l < 0.3 ? 'brown' : 'red'
  if (h < 40) return l < 0.42 ? 'brown' : 'orange'
  if (h < 70) return 'yellow'
  if (h < 170) return 'green'
  if (h < 255) return 'blue'
  return 'purple'
}

/** Terapkan warna ke sebuah tombol (inline maupun reply keyboard). */
export function paint<B extends { text: string }>(
  button: B, color?: ColorInput, mode: ColorMode = 'auto'
): B {
  if (color === undefined) return button
  const { swatch } = resolveColor(color)
  const out: any = { ...button }
  if (mode !== 'emoji' && swatch.native) out.style = swatch.native
  else if (mode !== 'native') out.text = `${swatch.emoji} ${button.text}`
  return out
}

type Opt = { color?: ColorInput; mode?: ColorMode; emoji?: string }
const mk = (base: any, o?: Opt | ColorInput) => {
  const opt: Opt = o && typeof o === 'object' && !Array.isArray(o) ? o : { color: o as ColorInput }
  const b = opt.emoji ? { ...base, icon_custom_emoji_id: opt.emoji } : base
  return paint(b, opt.color, opt.mode)
}

/** Pembuat tombol berwarna. Argumen terakhir: warna atau {color, mode}. */
export const Btn = {
  cb: (text: string, data: string, o?: Opt | ColorInput) =>
    mk({ text, callback_data: data }, o),
  url: (text: string, url: string, o?: Opt | ColorInput) =>
    mk({ text, url }, o),
  webApp: (text: string, url: string, o?: Opt | ColorInput) =>
    mk({ text, web_app: { url } }, o),
  switchInline: (text: string, query = '', o?: Opt | ColorInput) =>
    mk({ text, switch_inline_query: query }, o),
  switchInlineCurrent: (text: string, query = '', o?: Opt | ColorInput) =>
    mk({ text, switch_inline_query_current_chat: query }, o),
  copy: (text: string, copyText: string, o?: Opt | ColorInput) =>
    mk({ text, copy_text: { text: copyText } }, o),
  /** tombol reply keyboard biasa */
  text: (text: string, o?: Opt | ColorInput) => mk({ text }, o),
}

/** Susun tombol ke baris-baris. */
export function chunk<T>(items: T[], columns: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += columns) rows.push(items.slice(i, i + columns))
  return rows
}

/** Inline keyboard: terima 2D array, atau 1D array + opsi columns. */
export function colorKeyboard(buttons: any[][] | any[], opts: { columns?: number } = {}) {
  const rows = Array.isArray(buttons[0]) ? (buttons as any[][]) : chunk(buttons, opts.columns ?? 2)
  return MarkupApi.inlineKeyboard(rows)
}

/** Reply keyboard (keyboard biasa di bawah input). */
export function colorReplyKeyboard(buttons: any[][] | any[], opts: { columns?: number } = {}) {
  const rows = Array.isArray(buttons[0]) ? (buttons as any[][]) : chunk(buttons, opts.columns ?? 2)
  return MarkupApi.keyboard(rows as any).resize()
}
