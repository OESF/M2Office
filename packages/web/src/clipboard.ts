/**
 * @file クリップボードへのコピー。画面のどこでも同じものを使う。
 *
 * ブラウザーがクリップボードの口（`navigator.clipboard`）を許さないとき（http の画面・許可の無い埋め込み）は、
 * 見えない入力欄を選んでコピーする昔の方法で試す。どちらもできなければ `false`。
 */

/**
 * 文字をクリップボードにコピーする。
 *
 * @returns コピーできたか
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 昔の方法で試す
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
