/**
 * @file ヘルプの記事の Markdown を、表示のためのまとまり（見出し・段落・箇条書き）に分ける。
 *
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
  | { kind: 'ul' | 'ol'; items: string[] };

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
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') { flush(); continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      // 記事の題名は画面の見出し（h1）が持つため、本文の # と ## はどちらも h2 にする
      blocks.push({ kind: h[1]!.length === 3 ? 'h3' : 'h2', text: h[2]!.trim() });
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
