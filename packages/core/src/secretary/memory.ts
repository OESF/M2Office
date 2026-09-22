/**
 * @file 個人記憶の覚え方と、その判定（仕様書 第11.5.1節、ADR-0012）。
 *
 * 本人が「覚えておいて」と頼んだときだけ覚える。推論を通さないため、
 * 覚えた内容が指示と食い違うことがない（層 1。第10.9節）。
 */

/** 1 件の記憶の長さの上限（字）。 */
export const MEMORY_MAX_CHARS = 200;

/** 「覚えておいて」と頼む言い回し。 */
export const REMEMBER = /(覚え(て|ておいて|といて)|記憶して)/;

/** 「覚えないで」と断る言い回し。「覚えておいて」より先に見る。 */
export const DO_NOT_REMEMBER = /(覚え(ないで|なくて(いい|よい|大丈夫)|ないように)|記憶しないで)/;

/** 覚えていることを聞く言い回し。 */
export const WHAT_REMEMBERED = /(何を覚え|覚えていること|記憶(の一覧|を見せ|していること))/;

/** 認証情報らしき語。これを含む指示は覚えない（仕様書 第11.2節）。 */
const CREDENTIALS = /(パスワード|ぱすわーど|password|api\s*key|api\s*キー|アクセスキー|秘密鍵|シークレット|トークン|暗証番号|クレジットカード)/i;

/** 指示の言い回しを取り除く。前後どちらに付いていても落とす。 */
const TRAILING = /[、。,.\s]*(この件は|それは|これは)?\s*(を|は|って|と)?\s*(覚え(ておいてください|ておいて|といて|てください|て)|記憶して(おいてください|おいて|ください)?)\s*[。．!！?？]*\s*$/;
const LEADING = /^\s*(覚え(ておいてください|ておいて|といて|てください|て)|記憶して(おいてください|おいて|ください)?)\s*[:：、。]?\s*/;

/**
 * 指示から、覚える一文を取り出す。
 *
 * @param message 依頼の本文（例: 「山田さんは経理の担当だと覚えておいて」）
 * @returns 覚える一文（例: 「山田さんは経理の担当だ」）。取り出せなければ空文字
 */
export function memoryTextOf(message: string): string {
  return message.replace(TRAILING, '').replace(LEADING, '').replace(/^[、。\s]+|[、\s]+$/g, '').trim();
}

/** 覚えない理由。覚えてよければ `null`。 */
export type MemoryRefusal =
  | { reason: 'learning-off' }
  | { reason: 'excluded'; word: string }
  | { reason: 'credentials' }
  | { reason: 'too-long' }
  | { reason: 'empty' };

/**
 * 覚えてよいかを確かめる（仕様書 第11.5.1節）。
 *
 * @param text 覚える一文
 * @param settings 本人の設定（学習の停止と、対象外の言葉）
 * @returns 覚えてよければ `null`、覚えないならその理由
 */
export function refuseToRemember(
  text: string, settings: { learning: boolean; excludes: string[] },
): MemoryRefusal | null {
  if (!settings.learning) return { reason: 'learning-off' };
  if (!text) return { reason: 'empty' };
  // 認証情報は、推論に頼らず語で断る（第11.2節）
  if (CREDENTIALS.test(text)) return { reason: 'credentials' };
  const word = settings.excludes.find((w) => w.trim() && text.includes(w.trim()));
  if (word) return { reason: 'excluded', word };
  if (text.length > MEMORY_MAX_CHARS) return { reason: 'too-long' };
  return null;
}

/** 覚えなかった理由を、本人への言葉にする。 */
export function refusalMessage(refusal: MemoryRefusal): string {
  switch (refusal.reason) {
    case 'learning-off':
      return 'いまは覚えない設定になっています。個人設定の「記憶とデータ」で、覚えることを許すと覚えられます。';
    case 'excluded':
      return `「${refusal.word}」は覚えない言葉として指定されています。覚えませんでした。`;
    case 'credentials':
      return 'パスワードや鍵のようなものは覚えません。ほかの覚え方をご検討ください。';
    case 'too-long':
      return `長すぎるため覚えませんでした（${MEMORY_MAX_CHARS} 字まで）。短くしてもう一度お伝えください。`;
    case 'empty':
      return '何を覚えればよいか分かりませんでした。「〜を覚えておいて」の形でお伝えください。';
  }
}
