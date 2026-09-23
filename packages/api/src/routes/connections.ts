/**
 * @file 接続の設定の API。Gemini（自社の鍵・モデル・接続の確認）と Google Workspace（会社の OAuth クライアント・
 * 利用者ごとの接続）。
 *
 * AI Radio の「システム接続設定」と OAuth の流れを引き継ぐ（ADR-0007）。秘密の値は暗号化して保存し、API では返さない。
 * 許可の状況は、保存の有無ではなく Google に実際に許可された範囲を問い合わせて示す。
 *
 * @see 仕様書 第14.3.3節 接続の設定
 * @see 仕様書 第6.5.2節 Google 連携
 */

import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import {
  buildGoogleAuthUrl, checkGeminiLive, checkGeminiText, createPkce, exchangeGoogleCode, exchangeGoogleLoginCode, googleGrantedScopes,
  googleScopeLabel, googleUserEmail, refreshGoogleAccessToken, revokeGoogleToken, GoogleOAuthError,
  type GeminiModels, type GeminiSettingsMeta,
} from '@m2office/core';
import type { AppDeps } from '../context.js';
import { isOperational, requireRole, type AppEnv } from '../middleware/tenant.js';

const MODEL_KEYS: (keyof GeminiModels)[] = ['fast', 'standard', 'advanced', 'research', 'live'];

async function audit(deps: AppDeps, tenantId: string, userId: string, action: string, targetId: string, detail: Record<string, unknown> = {}) {
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType: 'connection', targetId,
    detail, occurredAt: new Date().toISOString(),
  });
}

/**
 * その会社で使える業務が求める Google の権限（短い名前）。無効にした業務は除く（仕様書 第14.3.2節 規定 2）。
 */
export async function requiredGoogleScopes(deps: AppDeps, tenantId: string): Promise<{ scope: string; level: string }[]> {
  const [view, settings] = await Promise.all([deps.tenantView(tenantId), deps.repo.getTenantSettings(tenantId)]);
  const out = new Map<string, string>();
  for (const agent of view.agents.filter((a) => !settings.agents.disabled.includes(a.id))) {
    for (const tool of view.registry.allowed(agent.tools)) if (tool.google) out.set(tool.google.scope, tool.google.level);
  }
  return [...out.entries()].map(([scope, level]) => ({ scope, level })).sort((a, b) => a.scope.localeCompare(b.scope));
}

/** 会社の OAuth クライアント（ID と、復号したシークレット）。未登録なら `null`。 */
async function googleClient(deps: AppDeps, tenantId: string): Promise<{ clientId: string; clientSecret: string } | null> {
  const cred = await deps.repo.getTenantCredential(tenantId, 'google_oauth');
  const clientId = typeof cred?.meta['clientId'] === 'string' ? cred.meta['clientId'] : '';
  if (!cred?.secretEnc || !clientId) return null;
  return { clientId, clientSecret: deps.box.decrypt(cred.secretEnc) };
}

/** 管理者向けの接続の設定。`/v1/admin/connections` に置く。 */
export function connectionsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireRole('admin'));

  /** 設定の一覧。秘密の値は返さず、登録済みかどうかと日時だけを返す。 */
  app.get('/', async (c) => {
    const { tenant } = c.get('ctx');
    const [gemini, google, required, users, conns, resolved] = await Promise.all([
      deps.repo.getTenantCredential(tenant.id, 'gemini'), deps.repo.getTenantCredential(tenant.id, 'google_oauth'),
      requiredGoogleScopes(deps, tenant.id), deps.repo.listUsers(tenant.id), deps.repo.listGoogleConnections(tenant.id),
      deps.ai.geminiFor(tenant.id),
    ]);
    const gmeta = (gemini?.meta ?? {}) as GeminiSettingsMeta;
    const need = required.map((r) => r.scope);
    return c.json({
      gemini: {
        mode: gmeta.mode ?? 'platform',
        keyRegistered: !!gemini?.secretEnc,
        updatedAt: gemini?.updatedAt ?? null,
        models: gmeta.models ?? {},
        defaults: deps.ai.defaults(),
        // 実際に使っている鍵の出どころ（tenant: 自社の鍵、platform: 運営の鍵、none: 鍵が無くスタブで動作）
        effective: resolved.source,
        platformKeyAvailable: deps.ai.hasPlatformKey(),
      },
      google: {
        clientId: typeof google?.meta['clientId'] === 'string' ? google.meta['clientId'] : '',
        secretRegistered: !!google?.secretEnc,
        updatedAt: google?.updatedAt ?? null,
        redirectUri: deps.oauth.redirectUri,
        requiredScopes: required.map((r) => ({ ...r, label: googleScopeLabel(r.scope) })),
        workspaceSource: deps.connector.source,
        users: users.filter((u) => u.status === 'active').map((u) => {
          const conn = conns.find((x) => x.userId === u.id);
          return {
            userId: u.id, name: u.displayName, email: u.email, connected: !!conn,
            googleEmail: conn?.googleEmail ?? null, connectedAt: conn?.connectedAt ?? null,
            missing: conn ? need.filter((s) => !conn.scopes.includes(s)).map(googleScopeLabel) : [],
          };
        }),
      },
    });
  });

  /**
   * Gemini の設定を保存する。本文 `{ mode, apiKey?, models? }`。
   *
   * @remarks `apiKey` を渡したときだけ鍵を上書きする（空なら既存の鍵のまま）。鍵は暗号化して保存し、返さない。
   */
  app.put('/gemini', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ mode?: string; apiKey?: string; models?: Record<string, unknown> }>().catch(() => ({} as { mode?: string; apiKey?: string; models?: Record<string, unknown> }));
    const mode = body.mode === 'byok' ? 'byok' : 'platform';
    const current = await deps.repo.getTenantCredential(tenant.id, 'gemini');
    const apiKey = (body.apiKey ?? '').trim();
    if (apiKey && !/^[A-Za-z0-9_\-]{20,}$/.test(apiKey)) return c.json({ error: 'API キーの形式が違います（Google AI Studio で発行した鍵を貼ってください）' }, 400);
    const secretEnc = apiKey ? deps.box.encrypt(apiKey) : current?.secretEnc ?? null;
    if (mode === 'byok' && !secretEnc) return c.json({ error: '自社の鍵を使うには、API キーを登録してください' }, 400);
    const models: Partial<GeminiModels> = {};
    for (const k of MODEL_KEYS) {
      const v = body.models?.[k];
      if (typeof v === 'string' && v.trim()) {
        if (!/^[a-z0-9.\-]+$/.test(v.trim())) return c.json({ error: `モデル名の形式が違います: ${v}` }, 400);
        models[k] = v.trim();
      }
    }
    await deps.repo.saveTenantCredential({
      tenantId: tenant.id, kind: 'gemini', secretEnc, meta: { mode, models }, updatedBy: user.id, updatedAt: new Date().toISOString(),
    });
    // 値は記録しない
    await audit(deps, tenant.id, user.id, 'connection.gemini.update', 'gemini', { mode, keyChanged: !!apiKey, models });
    return c.json({ ok: true });
  });

  /** Gemini の鍵を消す。消すと運営の設定に戻る。 */
  app.delete('/gemini/key', async (c) => {
    const { tenant, user } = c.get('ctx');
    const current = await deps.repo.getTenantCredential(tenant.id, 'gemini');
    if (!current?.secretEnc) return c.json({ error: '鍵は登録されていません' }, 404);
    await deps.repo.saveTenantCredential({
      ...current, secretEnc: null, meta: { ...current.meta, mode: 'platform' }, updatedBy: user.id, updatedAt: new Date().toISOString(),
    });
    await audit(deps, tenant.id, user.id, 'connection.gemini.delete_key', 'gemini');
    return c.json({ ok: true });
  });

  /** Gemini への接続を試す。本文 `{ kind: 'text' | 'live' }`。会社が使う鍵とモデルで試す。 */
  app.post('/gemini/test', async (c) => {
    const { tenant } = c.get('ctx');
    const body = await c.req.json<{ kind?: string }>().catch(() => ({} as { kind?: string }));
    const g = await deps.ai.geminiFor(tenant.id);
    if (!g.apiKey) return c.json({ ok: false, ms: 0, error: '使える鍵がありません。自社の鍵を登録するか、運営の設定を待ってください' });
    const result = body.kind === 'live' ? await checkGeminiLive(g.apiKey, g.models.live) : await checkGeminiText(g.apiKey, g.models.standard);
    return c.json({ ...result, source: g.source, model: body.kind === 'live' ? g.models.live : g.models.standard });
  });

  /**
   * 会社の OAuth クライアントを登録する。本文 `{ clientId, clientSecret? }`。
   *
   * @remarks シークレットは渡したときだけ上書きする。暗号化して保存し、返さない。
   */
  app.put('/google', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ clientId?: string; clientSecret?: string }>().catch(() => ({} as { clientId?: string; clientSecret?: string }));
    const clientId = (body.clientId ?? '').trim();
    if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId)) {
      return c.json({ error: 'クライアント ID の形式が違います（…apps.googleusercontent.com で終わる値です）' }, 400);
    }
    const current = await deps.repo.getTenantCredential(tenant.id, 'google_oauth');
    const secret = (body.clientSecret ?? '').trim();
    const secretEnc = secret ? deps.box.encrypt(secret) : current?.secretEnc ?? null;
    if (!secretEnc) return c.json({ error: 'クライアント シークレットを登録してください' }, 400);
    await deps.repo.saveTenantCredential({
      tenantId: tenant.id, kind: 'google_oauth', secretEnc, meta: { clientId }, updatedBy: user.id, updatedAt: new Date().toISOString(),
    });
    // クライアント ID を替えると、これまでの接続（トークン）は使えない。全員について後始末する。シークレットだけなら影響しない
    const previousId = (current?.meta as { clientId?: string } | undefined)?.clientId;
    const cleanup = previousId && previousId !== clientId ? await disconnectEveryone(deps, tenant.id, 'client-removed') : { users: 0, stoppedRuns: 0 };
    await audit(deps, tenant.id, user.id, 'connection.google.update', 'google_oauth', { clientId, secretChanged: !!secret, ...cleanup });
    return c.json({ ok: true, ...cleanup });
  });

  /**
   * OAuth クライアントを削除する（またはクライアント ID を替える）と影響するもの。削除の前の確認に使う（仕様書 第6.5.2.1節）。
   */
  app.get('/google/impact', async (c) => {
    const { tenant } = c.get('ctx');
    const conns = await deps.repo.listGoogleConnections(tenant.id);
    let runs = 0;
    for (const conn of conns) runs += (await deps.revocation.impact(tenant.id, conn.userId)).runs.length;
    return c.json({ users: conns.length, runs });
  });

  /** 会社の OAuth クライアントの登録を消す。接続している全員の許可が使えなくなるため、全員について後始末する。 */
  app.delete('/google', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.repo.deleteTenantCredential(tenant.id, 'google_oauth'))) return c.json({ error: '登録されていません' }, 404);
    const cleanup = await disconnectEveryone(deps, tenant.id, 'client-removed');
    await audit(deps, tenant.id, user.id, 'connection.google.delete', 'google_oauth', cleanup);
    return c.json({ ok: true, ...cleanup });
  });

  return app;
}

/**
 * 会社の全員の Google の接続を消し、後始末をする（OAuth クライアントの削除・クライアント ID の変更。仕様書 第6.5.2.1節）。
 *
 * @remarks トークンを Google 側でも取り消してから消す。取り消しに失敗しても、M2Office からは消す。
 */
async function disconnectEveryone(deps: AppDeps, tenantId: string, cause: 'client-removed') {
  const now = new Date();
  let stoppedRuns = 0;
  const conns = await deps.repo.listGoogleConnections(tenantId);
  for (const conn of conns) {
    await revokeGoogleToken(deps.box.decrypt(conn.refreshTokenEnc)).catch(() => false);
    await deps.repo.deleteGoogleConnection(tenantId, conn.userId);
    stoppedRuns += (await deps.revocation.stopUserRuns(tenantId, conn.userId, cause, now)).length;
    await deps.retention.purgeUser(tenantId, conn.userId, now);
  }
  return { users: conns.length, stoppedRuns };
}

/** 本人の Google 連携。`/v1/me/google` に置く（仕様書 第6.5.2節）。 */
export function myGoogleRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  /** 本人の接続の状況。業務が求める許可ごとに、許可済みかどうかを業務の言葉で返す。トークンは返さない。 */
  app.get('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    const [client, conn, required] = await Promise.all([
      deps.repo.getTenantCredential(tenant.id, 'google_oauth'), deps.repo.getGoogleConnection(tenant.id, user.id),
      requiredGoogleScopes(deps, tenant.id),
    ]);
    return c.json({
      available: !!client?.secretEnc,
      connected: !!conn,
      googleEmail: conn?.googleEmail ?? null,
      connectedAt: conn?.connectedAt ?? null,
      checkedAt: conn?.checkedAt ?? null,
      scopes: required.map((r) => ({ scope: r.scope, label: googleScopeLabel(r.scope), granted: !!conn?.scopes.includes(r.scope) })),
      needsReconnect: !!conn && required.some((r) => !conn.scopes.includes(r.scope)),
    });
  });

  /**
   * 取り消すと止まる業務と、飛ばす定時実行の数。取り消す前の確認に使う（仕様書 第6.5.2.1節）。
   */
  app.get('/impact', async (c) => {
    const { tenant, user } = c.get('ctx');
    const { allAgents } = await deps.tenantView(tenant.id);
    const impact = await deps.revocation.impact(tenant.id, user.id);
    return c.json({
      runs: impact.runs.map((r) => ({ ...r, agentName: allAgents.find((a) => a.id === r.agentId)?.name ?? r.agentId })),
      schedules: impact.schedules,
    });
  });

  /** 接続を始める。Google の同意の画面の URL を返す（画面はそこへ移る）。 */
  app.post('/connect', async (c) => {
    const { tenant, user } = c.get('ctx');
    const client = await googleClient(deps, tenant.id);
    if (!client) return c.json({ error: '会社の管理者が、まだ Google との接続を設定していません' }, 409);
    const required = await requiredGoogleScopes(deps, tenant.id);
    const { verifier, challenge } = createPkce();
    const state = deps.oauth.states.issue({
      tenantId: tenant.id, userId: user.id, codeVerifier: verifier, returnTo: returnTo(c),
    });
    const url = buildGoogleAuthUrl({
      clientId: client.clientId, redirectUri: deps.oauth.redirectUri, scopes: required.map((r) => r.scope),
      state, codeChallenge: challenge, loginHint: user.email,
    });
    return c.json({ url });
  });

  /** 許可の状況を Google に問い合わせ直す（AI Radio の「更新」と同じ）。 */
  app.post('/check', async (c) => {
    const { tenant, user } = c.get('ctx');
    const [client, conn] = await Promise.all([googleClient(deps, tenant.id), deps.repo.getGoogleConnection(tenant.id, user.id)]);
    if (!client || !conn) return c.json({ error: 'Google と接続していません' }, 404);
    try {
      const { accessToken } = await refreshGoogleAccessToken({ ...client, refreshToken: deps.box.decrypt(conn.refreshTokenEnc) });
      const scopes = await googleGrantedScopes(accessToken);
      await deps.repo.saveGoogleConnection({ ...conn, scopes, checkedAt: new Date().toISOString() });
      return c.json({ ok: true, scopes });
    } catch (err) {
      // 取り消された・失効した場合もここに来る。再接続を促す
      return c.json({ ok: false, error: err instanceof GoogleOAuthError ? `Google で確かめられませんでした（${err.message}）。接続し直してください` : '確かめられませんでした' });
    }
  });

  /** 接続を取り消す。Google 側の許可も取り消し、保存したトークンを消す。 */
  app.delete('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    const conn = await deps.repo.getGoogleConnection(tenant.id, user.id);
    if (!conn) return c.json({ error: 'Google と接続していません' }, 404);
    const revoked = await revokeGoogleToken(deps.box.decrypt(conn.refreshTokenEnc));
    await deps.repo.deleteGoogleConnection(tenant.id, user.id);
    // Google を使う動いている途中の業務を止め（仕様書 第6.5.2.1節）、終わった実行から Google 由来の中身を消す（第14.3.2節）
    const now = new Date();
    const stoppedRuns = (await deps.revocation.stopUserRuns(tenant.id, user.id, 'disconnect', now)).length;
    const purgedRuns = await deps.retention.purgeUser(tenant.id, user.id, now);
    await audit(deps, tenant.id, user.id, 'connection.google.disconnect', user.id, { revokedAtGoogle: revoked, stoppedRuns, purgedRuns });
    return c.json({ ok: true, revokedAtGoogle: revoked, stoppedRuns, purgedRuns });
  });

  return app;
}

/**
 * Google からの戻り。`/v1/oauth` に置き、テナントの判定とログインより前に受ける（ログインの Cookie が無いため）。
 *
 * @remarks `state` を照合してテナントと利用者を引く。照合できなければ何もしない（仕様書 第14.3.3節）。
 */
export function oauthCallbackRoute(deps: AppDeps) {
  const app = new Hono();
  app.get('/google/callback', async (c) => {
    const state = c.req.query('state') ?? '';
    const pending = deps.oauth.states.take(state);
    if (!pending) return c.text('この接続の要求は無効か、期限が切れています。M2Office の画面からもう一度「Google と接続する」を押してください。', 400);
    const back = (result: string) => c.redirect(`${pending.returnTo}${pending.returnTo.includes('?') ? '&' : '?'}google=${result}`);
    if (c.req.query('error')) return back('cancelled');
    const code = c.req.query('code');
    if (!code) return back('failed');
    // 要求のあとに停止された会社では接続を保存しない。停止中は Google との接続を受け付けない（仕様書 第23.8.6節）
    const tenant = await deps.repo.findTenantById(pending.tenantId);
    if (!tenant || !isOperational(tenant)) return back('failed');
    try {
      const client = await googleClient(deps, pending.tenantId);
      if (!client) return back('failed');
      const tokens = await exchangeGoogleCode({ ...client, code, redirectUri: deps.oauth.redirectUri, codeVerifier: pending.codeVerifier });
      const [scopes, email] = await Promise.all([
        googleGrantedScopes(tokens.accessToken).catch(() => tokens.scopes), googleUserEmail(tokens.accessToken),
      ]);
      const now = new Date().toISOString();
      await deps.repo.saveGoogleConnection({
        tenantId: pending.tenantId, userId: pending.userId, refreshTokenEnc: deps.box.encrypt(tokens.refreshToken),
        googleEmail: email, scopes, connectedAt: now, checkedAt: now,
      });
      await audit(deps, pending.tenantId, pending.userId, 'connection.google.connect', pending.userId, { googleEmail: email, scopes });
      return back('connected');
    } catch (err) {
      deps.log.warn('Google との接続に失敗しました', { tenantId: pending.tenantId, err: err instanceof Error ? err.message : String(err) });
      return back('failed');
    }
  });

  /**
   * ログインの戻りを受ける（仕様書 第16.1.2節）。
   *
   * @remarks
   * **運営のホストで受ける。** Google は HTTPS を要求する（例外は `localhost`）ため、
   * テナントごとのホストをリダイレクト先にできない。
   *
   * ここでは Cookie を張らない。`Domain` を付けない Cookie は、
   * このホストでしか効かないためである。代わりに 1 回限りの引換券を渡す。
   */
  app.get('/google/login-callback', async (c) => {
    const pending = deps.loginStates.take(c.req.query('state') ?? '');
    if (!pending) return c.text('ログインの要求が無効か、期限が切れています。もう一度お試しください。', 400);
    // 失敗しても、どこまで合っていたかは示さない（登録の有無を外から測らせない）
    const back = (result: string) =>
      c.redirect(`${pending.returnTo}${pending.returnTo.includes('?') ? '&' : '?'}login=${result}`);
    if (c.req.query('error')) return back('cancelled');
    const code = c.req.query('code');
    const login = deps.auth.login;
    if (!code || !login) return back('failed');

    try {
      const tenant = await deps.repo.findTenantById(pending.tenantId);
      // 停止中・緊急停止・解約済みの会社にはログインさせない（第23.8.6節）
      if (!tenant || !isOperational(tenant)) return back('failed');
      const { accessToken } = await exchangeGoogleLoginCode({
        clientId: login.clientId, clientSecret: login.clientSecret,
        code, redirectUri: login.redirectUri, codeVerifier: pending.codeVerifier,
      });
      const email = await googleUserEmail(accessToken);
      if (!email) return back('failed');

      // ドメインが会社のものであり、かつその会社の利用者として登録されていること（第16.1.2節）
      const domain = email.split('@')[1];
      const user = tenant.workspaceDomain && domain === tenant.workspaceDomain
        ? await deps.repo.findUserByEmail(tenant.id, email)
        : null;
      if (!user || user.status !== 'active') {
        await audit(deps, tenant.id, 'system', 'auth.login.denied', email, {
          reason: domain === tenant.workspaceDomain ? '登録されていない利用者' : 'ドメインが違う',
        });
        return back('denied');
      }
      const ticket = deps.handoffs.issue({ tenantId: tenant.id, userId: user.id });
      return c.redirect(`${pending.returnTo}?ticket=${encodeURIComponent(ticket)}`);
    } catch (err) {
      deps.log.warn('ログインに失敗しました', {
        tenantId: pending.tenantId, err: err instanceof Error ? err.message : String(err),
      });
      return back('failed');
    }
  });
  return app;
}

/** 接続のあとに戻す画面。要求を送った画面のオリジン（テナントのサブドメイン）と、個人設定を開く印。 */
function returnTo(c: Context<AppEnv>): string {
  const origin = c.req.header('origin') ?? (() => {
    const ref = c.req.header('referer');
    try { return ref ? new URL(ref).origin : ''; } catch { return ''; }
  })();
  const baseDomain = (process.env['BASE_DOMAIN'] ?? 'lvh.me').replace(/\./g, '\\.');
  const ok = new RegExp(`^https?://([a-z0-9-]+\\.(${baseDomain}|localhost)|localhost)(:\\d+)?$`).test(origin);
  const tenantQuery = c.req.header('x-tenant') ? `?tenant=${encodeURIComponent(c.req.header('x-tenant')!)}` : '';
  return ok ? `${origin}/${tenantQuery}` : `/${tenantQuery}`;
}
