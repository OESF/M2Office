/**
 * @file マスター管理画面の API（仕様書 第23.8.15節、ADR-0078）。顧客向けの API とは別のプロセスで動く（Q-212）。
 *
 * 名前が `ops.` で始まる要求だけを受ける（Google からの戻りだけは、開発で `localhost` に戻るため例外にする）。
 * 運営者のログインは Google だけ（Q-211。段 1）。Cookie は `ops.` のホストだけに張り、顧客のサブドメインには渡らない。
 * データベースは運営の専用のロールで、顧客の表には届かない（移行 111）。
 */

import { Hono, type Context, type Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  buildGoogleLoginUrl, createPkce, exchangeGoogleLoginCode, googleUserInfo, checkNewTenant, machineFlags, operatorCan, OPERATOR_ROLES,
  parseMachineReport, tenantErrorText, welcomeText, tenantsCsv, MACHINE_REPORT_MAX_BYTES, OpsRuleError,
  type Logger, type Operator, type OperatorRole, type OpsAction, type OpsSession, type OpsStore,
} from '@m2office/core';
import { HandoffStore } from '../auth/handoff.js';
import { OAuthStateStore } from '../auth/oauth-state.js';

/** 運営のログイン状態の Cookie（顧客の `m2o_session` と分ける）。 */
export const OPS_COOKIE = 'm2o_ops_session';

/** 運営の API の設定。 */
export interface OpsConfig {
  /** 運営の OAuth クライアント（顧客のログインと同じもの）と、運営の戻り先。 */
  login: { clientId: string; clientSecret: string; redirectUri: string } | null;
  /** 運営主体の Google Workspace のドメイン（あればこのドメインの人だけ）。 */
  googleDomain: string | null;
  /** 開発用ログイン（運営者を選ぶ）。本番では起動を拒否する。 */
  devLogin: boolean;
  cookieSecure: boolean;
  sessionTtlHours: number;
}

/** 運営の API が使うもの。 */
export interface OpsDeps {
  store: OpsStore;
  config: OpsConfig;
  log: Logger;
}

type OpsEnv = { Variables: { operator: Operator; session: OpsSession } };

/** 名前が `ops.` で始まるか（`ops.lvh.me:3100`・`ops.<本番のドメイン>`）。 */
export function isOpsHost(host: string | undefined): boolean {
  return !!host && host.split(':')[0]!.split('.')[0] === 'ops' && host.split(':')[0]!.split('.').length >= 2;
}

/**
 * 運営の画面の元（オリジン）から、会社のログインの URL を作る（`ops.` を会社のサブドメインに置き換える）。
 *
 * @example opsOrigin `https://ops.lvh.me:3100` と `acme` → `https://acme.lvh.me:3100/`
 */
export function tenantLoginUrl(opsOrigin: string, subdomain: string): string {
  const u = new URL(opsOrigin);
  u.hostname = u.hostname.replace(/^ops\./, `${subdomain}.`);
  u.pathname = '/';
  return u.toString();
}

/** 要求の元（画面のオリジン）。 */
function originOf(c: Context): string {
  const o = c.req.header('origin');
  if (o && isOpsHost(new URL(o).host)) return o;
  const host = c.req.header('host') ?? '';
  const proto = c.req.header('x-forwarded-proto') ?? 'https';
  return `${proto}://${host}`;
}

/**
 * マスター管理画面の API を組み立てる。
 *
 * @remarks 運営者の操作はすべて運営の操作の記録に残す。会社に影響する操作は、データベースの関数がその会社の監査ログにも残す
 */
export function opsApp(deps: OpsDeps): Hono<OpsEnv> {
  const { store, config, log } = deps;
  const app = new Hono<OpsEnv>();
  const states = new OAuthStateStore();
  const handoffs = new HandoffStore();

  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    const op = c.get('operator');
    const fields = { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started, operatorId: op?.id };
    if (c.req.path === '/health') log.debug('要求', fields); else if (c.res.status >= 500) log.error('要求', fields); else log.info('要求', fields);
  });
  app.onError((err, c) => {
    log.error('運営の API で例外が発生しました', { err: err instanceof Error ? err.message : String(err), path: c.req.path });
    return c.json({ error: '処理できませんでした' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true, service: 'ops' }));

  // 名前が ops. で始まる要求だけを受ける。Google からの戻りは、開発では localhost に戻るため例外にする（state で照合する）
  app.use('/v1/ops/*', async (c, next) => {
    if (c.req.path === '/v1/ops/auth/callback' || isOpsHost(c.req.header('host'))) return next();
    return c.json({ error: '見つかりません' }, 404);
  });

  // ---- 稼働の知らせの受け口（ローカルの形の機械が 1 時間に 1 回送る。第8.6.8節）。ログインではなく機械の鍵で名乗る ----
  app.post('/v1/ops/heartbeat', async (c) => {
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!token) return c.json({ error: '鍵がありません' }, 401);
    const text = await c.req.text();
    if (text.length > MACHINE_REPORT_MAX_BYTES) return c.json({ error: '大きすぎます' }, 413);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return c.json({ error: '形が違います' }, 400); }
    const report = parseMachineReport(body);
    if (!report) return c.json({ error: '形が違います' }, 400);
    const id = await store.receiveReport(token, report);
    if (!id) return c.json({ error: '鍵が違います' }, 401);
    return c.json({ ok: true });
  });

  // ---- ログイン（Google だけ。Q-211） ----
  app.get('/v1/ops/auth/providers', async (c) => c.json({
    google: { enabled: !!config.login },
    dev: config.devLogin
      ? { enabled: true, operators: (await store.listOperators()).filter((o) => o.status === 'active').map((o) => ({ email: o.email, displayName: o.displayName, role: o.role })) }
      : { enabled: false, operators: [] },
  }));

  /** ログイン状態を作り、Cookie を張る。 */
  const signIn = async (c: Context<OpsEnv>, op: Operator, provider: string) => {
    const { token, session } = await store.createSession(op.id, provider, c.req.header('user-agent') ?? null, config.sessionTtlHours);
    setCookie(c, OPS_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: config.cookieSecure, path: '/', maxAge: config.sessionTtlHours * 3600 });
    await store.audit(op.id, 'ops.login', 'operator', op.id, { provider });
    return c.json({ ok: true, csrfToken: session.csrfToken });
  };

  app.post('/v1/ops/auth/dev-login', async (c) => {
    if (!config.devLogin) return c.json({ error: '開発用ログインは無効です' }, 404);
    const { email } = await c.req.json<{ email?: string }>().catch(() => ({ email: undefined }));
    const op = email ? await store.findOperatorByEmail(email) : null;
    if (!op || op.status !== 'active') return c.json({ error: '登録されていない運営者です' }, 403);
    return signIn(c, op, 'dev');
  });

  app.get('/v1/ops/auth/google/start', (c) => {
    if (!config.login) return c.json({ error: 'Google のログインの設定がありません' }, 503);
    const { verifier, challenge } = createPkce();
    const state = states.issue({ tenantId: 'ops', userId: '', codeVerifier: verifier, returnTo: originOf(c) });
    return c.json({
      url: buildGoogleLoginUrl({
        clientId: config.login.clientId, redirectUri: config.login.redirectUri, state, codeChallenge: challenge,
        ...(config.googleDomain ? { hostedDomain: config.googleDomain } : {}),
      }),
    });
  });

  app.get('/v1/ops/auth/callback', async (c) => {
    const pending = states.take(c.req.query('state') ?? '');
    if (!pending || pending.tenantId !== 'ops') return c.text('ログインの要求が無効か、期限が切れています。もう一度お試しください。', 400);
    // 失敗しても、どこまで合っていたかは示さない（登録の有無を外から測らせない）
    const back = (result: string) => c.redirect(`${pending.returnTo}/?login=${result}`);
    const code = c.req.query('code');
    if (c.req.query('error') || !code || !config.login) return back('failed');
    try {
      const { accessToken } = await exchangeGoogleLoginCode({ ...config.login, code, codeVerifier: pending.codeVerifier });
      const { email } = await googleUserInfo(accessToken);
      const op = email && (!config.googleDomain || email.split('@')[1] === config.googleDomain) ? await store.findOperatorByEmail(email) : null;
      if (!op || op.status !== 'active') {
        log.warn('運営の画面へのログインを断りました', { reason: op ? '無効にした運営者' : '登録されていない' });
        return back('denied');
      }
      return c.redirect(`${pending.returnTo}/?ticket=${encodeURIComponent(handoffs.issue({ tenantId: 'ops', userId: op.id }))}`);
    } catch (err) {
      log.warn('運営の画面へのログインに失敗しました', { err: err instanceof Error ? err.message : String(err) });
      return back('failed');
    }
  });

  /** 引換券を、`ops.` のホストでのログイン状態に換える（Cookie はこの口でだけ張る）。 */
  app.post('/v1/ops/auth/exchange', async (c) => {
    const { ticket } = await c.req.json<{ ticket?: string }>().catch(() => ({ ticket: undefined }));
    const hit = ticket ? handoffs.take(ticket) : null;
    const op = hit && hit.tenantId === 'ops' ? await store.findOperator(hit.userId) : null;
    if (!op || op.status !== 'active') return c.json({ error: 'ログインをやり直してください' }, 401);
    return signIn(c, op, 'google');
  });

  // ---- ここから先はログインが要る ----
  app.use('/v1/ops/*', async (c, next: Next) => {
    if (c.req.path.startsWith('/v1/ops/auth/') && c.req.path !== '/v1/ops/auth/logout') return next();
    const token = getCookie(c, OPS_COOKIE);
    const hit = token ? await store.findSession(token) : null;
    if (!hit) return c.json({ error: 'ログインしてください', needsLogin: true }, 401);
    // 書き換える要求は、画面が持つ CSRF の値と照らす
    if (c.req.method !== 'GET' && c.req.header('x-csrf-token') !== hit.session.csrfToken) {
      return c.json({ error: '画面を再読み込みしてから、もう一度お試しください' }, 403);
    }
    c.set('operator', hit.operator);
    c.set('session', hit.session);
    return next();
  });

  /** そのロールでできない操作なら 403。 */
  const can = (c: Context<OpsEnv>, action: OpsAction) => operatorCan(c.get('operator').role, action);
  const denied = (c: Context<OpsEnv>) => c.json({ error: 'この操作を行う権限がありません' }, 403);

  app.post('/v1/ops/auth/logout', async (c) => {
    await store.revokeSession(c.get('session').id);
    await store.audit(c.get('operator').id, 'ops.logout', 'operator', c.get('operator').id);
    deleteCookie(c, OPS_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/v1/ops/me', (c) => {
    const op = c.get('operator');
    return c.json({
      operator: op, csrfToken: c.get('session').csrfToken,
      can: Object.fromEntries((['tenant.create', 'tenant.status', 'machine.manage', 'operator.manage', 'settings.manage'] as OpsAction[]).map((a) => [a, operatorCan(op.role, a)])),
    });
  });

  // ---- 会社 ----
  app.get('/v1/ops/tenants', async (c) => c.json({ tenants: await store.tenantOverview() }));

  // CSV の書き出し（運営の操作の記録に残す）
  app.get('/v1/ops/tenants.csv', async (c) => {
    const rows = await store.tenantOverview();
    await store.audit(c.get('operator').id, 'tenants.export', 'tenant', '*', { count: rows.length });
    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', `attachment; filename="m2office-tenants-${new Date().toISOString().slice(0, 10)}.csv"`);
    return c.body(tenantsCsv(rows));
  });

  // 会社の詳細（開いたことを運営の操作の記録に残す。利用者の名前を出すのはここだけ）
  app.get('/v1/ops/tenants/:id', async (c) => {
    const detail = await store.tenantDetail(c.req.param('id'));
    if (!detail) return c.json({ error: '会社が見つかりません' }, 404);
    await store.audit(c.get('operator').id, 'tenant.view', 'tenant', detail.tenant.id);
    return c.json({ detail, opsHistory: await store.listAuditFor(detail.tenant.id) });
  });

  // サーバー全体の稼働状況（第23.8.7節のうち段 1 の分）
  app.get('/v1/ops/server', async (c) => c.json({ status: await store.serverStatus() }));

  // 運営主体の設定（第23.8.14節）
  app.get('/v1/ops/settings/operator', async (c) => c.json({ profile: await store.operatorProfile() }));
  app.put('/v1/ops/settings/operator', async (c) => {
    if (!can(c, 'settings.manage')) return denied(c);
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const s = (k: string, max: number) => (typeof b[k] === 'string' ? (b[k] as string).trim().slice(0, max) : '');
    const profile = { nameJa: s('nameJa', 200), nameEn: s('nameEn', 200), address: s('address', 300), web: s('web', 300), contact: s('contact', 300) };
    if (profile.web && !/^https:\/\//.test(profile.web)) return c.json({ error: 'Web は https:// で始めてください' }, 400);
    await store.setOperatorProfile(profile, c.get('operator').id);
    await store.audit(c.get('operator').id, 'settings.operator', 'settings', 'operator', profile);
    return c.json({ profile });
  });

  app.post('/v1/ops/tenants', async (c) => {
    if (!can(c, 'tenant.create')) return denied(c);
    const checked = checkNewTenant(await c.req.json().catch(() => ({})));
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    const op = c.get('operator');
    try {
      const id = await store.createTenant(checked.value, op.id);
      const v = checked.value;
      await store.audit(op.id, 'tenant.create', 'tenant', id, { subdomain: v.subdomain, domain: v.domain, admin: v.admin, status: v.status });
      const loginUrl = tenantLoginUrl(originOf(c), v.subdomain);
      return c.json({ id, loginUrl, welcome: welcomeText({ name: v.name, loginUrl, admin: v.admin, domain: v.domain }) }, 201);
    } catch (err) {
      if (err instanceof OpsRuleError) return c.json({ error: tenantErrorText(err.code) }, 409);
      throw err;
    }
  });

  app.put('/v1/ops/tenants/:id/status', async (c) => {
    if (!can(c, 'tenant.status')) return denied(c);
    const { status } = await c.req.json<{ status?: string }>().catch(() => ({ status: undefined }));
    if (status !== 'trial' && status !== 'active') return c.json({ error: tenantErrorText('status_invalid') }, 400);
    const op = c.get('operator');
    try {
      const from = await store.setTenantStatus(c.req.param('id'), status, op.id);
      if (from !== status) await store.audit(op.id, 'tenant.status', 'tenant', c.req.param('id'), { from, to: status });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof OpsRuleError) return c.json({ error: tenantErrorText(err.code) }, err.code === 'not_found' ? 404 : 409);
      throw err;
    }
  });

  // ---- ローカルの形の機械（稼働の知らせ。第8.6.8節） ----
  app.get('/v1/ops/machines', async (c) => {
    const now = new Date();
    return c.json({ machines: (await store.listMachines()).map((m) => ({ ...m, flags: machineFlags(m.lastAt, m.report, now) })) });
  });

  app.post('/v1/ops/machines', async (c) => {
    if (!can(c, 'machine.manage')) return denied(c);
    const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
    const n = (name ?? '').trim();
    if (!n || n.length > 100) return c.json({ error: '呼び名を入れてください' }, 400);
    const op = c.get('operator');
    const { machine, token } = await store.addMachine(n, op.id);
    await store.audit(op.id, 'machine.add', 'machine', machine.id, { name: n });
    return c.json({ machine, token }, 201);
  });

  app.delete('/v1/ops/machines/:id', async (c) => {
    if (!can(c, 'machine.manage')) return denied(c);
    if (!(await store.removeMachine(c.req.param('id')))) return c.json({ error: '見つかりません' }, 404);
    await store.audit(c.get('operator').id, 'machine.remove', 'machine', c.req.param('id'));
    return c.json({ ok: true });
  });

  // ---- 運営者と操作履歴 ----
  app.get('/v1/ops/operators', async (c) => c.json({ operators: await store.listOperators() }));

  app.post('/v1/ops/operators', async (c) => {
    if (!can(c, 'operator.manage')) return denied(c);
    const b = await c.req.json<{ email?: string; displayName?: string; role?: string }>().catch(() => ({} as Record<string, string | undefined>));
    const email = (b.email ?? '').trim().toLowerCase();
    const role = b.role as OperatorRole;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'メールアドレスを入れてください' }, 400);
    if (config.googleDomain && email.split('@')[1] !== config.googleDomain) return c.json({ error: `運営者は ${config.googleDomain} のアカウントにしてください` }, 400);
    if (!OPERATOR_ROLES.includes(role)) return c.json({ error: 'ロールを選んでください' }, 400);
    const op = c.get('operator');
    const added = await store.addOperator({ email, displayName: (b.displayName ?? '').trim() || email.split('@')[0]!, role, by: op.id });
    if (!added) return c.json({ error: 'すでに登録されています' }, 409);
    await store.audit(op.id, 'operator.add', 'operator', added.id, { email, role });
    return c.json({ operator: added }, 201);
  });

  app.put('/v1/ops/operators/:id', async (c) => {
    if (!can(c, 'operator.manage')) return denied(c);
    const b = await c.req.json<{ role?: string; status?: string }>().catch(() => ({} as Record<string, string | undefined>));
    const role = b.role !== undefined ? b.role as OperatorRole : undefined;
    const status = b.status !== undefined ? b.status as Operator['status'] : undefined;
    if (role !== undefined && !OPERATOR_ROLES.includes(role)) return c.json({ error: 'ロールが違います' }, 400);
    if (status !== undefined && status !== 'active' && status !== 'disabled') return c.json({ error: '状態が違います' }, 400);
    const target = await store.findOperator(c.req.param('id'));
    if (!target) return c.json({ error: '見つかりません' }, 404);
    // 運営管理者がいなくならないようにする（最後の 1 人のロールを下げる・無効にすることはできない）
    const losesAdmin = target.role === 'admin' && target.status === 'active' && ((role && role !== 'admin') || status === 'disabled');
    if (losesAdmin && (await store.activeAdminCount()) <= 1) return c.json({ error: '運営管理者が 1 人もいなくなるため、変えられません' }, 409);
    const updated = await store.updateOperator(target.id, { ...(role ? { role } : {}), ...(status ? { status } : {}) });
    await store.audit(c.get('operator').id, 'operator.update', 'operator', target.id, { ...(role ? { role } : {}), ...(status ? { status } : {}) });
    return c.json({ operator: updated });
  });

  app.get('/v1/ops/audit', async (c) => c.json({ entries: await store.listAudit(Number(c.req.query('limit') ?? 200)) }));

  return app;
}
