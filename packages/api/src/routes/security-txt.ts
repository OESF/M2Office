/**
 * @file 脆弱性の報告の窓口（`/.well-known/security.txt`。RFC 9116。仕様書 第16.11.3節 G-11）。
 *
 * 外の人が M2Office の脆弱性を見つけたときに、どこへ知らせればよいかを示す。連絡先は運営主体が決めるため、
 * 設定 `SECURITY_CONTACT`（`mailto:` か `https:` の URL。カンマで複数）が無ければ出さない（404）。入口（Caddy）が
 * `/.well-known/security.txt` をこの道（`/v1/security.txt`）に渡す。会社の判定より前に受ける（どの名前でも同じ中身）。
 */

import { Hono } from 'hono';

/** 有効期限（RFC 9116 は 1 年より短くするよう勧める）。 */
const EXPIRES_DAYS = 180;

/**
 * security.txt の中身を作る。
 *
 * @param contacts 連絡先（`mailto:`・`https:`）。形の合わないものは落とす
 * @param canonical この中身の正式な URL
 * @returns 中身。連絡先が 1 つも無ければ `null`
 */
export function securityTxt(contacts: string[], canonical: string, now: Date = new Date()): string | null {
  const ok = contacts.map((c) => c.trim()).filter((c) => /^(mailto:[^\s@]+@[^\s@]+\.[^\s@]+|https:\/\/[^\s]+)$/.test(c));
  if (ok.length === 0) return null;
  const expires = new Date(now.getTime() + EXPIRES_DAYS * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return [...ok.map((c) => `Contact: ${c}`), `Expires: ${expires}`, 'Preferred-Languages: ja, en', `Canonical: ${canonical}`, ''].join('\n');
}

/** `GET /v1/security.txt`（入口が `/.well-known/security.txt` から渡す）。 */
export function securityTxtRoute() {
  const app = new Hono();
  app.get('/', (c) => {
    const host = c.req.header('host') ?? 'localhost';
    const body = securityTxt((process.env['SECURITY_CONTACT'] ?? '').split(','), `https://${host}/.well-known/security.txt`);
    if (!body) return c.text('Not Found', 404);
    return c.text(body, 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
  });
  return app;
}
