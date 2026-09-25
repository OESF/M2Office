/**
 * @file 秘書の答えの出典（仕様書 第6.2節「出典の見せ方」）。
 *
 * 題名の行と、抜き出した本文の 2 段で出す。答えで引用した出典を先に出し、ほかは畳む。
 */

/**
 * 秘書の答えの出典（仕様書 第6.2節「出典の見せ方」）。
 *
 * @remarks
 * 題名の行と、抜き出した本文の 2 段で出す。本文は書式の記号を外し、3 行に収める。
 * **答えの中で引用した出典を先に出し**、ほかに調べた箇所は畳む。
 * 同じ文書の節が、書式のまま細い欄に 5 つ並んで読めなかった（2026-09-25 の受け入れテスト）。
 */
export function Sources({ items, reply }: { items: { label: string; value: string }[]; reply: string }) {
  const cited = citedSources(items, reply);
  // 引用が見つからなければ、いちばん関係の深いもの（先頭）を出す
  const shown = cited.length > 0 ? cited : items.slice(0, 1);
  const others = items.filter((e) => !shown.includes(e));
  const one = (e: { label: string; value: string }, i: number) => (
    <div key={i} className="source">
      <div className="source-title">{e.label}</div>
      <div className="source-text">{plainText(e.value)}</div>
    </div>
  );
  return (
    <div className="sources">
      <div className="muted small">出典</div>
      {shown.map(one)}
      {others.length > 0 && (
        <details className="fold">
          <summary>ほかに調べた箇所（{others.length} 件）</summary>
          {others.map(one)}
        </details>
      )}
    </div>
  );
}

/**
 * 答えの中で引用した出典を選ぶ。
 *
 * @remarks
 * 答えの中の【】で囲んだ出典と、**完全に一致するもの**だけを引用とみなす。
 * 部分一致にすると、文書全体の出典（「…› 議事録」）が、節の出典（「…› 議事録 › 決定事項」）の途中と一致してしまう
 * （2026-09-25 に確認）。
 */
export function citedSources<T extends { label: string }>(items: T[], reply: string): T[] {
  const quoted = new Set([...reply.matchAll(/【([^】]+)】/g)].map((m) => m[1]!.trim()));
  return items.filter((e) => quoted.has(e.label.trim()));
}

/** 書式の記号（見出し・太字・箇条書きの印）を外して、読める文にする。改行は残す。 */
export function plainText(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '・')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
