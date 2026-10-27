/**
 * @file 証明書を取ってよいかを Caddy に答える口（仕様書 第20.4.6節「入口（Caddy）」、ADR-0113）。
 *
 * Caddy は会社のサブドメインの証明書を、初めて開かれたときに Let's Encrypt から取る（On-Demand TLS）。取る前にこの口に
 * `?domain=<名前>` で尋ね、**200 なら取り、それ以外なら取らない**。払い出した会社のサブドメインと、運営が使う決まった名前だけに 200 を返す。
 * でたらめな名前で証明書を取らせ、Let's Encrypt の回数の上限を使い切らせる攻撃を防ぐため。
 *
 * 機械の中（127.0.0.1）からだけ受ける。Caddy は外から来た `/internal/` の要求を通さない（雛形の Caddyfile）。
 */

import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Repository } from '@m2office/core';

/** 運営が使う決まった名前（親のドメインに付ける。空は親そのもの）。 */
const FIXED = ['', 'www', 'ops', 'signup'];
/** 会社のサブドメインの形（第20.4.3節の命名規則）。 */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * 名前が証明書を取ってよいものか。
 *
 * @param baseDomain 会社のサブドメインの親（`BASE_DOMAIN`）
 * @returns 取ってよければ `true`
 */
export async function tlsAllowed(repo: Pick<Repository, 'findTenantBySubdomain'>, domain: string, baseDomain: string): Promise<boolean> {
  const name = domain.trim().toLowerCase().replace(/\.$/, '');
  const base = baseDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!name || !base) return false;
  if (FIXED.some((f) => (f ? `${f}.${base}` : base) === name)) return true;
  if (!name.endsWith(`.${base}`)) return false;
  const label = name.slice(0, -(base.length + 1));
  if (!LABEL.test(label) || FIXED.includes(label)) return false;
  const tenant = await repo.findTenantBySubdomain(label);
  // 解約した会社の名前では取らない（ほかの状態の会社は、止めていても画面で理由を見せるため取る）
  return !!tenant && tenant.status !== 'cancelled';
}

/**
 * 証明書を取ってよいかを答える口（`GET /internal/tls-allowed?domain=`）。
 */
export function tlsAskRoute(repo: Pick<Repository, 'findTenantBySubdomain'>, baseDomain: () => string = () => process.env['BASE_DOMAIN'] ?? '') {
  const app = new Hono();
  app.get('/', async (c) => {
    const remote = (() => { try { return getConnInfo(c).remote.address ?? ''; } catch { return ''; } })();
    if (!LOCAL.has(remote)) return c.body(null, 403);
    const ok = await tlsAllowed(repo, c.req.query('domain') ?? '', baseDomain()).catch(() => false);
    return c.body(null, ok ? 200 : 404);
  });
  return app;
}
