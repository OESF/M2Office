/**
 * @file ローカルの形の「機械の管理者」の入口（仕様書 第8.6.3節、Q-154）。
 *
 * Google のログインとは別に、ID・合言葉・確認コード（認証アプリの 6 桁）で入り、「機械」の口（`machine.ts`）だけを使う。業務の画面と API には入れない。
 * 会社の判定とログインの確かめより前に置き、データベースが止まっていても機械の様子だけは見られるようにする。
 */

import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Tenant, User } from '@m2office/shared';
import {
  issueMachineSession, machineAdminFromEnv, machineCsrf, machineSessionKey, MachineLoginThrottle, MACHINE_ADMIN_ACTOR, MACHINE_ADMIN_SESSION_MS,
  verifyMachinePassword, verifyMachineSession, verifyTotp,
} from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';
import { clientAddress } from '../client-address.js';
import { machineRoute } from './machine.js';

/** 機械の管理者のログイン状態の Cookie（会社の利用者の `m2o_session` と分け、この入口の下だけに送る）。 */
export const MACHINE_ADMIN_COOKIE = 'm2o_machine';
const COOKIE_PATH = '/v1/machine-admin';
const WRONG = 'ID・合言葉・確認コードのどれかが違います';

/**
 * 機械の管理者の入口（仕様書 第8.6.3節）。ローカルの形で、導入のときに機械の管理者を作った機械だけで使える。ほかは 404。
 *
 * @remarks
 * - ログインは ID・合言葉・確認コードの 3 つを確かめる。どれが違ったかは返さない。続けて 5 回間違えると 15 分受け付けない（送り元ごと。全体でも 20 回）
 * - ログイン状態はデータベースに置かず、署名した値を Cookie に持つ（8 時間）。合言葉か確認コードの種を作り直すと、それまでのログイン状態は使えなくなる
 * - 状態を変える要求には CSRF の印（`x-csrf-token`）を求める
 * - データベースにつながらないときは、機械の様子（`GET /machine`）だけを返し、ほかは 503
 * - ログイン・ログアウト・失敗は会社の監査ログ（つながるとき）とシステムログに残す
 */
export function machineAdminRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const throttle = new MachineLoginThrottle();
  const serverSecret = process.env['M2OFFICE_SECRET_KEY'] ?? '';

  /** 使える設定。ローカルの形でなければ・作っていなければ `null`。 */
  const config = () => (deps.ai.deployment() === 'onsite' && deps.onsiteTenant && serverSecret ? machineAdminFromEnv(process.env) : null);

  /** 入っている会社。データベースにつながらなければ `null`。 */
  const tenantOf = async (): Promise<Tenant | null> => deps.repo.findTenantBySubdomain(deps.onsiteTenant!).catch(() => null);

  const audit = async (tenant: Tenant | null, action: string, detail: Record<string, unknown> = {}) => {
    if (!tenant) return;
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: MACHINE_ADMIN_ACTOR, action, targetType: 'machine', targetId: 'admin',
      detail, occurredAt: new Date().toISOString(),
    }).catch((err) => deps.log.warn('機械の管理者の操作を監査ログに残せませんでした', { action, err }));
  };

  app.use('*', async (c, next) => {
    if (!config()) return c.json({ error: '見つかりません' }, 404);
    await next();
  });

  /** ログイン（本文 `id`・`password`・`code`）。 */
  app.post('/login', async (c) => {
    const cfg = config()!;
    const from = clientAddress(c);
    const wait = throttle.lockedFor(from);
    if (wait > 0) return c.json({ error: `間違いが続いたため、受け付けを止めています。${Math.ceil(wait / 60)} 分ほどあとにお試しください` }, 429);
    const b = await c.req.json<{ id?: unknown; password?: unknown; code?: unknown }>().catch(() => ({} as Record<string, unknown>));
    const id = typeof b.id === 'string' ? b.id.trim() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    const code = typeof b.code === 'string' ? b.code : '';
    // どれが違っても同じ時間をかけ、どれが違ったかを返さない
    const idOk = id === cfg.id;
    const passwordOk = password.length > 0 && password.length <= 200 && verifyMachinePassword(password, cfg.passwordHash);
    const step = verifyTotp(cfg.totpSecret, code, new Date(), throttle.usedStep);
    const tenant = await tenantOf();
    if (!idOk || !passwordOk || step === null) {
      throttle.fail(from);
      deps.log.warn('機械の管理者のログインに失敗しました', { from });
      await audit(tenant, 'machine.admin_login_failed');
      return c.json({ error: WRONG }, 401);
    }
    throttle.succeed(from);
    throttle.usedStep = step;
    const key = machineSessionKey(serverSecret, cfg);
    const s = issueMachineSession(key);
    setCookie(c, MACHINE_ADMIN_COOKIE, s.token, {
      httpOnly: true, sameSite: 'Strict', secure: deps.auth.cookieSecure, path: COOKIE_PATH, maxAge: Math.floor(MACHINE_ADMIN_SESSION_MS / 1000),
    });
    deps.log.info('機械の管理者がログインしました', { from });
    await audit(tenant, 'machine.admin_login');
    return c.json({ id: cfg.id, expiresAt: s.expiresAt, csrfToken: machineCsrf(key, s.token) });
  });

  /** ログイン状態を確かめる。 */
  const session = (c: Context<AppEnv>) => {
    const cfg = config()!;
    const key = machineSessionKey(serverSecret, cfg);
    const token = getCookie(c, MACHINE_ADMIN_COOKIE);
    const expiresAt = verifyMachineSession(key, token);
    return expiresAt && token ? { cfg, key, token, expiresAt } : null;
  };

  /** いまのログイン状態（画面が開いたときに見る）。 */
  app.get('/me', (c) => {
    const s = session(c);
    if (!s) return c.json({ error: 'ログインしてください', login: true }, 401);
    return c.json({ id: s.cfg.id, expiresAt: s.expiresAt, csrfToken: machineCsrf(s.key, s.token) });
  });

  /** ログアウト。 */
  app.post('/logout', async (c) => {
    const s = session(c);
    deleteCookie(c, MACHINE_ADMIN_COOKIE, { path: COOKIE_PATH });
    if (s) await audit(await tenantOf(), 'machine.admin_logout');
    return c.json({ ok: true });
  });

  // ここから下は、ログインした機械の管理者だけ
  app.use('/machine/*', async (c, next) => {
    const s = session(c);
    if (!s) return c.json({ error: 'ログインしてください', login: true }, 401);
    const safe = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (!safe && c.req.header('x-csrf-token') !== machineCsrf(s.key, s.token)) return c.json({ error: '画面を読み込み直してください' }, 403);
    const tenant = await tenantOf();
    // データベースにつながらないときは、機械の様子だけを見せる（各部の動きでデータベースの不調が分かる）
    if (!tenant && !(c.req.method === 'GET' && /\/machine\/?$/.test(c.req.path))) {
      return c.json({ error: 'データベースにつながらないため使えません。機械の様子を確かめてください' }, 503);
    }
    const t = tenant ?? ({ id: '', subdomain: deps.onsiteTenant! } as Tenant);
    const user: User = { id: MACHINE_ADMIN_ACTOR, tenantId: t.id, email: '', displayName: '機械の管理者', roles: [], status: 'active' };
    c.set('tenant', t);
    c.set('ctx', { tenant: t, user });
    c.set('auth', { method: 'machine-admin' });
    await next();
  });
  app.route('/machine', machineRoute(deps));

  return app;
}
