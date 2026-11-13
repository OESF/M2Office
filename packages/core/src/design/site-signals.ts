/**
 * @file 会社の Web サイトの公開のページから、見た目の手がかり（よく使う色・テーマの色の変数・書体・テーマの名前）を読む（仕様書 第46.4節）。
 *
 * 読むのはトップのページと、同じホストの CSS（3 つまで）だけ。ほかのホストへは取りに行かない。読んだ文は外部のデータであり、
 * 指示として読まない（不変則 I-6）。値の形（色・書体の名前）だけを取り出して推論に渡す。
 */

import { outboundFetch } from '../net/outbound.js';
import { toHex } from './tokens.js';

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 600_000;

/** 読んだ手がかり。 */
export interface SiteDesignSignals {
  /** よく使う色（多い順。白・黒・灰色に近いものも含む）。 */
  colors: { hex: string; count: number }[];
  /** テーマの色の変数（`--vk-color-primary` など。名前と値）。 */
  variables: { name: string; value: string }[];
  /** 書体の指定（多い順）。 */
  fonts: string[];
  /** テーマ（`wp-content/themes/〜`）の名前。 */
  theme: string | null;
  /** `theme.json` を持つか（ブロックのテーマの手がかり）。読めなければ `null`。 */
  themeJson: boolean | null;
}

async function get(url: string): Promise<string | null> {
  try {
    const res = await outboundFetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.text()).slice(0, MAX_BYTES);
  } catch {
    return null;
  }
}

/**
 * 公開のページの見た目の手がかりを読む。
 *
 * @returns 読めなければ `null`
 */
export async function readSiteSignals(siteUrl: string): Promise<SiteDesignSignals | null> {
  let base: URL;
  try { base = new URL(siteUrl); } catch { return null; }
  if (!/^https?:$/.test(base.protocol)) return null;
  const html = await get(base.toString());
  if (html === null) return null;
  const host = base.hostname.replace(/^www\./, '');
  const sheets = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)]
    .map((m) => /href=["']([^"']+)["']/.exec(m[0])?.[1])
    .filter((h): h is string => !!h)
    .map((h) => { try { return new URL(h.replace(/&amp;/g, '&'), base); } catch { return null; } })
    .filter((u): u is URL => !!u && u.hostname.replace(/^www\./, '') === host)
    // テーマの CSS を先に読む（プラグインの CSS より見た目を決めている）
    .sort((a, b) => Number(b.pathname.includes('/themes/')) - Number(a.pathname.includes('/themes/')));
  const css = [html.match(/<style[^>]*>[\s\S]*?<\/style>/gi)?.join('\n') ?? ''];
  for (const u of [...new Map(sheets.map((u) => [u.pathname, u])).values()].slice(0, 3)) {
    const t = await get(u.toString());
    if (t) css.push(t);
  }
  const all = css.join('\n');
  const counts = new Map<string, number>();
  for (const m of all.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\([^)]*\)/gi)) {
    const hex = toHex(m[0]);
    if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  const variables = new Map<string, string>();
  for (const m of all.matchAll(/(--[a-z0-9-]*(?:color|primary|accent|font)[a-z0-9-]*)\s*:\s*([^;}]{1,80})/gi)) {
    if (!variables.has(m[1]!)) variables.set(m[1]!, m[2]!.trim());
  }
  const fonts = new Map<string, number>();
  for (const m of all.matchAll(/font-family\s*:\s*([^;}]{1,200})/gi)) {
    const first = m[1]!.split(',')[0]!.replace(/["']/g, '').trim();
    if (first && !/^(inherit|initial|var\()/i.test(first)) fonts.set(first, (fonts.get(first) ?? 0) + 1);
  }
  const theme = /wp-content\/themes\/([a-z0-9_-]+)/i.exec(html)?.[1] ?? null;
  let themeJson: boolean | null = null;
  if (theme) {
    try {
      const res = await outboundFetch(new URL(`/wp-content/themes/${theme}/theme.json`, base).toString(), { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS) });
      themeJson = res.ok;
    } catch { themeJson = null; }
  }
  return {
    colors: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([hex, count]) => ({ hex, count })),
    variables: [...variables].slice(0, 40).map(([name, value]) => ({ name, value })),
    fonts: [...fonts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([f]) => f.slice(0, 60)),
    theme,
    themeJson,
  };
}
