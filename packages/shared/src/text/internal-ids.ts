/**
 * @file 推論の文から、内部の ID を取り除く（仕様書 第9.3.2節・第9.3.3節・第6.2.2節）。
 *
 * 推論には「利用者に見せる文に ID を書かない」と指示しているが、それでも書くことがある
 * （2026-09-25 に、承認の画面と実行の詳細に成果物の ID がそのまま出た）。
 * 承認の画面（core）と実行の詳細（画面）の両方で使うため、ここに置く。
 */

/** 実行・成果物などの ID（UUID）。`g` を付けたもの（置き換え用）と付けないもの（判定用）を分ける。 */
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID = new RegExp(UUID_SOURCE, 'gi');
const IS_UUID = new RegExp(`^\\s*${UUID_SOURCE}\\s*$`, 'i');
/** Google のファイルなどの ID。英数字と `-`・`_` が 25 字以上続き、数字を含むもの。 */
const LONG_ID = /(?<![A-Za-z0-9_\-/=])[A-Za-z0-9_-]{25,}(?![A-Za-z0-9_\-])/g;

/**
 * 推論の文から、内部の ID を取り除く（承認の画面と実行の詳細に出す前の安全網）。
 *
 * @remarks
 * 推論には ID を書かないよう指示しているが、それでも書くことがある（2026-09-25 に承認の画面で成果物の ID が出た）。
 * **URL の中は触らない**（文書のリンクは押せるように残す）。ID を取り除いて空になった箇条書きと、
 * 「ID:」だけが残った括弧も消す。
 */
export function hideInternalIds(text: string): string {
  const cleaned = text.split(/(https?:\/\/[^\s)）]+)/).map((part, i) => {
    if (i % 2 === 1) return part; // URL
    return part
      .replace(/`([^`]*)`/g, (m, inner: string) => (IS_UUID.test(inner) || isLongId(inner) ? '' : m))
      .replace(UUID, '')
      .replace(LONG_ID, (m) => (/\d/.test(m) ? '' : m))
      .replace(/[（(]\s*[^（）()\n]{0,12}ID\s*[:：]?\s*[）)]/g, '')
      .replace(/ {2,}/g, ' ');
  }).join('');
  return cleaned.split('\n')
    // 「ID は以下の通りです」のように、ID を紹介するだけの行は、ID を消すと意味を失う
    .filter((l) => !/ID\s*(は|を)?[^。\n]{0,12}(以下|次)の(通り|とおり)/.test(l))
    // ID を消して「- （題名）」だけが残った箇条書きは、括弧を外す
    .map((l) => l.replace(/^(\s*[-*]\s*)[（(](.+)[）)]\s*$/, '$1$2'))
    .filter((l) => !/^\s*[-*]\s*$/.test(l))
    .join('\n');
}

/** 1 つの語が、長い ID か。 */
function isLongId(v: string): boolean {
  return /^[A-Za-z0-9_-]{25,}$/.test(v.trim()) && /\d/.test(v);
}
