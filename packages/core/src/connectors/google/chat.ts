/**
 * @file Chat の投稿先の見つけ方と、本文の書式（仕様書 第14.3.4節「Chat」）。
 *
 * 投稿先は、スペースの名前（「営業部」）でも、リンク・ID でも受ける。
 * 名前のときは、本人が入っているスペースから**ちょうど 1 つ**一致したときだけ使う。似た名前に推測で投稿しない。
 */

/** 本文をこの字数で切る。 */
export const MAX_CHAT_CHARS = 4000;

/**
 * 入力がスペースのリンク・ID なら、`spaces/…` の形にして返す。名前なら `null`。
 *
 * @remarks
 * 受けるのは次の形。
 * - `spaces/AAAA…`
 * - `https://chat.google.com/room/AAAA…`（Chat の画面のリンク）
 * - `https://mail.google.com/chat/u/0/#chat/space/AAAA…`（Gmail の中の Chat のリンク）
 */
export function spaceIdOf(input: string): string | null {
  const v = input.trim();
  const direct = /^spaces\/([A-Za-z0-9_-]+)$/.exec(v);
  if (direct) return `spaces/${direct[1]}`;
  const room = /chat\.google\.com\/(?:u\/\d+\/)?(?:room|space)\/([A-Za-z0-9_-]+)/.exec(v);
  if (room) return `spaces/${room[1]}`;
  const gmail = /mail\.google\.com\/chat\/.*#chat\/space\/([A-Za-z0-9_-]+)/.exec(v);
  if (gmail) return `spaces/${gmail[1]}`;
  return null;
}

/** 名前を比べる形にする。前後の空白・全角と半角・英字の大小を区別しない。 */
export function normalizeSpaceName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 名前が一致するスペースを 1 つ選ぶ。
 *
 * @returns 選んだスペース。無い・複数ある場合は、その理由の文（利用者に見せる）
 */
export function pickSpace(
  wanted: string, spaces: { name: string; displayName?: string }[],
): { space: string } | { reason: string } {
  const key = normalizeSpaceName(wanted);
  const hits = spaces.filter((s) => s.displayName && normalizeSpaceName(s.displayName) === key);
  if (hits.length === 1) return { space: hits[0]!.name };
  if (hits.length === 0) {
    return { reason: `「${wanted}」という名前のチャットのスペースが見つかりません（あなたが入っているスペースだけを探します）。名前を確かめるか、スペースのリンクを指定してください` };
  }
  return { reason: `「${wanted}」という名前のチャットのスペースが ${hits.length} つあります。どれに投稿するか決められないため、スペースのリンクを指定してください` };
}

/**
 * 本文を Chat の書式に直す。
 *
 * @remarks
 * Chat は Markdown の見出しを解さず、太字は `*…*` で書く。見出しは太字にし、`**…**` は `*…*` にする。
 * 長ければ {@link MAX_CHAT_CHARS} 字で切り、続きは M2Office で見られる旨を添える。
 */
export function toChatText(text: string): string {
  const body = text
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .trim();
  if (body.length <= MAX_CHAT_CHARS) return body;
  return `${body.slice(0, MAX_CHAT_CHARS)}\n…（長いため、ここで切りました。続きは M2Office で見られます）`;
}
