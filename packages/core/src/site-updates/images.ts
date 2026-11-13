/**
 * @file サイトの更新の段 2a の画像（仕様書 第45.18.2節）。ページの中の画像を数え、1 つの画像の差し替えと代わりの文の直しを、
 * その `<img>` とブロックの印の外を 1 文字も変えずに行う。
 *
 * WordPress から読んだ本文は外部のデータであり、指示として読まない（不変則 I-6）。
 */

import { COVER_PATTERNS, type CoverPattern } from '../columns/cover.js';
import { stripTags } from './segments.js';

/** 画像の出どころ（承認の画面と記録に出す）。 */
export type SiteImageSource =
  | {
    /** 秘書に渡した画像・資料の画像・AI の挿絵。どれも直し案の時点で M2Office のファイルに持つ。 */
    from: 'file' | 'library' | 'ai';
    fileId: string;
    /** 承認の画面に出す名前（ファイル名・資料の題名）。 */
    name: string;
    mimeType: string;
  }
  | { from: 'template'; pattern: CoverPattern; color: string };

/** サイトに入れられる画像の形式（WordPress がそのまま出せるもの）。 */
export const SITE_IMAGE_MIME: Readonly<Record<string, string>> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
/** 画像の形式から、M2Office のファイルの種類（保存のため）。 */
export const SITE_IMAGE_KIND: Readonly<Record<string, 'png' | 'jpeg' | 'webp'>> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };
/** サイトに入れる画像の大きさの上限。 */
export const SITE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** 1 回の頼みで扱う、画像の差し替えと代わりの文の数の上限。 */
export const SITE_IMAGE_EDITS_MAX = 10;

/** ページの中の画像 1 つ。 */
export interface PageImage {
  /** 上から数えた番号（1 から）。 */
  index: number;
  /** `<img>` の始まりと終わり（本文の中の位置）。 */
  start: number;
  end: number;
  src: string;
  alt: string;
  /** ファイル名（`src` の最後の部分）。 */
  file: string;
  /** WordPress のメディアの番号（`wp-image-番号`）。分からなければ `null`。 */
  mediaId: number | null;
  /** ギャラリーの中の画像（扱わない）。 */
  inGallery: boolean;
  /** すぐ前の見出し（手がかり）。 */
  heading: string;
}

const IMG = /<img\b[^>]*>/gi;
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 印の属性の値（無ければ `null`）。 */
export function attrOf(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/** 印の属性を書き換える（無ければ足す。`null` なら外す）。 */
export function withAttr(tag: string, name: string, value: string | null): string {
  const re = new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'i');
  if (value === null) return tag.replace(re, '');
  const next = ` ${name}="${escapeAttr(value)}"`;
  if (re.test(tag)) return tag.replace(re, next);
  // 閉じの前に足す（正規表現を使わず、末の空白と「/」を読む）
  const selfClose = tag.endsWith('/>');
  let k = tag.length - (selfClose ? 2 : 1);
  while (k > 0 && /\s/.test(tag.charAt(k - 1))) k--;
  return `${tag.slice(0, k)}${next}${selfClose ? ' /' : ''}>`;
}

/** ギャラリーのブロックの範囲（ブロックの印か、`wp-block-gallery` の figure）。 */
function galleryRanges(html: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /<!--\s*wp:gallery\b[\s\S]*?<!--\s*\/wp:gallery\s*-->|<figure\b[^>]*class="[^"]*wp-block-gallery[^"]*"[\s\S]*?<\/figure>\s*<\/figure>|<div\b[^>]*class="[^"]*\bgallery\b[^"]*"[\s\S]*?<\/div>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** ページの中の画像を上から数える。 */
export function pageImages(html: string): PageImage[] {
  const galleries = galleryRanges(html);
  const out: PageImage[] = [];
  IMG.lastIndex = 0;
  for (let m = IMG.exec(html); m; m = IMG.exec(html)) {
    const tag = m[0];
    const src = attrOf(tag, 'src') ?? '';
    const id = /\bwp-image-(\d+)\b/.exec(attrOf(tag, 'class') ?? '');
    const before = html.slice(Math.max(0, m.index - 4000), m.index);
    const heads = [...before.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)];
    const last = heads.at(-1);
    out.push({
      index: out.length + 1, start: m.index, end: m.index + tag.length, src, alt: attrOf(tag, 'alt') ?? '',
      file: decodeURIComponent(src.split(/[?#]/)[0]!.split('/').pop() ?? '').slice(0, 120),
      mediaId: id ? Number(id[1]) : null,
      inGallery: galleries.some(([s, e]) => m!.index >= s && m!.index < e),
      heading: last ? decode(stripTags(last[1]!)).trim().slice(0, 80) : '',
    });
  }
  return out;
}

/** 画像を差し替える・代わりの文を直す、1 つ分の中身。 */
export interface ImageEdit {
  /** 新しい画像（差し替えるとき）。メディアに入れた番号と URL。 */
  media?: { id: number; url: string };
  /** 新しい代わりの文（変えないなら省く）。 */
  alt?: string;
}

/**
 * ページの中の 1 つの画像を差し替える・代わりの文を直す（第45.18.2節）。
 *
 * 差し替えでは、その `<img>` の `src` を新しい URL に、`class` の `wp-image-番号` とブロックの印の `"id"` を新しいメディアの番号にし、
 * `srcset`・`sizes` を外す（古い画像の候補を持ち越さない）。その `<img>` とブロックの印の外は変えない。
 *
 * @returns 直した本文。その番号の画像が無い・ギャラリーの中なら理由
 */
export function editPageImage(html: string, index: number, edit: ImageEdit): { html: string } | { error: string } {
  const img = pageImages(html).find((x) => x.index === index);
  if (!img) return { error: `${index} 番目の画像が見つかりません` };
  if (img.inGallery) return { error: `${index} 番目の画像はギャラリーの中にあるため、差し替えません` };
  let tag = html.slice(img.start, img.end);
  let head = html.slice(0, img.start);
  // 直したブロックの印の位置（確かめで、そこを除いて比べる）
  let comment: { start: number; before: number; after: number } | null = null;
  if (edit.media) {
    tag = withAttr(tag, 'src', edit.media.url);
    tag = withAttr(tag, 'srcset', null);
    tag = withAttr(tag, 'sizes', null);
    const cls = attrOf(tag, 'class');
    if (cls && /\bwp-image-\d+\b/.test(cls)) tag = withAttr(tag, 'class', cls.replace(/\bwp-image-\d+\b/, `wp-image-${edit.media.id}`));
    // すぐ前の画像のブロックの印（閉じていないもの）の番号も直す。番号が古い画像のものと同じときだけ
    if (img.mediaId !== null) {
      const open = head.lastIndexOf('<!-- wp:image');
      if (open >= 0 && !head.slice(open).includes('<!-- /wp:image')) {
        const close = head.indexOf('-->', open);
        if (close > 0) {
          const old = head.slice(open, close + 3);
          const fixed = old.replace(new RegExp(`"id":${img.mediaId}(?=[,}])`), `"id":${edit.media.id}`);
          head = head.slice(0, open) + fixed + head.slice(close + 3);
          comment = { start: open, before: old.length, after: fixed.length };
        }
      }
    }
  }
  if (edit.alt !== undefined) tag = withAttr(tag, 'alt', edit.alt);
  const next = head + tag + html.slice(img.end);
  // 確かめ: その画像の印と、直したブロックの印の外が変わっていないこと（位置で切り出して比べる）
  const outside = (s: string, tagStart: number, tagLen: number, commentLen: number) => (comment
    ? s.slice(0, comment.start) + s.slice(comment.start + commentLen, tagStart) + s.slice(tagStart + tagLen)
    : s.slice(0, tagStart) + s.slice(tagStart + tagLen));
  const shift = head.length - img.start;
  if (outside(next, img.start + shift, tag.length, comment?.after ?? 0) !== outside(html, img.start, img.end - img.start, comment?.before ?? 0)) {
    return { error: '画像の外の部分が変わってしまうため、直しませんでした' };
  }
  return { html: next };
}

/** 出どころの呼び方（承認の画面）。 */
export function sourceLabel(s: SiteImageSource): string {
  if (s.from === 'file') return `渡した画像「${s.name}」`;
  if (s.from === 'library') return `資料「${s.name}」`;
  if (s.from === 'ai') return 'AI の挿絵';
  return '型の画像';
}

/** 置き場から読んだ出どころを確かめる（壊れた記録で落ちない）。 */
export function readSource(v: unknown): SiteImageSource | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if ((o['from'] === 'file' || o['from'] === 'library' || o['from'] === 'ai') && typeof o['fileId'] === 'string') {
    return { from: o['from'], fileId: o['fileId'], name: String(o['name'] ?? ''), mimeType: String(o['mimeType'] ?? 'image/png') };
  }
  if (o['from'] === 'template' && COVER_PATTERNS.includes(o['pattern'] as CoverPattern) && typeof o['color'] === 'string') {
    return { from: 'template', pattern: o['pattern'] as CoverPattern, color: o['color'] };
  }
  return null;
}
