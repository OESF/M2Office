/**
 * @file 認証の要る会社の接続（`oauth`）の、利用者ごとの接続と取り消し、相手のサービスからの戻り（仕様書 第12.11.6.3節）。
 *
 * 本人が許可し、本人が取り消す。業務は依頼した本人の認可で呼ぶ（不変則 I-9）。
 * 認可の値は暗号化して持ち、画面にも API にも出さない。
 */

import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import {
  CANCELLABLE, ConnectionOAuthError, buildConnectionAuthUrl, cancelRun, createPkce, discoverOAuthEndpoints,
  exchangeConnectionCode, fetchAccountLabel, presetById, registerOAuthClient, revokeConnectionToken, scopesForTools,
  type ConnectionSecret, type TenantConnection,
} from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';
import { isOperational } from '../middleware/tenant.js';

/**
 * その接続で求める権限（第12.11.6.2節「会社で使うツールが要るものだけ」）。
 *
 * @param disabled 管理者が止めたツール（`<接続の ID>.<ツール>`）
 */
export function requestedScopes(conn: TenantConnection, disabled: ReadonlySet<string>): string[] {
  const preset = presetById(conn.auth.preset);
  const enabled = conn.tools.filter((t) => !disabled.has(`${conn.id}.${t.name}`)).map((t) => t.name);
  if (preset) return scopesForTools(preset, enabled);
  return conn.auth.scopes ?? [];
}

/**
 * 認可の口を用意する。宣言に無ければ相手のサーバの案内から見つけ、接続に書き足して保存する（第12.11.6.2節）。
 *
 * @returns 口が分かった接続。見つからなければ `null`
 */
export async function ensureEndpoints(deps: AppDeps, conn: TenantConnection, needRegistration = false): Promise<TenantConnection | null> {
  if (conn.auth.authorizeUrl && conn.auth.tokenUrl && (!needRegistration || conn.auth.registrationUrl)) return conn;
  const found = await discoverOAuthEndpoints(conn.url);
  if (!found) return conn.auth.authorizeUrl && conn.auth.tokenUrl ? conn : null;
  const next: TenantConnection = {
    ...conn,
    auth: {
      ...conn.auth, authorizeUrl: conn.auth.authorizeUrl ?? found.authorizeUrl, tokenUrl: conn.auth.tokenUrl ?? found.tokenUrl,
      ...(found.registrationUrl ? { registrationUrl: found.registrationUrl, tokenAuthMethods: found.tokenAuthMethods } : {}),
    },
    updatedAt: new Date().toISOString(),
  };
  await deps.repo.saveConnection(next);
  return next;
}

/**
 * 接続のアプリ（クライアント）を用意する。会社が登録していなければ、相手が自動登録の口を持つときに M2Office が自動で登録する
 * （第12.11.6.2節「アプリの自動登録の決まり」、Q-99）。
 *
 * @returns 使えるアプリと、口の分かった接続
 * @throws ConnectionOAuthError 会社の登録が無く、自動登録もできない
 * @remarks 送るのはアプリの名前・戻り先・認可の型・求める権限だけ。返ってきたクライアント ID とシークレットは暗号化して持つ。監査ログ `connection.oauth.register`
 */
export async function ensureClient(
  deps: AppDeps, tenantId: string, userId: string, conn: TenantConnection,
): Promise<{ secret: ConnectionSecret; conn: TenantConnection }> {
  const secret = await deps.repo.getConnectionSecret(tenantId, conn.id);
  if (secret?.clientId) {
    const ready = await ensureEndpoints(deps, conn);
    if (!ready) throw new ConnectionOAuthError(`「${conn.name}」の許可の画面が分かりませんでした。管理者にお問い合わせください`);
    return { secret, conn: ready };
  }
  const ready = await ensureEndpoints(deps, conn, true);
  if (!ready?.auth.registrationUrl) throw new ConnectionOAuthError(`「${conn.name}」の接続の設定が済んでいません。管理者にお問い合わせください`);
  const view = await deps.tenantView(tenantId);
  const client = await registerOAuthClient({
    registrationUrl: ready.auth.registrationUrl, redirectUri: deps.oauth.connectionRedirectUri,
    scopes: requestedScopes(ready, view.disabledTools), authMethods: ready.auth.tokenAuthMethods ?? [],
  });
  const saved: ConnectionSecret = {
    tenantId, connectionId: conn.id, clientId: client.clientId,
    clientSecretEnc: client.clientSecret ? deps.box.encrypt(client.clientSecret) : null, apiKeyEnc: null, autoRegistered: true,
    updatedBy: userId, updatedAt: new Date().toISOString(),
  };
  await deps.repo.saveConnectionSecret(saved);
  // クライアント ID の値とシークレットは記録しない
  await audit(deps, tenantId, userId, 'connection.oauth.register', conn.id, { authorizationServer: new URL(ready.auth.registrationUrl).host });
  return { secret: saved, conn: ready };
}

/**
 * 許可の画面の URL を作る。`state` と PKCE を付け、戻ってきたら照合する。
 *
 * @throws ConnectionOAuthError 会社の設定が済んでいない・認可の口が分からない
 */
export async function beginConnectionAuth(
  deps: AppDeps, tenantId: string, userId: string, conn: TenantConnection, back: string,
): Promise<string> {
  const { secret, conn: ready } = await ensureClient(deps, tenantId, userId, conn);
  const view = await deps.tenantView(tenantId);
  const pkce = createPkce();
  const state = deps.oauth.states.issue({ tenantId, userId, codeVerifier: pkce.verifier, returnTo: back, connectionId: conn.id });
  return buildConnectionAuthUrl({
    authorizeUrl: ready.auth.authorizeUrl!, clientId: secret.clientId!, redirectUri: deps.oauth.connectionRedirectUri,
    scopes: requestedScopes(ready, view.disabledTools), state, codeChallenge: pkce.challenge,
  });
}

/**
 * 相手のサービスからの戻り（`/v1/oauth/connection/callback`）。テナントの判定とログインより前に受ける。
 *
 * @remarks `state` を照合してテナント・利用者・接続を引く。照合できなければ何もしない（第12.11.6.3節）
 */
export function registerConnectionCallback(app: Hono, deps: AppDeps): void {
  app.get('/connection/callback', async (c) => {
    const pending = deps.oauth.states.take(c.req.query('state') ?? '');
    // Google の要求の state では受けない（取り違えを防ぐ）
    if (!pending?.connectionId) {
      return c.text('この接続の要求は無効か、期限が切れています。M2Office の個人設定からもう一度「接続する」を押してください。', 400);
    }
    const connectionId = pending.connectionId;
    const back = (result: string) =>
      c.redirect(`${pending.returnTo}${pending.returnTo.includes('?') ? '&' : '?'}connection=${result}&id=${encodeURIComponent(connectionId)}`);
    if (c.req.query('error')) return back('cancelled');
    const code = c.req.query('code');
    if (!code) return back('failed');
    // 要求のあとに停止された会社では保存しない（第23.8.6節）
    const tenant = await deps.repo.findTenantById(pending.tenantId);
    if (!tenant || !isOperational(tenant)) return back('failed');
    try {
      const conn = (await deps.repo.listConnections(pending.tenantId)).find((x) => x.id === connectionId);
      const secret = await deps.repo.getConnectionSecret(pending.tenantId, connectionId);
      if (!conn || conn.auth.type !== 'oauth' || !conn.auth.tokenUrl || !secret?.clientId) return back('failed');
      let tokens;
      try {
        tokens = await exchangeConnectionCode({
          tokenUrl: conn.auth.tokenUrl, clientId: secret.clientId, clientSecret: secret.clientSecretEnc ? deps.box.decrypt(secret.clientSecretEnc) : null,
          code, redirectUri: deps.oauth.connectionRedirectUri, codeVerifier: pending.codeVerifier,
        });
      } catch (err) {
        // 自動で登録したアプリを相手が無効にしていたら、アプリを消し、次の接続で登録し直す。全員に接続し直しを促す（第12.11.6.2節）
        if (secret.autoRegistered && err instanceof Error && /invalid_client/.test(err.message)) {
          await deps.repo.saveConnectionSecret({ ...secret, clientId: null, clientSecretEnc: null, autoRegistered: false, updatedAt: new Date().toISOString() });
          const reset = await deps.repo.deleteUserConnectionsFor(pending.tenantId, connectionId);
          await audit(deps, pending.tenantId, pending.userId, 'connection.oauth.register_reset', connectionId, { reset });
        }
        throw err;
      }
      const label = conn.auth.accountUrl ? await fetchAccountLabel(conn.auth.accountUrl, tokens.accessToken) : '';
      const now = new Date().toISOString();
      await deps.repo.saveUserConnection({
        tenantId: pending.tenantId, userId: pending.userId, connectionId,
        accessTokenEnc: deps.box.encrypt(tokens.accessToken),
        refreshTokenEnc: tokens.refreshToken ? deps.box.encrypt(tokens.refreshToken) : null,
        expiresAt: tokens.expiresAt, scopes: tokens.scopes, accountLabel: label, clientId: secret.clientId,
        connectedAt: now, updatedAt: now,
      });
      await audit(deps, pending.tenantId, pending.userId, 'connection.oauth.connect', connectionId, { scopes: tokens.scopes, account: label });
      return back('connected');
    } catch (err) {
      deps.log.warn('会社の接続の認可に失敗しました', {
        tenantId: pending.tenantId, connectionId, err: err instanceof Error ? err.message : String(err),
      });
      return back('failed');
    }
  });
}

/**
 * 個人設定「サービスとの接続」の API（`/v1/me/connections`。仕様書 第6.5.9節）。本人の分だけを扱う。
 *
 * @param returnTo 接続のあとに戻す画面を、要求から決める（Google の接続と同じ）
 */
export function myConnectionsRoute(deps: AppDeps, returnTo: (c: Context<AppEnv>) => string) {
  const app = new Hono<AppEnv>();

  /** 会社の `oauth` の接続と、本人が接続しているか。 */
  app.get('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    const view = await deps.tenantView(tenant.id);
    const mine = await deps.repo.listUserConnections(tenant.id, { userId: user.id });
    const agents = await deps.agentsFor(tenant.id, user.id);
    const items = [];
    for (const conn of view.connections.filter((x) => x.auth.type === 'oauth')) {
      const secret = await deps.repo.getConnectionSecret(tenant.id, conn.id);
      const uc = mine.find((m) => m.connectionId === conn.id);
      const want = requestedScopes(conn, view.disabledTools);
      items.push({
        id: conn.id, name: conn.name, description: conn.description ?? '',
        // 会社が登録したアプリがあるか、相手がアプリの自動登録に対応していれば接続できる（第12.11.6.2節、Q-99）
        available: !!secret?.clientId || !!conn.auth.registrationUrl,
        connected: !!uc, account: uc?.accountLabel ?? '', connectedAt: uc?.connectedAt ?? null,
        // 会社がツールを足して権限が増えたら、接続し直しを促す（第6.5.9節）。相手が権限を返さなければ判断しない
        needsReconnect: !!uc && uc.scopes.length > 0 && want.some((s) => !uc.scopes.includes(s)),
        usedBy: agents.filter((a) => a.tools.some((n) => n.startsWith(`${conn.id}.`))).map((a) => ({ id: a.id, name: a.name })),
      });
    }
    return c.json({ items });
  });

  /** 相手のサービスの許可の画面の URL を返す（画面が移る）。 */
  app.post('/:id/connect', async (c) => {
    const { tenant, user } = c.get('ctx');
    const conn = (await deps.repo.listConnections(tenant.id)).find((x) => x.id === c.req.param('id'));
    if (!conn || conn.auth.type !== 'oauth') return c.json({ error: '接続が見つかりません' }, 404);
    try {
      return c.json({ url: await beginConnectionAuth(deps, tenant.id, user.id, conn, returnTo(c)) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : '接続を始められませんでした' }, 409);
    }
  });

  /** 取り消すと止まる業務（取り消す前に示す。第12.11.6.5節）。 */
  app.get('/:id/impact', async (c) => {
    const { tenant, user } = c.get('ctx');
    const view = await deps.tenantView(tenant.id);
    const id = c.req.param('id');
    const runs = await liveRunsUsing(deps, tenant.id, user.id, id);
    const agents = (await deps.agentsFor(tenant.id, user.id)).filter((a) => a.tools.some((n) => n.startsWith(`${id}.`)));
    const schedules = (await deps.repo.listSchedules(tenant.id, user.id)).filter((s) => s.enabled && view.resolve(s.agentId, s.agentVersion)?.tools.some((n) => n.startsWith(`${id}.`)));
    return c.json({ runs: runs.length, agents: agents.map((a) => ({ id: a.id, name: a.name })), schedules: schedules.length });
  });

  /**
   * 取り消す。相手の側でも取り消し（口があれば）、保存した認可を消し、その接続を使う本人の動いている業務を止める。
   */
  app.delete('/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const id = c.req.param('id');
    const conn = (await deps.repo.listConnections(tenant.id)).find((x) => x.id === id);
    const uc = await deps.repo.getUserConnection(tenant.id, user.id, id);
    if (!conn || !uc) return c.json({ error: '接続していません' }, 404);
    if (conn.auth.revokeUrl) await revokeConnectionToken(conn.auth.revokeUrl, deps.box.decrypt(uc.accessTokenEnc));
    await deps.repo.deleteUserConnection(tenant.id, user.id, id);
    const stopped = await stopRuns(deps, tenant.id, user.id, conn);
    await audit(deps, tenant.id, user.id, 'connection.oauth.disconnect', id, { stopped: stopped.length });
    return c.json({ ok: true, stopped: stopped.length });
  });

  return app;
}

/** その人の、その接続のツールを使う、止められる業務。 */
async function liveRunsUsing(deps: AppDeps, tenantId: string, userId: string, connectionId: string) {
  const view = await deps.tenantView(tenantId);
  const live = await deps.repo.listLiveRuns(tenantId, new Date().toISOString());
  return live.filter((r) => r.job.requestedBy === userId && CANCELLABLE.has(r.run.status)
    && !!view.resolve(r.job.agentId, r.job.agentVersion)?.tools.some((n) => n.startsWith(`${connectionId}.`)));
}

/** 取り消したので、その接続を使う本人の業務を止める（第12.11.6.5節）。止めた実行の ID を返す。 */
async function stopRuns(deps: AppDeps, tenantId: string, userId: string, conn: TenantConnection): Promise<string[]> {
  const reason = `${conn.name}との接続を取り消したため止めました`;
  const stopped: string[] = [];
  const now = new Date();
  for (const { run, job } of await liveRunsUsing(deps, tenantId, userId, conn.id)) {
    const result = await cancelRun(deps.repo, job, run, reason, { actorType: 'system', actorId: 'connection' }, { connection: conn.id }, now);
    if (!result.stopped) continue;
    await deps.repo.createNotification({
      id: randomUUID(), tenantId, userId: job.requestedBy, kind: 'failure', title: '業務を止めました',
      body: `${reason}。必要なら、接続し直してから、もう一度依頼してください。`, runId: run.id, readAt: null, createdAt: now.toISOString(),
    });
    stopped.push(run.id);
  }
  return stopped;
}

async function audit(deps: AppDeps, tenantId: string, userId: string, action: string, targetId: string, detail: Record<string, unknown>) {
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType: 'connection', targetId,
    detail, occurredAt: new Date().toISOString(),
  });
}
