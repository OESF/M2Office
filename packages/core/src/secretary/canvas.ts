/**
 * @file 音声の答えを、秘書のキャンバスにも出すかを決める（仕様書 第6.2.0節、ADR-0026）。
 *
 * 音声の依頼には、基本は音声で返す。聞くより見たほうが早い「大きい」答えだけを、画面にも出す。
 */

import type { SecretaryReply } from './secretary.js';

/** 読み上げると 30 秒を超える目安の字数（第6.2.0節）。 */
export const SPOKEN_MAX = 200;

/** これ以上の件数の一覧は、画面に出す（第6.2.0節）。 */
export const LIST_MIN = 4;

/**
 * 答えが「大きい」か（仕様書 第6.2.0節）。大きければ秘書のキャンバスにも出し、音声では要点だけを話す。
 *
 * @remarks
 * 次のどれかに当たれば大きい。4 件以上の一覧（本文の箇条書きか、根拠の件数）・表・長い答え・
 * 押すボタンが付くもの（業務を開く・ヘルプの記事）・出典が付くもの。
 * メールや文書の本文は、長さか一覧・表のどれかに当たる。
 *
 * @returns 大きければ、その理由（画面に出したことを伝えるときに使う）。大きくなければ `null`
 */
export function needsCanvas(
  reply: Pick<SecretaryReply, 'text' | 'evidence' | 'suggestedAgent' | 'helpArticles'>,
): string | null {
  if (reply.suggestedAgent) return '業務を開くボタン';
  if ((reply.helpArticles?.length ?? 0) > 0) return 'ヘルプの記事';
  if (reply.evidence.some((e) => e.kind === 'source')) return '出典';
  const lines = reply.text.split('\n');
  if (lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length >= 2) return '表';
  const items = lines.filter((l) => /^\s*([-*+・]|\d+[.)．])\s+/.test(l)).length;
  if (items >= LIST_MIN || reply.evidence.length >= LIST_MIN) return '一覧';
  if (reply.text.replace(/\s/g, '').length > SPOKEN_MAX) return '長い答え';
  return null;
}
