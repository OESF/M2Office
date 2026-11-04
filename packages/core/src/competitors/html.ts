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

/** タグの名前（`<` の直後から読む）。 */
const TAG_NAME = /(\/?)([a-zA-Z][a-zA-Z0-9]*)/y;

/** HTML の中のタグ 1 つ（`attrs` は名前の後ろの部分。4,096 字まで）。 */
interface Tag {
  name: string;
  close: boolean;
  attrs: string;
  /** `<` の位置。 */
  start: number;
  /** `>` の次の位置。 */
  end: number;
}

/**
 * HTML のタグを前から順に拾う。
 *
 * @remarks 外のサイトの HTML（2 MB まで）を読むので、正規表現で閉じを探さない（閉じの無い形が長く続くと、時間が長さの 2 乗で伸びる。
 * CodeQL の js/polynomial-redos。仕様書 第10.9.9節）。`<` と `>` を `indexOf` で 1 回なめる。次の `>` の位置は、いまの `<` より前になったときだけ探し直す
 */
function scanTags(html: string): Tag[] {
  const out: Tag[] = [];
  let pos = 0;
  let gt = -1;
  for (;;) {
    const lt = html.indexOf('<', pos);
    if (lt < 0) break;
    if (gt <= lt) gt = html.indexOf('>', lt + 1);
    if (gt < 0) break;
    TAG_NAME.lastIndex = lt + 1;
    const m = TAG_NAME.exec(html);
    if (!m) { pos = lt + 1; continue; }
    const nameEnd = lt + 1 + m[0].length;
    out.push({ name: m[2]!.toLowerCase(), close: m[1] === '/', attrs: html.slice(nameEnd, Math.min(gt, nameEnd + 4_096)), start: lt, end: gt + 1 });
    pos = gt + 1;
  }
  return out;
}

/** タグを除く（`indexOf` で 1 回なめる。閉じの無い `<` からは文字のまま残す）。 */
function stripTags(s: string): string {
  const out: string[] = [];
  let pos = 0;
  let gt = -1;
  for (;;) {
    const lt = s.indexOf('<', pos);
    if (lt < 0) break;
    if (gt <= lt) gt = s.indexOf('>', lt + 1);
    if (gt < 0) break;
    out.push(s.slice(pos, lt), ' ');
    pos = gt + 1;
  }
  out.push(s.slice(pos));
  return out.join('');
}

const clean = (s: string) => decodeEntities(stripTags(s)).replace(/\s+/g, ' ').trim();

/** タグの属性の値（引用符で囲んだものだけ）。 */
const attr = (attrs: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs)?.[1];

/**
 * HTML を読む。
 *
 * @param url そのページの URL（リンクを絶対の URL にするため）
 */
export function readHtml(html: string, url: string): PageContent {
  const base = new URL(url);
  const noScript = stripHidden(html);
  const tags = scanTags(noScript);
  const between = (open: Tag, close: Tag | undefined) => (close ? noScript.slice(open.end, close.start) : '');
  // 題名（最初の <title> から次の </title> まで）
  const ti = tags.findIndex((t) => t.name === 'title' && !t.close);
  const title = ti < 0 ? '' : clean(between(tags[ti]!, tags.slice(ti + 1).find((t) => t.name === 'title' && t.close))).slice(0, 200);
  // 説明（name="description" の <meta> の content）
  const meta = tags.find((t) => t.name === 'meta' && !t.close && /\bname\s*=\s*["']description["']/i.test(t.attrs));
  const description = clean(meta ? attr(meta.attrs, 'content') ?? '' : '').slice(0, 300);
  // 見出しとリンクは前から 1 回なめて拾う（開いたものは次の閉じまで。開いている間の同じ種類の開きは中身として扱う）
  const headings: string[] = [];
  const links: { url: string; label: string }[] = [];
  const seen = new Set<string>();
  let heading: Tag | null = null;
  let anchor: Tag | null = null;
  for (const t of tags) {
    if (/^h[1-3]$/.test(t.name)) {
      if (!t.close && !heading) heading = t;
      else if (t.close && heading) {
        const h = clean(noScript.slice(heading.end, t.start));
        if (h && headings.length < 40) headings.push(h);
        heading = null;
      }
    }
    if (t.name !== 'a') continue;
    if (!t.close) { if (!anchor) anchor = t; continue; }
    if (!anchor) continue;
    const open = anchor;
    anchor = null;
    if (links.length >= 200) continue;
    const href = /\bhref=["']([^"'#]+)(?:#[^"']*)?["']/i.exec(open.attrs)?.[1];
    if (!href) continue;
    let target: URL;
    try {
      target = new URL(decodeEntities(href.trim()), base);
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
    const label = (clean(noScript.slice(open.end, t.start)) || clean(attr(open.attrs, 'title') ?? attr(open.attrs, 'aria-label') ?? '')).slice(0, 60);
    links.push({ url: key, label });
  }
  // 本文（最初の <body> から最後の </body> まで。無ければ全体）
  const bodyOpen = tags.find((t) => t.name === 'body' && !t.close);
  const bodyClose = [...tags].reverse().find((t) => t.name === 'body' && t.close);
  const body = bodyOpen && bodyClose && bodyClose.start >= bodyOpen.end ? noScript.slice(bodyOpen.end, bodyClose.start) : noScript;
  const text = clean(body.replace(/<(br|p|div|li|tr|h[1-6]|section|article)\b/gi, '\n<$1')).slice(0, 20_000);
  return { url, title, description, headings, text, links, hash: pageHash(text) };
}

/** ページの印（余白と数字以外の揺れを詰めた文字の指紋）。 */
export function pageHash(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 32);
}
