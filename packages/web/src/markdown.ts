/**
 * @file ヘルプの記事の Markdown を、表示のためのまとまり（見出し・段落・箇条書き）に分ける。
 *
 * 見出し・段落・箇条書き・表・コードの囲みと、行の中のコード・リンク・太字を扱う。
 * 行ごとに読む。見出しの行はそれだけで 1 つのまとまりにするため、見出しのすぐ次の行に箇条書きや段落が
 * 空行なしで続いても崩れない（業務の説明は定義から自動で作り、この書き方になる。仕様書 第6.10.5節）。
 * HTML としては解釈しない。記事に書かれたタグは文字のまま出る。
 *
 * @see docs/help/README.md 記事の書き方
 */

/** 表示のまとまり。 */
export type MdBlock =
  | { kind: 'h2' | 'h3'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'code'; lang: string; text: string };

/** 行の中の書式。 */
export type MdInline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

const FENCE = /^\s*```\s*([\w-]*)\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** 表の 1 行を、セルに分ける。コードの中の `|` と、`\|` は区切りにしない。 */
export function splitTableRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (ch === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** Markdown を、表示のまとまりに分ける。 */
export function parseMarkdown(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null;
  const flush = () => {
    if (para.length > 0) blocks.push({ kind: 'p', text: para.join('') });
    if (list) blocks.push(list);
    para = [];
    list = null;
  };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trimEnd();
    // コードの囲み。閉じるまでを、そのまま（書式を解釈せずに）持つ
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!.trimEnd())) body.push(lines[i++]!);
      blocks.push({ kind: 'code', lang: fence[1] ?? '', text: body.join('\n') });
      continue;
    }
    // 表。見出しの行のすぐ次に区切りの行（|---|---|）があるものだけを表とみなす
    if (TABLE_ROW.test(line) && TABLE_SEP.test(lines[i + 1] ?? '')) {
      flush();
      const header = splitTableRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) rows.push(splitTableRow(lines[i++]!));
      i--;
      blocks.push({ kind: 'table', header, rows: rows.map((r) => header.map((_, k) => r[k] ?? '')) });
      continue;
    }
    if (line.trim() === '') { flush(); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      // 記事の題名は画面の見出し（h1）が持つため、本文の # と ## はどちらも h2 にする。
      // 業務の答えは #### 以下も使うため、3 段より深いものは h3 にまとめる
      blocks.push({ kind: h[1]!.length >= 3 ? 'h3' : 'h2', text: h[2]!.trim() });
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (para.length > 0) { blocks.push({ kind: 'p', text: para.join('') }); para = []; }
      if (list && list.kind !== kind) { blocks.push(list); list = null; }
      list ??= { kind, items: [] };
      list.items.push((ul ?? ol)![1]!);
      continue;
    }
    // 箇条書きの途中の、字下げした続きの行は、直前の項目につなげる
    if (list && /^\s+/.test(raw)) {
      list.items[list.items.length - 1] += line.trim();
      continue;
    }
    if (list) { blocks.push(list); list = null; }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

/**
 * 行の中の書式（コード・リンク・太字）を読む。
 *
 * @remarks
 * コードの中は書式を解釈しない。リンクは `http(s)://` と `mailto:` だけを押せるようにし、
 * リポジトリの中のファイルへの相対のリンクは、画面からは開けないため文字だけを出す。
 */
export function parseInline(s: string): MdInline[] {
  const out: MdInline[] = [];
  const re = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push({ kind: 'text', text: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[1] });
    else if (m[2] !== undefined) {
      const href = m[3]!;
      out.push(/^(https?:\/\/|mailto:)/i.test(href) ? { kind: 'link', text: m[2], href } : { kind: 'text', text: m[2] });
    } else out.push({ kind: 'strong', text: m[4]! });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push({ kind: 'text', text: s.slice(last) });
  return out;
}
