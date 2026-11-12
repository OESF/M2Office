/**
 * @file サイトの更新の、本文の分け方と組み直し（仕様書 第45.5節）。
 *
 * WordPress の本文（編集用の形。ブロックの印 `<!-- wp:… -->` と HTML の札を含む）を、
 * **文のかたまり**（段落・見出し・箇条書きの 1 行・表のます・ボタンの文字など）に分けて番号を振る。
 * 推論には文のかたまりだけを渡し、印と札はプログラムが持って元のまま組み直す。
 * 組み直した後に、頼まれた番号の外が 1 文字も変わっていないこと、決めた札の外を足していないことを確かめる。
 * ページの文は外部のデータであり、指示として読まない（不変則 I-6）。
 */

/** 本文を分けた 1 つ（印・札・文）。 */
type Token = { kind: 'comment' | 'tag' | 'text'; raw: string };

/** 文のかたまり 1 つ。推論にはこれだけを渡す。 */
export interface SiteSegment {
  /** 番号（1 から）。 */
  id: number;
  /** かたまりの中身（文と、行の中の札）。 */
  html: string;
  /** かたまりを包む札の名前（`p`・`h2`・`li`・`td` など。分からなければ空）。 */
  container: string;
}

/** 推論が返す直し 1 つ。 */
export type SiteEditOp =
  | { op: 'replace'; id: number; html: string }
  | { op: 'delete'; id: number }
  | { op: 'insert'; after: number; html: string; kind: 'paragraph' | 'list-item' };

/** かたまり 1 つの位置。 */
interface SegmentRange {
  id: number;
  /** token の始まり（含む）と終わり（含まない）。 */
  start: number;
  end: number;
  /** 包む札の名前と、その開く札の token の番号（無ければ -1）。 */
  container: string;
  openIdx: number;
}

/** 分けた本文。組み直しに使う。 */
export interface SegmentedContent {
  tokens: Token[];
  /** かたまりごとの、token の始まり（含む）と終わり（含まない）と、包む札。 */
  ranges: SegmentRange[];
  segments: SiteSegment[];
  /** ブロックの印があるか（ブロックエディターで書いたか）。 */
  blocks: boolean;
}

/** かたまりの切れ目になる札（ブロックの札）。 */
const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'caption', 'figcaption', 'figure', 'blockquote', 'div', 'section', 'article', 'header', 'footer', 'aside', 'nav', 'main', 'pre',
  'hr', 'img', 'iframe', 'video', 'audio', 'picture', 'source', 'form', 'details', 'summary', 'address', 'script', 'style', 'noscript',
  'svg', 'canvas', 'object', 'embed', 'select', 'textarea', 'button', 'input', 'label', 'fieldset', 'legend',
]);
/** 閉じる札を持たない札。 */
const VOID_TAGS = new Set(['hr', 'img', 'source', 'input', 'embed', 'br', 'wbr', 'col', 'area', 'meta', 'link', 'param', 'track']);
/** 消してよい（包むブロックごと外してよい）かたまりの札。表のますなどは消すと崩れる。 */
const DELETABLE = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'figcaption', 'blockquote', 'dt', 'dd']);
/** 中の文を読まない札（中身ごと 1 つの印として持つ）。 */
const OPAQUE_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'textarea', 'pre', 'iframe', 'object']);
/** 推論が新しく足してよい、行の中の札。 */
const ADDABLE_TAG = /^<\/?(?:strong|em|b|i)>$|^<br\s*\/?>$|^<\/a>$|^<a href="(?:https:\/\/[^"<>\s]+|tel:[0-9+\-()]+|mailto:[^"<>\s@]+@[^"<>\s]+)">$/i;
/** 足してはいけないもの（札の外の確かめにも使う）。 */
const DANGEROUS = /<\s*(?:script|iframe|object|embed|style|link|meta|form|input|svg)\b|\son[a-z]+\s*=|javascript:|style\s*=/i;

/**
 * ページビルダーで作った本文か（直さない。第45.4節、Q-333）。
 *
 * @returns ビルダーの名前。見分けられなければ `null`（入れた後の公開のページでの確かめで分かる。第45.7節）
 */
export function looksLikePageBuilder(raw: string): string | null {
  if (/\[(?:et_pb_|vc_row|vc_column|fusion_|cs_section|themify_builder)/i.test(raw)) return 'ショートコードで組むページビルダー';
  if (/elementor/i.test(raw) && !/<!--\s*wp:/i.test(raw)) return 'Elementor';
  return null;
}

function tokenize(raw: string): Token[] {
  const out: Token[] = [];
  const re = /<!--[\s\S]*?-->|<\/?[A-Za-z][^<>]*>/g;
  let last = 0;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    if (m.index > last) out.push({ kind: 'text', raw: raw.slice(last, m.index) });
    out.push({ kind: m[0].startsWith('<!--') ? 'comment' : 'tag', raw: m[0] });
    last = m.index + m[0].length;
  }
  if (last < raw.length) out.push({ kind: 'text', raw: raw.slice(last) });
  // 中身を読まない札は、閉じる札までを 1 つの印にまとめる
  const merged: Token[] = [];
  for (let i = 0; i < out.length; i++) {
    const t = out[i]!;
    const name = t.kind === 'tag' ? tagName(t.raw) : '';
    if (t.kind === 'tag' && OPAQUE_TAGS.has(name) && !t.raw.startsWith('</') && !t.raw.endsWith('/>')) {
      let j = i + 1;
      let raw2 = t.raw;
      while (j < out.length && !(out[j]!.kind === 'tag' && out[j]!.raw.toLowerCase().startsWith(`</${name}`))) raw2 += out[j++]!.raw;
      if (j < out.length) raw2 += out[j]!.raw;
      merged.push({ kind: 'comment', raw: raw2 });
      i = j;
      continue;
    }
    merged.push(t);
  }
  return merged;
}

function tagName(raw: string): string {
  return /^<\/?\s*([A-Za-z][\w-]*)/.exec(raw)?.[1]?.toLowerCase() ?? '';
}

function isBoundary(t: Token): boolean {
  return t.kind === 'comment' || (t.kind === 'tag' && BLOCK_TAGS.has(tagName(t.raw)));
}

/**
 * 本文を文のかたまりに分ける。
 *
 * @param raw 編集用の本文（`content.raw`）
 */
export function segmentContent(raw: string): SegmentedContent {
  const tokens = tokenize(raw);
  const ranges: SegmentRange[] = [];
  // 開いているブロックの札（名前と token の番号）。かたまりを包む札は、いちばん内側のもの
  const stack: { name: string; idx: number }[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (isBoundary(t)) {
      if (t.kind === 'tag') {
        const name = tagName(t.raw);
        if (t.raw.startsWith('</')) {
          const at = stack.map((x) => x.name).lastIndexOf(name);
          if (at >= 0) stack.length = at;
        } else if (!VOID_TAGS.has(name) && !t.raw.endsWith('/>')) {
          stack.push({ name, idx: i });
        }
      }
      i++;
      continue;
    }
    // 切れ目までの行の中のもの（文と行の中の札）を 1 つのかたまりにする
    let j = i;
    while (j < tokens.length && !isBoundary(tokens[j]!)) j++;
    const html = tokens.slice(i, j).map((x) => x.raw).join('');
    if (html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()) {
      // 前後の空白と改行はかたまりに入れない（組み直しで崩さないため）
      let s = i;
      let e = j;
      while (s < e && tokens[s]!.kind === 'text' && !tokens[s]!.raw.trim()) s++;
      while (e > s && tokens[e - 1]!.kind === 'text' && !tokens[e - 1]!.raw.trim()) e--;
      const top = stack[stack.length - 1];
      ranges.push({ id: ranges.length + 1, start: s, end: e, container: top?.name ?? '', openIdx: top?.idx ?? -1 });
    }
    i = j;
  }
  const segments = ranges.map((r) => ({ id: r.id, container: r.container, html: tokens.slice(r.start, r.end).map((x) => x.raw).join('') }));
  return { tokens, ranges, segments, blocks: /<!--\s*wp:/i.test(raw) };
}

/** 札だけを並べる（足した札の確かめ用）。 */
function tagsOf(html: string): string[] {
  return html.match(/<[^>]+>/g) ?? [];
}

/** 推論が返した行の中の HTML が、決めた札だけでできているか。 */
function checkInline(html: string, original: string): string | null {
  if (DANGEROUS.test(html)) return 'スクリプト・埋め込み・見た目の指定は足せません';
  if (/<!--/.test(html)) return 'ブロックの印は足せません';
  const kept = new Set(tagsOf(original));
  for (const tag of tagsOf(html)) {
    if (kept.has(tag)) continue;
    if (!ADDABLE_TAG.test(tag)) return `足せない札があります（${tag.slice(0, 40)}）`;
  }
  return null;
}

/** 組み直した結果。 */
export type ApplyResult = { ok: true; raw: string; changed: number[] } | { ok: false; error: string };

/**
 * 直しを本文に当てる。頼まれた番号の外は、元の印と札と文をそのまま使う。
 *
 * @returns 組み直した本文と、変えたかたまりの番号。決まりに合わなければ理由
 */
export function applySiteEdits(content: SegmentedContent, ops: readonly SiteEditOp[]): ApplyResult {
  const byId = new Map(content.ranges.map((r) => [r.id, r]));
  const replace = new Map<number, string | null>();
  const inserts = new Map<number, { html: string; kind: 'paragraph' | 'list-item' }[]>();
  for (const op of ops) {
    if (op.op === 'insert') {
      const r = byId.get(op.after);
      if (!r) return { ok: false, error: `番号 ${op.after} のかたまりがありません` };
      const problem = checkInline(op.html, '');
      if (problem) return { ok: false, error: problem };
      if (op.kind === 'list-item' && r.container !== 'li') return { ok: false, error: `番号 ${op.after} は箇条書きの行ではありません` };
      inserts.set(op.after, [...(inserts.get(op.after) ?? []), { html: op.html, kind: op.kind }]);
      continue;
    }
    const r = byId.get(op.id);
    if (!r) return { ok: false, error: `番号 ${op.id} のかたまりがありません` };
    if (replace.has(op.id)) return { ok: false, error: `番号 ${op.id} を 2 度直そうとしています` };
    if (op.op === 'replace') {
      const original = content.tokens.slice(r.start, r.end).map((x) => x.raw).join('');
      const problem = checkInline(op.html, original);
      if (problem) return { ok: false, error: problem };
      if (!op.html.replace(/<[^>]*>/g, '').trim()) return { ok: false, error: `番号 ${op.id} を空にするときは、消す直しにしてください` };
      replace.set(op.id, op.html);
    } else {
      if (!DELETABLE.has(r.container)) return { ok: false, error: `番号 ${op.id} は消せないかたまりです（表のますなど。文を直してください）` };
      replace.set(op.id, null);
    }
  }
  // 消すかたまりは、包むブロック（印か札）ごと外す。外す範囲を token の番号で決める
  const drop = new Set<number>();
  for (const [id, html] of replace) {
    if (html !== null) continue;
    const r = byId.get(id)!;
    const [s, e] = enclosingBlock(content, r);
    const others = content.ranges.filter((x) => x.id !== id && x.start >= s && x.end <= e);
    if (others.length || (s === r.start && e === r.end)) return { ok: false, error: `番号 ${id} は、包むブロックを見分けられないので消せません` };
    for (let k = s; k < e; k++) drop.add(k);
  }
  const out: string[] = [];
  const startOf = new Map(content.ranges.map((r) => [r.start, r]));
  let k = 0;
  while (k < content.tokens.length) {
    const r = startOf.get(k);
    if (drop.has(k)) {
      k++;
      continue;
    }
    if (r) {
      const html = replace.get(r.id);
      out.push(html === undefined ? content.tokens.slice(r.start, r.end).map((x) => x.raw).join('') : html ?? '');
      k = r.end;
      const after = inserts.get(r.id);
      if (after) {
        // 足すものは、そのかたまりを包むブロックの後ろに置く
        const [, e] = enclosingBlock(content, r);
        while (k < e) {
          if (!drop.has(k)) out.push(content.tokens[k]!.raw);
          k++;
        }
        for (const a of after) out.push(blockFor(a, content.blocks));
      }
      continue;
    }
    out.push(content.tokens[k]!.raw);
    k++;
  }
  const raw = out.join('');
  // 確かめ: 直していないかたまりが、順も中身も元のままか（組み直した本文を分け直し、元のかたまりが同じ順で残っているか）
  const before = content.segments.filter((s) => !replace.has(s.id)).map((s) => s.html);
  const after = segmentContent(raw).segments.map((s) => s.html);
  const deleted = [...replace.values()].filter((v) => v === null).length;
  const inserted = [...inserts.values()].reduce((n, a) => n + a.length, 0);
  if (after.length !== content.segments.length - deleted + inserted || !isSubsequence(before, after)) {
    return { ok: false, error: '頼まれていない所が変わってしまいました' };
  }
  // 確かめ: 危ないものが増えていないか
  const danger = (s: string) => (s.match(new RegExp(DANGEROUS.source, 'gi')) ?? []).length;
  if (danger(raw) > danger(content.tokens.map((x) => x.raw).join(''))) return { ok: false, error: 'スクリプト・埋め込み・見た目の指定が増えてしまいました' };
  const changed = [...new Set([...replace.keys(), ...inserts.keys()])].sort((a, b) => a - b);
  return { ok: true, raw, changed };
}

/** `part` が `whole` の中に、同じ順で現れるか。 */
function isSubsequence(part: readonly string[], whole: readonly string[]): boolean {
  let k = 0;
  for (const w of whole) if (k < part.length && part[k] === w) k++;
  return k === part.length;
}

/** かたまりを包むブロック（ブロックの印があれば印から印まで、無ければ包む札から閉じる札まで）の token の範囲。 */
function enclosingBlock(content: SegmentedContent, r: SegmentRange): [number, number] {
  const t = content.tokens;
  if (r.openIdx < 0) return [r.start, r.end];
  // 開く札に合う閉じる札を、同じ名前の札の入れ子を数えて探す
  let depth = 0;
  let e = -1;
  for (let k = r.openIdx; k < t.length; k++) {
    const x = t[k]!;
    if (x.kind !== 'tag' || tagName(x.raw) !== r.container) continue;
    depth += x.raw.startsWith('</') ? -1 : 1;
    if (depth === 0) {
      e = k + 1;
      break;
    }
  }
  if (e < 0) return [r.start, r.end];
  let s = r.openIdx;
  if (content.blocks) {
    // 札のすぐ外側にブロックの印があれば、印ごと含める（空白をはさんでよい）
    let ps = s;
    while (ps > 0 && t[ps - 1]!.kind === 'text' && !t[ps - 1]!.raw.trim()) ps--;
    let pe = e;
    while (pe < t.length && t[pe]!.kind === 'text' && !t[pe]!.raw.trim()) pe++;
    const open = t[ps - 1];
    const close = t[pe];
    if (open?.kind === 'comment' && /^<!--\s*wp:/i.test(open.raw) && close?.kind === 'comment' && /^<!--\s*\/wp:/i.test(close.raw)) {
      s = ps - 1;
      e = pe + 1;
      // 後ろの空白（ブロックの間の空行）も 1 つ外す
      if (t[e]?.kind === 'text' && !t[e]!.raw.trim()) e++;
    }
  }
  return [s, e];
}

/** 足すかたまりの、ブロックの形。 */
function blockFor(a: { html: string; kind: 'paragraph' | 'list-item' }, blocks: boolean): string {
  if (a.kind === 'list-item') return blocks ? `\n<!-- wp:list-item -->\n<li>${a.html}</li>\n<!-- /wp:list-item -->` : `\n<li>${a.html}</li>`;
  return blocks ? `\n\n<!-- wp:paragraph -->\n<p>${a.html}</p>\n<!-- /wp:paragraph -->` : `\n<p>${a.html}</p>`;
}

/** HTML から、人が読む文だけを取り出す（公開のページでの確かめと、承認の画面の文に使う）。 */
export function plainText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    // ブロックの札は切れ目にし、行の中の札（太字・リンクなど）は跡を残さず外す
    .replace(/<\/?(?:p|div|li|ul|ol|h[1-6]|tr|td|th|table|thead|tbody|section|article|header|footer|nav|aside|main|blockquote|figure|figcaption|dt|dd|dl|title|body|html|head)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t　]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}
