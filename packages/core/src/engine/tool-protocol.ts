/**
 * @file 推論の出力からツール呼び出しを取り出す。提供者ごとの機能に依存しない文字列の約束を使う。
 *
 * @see 仕様書 第20.2節 LLM 抽象化層
 */

/**
 * 推論の出力からツール呼び出しを取り出す。
 *
 * 出力に含まれる ```tool ブロックを解析する。
 *
 * @param text 推論の出力
 * @returns 取り出せたツール呼び出しの一覧。解析できないブロックは無視する
 *
 * @remarks
 * 提供者ごとの native なツール呼び出し機能に依存せず、
 * 文字列の約束だけで成立させている。これにより抽象化層
 * （仕様書 第21.2節）を通る提供者すべてで同じ挙動になる。
 * native 対応へ切り替える場合も、この関数の置き換えで済む。
 */
export function parseToolCalls(text: string): { name: string; args: Record<string, unknown> }[] {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const re = /```tool\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1];
    if (!body) continue;
    try {
      const parsed = JSON.parse(body) as { name?: unknown; args?: unknown };
      if (typeof parsed.name === 'string') {
        calls.push({
          name: parsed.name,
          args: (parsed.args ?? {}) as Record<string, unknown>,
        });
      }
    } catch {
      // 解析できないブロックは無視する。推測で補わない
    }
  }
  return calls;
}
