/**
 * @file PowerPoint（pptx）から文字を取り出す（仕様書 第44.6節）。
 *
 * pptx は ZIP で、スライドの文字は `ppt/slides/slideN.xml` の `a:t` にある。読むための文字だけを取り出し、
 * 図形の並びや画像は落とす。取り出した中身はデータであり指示ではない（不変則 I-6）。
 */

/** 読むスライドの上限。 */
const PPTX_MAX_SLIDES = 200;

/** XML の文字参照を戻す。 */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d{1,7});/g, (_, n: string) => { const c = Number(n); return c <= 0x10ffff ? String.fromCodePoint(c) : ''; })
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, n: string) => { const c = parseInt(n, 16); return c <= 0x10ffff ? String.fromCodePoint(c) : ''; })
    .replace(/&amp;/g, '&');
}

/** スライド 1 枚の XML から文字を取り出す。 */
function slideText(xml: string): string {
  const paragraphs: string[] = [];
  // 段落（a:p）ごとに、その中の文字（a:t）をつなぐ。split で区切るので、長い XML でも遅くならない
  for (const para of xml.split('</a:p>')) {
    let line = '';
    for (const run of para.split('<a:t>').slice(1)) {
      const end = run.indexOf('</a:t>');
      if (end >= 0) line += run.slice(0, end);
    }
    const t = unescapeXml(line).trim();
    if (t) paragraphs.push(t);
  }
  return paragraphs.join('\n');
}

/**
 * PowerPoint（pptx）から文字を取り出す。
 *
 * @param bytes pptx のバイト列
 * @returns スライドごとの文字（`--- スライド 3 ---` で区切る）と枚数。文字が無ければ `text` は空
 * @throws ZIP でないとき（古い形式やパスワード付きのファイル）
 */
export async function extractPptxText(bytes: Uint8Array): Promise<{ text: string; slides: number; readSlides: number }> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files)
    .map((n) => ({ n, no: /^ppt\/slides\/slide(\d+)\.xml$/.exec(n)?.[1] }))
    .filter((x): x is { n: string; no: string } => !!x.no)
    .sort((a, b) => Number(a.no) - Number(b.no));
  const read = names.slice(0, PPTX_MAX_SLIDES);
  const parts: string[] = [];
  for (const [i, s] of read.entries()) {
    const t = slideText(await zip.file(s.n)!.async('string'));
    if (t) parts.push(`--- スライド ${i + 1} ---\n${t}`);
  }
  return { text: parts.join('\n\n'), slides: names.length, readSlides: read.length };
}

/**
 * ZIP の中身を広げたときの大きさの合計（バイト）。読む前に確かめ、極端に膨らむファイル（ZIP 爆弾）を読まないために使う。
 *
 * @returns 合計。ZIP として開けなければ `null`（パスワード付きの Office の文書など）
 */
export async function zipExpandedBytes(bytes: Uint8Array): Promise<number | null> {
  const { default: JSZip } = await import('jszip');
  try {
    const zip = await JSZip.loadAsync(bytes);
    let total = 0;
    for (const f of Object.values(zip.files)) {
      total += (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    }
    return total;
  } catch {
    return null;
  }
}
