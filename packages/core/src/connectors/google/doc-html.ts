/**
 * @file 文書の本文（Markdown）を、Google ドキュメントに取り込ませる HTML に直す（仕様書 第14.3.4節「ドキュメント」）。
 *
 * Google ドライブは HTML を取り込むと、見出し・太字・箇条書き・表をドキュメントの書式にする。
 * 推論が書く本文は Markdown なので、そのまま文字で入れると `##` や `**` が記号のまま残る。
 *
 * 扱う書き方: 見出し（`#`〜`######`）・段落・太字（`**…**`）・行の中のコード（`` `…` ``）・リンク（`[文字](https://…)`）・
 * 箇条書き（`-`・`*`・`+`。字下げで入れ子）・番号（`1.`）・引用（`>`）・表（見出しのすぐ次に `|---|` の行）・
 * コードの囲み（```）・区切り線（`---`）。**中身の文字はすべてエスケープする**（本文に HTML が書かれていても、文字として入れる）。
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 行の中の書式。エスケープしてから、太字・コード・リンクだけを書式にする。 */
function inline(text: string): string {
  const codes: string[] = [];
  // コードの中は書式にしない。先に取り出して、最後に戻す
  let s = text.replace(/`([^`]+)`/g, (_m, c: string) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // リンクは http(s) だけを押せるようにする
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t: string, u: string) => `<a href="${u}">${t}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${esc(codes[Number(i)] ?? '')}</code>`);
}

/** 箇条書きの 1 行。字下げ（空白の数）と、番号つきかどうか。 */
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/**
 * Markdown を HTML にする。
 *
 * @returns `<html>` で包んだ HTML。Google ドライブに `text/html` として取り込ませる
 */
export function markdownToDocHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) { flush(); continue; }

    const fence = /^\s*```/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) body.push(lines[i]!);
      out.push(`<pre>${esc(body.join('\n'))}</pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { flush(); out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`); continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }

    // 表: 見出しの行のすぐ次に区切りの行
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) rows.push(cells(lines[i]!));
      i--;
      out.push(
        '<table border="1" style="border-collapse:collapse">',
        `<tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>`,
        ...rows.map((r) => `<tr>${head.map((_c, j) => `<td>${inline(r[j] ?? '')}</td>`).join('')}</tr>`),
        '</table>',
      );
      continue;
    }

    if (/^\s*>/.test(line)) {
      flush();
      const body: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) body.push(lines[i]!.replace(/^\s*>\s?/, ''));
      i--;
      out.push(`<blockquote>${markdownToDocHtml(body.join('\n')).replace(/^<html><body>|<\/body><\/html>$/g, '')}</blockquote>`);
      continue;
    }

    if (LIST.test(line)) {
      flush();
      const items: { indent: number; ordered: boolean; text: string }[] = [];
      for (; i < lines.length; i++) {
        const m = LIST.exec(lines[i]!);
        if (!m) break;
        items.push({ indent: m[1]!.replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]!), text: m[3]! });
      }
      i--;
      out.push(renderList(items));
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return `<html><body>${out.join('\n')}</body></html>`;
}

/** 箇条書きを入れ子の `<ul>`・`<ol>` にする。字下げが深くなったら、1 つ前の項目の下に入れる。 */
function renderList(items: { indent: number; ordered: boolean; text: string }[]): string {
  let html = '';
  const stack: { indent: number; tag: 'ul' | 'ol' }[] = [];
  for (const it of items) {
    const tag = it.ordered ? 'ol' : 'ul';
    while (stack.length > 0 && it.indent < stack[stack.length - 1]!.indent) html += `</li></${stack.pop()!.tag}>`;
    const top = stack[stack.length - 1];
    if (!top || it.indent > top.indent) {
      html += `<${tag}>`;
      stack.push({ indent: it.indent, tag });
    } else {
      html += '</li>';
    }
    html += `<li>${inline(it.text)}`;
  }
  while (stack.length > 0) html += `</li></${stack.pop()!.tag}>`;
  return html;
}
