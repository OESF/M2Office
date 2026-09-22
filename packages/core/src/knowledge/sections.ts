/**
 * @file 組織知識の本文を、検索と出典の単位である「節」に分ける。
 *
 * 規程は章・条で書かれるため、条の単位で引くのが最も正確で説明しやすい（ADR-0008）。
 * 分け方は本文の書き方から機械的に決め、LLM は使わない。同じ本文は毎回同じに分かれる。
 *
 * @see 仕様書 第11.7.2節 取り込み時の分割
 */

/** 節の 1 つ。 */
export interface KnowledgeSection {
  /** 文書の中での順序（0 から）。 */
  ordinal: number;
  /** 節の見出し（例: `第23条（年次有給休暇）`）。見出しのない短い文書では空。 */
  heading: string;
  /** 上位の見出しの経路（例: `['第5章 休暇']`）。 */
  path: string[];
  body: string;
}

/** 1 件の文書の大きさの上限（字）。超える場合は登録を断る（第11.7.2節）。 */
export const KNOWLEDGE_MAX_CHARS = 500_000;
/** これを超える節は段落の境で分ける（字）。 */
export const SECTION_MAX_CHARS = 2_000;
/** 見出しのない文書を段落でまとめるときの目安（字）。 */
const CHUNK_CHARS = 1_000;
/**
 * 分け方の版。分け方を変えたら 1 つ上げる。
 *
 * @remarks 保存済みの知識のうち、これより古い版で分けたものは、次の検索の前に分け直す（第11.7.5節）。
 */
export const SPLIT_VERSION = 1;

const NUM = '[0-9０-９一二三四五六七八九十百千〇]+';
/** 行頭の「第○条」。「第○条の二」も認める。後ろに見出しの括弧や本文が続いてよい。 */
const ARTICLE = new RegExp(`^第${NUM}条(?:の${NUM})?`);
/** 行頭の「第○編・章・節・款」。 */
const CHAPTER = new RegExp(`^第${NUM}([編章節款])(?:\\s|$|[^\\s条])`);
/** 附則。 */
const SUPPLEMENT = /^附\s*則/;
/** Markdown の見出し（#〜###）。 */
const MD_HEADING = /^(#{1,3})\s+(.+)$/;
/** 条の前の行に置く、括弧だけの見出し（例: `（年次有給休暇）`）。 */
const CAPTION = /^[（(]([^）)]{1,40})[）)]$/;

/** 条の番号のすぐ後にこれが続けば、見出しではなく条を引用した本文。 */
const REFERENCE = /^(?:の規定|に定め|により|による|で定め|を準用|から|まで|及び|又は|並びに|若しくは|、)/;

/** 見出しの深さ。条は常に末端。 */
const CHAPTER_LEVEL: Record<string, number> = { 編: 1, 章: 2, 節: 3, 款: 4 };
const LEAF = 99;

interface Heading { level: number; text: string; rest: string }

/** 空白を 1 つに揃える（全角の空白も）。 */
function squash(s: string): string {
  return s.replace(/[\s　]+/g, ' ').trim();
}

/**
 * 行が見出しなら、その深さと見出しの文を返す。
 *
 * @param caption 直前の行が括弧だけの見出しなら、その中身
 */
function headingOf(line: string, caption: string | null): Heading | null {
  const t = line.replace(/^[\s　]+/, '');
  const md = MD_HEADING.exec(t);
  if (md) return { level: md[1]!.length + 1, text: squash(md[2]!), rest: '' };
  const art = ARTICLE.exec(t);
  // 「第3条の規定により…」のように、条を引用して始まる本文の行は見出しにしない
  if (art && !REFERENCE.test(t.slice(art[0].length))) {
    let rest = t.slice(art[0].length);
    let label = caption;
    const inParen = /^[\s　]*[（(]([^）)]{1,40})[）)]/.exec(rest);
    if (inParen) { label = inParen[1]!; rest = rest.slice(inParen[0].length); }
    return { level: LEAF, text: `${art[0]}${label ? `（${squash(label)}）` : ''}`, rest: rest.trim() };
  }
  const ch = CHAPTER.exec(t);
  if (ch && t.length <= 40 && !t.includes('。')) return { level: CHAPTER_LEVEL[ch[1]!] ?? 2, text: squash(t), rest: '' };
  if (SUPPLEMENT.test(t)) return { level: 2, text: '附則', rest: squash(t.replace(SUPPLEMENT, '')) };
  return null;
}

/**
 * 長すぎる本文を、段落（空行）の境で分ける。段落そのものが長ければ行、さらに長ければ字数で切る。
 */
function splitLong(body: string, max: number): string[] {
  if (body.length <= max) return [body];
  const units = body.split(/\n\s*\n/).flatMap((p) => (p.length <= max ? [p] : p.split('\n')))
    .flatMap((p) => {
      const out: string[] = [];
      for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
      return out;
    });
  const parts: string[] = [];
  let cur = '';
  for (const u of units) {
    if (cur && cur.length + u.length + 1 > max) { parts.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${u}` : u;
  }
  if (cur) parts.push(cur);
  return parts;
}

/**
 * 本文を節に分ける。
 *
 * @param body 知識の本文
 * @returns 節の並び。本文が空なら空の配列
 *
 * @remarks
 * 見出しとみなす行は、優先の高い順に「第○条」「第○章・節・附則」「Markdown の見出し」（第11.7.2節の表）。
 * 見出しがない文書は、空行で区切った段落をおよそ 1,000 字ずつにまとめる。
 * 2,000 字を超える節は段落の境で分け、見出しに「（続き）」を付ける。
 *
 * @example
 * splitKnowledge('第5章 休暇\n第23条（年次有給休暇）\n6 か月で 10 日を付与する。')
 * // → [{ ordinal: 0, heading: '第23条（年次有給休暇）', path: ['第5章 休暇'], body: '6 か月で 10 日を付与する。' }]
 */
export function splitKnowledge(body: string): KnowledgeSection[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const raw: { heading: string; path: string[]; lines: string[]; leaf: boolean }[] = [];
  const stack: { level: number; text: string }[] = [];
  let current: (typeof raw)[number] = { heading: '', path: [], lines: [], leaf: false };
  let sawHeading = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    // 括弧だけの行が次の「第○条」の見出しなら、条の見出しとして使い、本文には入れない
    const cap = CAPTION.exec(trimmed);
    const next = lines[i + 1]?.replace(/^[\s　]+/, '') ?? '';
    if (cap && ARTICLE.test(next)) {
      const h = headingOf(next, cap[1]!)!;
      raw.push(current);
      current = { heading: h.text, path: stack.map((s) => s.text), lines: h.rest ? [h.rest] : [], leaf: true };
      sawHeading = true;
      i++;
      continue;
    }
    const h = trimmed ? headingOf(line, null) : null;
    if (!h) { current.lines.push(line); continue; }
    sawHeading = true;
    raw.push(current);
    if (h.level === LEAF) {
      current = { heading: h.text, path: stack.map((s) => s.text), lines: h.rest ? [h.rest] : [], leaf: true };
    } else {
      while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) stack.pop();
      current = { heading: h.text, path: stack.map((s) => s.text), lines: h.rest ? [h.rest] : [], leaf: false };
      stack.push({ level: h.level, text: h.text });
    }
  }
  raw.push(current);

  const text = (ls: string[]) => ls.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // 見出しがない文書は、段落をまとめて分ける
  if (!sawHeading) {
    const all = text(raw[0]!.lines);
    if (!all) return [];
    const chunks = all.length <= SECTION_MAX_CHARS ? [all] : splitLong(all, CHUNK_CHARS);
    return chunks.map((b, i) => ({
      ordinal: i, heading: chunks.length === 1 ? '' : `本文（${i + 1}/${chunks.length}）`, path: [], body: b,
    }));
  }

  const out: KnowledgeSection[] = [];
  for (const [i, s] of raw.entries()) {
    const b = text(s.lines);
    // 章の見出しだけの行（直下に本文がない）は節にしない。条は本文がなくても残す（「第5条（削除）」など）
    if (!b && !s.leaf) continue;
    const heading = i === 0 && !s.heading ? '前文' : s.heading;
    const parts = splitLong(b || heading, SECTION_MAX_CHARS);
    parts.forEach((p, j) => out.push({
      ordinal: out.length, heading: j === 0 ? heading : `${heading}（続き）`, path: s.path, body: p,
    }));
  }
  return out;
}

/**
 * 節の出典を書く（第11.7.4節）。
 *
 * @example citationOf('就業規則', { heading: '第23条（年次有給休暇）', path: ['第5章 休暇'] })
 * // → '就業規則 › 第5章 休暇 › 第23条（年次有給休暇）'
 */
export function citationOf(title: string, s: Pick<KnowledgeSection, 'heading' | 'path'>): string {
  return [title, ...s.path, s.heading].filter(Boolean).join(' › ');
}
