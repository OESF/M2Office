import type { Context, Next } from 'hono';
import type { RequestContext } from '@m2office/shared';
import type { AppDeps } from '../context.js';

/**
 * ホスト名からテナントを解決し、以降の処理に境界を強制する。
 *
 * `a.lvh.me:3101` の `a` をサブドメインとして扱う。
 * 開発と外部からの確認のため、`X-Tenant` ヘッダーでの指定も受け付ける。
 *
 * @remarks
 * テナント境界: ここで確定した `tenantId` を、以降のすべてのデータ
 * アクセスに持ち回る（不変則 I-2）。解決できない要求は処理しない。
 *
 * @see 仕様書 第6.5.1節 マルチテナントの分離方式
 */
export function tenantMiddleware(deps: AppDeps) {
  return async (c: Context, next: Next) => {
    const host = c.req.header('host') ?? '';
    const explicit = c.req.header('x-tenant');
    const subdomain = explicit ?? extractSubdomain(host);

    if (!subdomain) {
      return c.json(
        { error: 'テナントを特定できません。サブドメインを指定してください。' },
        400,
      );
    }

    const tenant = await deps.repo.findTenantBySubdomain(subdomain);
    if (!tenant) {
      return c.json({ error: `テナントが見つかりません: ${subdomain}` }, 404);
    }

    // 認証は Google アカウントに一本化する（仕様書 第16.1節）。
    // プロトタイプでは開発用の利用者を X-User で指定する。
    const email = c.req.header('x-user') ?? `admin@${tenant.workspaceDomain}`;
    const user = await deps.repo.findUserByEmail(tenant.id, email);
    if (!user) {
      return c.json({ error: `利用者が見つかりません: ${email}` }, 401);
    }

    const ctx: RequestContext = { tenant, user };
    c.set('ctx', ctx);
    await next();
  };
}

/** `a.lvh.me` や `a.m2office.online` から先頭のラベルを取り出す。 */
function extractSubdomain(host: string): string | null {
  const name = host.split(':')[0] ?? '';
  const labels = name.split('.');
  if (labels.length < 2) return null;
  const first = labels[0];
  if (!first || RESERVED.has(first)) return null;
  return first;
}

/** 運営が使う名前は払い出さない（仕様書 第21.4.3節）。 */
const RESERVED = new Set([
  'www', 'api', 'app', 'admin', 'mail', 'docs', 'status', 'help', 'localhost',
]);
