/**
 * @file 言い換えを秘書が考える（仕様書 第11.7.7.0節、ADR-0028）。
 *
 * 「育休」が「育児休業」のことだと、人なら想像がつく。人に言い換えの表を作らせず、探すたびに推論に挙げさせる。
 * 挙げた言葉は、探す語を広げるだけに使う。答えの根拠は、見つけた節だけである。
 */

import type { LlmProvider } from '../llm/provider.js';
import { extractTerms } from './search.js';

/** 待つ上限（ミリ秒）。間に合わなければ言い換えなしで探す。 */
export const EXPAND_TIMEOUT_MS = 2000;

/** 1 つの言葉に挙げさせる言い換えの上限。 */
const MAX_PER_TERM = 4;

/**
 * 推論に言い換えを挙げさせる指示。
 */
export function expandPrompt(query: string, terms: string[]): string {
  return [
    '社内の規程や文書を探します。次の質問の言葉ごとに、規程や文書で使われていそうな別の言い方（正式な名前・略さない形・同じ意味の言葉）を挙げてください。',
    '',
    `質問: ${query}`,
    `言葉: ${terms.join('、')}`,
    '',
    '「育休 = 育児休業、育児休暇」のように、1 行に 1 つ、元の言葉と言い換えを「=」と「、」で書いてください。',
    `言い換えは 1 つの言葉に ${MAX_PER_TERM} つまで。意味を広げすぎない（別の制度や別の物にしない）。思い付かない言葉は書かない。ほかのことは書かない。`,
  ].join('\n');
}

/** 応答を言葉の組にする（先頭が元の言葉）。 */
export function parseExpansion(text: string): string[][] {
  const groups: string[][] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[-*・\s]+/, '').trim();
    const [head, tail] = line.split(/\s*[=＝]\s*/);
    if (!head || !tail) continue;
    const words = [head, ...tail.split(/[、,，]/)].map((w) => w.trim()).filter((w) => w.length >= 2 && w.length <= 30);
    const uniq = [...new Set(words)].slice(0, MAX_PER_TERM + 1);
    if (uniq.length >= 2) groups.push(uniq);
  }
  return groups;
}

/**
 * 質問の言葉の言い換えを挙げさせる。
 *
 * @returns 言葉の組（登録した言い換えと同じ形）。推論が使えない・間に合わない・失敗したときは空
 */
export async function expandQuery(llm: LlmProvider, query: string): Promise<string[][]> {
  if (llm.name === 'stub' || llm.name === 'unconfigured') return [];
  const terms = extractTerms(query);
  if (terms.length === 0) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      llm.complete({
        tier: 'fast',
        maxOutputTokens: 200,
        messages: [
          { role: 'system', content: '日本語で答えます。指定された形式だけを出力します。' },
          { role: 'user', content: expandPrompt(query, terms) },
        ],
      }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), EXPAND_TIMEOUT_MS); }),
    ]);
    return res ? parseExpansion(res.text) : [];
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}
