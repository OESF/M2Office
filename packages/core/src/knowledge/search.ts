/**
 * @file 組織知識の検索で、質問から言葉を取り出し、節に点数を付けて並べる。
 *
 * データベースからは候補の節を受け取るだけにし、並べ方はここで決める。
 * そのため、索引の拡張機能（pg_bigm）の有無で結果は変わらない（ADR-0008）。
 *
 * @see 仕様書 第11.7.3節 検索と並べ替え
 * @see 仕様書 第11.7.4節 推論への渡し方と出典
 * @see 仕様書 第11.7.7節 言い換えの登録
 */

/** 返す節の数の上限。 */
export const SEARCH_MAX_SECTIONS = 5;
/** 推論へ渡す本文の合計の上限（字）。 */
export const SEARCH_MAX_CHARS = 8_000;
/** データベースから受け取る候補の上限。 */
export const SEARCH_CANDIDATES = 200;

/** 点数を付ける対象の節。 */
export interface ScoredCandidate {
  heading: string;
  path: string[];
  body: string;
  updatedAt: string;
}

/** 漢字・カタカナ・英数字の連なり（ひらがなや記号で区切る）。 */
const CONTENT_RUN = /[\p{Script=Han}\p{Script=Katakana}ー々〆ヶA-Za-z0-9]+/gu;
/** ひらがなだけの語。助詞や語尾なので言葉にしない。 */
const HIRAGANA_ONLY = /^[\p{Script=Hiragana}ー]+$/u;
/** 質問によく出るが、知識を探す手がかりにならない語。 */
const STOP = new Set(['教え', '教えて', '知り', '知りたい', '聞き', '調べ', '確認', '場合', '何日', '何時', 'どう', '内容', '方法は']);

let segmenter: Intl.Segmenter | null | undefined;
/** 日本語の単語の区切り。実行環境に無ければ使わない。 */
function wordSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    try { segmenter = new Intl.Segmenter('ja', { granularity: 'word' }); } catch { segmenter = null; }
  }
  return segmenter;
}

/** 検索のための正規化（全角英数を半角に、英字を小文字に）。保存する検索用の文にも同じものを使う。 */
export function normalizeForSearch(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

/**
 * 質問の文から検索の言葉を取り出す。
 *
 * @returns 2 文字以上の言葉（重複なし、正規化済み）
 *
 * @remarks
 * 漢字・カタカナ・英数字の連なりと、`Intl.Segmenter` の単語（2 文字以上でひらがなだけではない語）を合わせる。
 * 前者は「有給休暇」のような複合語を、後者は「取り扱い」のようにひらがなを含む語を拾う（第11.7.3節）。
 *
 * @example extractTerms('育休の取り扱いを教えて') // → ['育休', '取り扱い']
 */
export function extractTerms(query: string): string[] {
  const q = normalizeForSearch(query);
  const terms = new Set<string>();
  for (const m of q.matchAll(CONTENT_RUN)) if (m[0].length >= 2) terms.add(m[0]);
  const seg = wordSegmenter();
  if (seg) {
    for (const w of seg.segment(q)) {
      const t = w.segment.trim();
      if (w.isWordLike && t.length >= 2 && !HIRAGANA_ONLY.test(t)) terms.add(t);
    }
  }
  return [...terms].filter((t) => !STOP.has(t));
}

/**
 * 検索の言葉 1 つと、その言い換え。点数ではまとめて 1 つの言葉として数える（第11.7.7節）。
 */
export interface SearchConcept {
  /** 質問から取り出した言葉。 */
  term: string;
  /** 探す語。先頭は `term` そのもの、続いて言い換え（正規化済み、重複なし）。 */
  alternatives: string[];
}

/**
 * 言葉に言い換えを足す。
 *
 * @param terms `extractTerms` の結果
 * @param groups 言い換えの組（標準と自社を合わせたもの）
 *
 * @remarks
 * 言葉が組の語を含めば、組のほかの語も探す（「育休中」は「育休」を含むので「育児休業」も探す）。
 * 複数の組に当たれば、すべての組の語を足す。組の中はどの語からでも、ほかの語を探す。
 */
export function expandTerms(terms: string[], groups: readonly (readonly string[])[]): SearchConcept[] {
  const norm = groups.map((g) => g.map(normalizeForSearch));
  return terms.map((term) => {
    const alternatives = new Set([term]);
    for (const g of norm) {
      if (g.some((w) => term.includes(w))) for (const w of g) alternatives.add(w);
    }
    return { term, alternatives: [...alternatives] };
  });
}

/** 言い換えを使わないときの形にする。 */
export function toConcepts(terms: string[]): SearchConcept[] {
  return terms.map((term) => ({ term, alternatives: [term] }));
}

/**
 * 返す節が、言い換えのおかげで見つかった言葉を示す（答えに「読み替えて探しました」と出すため）。
 *
 * @returns 元の言葉がどの節にも無く、言い換えの語がいずれかの節にあったもの
 */
export function rewritesOf(
  concepts: SearchConcept[], hits: Pick<ScoredCandidate, 'heading' | 'path' | 'body'>[],
): { from: string; to: string[] }[] {
  const texts = hits.map((h) => normalizeForSearch([...h.path, h.heading, h.body].join(' ')));
  const out: { from: string; to: string[] }[] = [];
  for (const c of concepts) {
    if (c.alternatives.length < 2 || texts.some((t) => t.includes(c.term))) continue;
    const to = c.alternatives.slice(1).filter((a) => texts.some((t) => t.includes(a)));
    if (to.length > 0) out.push({ from: c.term, to });
  }
  return out;
}

/**
 * 読み替えを利用者に示す文にする（第11.7.7節）。
 *
 * @example rewriteNote([{ from: '育休', to: ['育児休業'] }]) // '「育休」を「育児休業」と読み替えて探しました'
 */
export function rewriteNote(rewrites: { from: string; to: string[] }[]): string {
  return `${rewrites.map((r) => `「${r.from}」を${r.to.map((t) => `「${t}」`).join('・')}`).join('、')}と読み替えて探しました`;
}

/** 2 文字ずつの組（バイグラム）。2 文字の語はそれ自体。 */
export function bigrams(term: string): string[] {
  const chars = [...term];
  if (chars.length <= 2) return [chars.join('')];
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i]! + chars[i + 1]!);
  return [...out];
}

/** 語が文に出てくる回数。 */
function count(text: string, term: string): number {
  let n = 0;
  for (let i = text.indexOf(term); i >= 0; i = text.indexOf(term, i + term.length)) n++;
  return n;
}

/**
 * 節に点数を付ける（第11.7.3節の表）。言い換えの組はまとめて 1 つの言葉として数え、いちばん高い語の点を使う（第11.7.7節）。
 *
 * | 観点 | 点 |
 * |---|---|
 * | 見出し（経路を含む）に言葉がある | 1 語につき 3 |
 * | 本文に言葉がある | 1 語につき 1 ＋ 出現回数に応じた加点（上限 1） |
 * | そのままは無いが、2 文字の組の半分以上がある | 1 語につき 0.5 |
 * | 質問の言葉を多く満たす | 満たした語の割合 × 2 |
 */
export function scoreSection(
  concepts: SearchConcept[] | string[], s: Pick<ScoredCandidate, 'heading' | 'path' | 'body'>,
): number {
  return matchConcepts(concepts, s).score;
}

/**
 * 節と言葉の当たり方の詳細。点数に加え、見出しに当たった言葉の数と、満たした言葉の数を返す。
 *
 * @remarks ヘルプの記事の検索は、題名に当たらない記事を厳しく絞るためにこの詳細を使う（第6.10.6節）。
 */
export function matchConcepts(
  concepts: SearchConcept[] | string[], s: Pick<ScoredCandidate, 'heading' | 'path' | 'body'>,
): { score: number; inHeading: number; matched: number; total: number } {
  const cs = concepts.map((c) => (typeof c === 'string' ? { term: c, alternatives: [c] } : c));
  if (cs.length === 0) return { score: 0, inHeading: 0, matched: 0, total: 0 };
  const head = normalizeForSearch([...s.path, s.heading].join(' '));
  const body = normalizeForSearch(s.body);
  let score = 0;
  let matched = 0;
  let inHeading = 0;
  for (const c of cs) {
    let best = 0;
    let full = false;
    let headHit = false;
    for (const t of c.alternatives) {
      const inHead = head.includes(t);
      const n = count(body, t);
      let p = 0;
      if (inHead) { p += 3; headHit = true; }
      if (n > 0) p += 1 + Math.min(1, Math.log2(n) / 3);
      if (inHead || n > 0) { full = true; best = Math.max(best, p); }
    }
    if (headHit) inHeading++;
    if (full) { score += best; matched++; continue; }
    for (const t of c.alternatives) {
      const grams = bigrams(t);
      const hit = grams.filter((g) => head.includes(g) || body.includes(g)).length;
      if (grams.length > 1 && hit / grams.length >= 0.5) { score += 0.5; matched += 0.5; break; }
    }
  }
  return { score: score + (matched / cs.length) * 2, inHeading, matched, total: cs.length };
}

/**
 * 候補の節を点数の高い順に並べ、返す節を選ぶ。
 *
 * @returns 返す節（最大 5 節、本文の合計 8,000 字まで）。点が足りない節は含めない
 *
 * @remarks
 * 言葉が 1 つもそのまま当たらない節（点が 1 未満）と、最上位の 3 割に満たない節は返さない。
 * 何にでも当たる長い文書を出さないため（第11.7.3節）。同点なら更新日の新しい順。
 */
export function rankSections<T extends ScoredCandidate>(
  terms: SearchConcept[] | string[], candidates: T[],
): (T & { score: number })[] {
  const scored = candidates
    .map((c) => ({ ...c, score: scoreSection(terms, c) }))
    .filter((c) => c.score >= 1)
    .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
  const top = scored[0]?.score ?? 0;
  const out: (T & { score: number })[] = [];
  let chars = 0;
  for (const c of scored) {
    if (out.length >= SEARCH_MAX_SECTIONS || c.score < top * 0.3) break;
    if (out.length > 0 && chars + c.body.length > SEARCH_MAX_CHARS) break;
    out.push(c);
    chars += c.body.length;
  }
  return out;
}
