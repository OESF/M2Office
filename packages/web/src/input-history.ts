/**
 * @file 秘書の入力欄で、前に送った依頼を上下のキーで呼び戻す（仕様書 第6.1.3節「入力欄」。第 0.606.0 版）。
 *
 * よくある入力欄と同じく、`↑` を押すたびに 1 つ前の依頼へさかのぼり、`↓` で新しい側へ戻る。
 * いちばん新しい依頼より先へ `↓` で進むと、呼び戻す前に書きかけていた文に戻す。
 * 呼び戻す依頼は、サーバーにある本人の会話の記録（新しい順。本人が消した会話や、会話を残さない設定では出ない）と、
 * この画面を開いてから送った依頼から作る。ブラウザには残さない（共用の端末で、ほかの人の依頼を見せないため）。
 *
 * 画面の部品に依存しない純粋な関数だけを置き、`App.tsx` の秘書の入力欄から使う。
 */

/** 呼び戻せる依頼の数の上限（サーバーの会話の記録が 1 回に返す数と同じ）。 */
export const INPUT_HISTORY_MAX = 50;

/** 呼び戻しの状態。`index` が -1 なら呼び戻していない（書きかけの文を出している）。 */
export interface HistoryState {
  /** 送った依頼（新しい順。同じ依頼は新しいほうの 1 つだけ） */
  items: string[];
  /** いま出している依頼の位置（`items` の添字）。-1 は書きかけの文 */
  index: number;
  /** 呼び戻しを始める前に書いていた文（`↓` で戻すため） */
  draft: string;
}

/** 空の状態。 */
export const EMPTY_HISTORY: HistoryState = { items: [], index: -1, draft: '' };

/**
 * 依頼の並びを作る。新しい順のまま、空の依頼を除き、同じ依頼は新しいほうの 1 つだけを残し、上限で切る。
 *
 * この画面で送った依頼は、会話を残す設定ならサーバーの記録にも入っている。同じ依頼を 1 つにまとめるので、
 * 両方を渡してよい（会話を残さない設定では、この画面で送った依頼だけが並ぶ）。
 *
 * @param sent - この画面で送った依頼（新しい順）
 * @param stored - サーバーの会話の記録の依頼（新しい順）
 */
export function mergeHistory(sent: string[], stored: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...sent, ...stored]) {
    const m = raw.trim();
    if (!m || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
    if (out.length >= INPUT_HISTORY_MAX) break;
  }
  return out;
}

/**
 * 上下のキーで、前の依頼を呼び戻すか。
 *
 * 複数行の文の中では、カーソルを行の間で動かす本来の動きを残す。`↑` はカーソルが 1 行目にあるとき、
 * `↓` は呼び戻している最中で、カーソルが最後の行にあるときだけ呼び戻す。
 *
 * @param key - 押したキー（`ArrowUp`・`ArrowDown`）
 * @param value - 入力欄の文
 * @param caret - カーソルの位置（選んでいる範囲があれば呼び戻さないので、始まりと終わりを渡す）
 * @param browsing - 呼び戻している最中か
 */
export function shouldRecall(
  key: string, value: string, caret: { start: number; end: number }, browsing: boolean,
): boolean {
  if (caret.start !== caret.end) return false;
  if (key === 'ArrowUp') return !value.slice(0, caret.start).includes('\n');
  if (key === 'ArrowDown') return browsing && !value.slice(caret.end).includes('\n');
  return false;
}

/**
 * `↑`（`older`）か `↓`（`newer`）で 1 つ動かす。動けなければ同じ状態を返す（`text` は `null`）。
 *
 * @param s - いまの状態
 * @param dir - 動かす向き
 * @param current - いま入力欄にある文（呼び戻しを始めるときに書きかけとして取っておく）
 * @returns 新しい状態と、入力欄に出す文
 */
export function stepHistory(
  s: HistoryState, dir: 'older' | 'newer', current: string,
): { state: HistoryState; text: string | null } {
  if (dir === 'older') {
    if (s.index + 1 >= s.items.length) return { state: s, text: null };
    const draft = s.index === -1 ? current : s.draft;
    const index = s.index + 1;
    return { state: { ...s, index, draft }, text: s.items[index]! };
  }
  if (s.index === -1) return { state: s, text: null };
  const index = s.index - 1;
  return { state: { ...s, index }, text: index === -1 ? s.draft : s.items[index]! };
}
