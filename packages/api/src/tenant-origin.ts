/**
 * @file 会社の画面のオリジン（`https://{会社}.…`）を、要求から決める。ログインの戻り先と、QR に入れる URL が使う。
 *
 * 要求の Host は会社の解決（サブドメイン）に使ったものであり、会社の外のホストにはならない。
 * `Origin` は、**ホストが要求の Host と同じときだけ**使う（プロトコルを知るため）。違えば使わない。
 * `Origin` は要求を送る側が自由に書けるため、そのまま使うと、ログインの戻り先を外のサイトにされ、
 * 引換券を盗まれる（2026-10-12 の点検で見つけた。仕様書 第16.1.2節）。
 */

/**
 * 会社の画面のオリジン。
 *
 * @param origin 要求の `Origin`
 * @param host 要求の `Host`
 * @returns `https://a.example.jp` の形。開発（`localhost`・`*.localhost`・`*.lvh.me`）では http
 */
export function tenantOrigin(origin: string | undefined, host: string | undefined): string {
  const h = host ?? 'localhost';
  const dev = h.startsWith('localhost') || h.includes('.lvh.me') || /\.localhost(:\d+)?$/.test(h);
  if (origin) {
    try {
      const o = new URL(origin);
      if (o.host === h && (o.protocol === 'https:' || (o.protocol === 'http:' && dev))) return o.origin;
    } catch { /* 読めない Origin は使わない */ }
  }
  return `${dev ? 'http' : 'https'}://${h}`;
}
