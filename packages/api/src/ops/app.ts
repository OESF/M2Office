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
  parseMachineReport, tenantErrorText, welcomeText, tenantsCsv, statusNoticeText, SUSPEND_REASONS, LOCK_REASONS, MACHINE_REPORT_MAX_BYTES, OpsRuleError,
  OPS_PASSKEY_MAX,
  type Logger, type Operator, type OperatorRole, type OpsAction, type OpsSession, type OpsStore,
} from '@m2office/core';
import { ChallengeStore, fromB64, realWebAuthn, toB64, type WebAuthnFns } from './passkey.js';
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
  /** パスキーの手続き（省略すると本物。テストで差し替える）。 */
  webauthn?: WebAuthnFns;
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
    // 開発用ログイン（本番では起動を拒否する）だけはパスキーを求めない。Google のあとは、ログインのたびにパスキーで確かめる
    const { token, session } = await store.createSession(op.id, provider, c.req.header('user-agent') ?? null, config.sessionTtlHours, provider === 'dev');
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
    // パスキーで確かめるまでは、本人とパスキーの操作とログアウトしかできない（第23.8.15節）
    if (!hit.session.verified && c.req.path !== '/v1/ops/me' && c.req.path !== '/v1/ops/auth/logout' && !c.req.path.startsWith('/v1/ops/passkey/')) {
      return c.json({ error: 'パスキーで確かめてください', needsPasskey: true }, 401);
    }
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
      // パスキーで確かめたか。確かめていなければ、登録済みなら確かめ、まだなら登録の合言葉で登録する
      verified: c.get('session').verified, passkeyCount: op.passkeyCount ?? 0,
      can: Object.fromEntries((['tenant.create', 'tenant.status', 'tenant.suspend', 'tenant.lock', 'machine.manage', 'operator.manage', 'settings.manage'] as OpsAction[]).map((a) => [a, operatorCan(op.role, a)])),
    });
  });

  // ---- 運営者のパスキー（第23.8.15節）。確かめる前でも使える道 ----
  const webauthn = deps.webauthn ?? realWebAuthn;
  const challenges = new ChallengeStore();
  /** パスキーの相手の名前（ops. のホスト名）と、画面の元。 */
  const rp = (c: Context<OpsEnv>) => ({ rpID: (c.req.header('host') ?? '').split(':')[0]!, origin: originOf(c) });

  /** 登録の問いかけ。確かめる前は、まだパスキーが無く、登録の合言葉が合うときだけ。確かめたあとは予備を足す。 */
  app.post('/v1/ops/passkey/register-options', async (c) => {
    const op = c.get('operator');
    const session = c.get('session');
    const { code } = await c.req.json<{ code?: string }>().catch(() => ({ code: undefined }));
    const keys = await store.listPasskeys(op.id);
    if (!session.verified) {
      if (keys.length > 0) return c.json({ error: '登録済みのパスキーで確かめてください' }, 409);
      if (!code || !(await store.checkEnrollCode(op.id, code, false))) return c.json({ error: '登録の合言葉が違うか、期限が切れています。運営管理者に出し直してもらってください' }, 403);
    }
    if (keys.length >= OPS_PASSKEY_MAX) return c.json({ error: `パスキーは ${OPS_PASSKEY_MAX} つまでです` }, 409);
    const { rpID } = rp(c);
    const options = await webauthn.registrationOptions({
      rpName: 'M2Office マスター管理', rpID, userName: op.email, userDisplayName: op.displayName,
      userID: new TextEncoder().encode(op.id), attestationType: 'none',
      excludeCredentials: keys.map((k) => ({ id: k.id, transports: k.transports as never })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
    challenges.put(session.id, 'register', options.challenge);
    return c.json({ options });
  });

  app.post('/v1/ops/passkey/register', async (c) => {
    const op = c.get('operator');
    const session = c.get('session');
    const b = await c.req.json<{ response?: unknown; name?: string; code?: string }>().catch(() => ({} as Record<string, unknown>));
    const challenge = challenges.take(session.id, 'register');
    if (!challenge || !b.response) return c.json({ error: '登録をやり直してください' }, 400);
    const { rpID, origin } = rp(c);
    let result;
    try {
      result = await webauthn.verifyRegistration({ response: b.response as never, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    } catch (err) {
      log.warn('運営者のパスキーの登録を確かめられませんでした', { err: err instanceof Error ? err.message : String(err) });
      return c.json({ error: 'パスキーを登録できませんでした' }, 400);
    }
    if (!result.verified) return c.json({ error: 'パスキーを登録できませんでした' }, 400);
    // 確かめる前の登録は、ここで登録の合言葉を使い切る（合わなければ登録しない）
    if (!session.verified && !(typeof b.code === 'string' && (await store.checkEnrollCode(op.id, b.code, true)))) {
      return c.json({ error: '登録の合言葉が違うか、期限が切れています' }, 403);
    }
    const cred = result.registrationInfo.credential;
    await store.addPasskey(op.id, {
      id: cred.id, publicKey: toB64(cred.publicKey), counter: cred.counter, transports: (cred.transports ?? []) as string[],
      name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : 'パスキー',
    });
    await store.markSessionVerified(session.id);
    await store.audit(op.id, 'passkey.add', 'operator', op.id, { name: b.name ?? '' });
    return c.json({ ok: true });
  });

  /** 確かめの問いかけ（ログインのたび）。 */
  app.post('/v1/ops/passkey/options', async (c) => {
    const op = c.get('operator');
    const keys = await store.listPasskeys(op.id);
    if (keys.length === 0) return c.json({ error: 'パスキーが登録されていません' }, 409);
    const options = await webauthn.authenticationOptions({
      rpID: rp(c).rpID, userVerification: 'required',
      allowCredentials: keys.map((k) => ({ id: k.id, transports: k.transports as never })),
    });
    challenges.put(c.get('session').id, 'verify', options.challenge);
    return c.json({ options });
  });

  app.post('/v1/ops/passkey/verify', async (c) => {
    const op = c.get('operator');
    const session = c.get('session');
    const { response } = await c.req.json<{ response?: { id?: string } }>().catch(() => ({ response: undefined }));
    const challenge = challenges.take(session.id, 'verify');
    const key = response?.id ? (await store.listPasskeys(op.id)).find((k) => k.id === response.id) : undefined;
    if (!challenge || !key) return c.json({ error: '確かめをやり直してください' }, 400);
    const { rpID, origin } = rp(c);
    let result;
    try {
      result = await webauthn.verifyAuthentication({
        response: response as never, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: key.id, publicKey: fromB64(key.publicKey), counter: key.counter, transports: key.transports as never },
      });
    } catch (err) {
      log.warn('運営者のパスキーを確かめられませんでした', { err: err instanceof Error ? err.message : String(err) });
      return c.json({ error: 'パスキーで確かめられませんでした' }, 401);
    }
    if (!result.verified) return c.json({ error: 'パスキーで確かめられませんでした' }, 401);
    await store.touchPasskey(key.id, result.authenticationInfo.newCounter);
    await store.markSessionVerified(session.id);
    await store.audit(op.id, 'passkey.verify', 'operator', op.id, { name: key.name });
    return c.json({ ok: true });
  });

  /** 自分のパスキー（確かめたあと）。 */
  app.get('/v1/ops/me/passkeys', async (c) => c.json({
    passkeys: (await store.listPasskeys(c.get('operator').id)).map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt })),
  }));

  app.delete('/v1/ops/me/passkeys/:id', async (c) => {
    const op = c.get('operator');
    if ((await store.listPasskeys(op.id)).length <= 1) return c.json({ error: '最後のパスキーは削除できません（先に予備を足してください）' }, 409);
    if (!(await store.deletePasskey(op.id, c.req.param('id')))) return c.json({ error: '見つかりません' }, 404);
    await store.audit(op.id, 'passkey.delete', 'operator', op.id);
    return c.json({ ok: true });
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

  // ---- 利用の停止と再開（第23.8.6節。段 2） ----
  /** 決めた理由の種類の表示名。 */
  const reasonLabel = (kind: string, code: string) =>
    (kind === 'lock' ? (LOCK_REASONS as Record<string, string>)[code] : (SUSPEND_REASONS as Record<string, string>)[code]) ?? 'そのほか';
  /** 状態の操作の失敗を返す。 */
  const ruleError = (c: Context<OpsEnv>, err: unknown) => {
    if (err instanceof OpsRuleError) return c.json({ error: tenantErrorText(err.code) }, err.code === 'not_found' ? 404 : 409);
    throw err;
  };

  app.get('/v1/ops/status-requests', async (c) => c.json({ requests: await store.listStatusRequests(c.req.query('tenant') || undefined) }));

  // 申請する。緊急停止はすぐに止め、運営者が会社へ渡す案内の文を返す
  app.post('/v1/ops/tenants/:id/requests', async (c) => {
    const b = await c.req.json<{ kind?: string; reasonCode?: string; reason?: string }>().catch(() => ({} as Record<string, string | undefined>));
    const kind = b.kind;
    if (kind !== 'suspend' && kind !== 'lock' && kind !== 'resume') return c.json({ error: tenantErrorText('kind_invalid') }, 400);
    if (!can(c, kind === 'lock' ? 'tenant.lock' : 'tenant.suspend')) return denied(c);
    const codes = kind === 'lock' ? LOCK_REASONS : kind === 'suspend' ? SUSPEND_REASONS : { resolved: '解消した' };
    const reasonCode = b.reasonCode && b.reasonCode in codes ? b.reasonCode : null;
    if (!reasonCode) return c.json({ error: '理由の種類を選んでください' }, 400);
    const reason = (b.reason ?? '').trim().slice(0, 1000);
    const op = c.get('operator');
    try {
      const id = await store.requestStatus(c.req.param('id'), kind, reasonCode, reason, op.id);
      await store.audit(op.id, `tenant.${kind}_request`, 'tenant', c.req.param('id'), { request: id, reasonCode });
      const req = (await store.listStatusRequests(c.req.param('id'))).find((r) => r.id === id);
      return c.json({
        id,
        notice: kind === 'lock' ? statusNoticeText('lock', { name: req?.tenantName ?? '', reasonLabel: reasonLabel(kind, reasonCode) }) : null,
      }, 201);
    } catch (err) { return ruleError(c, err); }
  });

  // 承認するか、しない。通常の停止の承認と再開のあとに、運営者が会社へ渡す案内の文を返す
  app.post('/v1/ops/status-requests/:id/decide', async (c) => {
    if (!can(c, 'tenant.suspend')) return denied(c);
    const { approve } = await c.req.json<{ approve?: boolean }>().catch(() => ({ approve: undefined }));
    if (typeof approve !== 'boolean') return c.json({ error: '承認するかどうかを選んでください' }, 400);
    const op = c.get('operator');
    try {
      const state = await store.decideStatus(c.req.param('id'), approve, op.id);
      const req = (await store.listStatusRequests()).find((r) => r.id === c.req.param('id'));
      await store.audit(op.id, approve ? 'tenant.status_approve' : 'tenant.status_reject', 'tenant', req?.tenantId ?? '', { request: c.req.param('id'), state });
      const notice = !req || !approve ? null
        : req.kind === 'suspend' ? statusNoticeText('suspend_scheduled', { name: req.tenantName ?? '', effectiveAt: req.effectiveAt, reasonLabel: reasonLabel(req.kind, req.reasonCode) })
          : req.kind === 'resume' ? statusNoticeText('resume', { name: req.tenantName ?? '', reasonLabel: '' }) : null;
      return c.json({ state, notice });
    } catch (err) { return ruleError(c, err); }
  });

  app.post('/v1/ops/status-requests/:id/withdraw', async (c) => {
    if (!can(c, 'tenant.suspend')) return denied(c);
    const op = c.get('operator');
    try {
      await store.withdrawStatus(c.req.param('id'), op.id);
      await store.audit(op.id, 'tenant.status_withdraw', 'status-request', c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) { return ruleError(c, err); }
  });

  // 緊急停止の事後の確認（申請した人とは別の運営管理者かサポート）
  app.post('/v1/ops/status-requests/:id/confirm', async (c) => {
    if (!can(c, 'tenant.suspend')) return denied(c);
    const op = c.get('operator');
    try {
      await store.confirmLock(c.req.param('id'), op.id);
      await store.audit(op.id, 'tenant.lock_confirm', 'status-request', c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) { return ruleError(c, err); }
  });

  // ---- 代理アクセス（第23.6.1節）。申請は運営管理者とサポート。入れるのは申請した運営者だけ ----
  app.get('/v1/ops/proxy', async (c) => c.json({ grants: await store.listProxy(c.req.query('tenant') || undefined) }));

  app.post('/v1/ops/tenants/:id/proxy', async (c) => {
    if (!can(c, 'tenant.suspend')) return denied(c);
    const b = await c.req.json<{ scope?: string; reason?: string }>().catch(() => ({} as Record<string, string | undefined>));
    if (b.scope !== 'admin' && b.scope !== 'runs') return c.json({ error: '範囲を選んでください' }, 400);
    const op = c.get('operator');
    try {
      const id = await store.requestProxy(c.req.param('id'), b.scope, (b.reason ?? '').trim().slice(0, 1000), op.id, op.email);
      await store.audit(op.id, 'proxy.request', 'tenant', c.req.param('id'), { grant: id, scope: b.scope });
      return c.json({ id }, 201);
    } catch (err) { return ruleError(c, err); }
  });

  // 会社の画面を開く URL（1 回だけの 2 分の引換券つき）
  app.post('/v1/ops/proxy/:id/open', async (c) => {
    if (!can(c, 'tenant.suspend')) return denied(c);
    const op = c.get('operator');
    try {
      const { ticket, subdomain } = await store.proxyTicket(c.req.param('id'), op.id);
      await store.audit(op.id, 'proxy.open', 'proxy', c.req.param('id'));
      return c.json({ url: `${tenantLoginUrl(originOf(c), subdomain)}?proxy=${encodeURIComponent(ticket)}` });
    } catch (err) { return ruleError(c, err); }
  });

  app.post('/v1/ops/proxy/:id/end', async (c) => {
    if (!can(c, 'tenant.suspend')) return denied(c);
    const op = c.get('operator');
    try {
      await store.endProxy(c.req.param('id'), op.id);
      await store.audit(op.id, 'proxy.end', 'proxy', c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) { return ruleError(c, err); }
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

  // なくしたときの戻し方（第23.8.15節）: 別の運営管理者が、その人のパスキーを削除し、新しい登録の合言葉を出す
  app.post('/v1/ops/operators/:id/enroll-code', async (c) => {
    if (!can(c, 'operator.manage')) return denied(c);
    const target = await store.findOperator(c.req.param('id'));
    if (!target) return c.json({ error: '見つかりません' }, 404);
    const issued = await store.issueEnrollCode(target.id, c.get('operator').id);
    await store.audit(c.get('operator').id, 'operator.enroll_code', 'operator', target.id);
    return c.json(issued);
  });

  app.delete('/v1/ops/operators/:id/passkeys', async (c) => {
    if (!can(c, 'operator.manage')) return denied(c);
    if (c.req.param('id') === c.get('operator').id) return c.json({ error: '自分のパスキーは、別の運営管理者に削除してもらってください' }, 409);
    const target = await store.findOperator(c.req.param('id'));
    if (!target) return c.json({ error: '見つかりません' }, 404);
    await store.resetPasskeys(target.id);
    await store.audit(c.get('operator').id, 'operator.reset_passkeys', 'operator', target.id);
    return c.json({ ok: true });
  });

  app.get('/v1/ops/audit', async (c) => c.json({ entries: await store.listAudit(Number(c.req.query('limit') ?? 200)) }));

  return app;
}
