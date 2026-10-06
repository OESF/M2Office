/**
 * @file 2 つの版の文書を、条項ごとに並べて比べる（仕様書 第28.13節）。契約書チェックが、相手から戻ってきた修正版と前の版を比べるのに使う。
 *
 * **変わったところを見つけるのはプログラムで、推論ではない**（見落とさないため）。推論は、ここが返した変更の 1 つずつについて、当社への影響を読む。
 * 条項は「第〇条」「Article 〇」の見出しで分け、見出しの題名と中身の近さで前の版と結び付ける（条の番号がずれても追える）。
 * 結び付いた条項の中は、文（「。」と改行で分ける）の単位で比べる（全角と半角の違いは無くして比べ、返す文も半角にそろえる）。
 * 中身はデータであり、指示として扱わない（不変則 I-6）。
 */

/** 条項の 1 つ。 */
export interface Clause {
  /** 条の番号（「第5条」「Article 5」。前文は空） */
  number: string;
  /** 見出しの題名（「（損害賠償）」の中身。無ければ空） */
  title: string;
  /** 見出しを含む本文 */
  text: string;
}

/** 条項の 1 つの変わり方。 */
export interface ClauseChange {
  kind: 'changed' | 'added' | 'removed';
  /** 前の版の条項（足されたものは `null`） */
  before: { number: string; title: string } | null;
  /** 新しい版の条項（消されたものは `null`） */
  after: { number: string; title: string } | null;
  /** 前の版にだけある文 */
  removed: string[];
  /** 新しい版にだけある文 */
  added: string[];
}

/** 比べた結果。 */
export interface Comparison {
  beforeClauses: number;
  afterClauses: number;
  /** 中身の変わらなかった条項の数（番号だけ変わったものを含む） */
  unchanged: number;
  /** 中身は同じで、番号だけ変わった条項（「第5条 → 第6条」） */
  renumbered: string[];
  changes: ClauseChange[];
  /** 文の重なり（0〜1）。低ければ別の文書の見込み */
  similarity: number;
}

/** 1 つの文の長さの上限（返すとき） */
const SENTENCE_MAX = 400;
/** 返す変更の数の上限 */
const CHANGES_MAX = 60;

const KANJI_NUM = '〇一二三四五六七八九十百';
const HEAD = new RegExp(`^\\s*(第\\s*[0-9${KANJI_NUM}]+\\s*条(?:の[0-9${KANJI_NUM}]+)?|Article\\s+\\d+(?:\\.\\d+)?)\\s*(.*)$`, 'i');

/** 比べるための形（全角と半角・空白の違いを無くす）。 */
const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, '');

/** 見出しの行から題名を取り出す（「（損害賠償）」「(Confidentiality)」「損害賠償」）。 */
function titleOf(rest: string): string {
  const t = rest.normalize('NFKC').trim();
  const paren = /^\(([^)]{1,40})\)/.exec(t);
  if (paren) return paren[1]!.trim();
  // 見出しの後ろにそのまま本文が続く書き方では、題名は無いとみなす
  return t.length <= 20 && !/[。.]$/.test(t) ? t : '';
}

/**
 * 文書を条項に分ける。最初の条より前は前文（番号は空）にする。
 *
 * @param text 文書の文字
 */
export function splitClauses(text: string): Clause[] {
  const out: Clause[] = [];
  let cur: Clause = { number: '', title: '前文', text: '' };
  for (const line of text.split(/\r?\n/)) {
    const m = HEAD.exec(line.normalize('NFKC').replace(/^[#\s*]+/, ''));
    if (m) {
      if (cur.text.trim()) out.push(cur);
      cur = { number: norm(m[1]!), title: titleOf(m[2] ?? ''), text: `${line}\n` };
    } else {
      cur.text += `${line}\n`;
    }
  }
  if (cur.text.trim()) out.push(cur);
  return out;
}

/** 文に分ける（「。」と改行。空と、見出しの行の番号は除く）。 */
function sentences(c: Clause): string[] {
  return c.text.split(/(?<=[。．.])\s*|\r?\n/)
    .map((s) => s.normalize('NFKC').trim().replace(HEAD, (_m, _n, rest: string) => rest))
    .map((s) => s.replace(/^[#*\s]+/, '').trim())
    // 見出しの題名だけの行（「（損害賠償）」）は文に数えない（題名は条項の見出しで返す）
    .filter((s) => s.length > 0 && !/^\([^)]{1,40}\)$/.test(s));
}

/** 2 つの並びの最長の共通部分の印（どちらの要素が共通か）。 */
function lcs(a: string[], b: string[]): { inA: boolean[]; inB: boolean[] } {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const inA = new Array<boolean>(n).fill(false);
  const inB = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { inA[i] = true; inB[j] = true; i++; j++; } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++; else j++;
  }
  return { inA, inB };
}

/** 文字の 2 つ組の重なり（0〜1）。条項の近さに使う。 */
function closeness(a: string, b: string): number {
  const grams = (s: string) => {
    const t = norm(s);
    const set = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const x = grams(a);
  const y = grams(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const g of x) if (y.has(g)) both++;
  return (2 * both) / (x.size + y.size);
}

/** 文の重なりの割合（共通の文の数の 2 倍を、両方の文の数の和で割る）。 */
function dice(shared: number, a: Clause[], b: Clause[]): number {
  const n = a.reduce((x, c) => x + sentences(c).length, 0) + b.reduce((x, c) => x + sentences(c).length, 0);
  return n ? (2 * shared) / n : 0;
}

/** 条項の本文から、番号の行を除いた中身（番号だけが変わったかを見るため）。 */
const body = (c: Clause) => sentences(c).map(norm).join('');

/**
 * 2 つの版を比べる。前の版の条項と新しい版の条項を、題名が同じものから結び、残りは中身の近さ（半分より近い）で結ぶ。
 *
 * @param before 前の版の文字
 * @param after 新しい版の文字
 */
export function compareTexts(before: string, after: string): Comparison {
  const a = splitClauses(before);
  const b = splitClauses(after);
  const pair = new Map<number, number>();
  const usedB = new Set<number>();
  // 1. 前文どうし・題名が同じ条項どうし（並びの順に）
  a.forEach((c, i) => {
    const key = c.number ? norm(c.title) : '前文';
    if (!key) return;
    const j = b.findIndex((d, k) => !usedB.has(k) && (d.number ? norm(d.title) : '前文') === key);
    if (j >= 0) { pair.set(i, j); usedB.add(j); }
  });
  // 2. 残りは中身の近さで（近いものから）
  const cands: { i: number; j: number; s: number }[] = [];
  a.forEach((c, i) => {
    if (pair.has(i)) return;
    b.forEach((d, j) => { if (!usedB.has(j)) cands.push({ i, j, s: closeness(c.text, d.text) }); });
  });
  for (const x of cands.sort((p, q) => q.s - p.s)) {
    if (x.s < 0.5 || pair.has(x.i) || usedB.has(x.j)) continue;
    pair.set(x.i, x.j);
    usedB.add(x.j);
  }

  const head = (c: Clause) => ({ number: c.number, title: c.title });
  const clip = (s: string) => (s.length > SENTENCE_MAX ? `${s.slice(0, SENTENCE_MAX)}…` : s);
  const changes: ClauseChange[] = [];
  const renumbered: string[] = [];
  let unchanged = 0;
  let shared = 0;
  // 新しい版の並びの順に出す（消された条項は、前の版で直前にあった条項の後ろ）
  const order: { at: number; change: ClauseChange | null }[] = [];
  a.forEach((c, i) => {
    const j = pair.get(i);
    const sa = sentences(c);
    if (j === undefined) {
      const prev = [...pair.entries()].filter(([k]) => k < i).map(([, v]) => v);
      order.push({ at: (prev.length ? Math.max(...prev) : -1) + 0.5, change: { kind: 'removed', before: head(c), after: null, removed: sa.map(clip), added: [] } });
      return;
    }
    const d = b[j]!;
    const sb = sentences(d);
    const { inA, inB } = lcs(sa.map(norm), sb.map(norm));
    shared += inA.filter(Boolean).length;
    if (body(c) === body(d)) {
      unchanged += 1;
      if (c.number !== d.number) renumbered.push(`${c.number} → ${d.number}`);
      return;
    }
    order.push({
      at: j,
      change: { kind: 'changed', before: head(c), after: head(d), removed: sa.filter((_, k) => !inA[k]).map(clip), added: sb.filter((_, k) => !inB[k]).map(clip) },
    });
  });
  b.forEach((d, j) => {
    if (usedB.has(j)) return;
    order.push({ at: j, change: { kind: 'added', before: null, after: head(d), removed: [], added: sentences(d).map(clip) } });
  });
  for (const o of order.sort((x, y) => x.at - y.at)) if (o.change) changes.push(o.change);
  return {
    beforeClauses: a.length, afterClauses: b.length, unchanged, renumbered, changes: changes.slice(0, CHANGES_MAX),
    similarity: Math.round(dice(shared, a, b) * 100) / 100,
  };
}
