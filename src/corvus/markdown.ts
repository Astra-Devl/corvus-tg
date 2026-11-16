/* eslint-disable @typescript-eslint/no-explicit-any */
import { escapeAttr, escapeHTML } from './util'

/** Markdown sederhana (gaya Gemini) -> HTML Telegram. */
export function markdownToHTML(md: string): string {
  const stash: string[] = []
  const hold = (html: string) => `\u0000${stash.push(html) - 1}\u0000`
  let s = md.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_m, lang, code) =>
    hold(lang
      ? `<pre><code class="language-${escapeAttr(lang)}">${escapeHTML(code.replace(/\n$/, ''))}</code></pre>`
      : `<pre>${escapeHTML(code.replace(/\n$/, ''))}</pre>`))
  s = s.replace(/`([^`\n]+)`/g, (_m, c) => hold(`<code>${escapeHTML(c)}</code>`))
  s = escapeHTML(s)
  s = s
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<i>$2</i>')
    .replace(/^\s*[*-]\s+/gm, '• ')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => stash[Number(i)]!)
}
