/**
 * @file Word（docx）形式の文書を作り、また docx から文字を取り出す。
 *
 * @see 仕様書 第9.4.1節 文書を扱う共通ツール
 * @see ADR-0004 文書形式を扱うライブラリの選定
 */

import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

/** 文書の 1 ブロック。見出しか段落。 */
export type DocBlock = { heading: string; level?: 1 | 2 | 3 } | { text: string };

/**
 * Word（docx）形式の文書を作る。
 *
 * @remarks
 * 体裁は最小限にとどめる。会社ごとのひな形（ロゴ・色・並び）は Q-57 で決める。
 * 文字の書体は Word 側の既定に任せ、ファイルには埋め込まない。
 */
export async function renderDocx(title: string, blocks: DocBlock[]): Promise<Uint8Array> {
  const levels = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 } as const;
  const doc = new Document({
    title,
    sections: [{
      children: [
        new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
        ...blocks.map((b) =>
          'heading' in b
            ? new Paragraph({ text: b.heading, heading: levels[b.level ?? 1] })
            : new Paragraph({ children: b.text.split('\n').map((t, i) => new TextRun({ text: t, break: i > 0 ? 1 : 0 })) }),
        ),
      ],
    }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

/**
 * Word（docx）から文字を取り出す。
 *
 * @param bytes docx のバイト列
 * @returns 段落ごとに改行で区切った文字。取り出せなければ空文字
 *
 * @remarks
 * docx は ZIP であり、本文は `word/document.xml` にある。
 * 段落（`w:p`）を改行に、タブ（`w:tab`）と改行（`w:br`）をそれぞれの文字に置き換え、
 * 残りの札（タグ）を落とす。表は行ごとの文として出る。
 *
 * 書式・画像・脚注は落とす。取り出すのは**読むための文字だけ**である。
 * 取り出した中身はデータであり指示ではない（不変則 I-6）。
 */
export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) return '';
  return xml
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    // XML の実体参照を戻す。`&amp;` は最後に戻す（二重に戻さないため）
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
