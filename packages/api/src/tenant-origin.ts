/**
 * @file 会社の画面のオリジン（`https://{会社}.…`）を、要求から決める。ログインの戻り先と、QR に入れる URL が使う。
 *
 * 要求の Host は会社の解決（サブドメイン）に使ったものであり、会社の外のホストにはならない。
 * `Origin` は、ブラウザが付けたときだけ使う（同じオリジンの GET では付かない）。
 */

/**
 * 会社の画面のオリジン。
 *
 * @param origin 要求の `Origin`
 * @param host 要求の `Host`
 * @returns `https://a.example.jp` の形。開発（`localhost`・`*.lvh.me`）では http
 */
export function tenantOrigin(origin: string | undefined, host: string | undefined): string {
  if (origin) return origin;
  const h = host ?? 'localhost';
  return `${h.startsWith('localhost') || h.includes('.lvh.me') ? 'http' : 'https'}://${h}`;
}
