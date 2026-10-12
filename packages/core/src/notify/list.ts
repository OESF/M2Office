/**
 * @file お知らせの本文に、いくつかの項目を 1 行に 1 つの箇条書きで並べる。
 *
 * お知らせの本文は 300 字までで、画面は改行と箇条書きを出す（Markdown）。
 * 項目を「・」でつないで 1 行にすると読みにくく、先頭のいくつかだけを並べると題名の数と合わなくなるため、
 * 入るだけ並べ、入らなかった数を最後の行に書く。
 */

/** お知らせの本文の上限（字）。`createNotification` に渡す前に切る長さと同じ。 */
export const NOTICE_BODY_LIMIT = 300;

/**
 * 項目を、1 行に 1 つの箇条書きにする。上限に入らない項目は並べず、「ほか N つ」の行にまとめる。
 *
 * @param items 並べる項目（題名など）。前後の空白は落とし、空の項目は並べない
 * @param unit 数の数え方（「つ」「件」など）
 * @param limit 本文の上限（字）
 * @returns 箇条書きの本文。項目が無ければ空の文字列
 * @example noticeList(['秋の熱中症', '汗のあとの保湿'], 'つ') // => '- 秋の熱中症\n- 汗のあとの保湿'
 */
export function noticeList(items: readonly string[], unit: string, limit = NOTICE_BODY_LIMIT): string {
  const all = items.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const lines: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const rest = all.length - i - 1;
    const next = [...lines, `- ${all[i]}`];
    const tail = rest > 0 ? `\n- ほか ${rest} ${unit}` : '';
    if (next.join('\n').length + tail.length > limit) break;
    lines.push(`- ${all[i]}`);
  }
  const left = all.length - lines.length;
  return [...lines, ...(left > 0 ? [`- ${lines.length ? 'ほか ' : ''}${left} ${unit}`] : [])].join('\n');
}
