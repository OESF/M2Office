/**
 * @file HTML から、題名・説明・見出し・本文の文字・同じサイトのリンクを取り出す（競合の分析。仕様書 第36.7節）。
 *
 * 取り出した文字は、事実を取り出す間だけ使い、残さない（残すのはページの印だけ）。
 */

import { createHash } from 'node:crypto';

/** 読んだページの中身（残さない）。 */
export interface PageContent {
  url: string;
  title: string;
  description: string;
  headings: string[];
  /** 本文の文字（余白を詰めたもの。上限 20,000 字） */
  text: string;
  /** 同じサイトの中のリンク（URL と、リンクの文字） */
  links: { url: string; label: string }[];
  /** ページの印（文字の指紋。変わったかを見る） */
  hash: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', yen: '¥', copy: '©' };

/** 文字参照をもとに戻す。 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const clean = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** 中身ごと除く要素（読むための文字が無い）。 */
const DROPPED = /<(script|style|noscript|svg|template|iframe)\b/gi;

/**
 * コメントと、中身ごと除く要素（スクリプト・スタイルなど）を空白に替える。
 *
 * @remarks 外のサイトの HTML（2 MB まで）を読むので、正規表現の `[\s\S]*?` で閉じを探さない。閉じの無いものが長く続くと、
 * 時間が長さの 2 乗で伸びるため（CodeQL の js/polynomial-redos。仕様書 第10.9.9節）。`indexOf` で前から 1 回なめる。閉じが無ければ終わりまで除く
 */
export function stripHidden(html: string): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  let pos = 0;
  // 次のコメントと次の要素の位置は、いまの位置より前になったときだけ探し直す（同じところを何度もなめない）
  let comment = -1; let commentFrom = -1;
  let tag: RegExpExecArray | null = null; let tagFrom = -1;
  while (pos < html.length) {
    if (commentFrom < 0 || (comment >= 0 && comment < pos)) { comment = lower.indexOf('<!--', pos); commentFrom = pos; }
    if (tagFrom < 0 || (tag && tag.index < pos)) { DROPPED.lastIndex = pos; tag = DROPPED.exec(lower); tagFrom = pos; }
    const next = tag && (comment < 0 || tag.index < comment) ? { at: tag.index, end: `</${tag[1]}` } : comment >= 0 ? { at: comment, end: '-->' } : null;
    if (!next) break;
    out.push(html.slice(pos, next.at), ' ');
    const close = lower.indexOf(next.end, next.at + 4);
    if (close < 0) { pos = html.length; break; }
    // 閉じのタグは `>` まで除く（`</script >` のような形も）
    pos = next.end === '-->' ? close + 3 : Math.max(close + next.end.length, lower.indexOf('>', close) + 1);
  }
  out.push(html.slice(pos));
  return out.join('');
}

/**
 * HTML を読む。
 *
 * @param url そのページの URL（リンクを絶対の URL にするため）
 */
export function readHtml(html: string, url: string): PageContent {
  const base = new URL(url);
  const noScript = stripHidden(html);
  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(noScript)?.[1] ?? '').slice(0, 200);
  const description = clean(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(noScript)?.[1]
    ?? /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(noScript)?.[1] ?? '').slice(0, 300);
  const headings = [...noScript.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => clean(m[1] ?? '')).filter(Boolean).slice(0, 40);
  const links: { url: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const m of noScript.matchAll(/<a\b[^>]*href=["']([^"'#]+)(?:#[^"']*)?["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let target: URL;
    try {
      target = new URL(decodeEntities(m[1]!.trim()), base);
    } catch {
      continue;
    }
    if (target.origin !== base.origin || !/^https?:$/.test(target.protocol)) continue;
    // 画像・資料などは読まない
    if (/\.(jpe?g|png|gif|webp|svg|pdf|zip|mp4|mp3|docx?|xlsx?|pptx?)$/i.test(target.pathname)) continue;
    target.hash = '';
    const key = target.toString();
    if (seen.has(key) || key === base.toString()) continue;
    seen.add(key);
    const label = (clean(m[2] ?? '') || clean(/(?:title|aria-label)=["']([^"']+)["']/i.exec(m[0])?.[1] ?? '')).slice(0, 60);
    links.push({ url: key, label });
    if (links.length >= 200) break;
  }
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(noScript)?.[1] ?? noScript;
  const text = clean(body.replace(/<(br|p|div|li|tr|h[1-6]|section|article)\b/gi, '\n<$1')).slice(0, 20_000);
  return { url, title, description, headings, text, links, hash: pageHash(text) };
}

/** ページの印（余白と数字以外の揺れを詰めた文字の指紋）。 */
export function pageHash(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 32);
}
