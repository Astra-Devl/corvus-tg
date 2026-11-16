/** Tipe Rich Messages Telegram Bot API 10.1+ (disusun dari dokumentasi resmi core.telegram.org/bots/api). */
export type RichText =
  | string
  | RichText[]
  | { type: string; text?: RichText; [k: string]: any }

export interface RichMessageButton {
  text: string
  /** danger (merah) | success (hijau) | primary (biru) | link (hanya bersama callback_data) */
  style?: 'danger' | 'success' | 'primary' | 'link'
  callback_data?: string
  url?: string
  [k: string]: any
}

export interface InputRichMessage {
  blocks?: any[]
  html?: string
  markdown?: string
  media?: { id: string; media: any }[]
  is_rtl?: boolean
  skip_entity_detection?: boolean
}

/** Batas resmi */
export const RICH_LIMITS = { chars: 32768, blocks: 500, depth: 16, media: 50, tableColumns: 20, buttonsPerRow: 8 }
