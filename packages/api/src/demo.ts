/**
 * @file 体験版の入口（`demo.<親のドメイン>`。仕様書 第23.3.2節、ADR-0115）。ゲストの ID とパスワードでのログインと、規約への同意。
 *
 * 体験版の入口では、会社をサブドメインではなく**ゲストのログイン状態から**決める（会社の判定のミドルウェア）。
 * ログインの口は会社の判定より前に置き、ゲストの ID から体験用の会社を引く。パスワードは scrypt の控えと時間を一定にして比べる。
 * Google のログインの決まり（第16.1節）の例外は、この入口と体験用の会社の中だけに閉じる。
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import {
  DEMO_SESSION_HOURS, DEMO_TERMS, hashMachinePassword, isDemoTenantId, isGuestLoginId, verifyMachinePassword,
} from '@m2office/core';
import type { AppDeps } from './context.js';
import type { AppEnv } from './middleware/tenant.js';
import { issueSession } from './auth/session.js';
import { clientAddress } from './client-address.js';

/** 体験版の入口のログイン画面に出す名前。 */
export const DEMO_PRODUCT_NAME = '体験版';

/**
 * 要求が体験版の入口に来たか（`demo.<BASE_DOMAIN>`。開発では `demo.localhost` も）。
 *
 * @param sub 入口の名前（`DEMO_SUBDOMAIN`）。無ければ体験版を使わない
 */
export function isDemoHost(host: string | undefined, sub: string | null, baseDomain: string = process.env['BASE_DOMAIN'] ?? 'lvh.me'): boolean {
  if (!sub || !host) return false;
  const name = (host.split(':')[0] ?? '').toLowerCase();
  const base = baseDomain.toLowerCase().replace(/^\.+|\.+$/g, '');
  return name === `${sub}.${base}` || name === `${sub}.localhost`;
}

/** 体験版の入口のログイン手段（画面はこれを見て、ゲストの ID とパスワードの欄を出す）。 */
export function demoProviders(): Record<string, unknown> {
  return {
    tenant: { name: DEMO_PRODUCT_NAME, subdomain: '' },
    google: { enabled: false, reason: '' },
    dev: { enabled: false, users: [] },
    machineAdmin: false,
    demo: true,
  };
}

/** ログインに使える回数（同じ送り元から 15 分に 20 回まで。ID ごとの 5 回の間違いの止めとは別に重ねる）。 */
const ADDRESS_LIMIT = 20;
const ADDRESS_WINDOW_MS = 15 * 60_000;

/** 送り元ごとのログインの回数。 */
export class DemoLoginThrottle {
  private readonly hits = new Map<string, { count: number; first: number }>();

  /** この送り元から、いま試してよいか（試した回数を 1 つ数える）。 */
  allow(address: string, now: number = Date.now()): boolean {
    if (this.hits.size > 5000) this.hits.clear();
    const cur = this.hits.get(address);
    const h = cur && now - cur.first < ADDRESS_WINDOW_MS ? cur : { count: 0, first: now };
    h.count++;
    this.hits.set(address, h);
    return h.count <= ADDRESS_LIMIT;
  }
}

/** ID が無いときにも同じだけ時間をかけるための控え（ID があるかを時間で知られないため）。 */
const DUMMY_HASH = hashMachinePassword(randomBytes(12).toString('base64url'));

/** 断るときの文（ID が無い・パスワードが違う・期限が過ぎた、を分けない）。 */
const LOGIN_FAILED = 'ゲストの ID かパスワードが違うか、体験の期限が過ぎています';

/**
 * ゲストのログイン（`POST /v1/demo-login`）。会社の判定より前に置く。
 *
 * @remarks
 * 最初のログインのときに、見本の会社のデータを入れる（同時のログインで二重に入れないよう、データベースで番を取る）。
 * ログイン状態は 12 時間で、体験の期限を越えない
 */
export function demoLoginRoute(deps: AppDeps, throttle = new DemoLoginThrottle()) {
  const app = new Hono<AppEnv>();
  app.post('/', async (c) => {
    if (!isDemoHost(c.req.header('host'), deps.demo.subdomain)) return c.json({ error: '見つかりません' }, 404);
    if (!throttle.allow(clientAddress(c))) return c.json({ error: '試した回数が多すぎます。15 分ほど待ってから、もう一度お試しください' }, 429);
    const b = await c.req.json<{ loginId?: unknown; password?: unknown }>().catch(() => ({} as { loginId?: unknown; password?: unknown }));
    const loginId = typeof b.loginId === 'string' ? b.loginId.trim().toLowerCase() : '';
    const password = typeof b.password === 'string' ? b.password.trim() : '';
    if (!isGuestLoginId(loginId) || !password || password.length > 200) return c.json({ error: LOGIN_FAILED }, 401);
    const g = await deps.demo.store.lookup(loginId);
    if (!g) {
      verifyMachinePassword(password, DUMMY_HASH);
      return c.json({ error: LOGIN_FAILED }, 401);
    }
    if (g.lockedUntil && Date.parse(g.lockedUntil) > Date.now()) {
      return c.json({ error: '続けて間違えたため、15 分ほどログインを止めています。時間をおいてお試しください' }, 429);
    }
    const ok = verifyMachinePassword(password, g.passwordHash);
    await deps.demo.store.loginResult(g.guestId, ok);
    if (!ok) return c.json({ error: LOGIN_FAILED }, 401);
    if (!g.seeded) {
      if (!(await deps.demo.store.claimSeed(g.tenantId))) {
        return c.json({ error: '体験の準備をしています。1 分ほど待ってから、もう一度ログインしてください' }, 503);
      }
      const r = await deps.demo.seed(g.tenantId, g.userId);
      if (r.failed.length) deps.log.warn('体験用の会社に見本のデータを入れきれませんでした', { tenantId: g.tenantId, failed: r.failed.join(',') });
      await deps.demo.store.markSeeded(g.tenantId);
    }
    const hours = Math.min(DEMO_SESSION_HOURS, (Date.parse(g.expiresAt) - Date.now()) / 3_600_000);
    const session = await issueSession(c, deps.repo, deps.auth, { tenantId: g.tenantId, userId: g.userId, provider: 'demo' }, hours);
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: g.tenantId, actorType: 'user', actorId: g.userId,
      action: 'auth.login', targetType: 'session', targetId: session.id.slice(0, 16),
      detail: { provider: 'demo' }, occurredAt: new Date().toISOString(),
    });
    return c.json({ ok: true, csrfToken: session.csrfToken });
  });
  return app;
}

/** 体験の様子（`/v1/me` の `demo`）。体験用の会社でなければ `null`。 */
export async function demoView(deps: Pick<AppDeps, 'demo'>, tenantId: string): Promise<{
  expiresAt: string; termsAcceptedAt: string | null; aiCapJpy: number; terms: readonly string[];
} | null> {
  if (!isDemoTenantId(tenantId)) return null;
  const t = await deps.demo.store.trial(tenantId).catch(() => null);
  return t ? { expiresAt: t.expiresAt, termsAcceptedAt: t.termsAcceptedAt, aiCapJpy: t.aiCapJpy, terms: DEMO_TERMS } : null;
}

/**
 * 体験版の利用規約への同意（`POST /v1/me/demo/terms`）。ログインの後に呼ぶ。
 */
export function demoTermsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.post('/terms', async (c: Context<AppEnv>) => {
    const { tenant, user } = c.get('ctx');
    if (!isDemoTenantId(tenant.id)) return c.json({ error: '見つかりません' }, 404);
    await deps.demo.store.acceptTerms(tenant.id);
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'demo.terms',
      targetType: 'tenant', targetId: tenant.id, detail: {}, occurredAt: new Date().toISOString(),
    });
    return c.json({ ok: true });
  });
  return app;
}
