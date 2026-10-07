/**
 * @file 修正の案を、Word（docx）の変更履歴（削除と挿入）とコメントとして入れる（仕様書 第28.15節、ADR-0083、Q-98）。
 *
 * 元の Word の `word/document.xml` の段落（`w:p`）の中から直す文を探し、その段落だけを、元の文の前・削除・挿入・元の文の後に組み直す。
 * ほかの段落・書式・表はそのまま残す。組み直した段落の中の書式は、段落の最初の文字の書式にそろう。
 * 直す文が見つからない修正の案は、黙って落とさず、文書の最後に「変更履歴にできなかった修正の案」として並べる。
 * 比べるときは空白を除く（推論が書き写した文と、元の文の空白の違いを吸収する）。
 */

import JSZip from 'jszip';

/** 1 つの修正の案。 */
export interface RedlineEdit {
  /** 元の文（直す範囲）。 */
  before: string;
  /** 直した文。空なら削除だけ。 */
  after: string;
  /** 理由（コメントにする）。 */
  reason?: string;
}

/** 変更履歴を入れた結果。 */
export interface RedlineResult {
  bytes: Uint8Array;
  applied: number;
  unapplied: RedlineEdit[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** 段落の文字（`w:t` と `w:tab`）。 */
function paragraphText(xml: string): string {
  let out = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)) out += m[1] !== undefined ? unesc(m[1]) : '\t';
  return out;
}

/** 空白を除き、1 字ずつ全角と半角をそろえた文字と、元の位置の対応（そろえて字数が変わっても元の位置に戻せる）。 */
function squeeze(s: string): { text: string; map: number[] } {
  const map: number[] = [];
  let text = '';
  for (let i = 0; i < s.length; i++) {
    for (const c of s[i]!.normalize('NFKC')) {
      if (/\s/.test(c)) continue;
      text += c;
      map.push(i);
    }
  }
  return { text, map };
}

/** 段落の中で、元の文の範囲を探す（空白を除いて比べる）。見つからなければ `null`。 */
export function findRange(paragraph: string, before: string): { start: number; end: number } | null {
  const p = squeeze(paragraph);
  const b = squeeze(before).text;
  if (!b) return null;
  const at = p.text.indexOf(b);
  if (at < 0) return null;
  return { start: p.map[at]!, end: p.map[at + b.length - 1]! + 1 };
}

/**
 * Word に変更履歴を入れる。
 *
 * @param author 変更の作成者（「M2Office（修正の案）」）
 */
export async function redlineDocx(bytes: Uint8Array, edits: RedlineEdit[], author: string, now: Date = new Date()): Promise<RedlineResult> {
  const zip = await JSZip.loadAsync(bytes);
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('Word の本文が見つかりません');
  let doc = await docFile.async('string');
  const date = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  let id = 9000;
  const comments: string[] = [];
  const left = new Set(edits.map((_, i) => i));

  doc = doc.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (p) => {
    const text = paragraphText(p);
    if (!text) return p;
    // この段落に当たる修正（重ならないもの）を、前から順に
    const hits: { i: number; start: number; end: number }[] = [];
    for (const i of left) {
      const r = findRange(text, edits[i]!.before);
      if (r && !hits.some((h) => r.start < h.end && h.start < r.end)) hits.push({ i, ...r });
    }
    if (!hits.length) return p;
    hits.sort((a, b) => a.start - b.start);
    const open = /^<w:p(?:\s[^>]*)?>/.exec(p)![0];
    const pPr = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(p)?.[0] ?? '';
    const rPr = /<w:r(?:\s[^>]*)?>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/.exec(p)?.[1] ?? '';
    const run = (t: string) => (t ? `<w:r>${rPr}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>` : '');
    let out = `${open}${pPr}`;
    let pos = 0;
    for (const h of hits) {
      const e = edits[h.i]!;
      left.delete(h.i);
      const cid = id++;
      out += run(text.slice(pos, h.start));
      if (e.reason) out += `<w:commentRangeStart w:id="${cid}"/>`;
      out += `<w:del w:id="${id++}" w:author="${esc(author)}" w:date="${date}"><w:r>${rPr}<w:delText xml:space="preserve">${esc(text.slice(h.start, h.end))}</w:delText></w:r></w:del>`;
      if (e.after) out += `<w:ins w:id="${id++}" w:author="${esc(author)}" w:date="${date}"><w:r>${rPr}<w:t xml:space="preserve">${esc(e.after)}</w:t></w:r></w:ins>`;
      if (e.reason) {
        out += `<w:commentRangeEnd w:id="${cid}"/><w:r><w:commentReference w:id="${cid}"/></w:r>`;
        comments.push(`<w:comment w:id="${cid}" w:author="${esc(author)}" w:date="${date}" w:initials="M2"><w:p><w:r><w:t xml:space="preserve">${esc(e.reason)}</w:t></w:r></w:p></w:comment>`);
      }
      pos = h.end;
    }
    out += `${run(text.slice(pos))}</w:p>`;
    return out;
  });

  const unapplied = [...left].sort((a, b) => a - b).map((i) => edits[i]!);
  if (unapplied.length) {
    const para = (t: string, bold = false) => `<w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
    const tail = [para('変更履歴にできなかった修正の案（元の文が見つからなかったもの）', true),
      ...unapplied.map((e) => para(`元の文: ${e.before} → 修正の案: ${e.after || '（削る）'}${e.reason ? `（${e.reason}）` : ''}`))].join('');
    const sect = doc.lastIndexOf('<w:sectPr');
    const bodyEnd = doc.lastIndexOf('</w:body>');
    const at = sect > 0 && sect < bodyEnd ? sect : bodyEnd;
    doc = doc.slice(0, at) + tail + doc.slice(at);
  }
  zip.file('word/document.xml', doc);

  if (comments.length) {
    const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const existing = zip.file('word/comments.xml');
    if (existing) {
      const xml = await existing.async('string');
      // 中身の無いコメントの置き場は「<w:comments …/>」の形で書かれていることがある
      const opened = xml.includes('</w:comments>') ? xml : xml.replace(/<w:comments([^>]*)\/>/, '<w:comments$1></w:comments>');
      zip.file('word/comments.xml', opened.replace('</w:comments>', `${comments.join('')}</w:comments>`));
    } else {
      zip.file('word/comments.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${NS}>${comments.join('')}</w:comments>`);
      const relsPath = 'word/_rels/document.xml.rels';
      const rels = await zip.file(relsPath)?.async('string');
      if (rels && !rels.includes('relationships/comments')) {
        zip.file(relsPath, rels.replace('</Relationships>', '<Relationship Id="rIdM2oComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>'));
      }
      const types = await zip.file('[Content_Types].xml')?.async('string');
      if (types && !types.includes('/word/comments.xml')) {
        zip.file('[Content_Types].xml', types.replace('</Types>', '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>'));
      }
    }
  }
  const out = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return { bytes: out, applied: edits.length - unapplied.length, unapplied };
}
