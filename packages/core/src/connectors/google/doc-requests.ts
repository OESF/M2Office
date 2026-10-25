/**
 * @file 文書の本文（Markdown）を、Docs API で「名前の付いたスタイル」を指定して書き入れる命令に直す
 * （仕様書 第9.5.5.2節「文書のテンプレート」、Q-267、ADR-0110）。
 *
 * テンプレート（Google ドキュメントのテンプレート ギャラリーから作ったもの）の見た目を生かすため、字体・大きさ・色は指定せず、
 * 段落ごとに題名・見出し・標準のテキストのスタイルを当てる。箇条書きは Docs の箇条書きに、表は印の段落を置いて後から表にする。
 * Google には触らない（命令を作るだけ）。
 *
 * 扱う書き方: 見出し（`#` → 題名、`##` → 見出し 1、`###` → 見出し 2、`####` 以下 → 見出し 3）・段落・太字（`**…**`）・
 * 行の中のコード（`` `…` ``）・リンク（`[文字](https://…)`）・箇条書き（`-`・`*`・`+`。字下げで入れ子）・番号（`1.`）・
 * 引用（`>`。段落にする）・表・コードの囲み（```）。区切り線（`---`）は空の段落にする。
 */

type Request = Record<string, unknown>;

/** 本文の塊。 */
export type DocBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'para'; text: string }
  | { type: 'list'; ordered: boolean; items: { level: number; text: string }[] }
  | { type: 'table'; rows: string[][] }
  | { type: 'code'; lines: string[] };

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/** 表を置く印（後から表に置き換える段落の文）。本文に現れない文字で包む。 */
export const TABLE_MARK = (n: number) => `⁣M2TABLE${n}⁣`;

/**
 * Markdown を塊に分ける。
 */
export function parseMarkdownBlocks(markdown: string): DocBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: DocBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ type: 'para', text: para.join(' ').trim() });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      out.push({ type: 'code', lines: code });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push({ type: 'heading', level: h[1]!.length, text: h[2]!.replace(/\s+#+\s*$/, '').trim() });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      flush();
      const rows = [cells(line)];
      for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) rows.push(cells(lines[i]!));
      i--;
      out.push({ type: 'table', rows });
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]!);
      const level = Math.min(Math.floor(li[1]!.replace(/\t/g, '  ').length / 2), 8);
      const last = out.at(-1);
      if (last?.type === 'list' && last.ordered === ordered) last.items.push({ level, text: li[3]!.trim() });
      else out.push({ type: 'list', ordered, items: [{ level, text: li[3]!.trim() }] });
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      out.push({ type: 'para', text: '' });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line.replace(/^\s*>\s?/, ''));
  }
  flush();
  return out;
}

/** 行の中の書式を取り出す。返す文は書式の印を外したもの。位置は文の中の位置（UTF-16）。 */
export function parseInline(src: string): { text: string; bold: [number, number][]; code: [number, number][]; links: [number, number, string][] } {
  const bold: [number, number][] = [];
  const code: [number, number][] = [];
  const links: [number, number, string][] = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const c = /^`([^`]+)`/.exec(rest);
    if (c) { code.push([text.length, text.length + c[1]!.length]); text += c[1]; i += c[0].length; continue; }
    const b = /^\*\*(.+?)\*\*/.exec(rest);
    if (b) {
      // 太字の中のリンクは文字だけにする
      const inner = b[1]!.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1');
      bold.push([text.length, text.length + inner.length]); text += inner; i += b[0].length; continue;
    }
    const l = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(rest);
    if (l) { links.push([text.length, text.length + l[1]!.length, l[2]!]); text += l[1]; i += l[0].length; continue; }
    text += src[i];
    i += 1;
  }
  return { text, bold, code, links };
}

/** 見出しの深さ → 名前の付いたスタイル。 */
const HEADING_STYLE = (level: number) => (level <= 1 ? 'TITLE' : level === 2 ? 'HEADING_1' : level === 3 ? 'HEADING_2' : 'HEADING_3');

/** 直接の文字の書式を外す項目（スタイルに任せる）。 */
const TEXT_RESET = 'bold,italic,underline,strikethrough,smallCaps,fontSize,weightedFontFamily,foregroundColor,backgroundColor,link,baselineOffset';
/** 直接の段落の書式を外す項目（スタイルに任せる）。 */
const PARA_RESET = 'namedStyleType,alignment,indentStart,indentEnd,indentFirstLine,spaceAbove,spaceBelow,lineSpacing,direction';

/**
 * 本文を書き入れる命令を作る（空にした本文の先頭 `start` に入れる）。
 *
 * @returns 入れる文の命令と書式の命令（1 回の一括更新で送る）、表（印の文と行。書き入れた後に表に置き換える）
 */
export function docBodyRequests(markdown: string, start = 1): { requests: Request[]; tables: { mark: string; rows: string[][] }[] } {
  const blocks = parseMarkdownBlocks(markdown);
  const paragraphs: { text: string; style: string; bold: [number, number][]; code: [number, number][]; links: [number, number, string][]; mono?: boolean }[] = [];
  const lists: { from: number; to: number; ordered: boolean }[] = [];
  const tables: { mark: string; rows: string[][] }[] = [];
  for (const b of blocks) {
    if (b.type === 'heading') paragraphs.push({ ...parseInline(b.text), style: HEADING_STYLE(b.level) });
    else if (b.type === 'para') paragraphs.push({ ...parseInline(b.text), style: 'NORMAL_TEXT' });
    else if (b.type === 'code') for (const l of b.lines) paragraphs.push({ text: l, style: 'NORMAL_TEXT', bold: [], code: [], links: [], mono: true });
    else if (b.type === 'table') {
      const mark = TABLE_MARK(tables.length);
      tables.push({ mark, rows: b.rows.map((r) => r.map((c) => parseInline(c).text)) });
      paragraphs.push({ text: mark, style: 'NORMAL_TEXT', bold: [], code: [], links: [] });
    } else {
      const from = paragraphs.length;
      for (const it of b.items) {
        // 入れ子は行頭のタブで表す（箇条書きにするときに Docs がタブを外して深さにする）
        const inl = parseInline(it.text);
        const tabs = '\t'.repeat(it.level);
        paragraphs.push({
          text: tabs + inl.text, style: 'NORMAL_TEXT',
          bold: inl.bold.map(([s, e]) => [s + tabs.length, e + tabs.length]), code: inl.code.map(([s, e]) => [s + tabs.length, e + tabs.length]),
          links: inl.links.map(([s, e, u]) => [s + tabs.length, e + tabs.length, u]),
        });
      }
      lists.push({ from, to: paragraphs.length - 1, ordered: b.ordered });
    }
  }
  if (paragraphs.length === 0) paragraphs.push({ text: '', style: 'NORMAL_TEXT', bold: [], code: [], links: [] });
  // 段落の位置
  const at: { start: number; end: number }[] = [];
  let pos = start;
  for (const p of paragraphs) {
    at.push({ start: pos, end: pos + p.text.length + 1 });
    pos += p.text.length + 1;
  }
  // 最後の段落は、本文に残っている最後の改行と合わさる（末尾に空の段落を作らない）
  const text = paragraphs.map((p) => p.text).join('\n');
  const requests: Request[] = [];
  if (text) requests.push({ insertText: { location: { index: start }, text } });
  const total = text.length;
  if (total > 0) requests.push({ updateTextStyle: { range: { startIndex: start, endIndex: start + total }, textStyle: {}, fields: TEXT_RESET } });
  paragraphs.forEach((p, k) => {
    const r = at[k]!;
    const end = Math.min(r.end, start + total + 1);
    requests.push({ updateParagraphStyle: { range: { startIndex: r.start, endIndex: end }, paragraphStyle: { namedStyleType: p.style }, fields: PARA_RESET } });
    for (const [s, e] of p.bold) if (e > s) requests.push({ updateTextStyle: { range: { startIndex: r.start + s, endIndex: r.start + e }, textStyle: { bold: true }, fields: 'bold' } });
    for (const [s, e, url] of p.links) if (e > s) requests.push({ updateTextStyle: { range: { startIndex: r.start + s, endIndex: r.start + e }, textStyle: { link: { url } }, fields: 'link' } });
    const mono = p.mono && p.text.length ? [[0, p.text.length] as [number, number]] : p.code;
    for (const [s, e] of mono) if (e > s) requests.push({ updateTextStyle: { range: { startIndex: r.start + s, endIndex: r.start + e }, textStyle: { weightedFontFamily: { fontFamily: 'Roboto Mono' } }, fields: 'weightedFontFamily' } });
  });
  // 箇条書きは後ろから（行頭のタブが外れて位置がずれるため）
  for (const l of [...lists].reverse()) {
    requests.push({
      createParagraphBullets: {
        range: { startIndex: at[l.from]!.start, endIndex: Math.min(at[l.to]!.end, start + total + 1) - 1 },
        bulletPreset: l.ordered ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE',
      },
    });
  }
  return { requests, tables };
}

/** 文書の本文（Docs API の `body.content`）の、ここで読む所だけの形。 */
export interface DocContent {
  startIndex?: number;
  endIndex?: number;
  paragraph?: { elements?: { textRun?: { content?: string } }[] };
  table?: { tableRows?: { tableCells?: { content?: { startIndex?: number }[] }[] }[] };
}

/**
 * 本文を空にする命令（最後の改行だけを残す）。本文がすでに空なら空の並び。
 */
export function clearBodyRequests(content: DocContent[]): Request[] {
  const end = Math.max(...content.map((c) => c.endIndex ?? 0), 0);
  return end - 1 > 1 ? [{ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1 } } }] : [];
}

/** 印の段落の場所（表に置き換える）。 */
export function findMark(content: DocContent[], mark: string): { start: number; end: number } | null {
  for (const c of content) {
    const text = (c.paragraph?.elements ?? []).map((e) => e.textRun?.content ?? '').join('');
    if (text.includes(mark) && c.startIndex !== undefined) {
      const at = c.startIndex + text.indexOf(mark);
      return { start: at, end: at + mark.length };
    }
  }
  return null;
}

/**
 * 空の表のます目に文を入れる命令（後ろのます目から入れて、位置がずれないようにする）。見出しの行は太字にする。
 *
 * @param table 表を入れた直後に読んだ表（`body.content` の要素）
 */
export function fillTableRequests(table: DocContent, rows: string[][]): Request[] {
  const requests: Request[] = [];
  const grid = table.table?.tableRows ?? [];
  const jobs: { index: number; text: string; header: boolean }[] = [];
  grid.forEach((row, r) => (row.tableCells ?? []).forEach((cell, k) => {
    const index = cell.content?.[0]?.startIndex;
    const text = rows[r]?.[k] ?? '';
    if (index !== undefined && text) jobs.push({ index, text, header: r === 0 });
  }));
  for (const j of jobs.sort((a, b) => b.index - a.index)) {
    requests.push({ insertText: { location: { index: j.index }, text: j.text } });
    if (j.header) requests.push({ updateTextStyle: { range: { startIndex: j.index, endIndex: j.index + j.text.length }, textStyle: { bold: true }, fields: 'bold' } });
  }
  return requests;
}
