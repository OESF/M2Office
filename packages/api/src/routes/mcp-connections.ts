/**
 * @file 会社の接続（コネクタ。MCP サーバ）を管理する API（仕様書 第12.11.0節・第6.6.3節、ADR-0037）。
 *
 * コネクタは拡張機能の一部ではなく、ツールを供給する会社の資源である。
 * 管理者が URL から登録し、ツールごとに危険度と入り切りを決める。秘書・公式の業務・拡張機能のどれからでも使う。
 * 認証の要る接続（`oauth`・`api_key`）は、認証情報を登録してからツールを問い合わせる（仕様書 第12.11.6節）。
 * 秘密の値（クライアント シークレット・会社の鍵）は暗号化して持ち、登録後は返さない。
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { RISK_LEVELS, type RiskLevel } from '@m2office/shared';
import {
  CONNECTION_PRESETS, CONNECTOR_ROLE_WORDS, CONNECTOR_TOOL_ROLES, applyReviewedRoles, checkConnector, checkOutboundUrl, connectionAgentId,
  discoverOAuthEndpoints, isLocalPolicy, parseSiteInfo, presetById, siteConnectionAgentId, siteInfoTool,
  type ConnectorAuth, type ConnectorToolRole, type TenantConnection,
} from '@m2office/core';
import type { AppDeps } from '../context.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';
import { requestedScopes } from './connection-auth.js';
import { profiledTools } from '../connection-profile.js';

/** 危険度を、管理者に見せる言葉にする。 */
const RISK_WORDS: Record<RiskLevel, string> = {
  read: '読むだけ',
  draft: '下書きを作る',
  'write-internal': '社内に書き込む',
  'external-send': '社外や他の人へ送る',
  financial: 'お金に関わる',
};

/** 認証の方式を、管理者に見せる言葉にする。 */
const AUTH_WORDS: Record<ConnectorAuth['type'], string> = {
  none: '認証なし',
  oauth: '利用者ごとに許可（OAuth）',
  api_key: '会社の鍵',
};

/** URL から接続の ID の案を作る（`https://mcp.deepwiki.com/mcp` → `deepwiki`）。 */
function idFromUrl(url: string): string {
  try {
    const labels = new URL(url).hostname.split('.').filter((l) => !['mcp', 'www', 'api'].includes(l));
    return (labels[0] ?? 'mcp').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'mcp';
  } catch {
    return 'mcp';
  }
}

export function mcpConnectionsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireRole('admin'));

  /** 会社の接続の一覧。ツールごとの危険度と入り切り、その接続を使う業務を返す。 */
  app.get('/', async (c) => {
    const { tenant } = c.get('ctx');
    const view = await deps.tenantView(tenant.id);
    const authOf = async (x: TenantConnection) => {
      if (x.auth.type === 'none') return { type: 'none', text: AUTH_WORDS.none, ready: true };
      const secret = await deps.repo.getConnectionSecret(tenant.id, x.id);
      const preset = presetById(x.auth.preset);
      if (x.auth.type === 'api_key') {
        return {
          type: 'api_key', text: x.auth.scheme === 'basic' ? '会社の利用者名とパスワード（Basic）' : AUTH_WORDS.api_key, ready: !!secret?.apiKeyEnc, keySet: !!secret?.apiKeyEnc,
          header: x.auth.scheme === 'basic' ? 'Authorization' : x.auth.header ?? 'Authorization', scheme: x.auth.scheme ?? 'bearer',
        };
      }
      return {
        // 会社が登録したアプリがあるか、相手がアプリの自動登録に対応していれば使える（第12.11.6.2節、Q-99）
        type: 'oauth', text: AUTH_WORDS.oauth, ready: !!secret?.clientId || !!x.auth.registrationUrl,
        // クライアント ID は秘密ではない。シークレットは登録したかだけを返す。自動で登録したものは値を出さない
        clientId: secret?.autoRegistered ? '' : secret?.clientId ?? '', secretSet: !!secret?.clientSecretEnc && !secret.autoRegistered,
        autoRegister: !!x.auth.registrationUrl, autoRegistered: !!secret?.autoRegistered,
        redirectUri: deps.oauth.connectionRedirectUri,
        scopes: requestedScopes(x, view.disabledTools),
        connectedUsers: (await deps.repo.listUserConnections(tenant.id, { connectionId: x.id })).length,
        preset: preset ? { id: preset.id, name: preset.name, setup: preset.setup, source: preset.source, checkedAt: preset.checkedAt } : null,
      };
    };
    const items = [];
    for (const x of view.connections) {
      items.push({
        id: x.id, name: x.name, description: x.description, url: x.url, auth: x.auth.type, authState: await authOf(x),
        origin: x.origin, originText: x.origin === 'manual' ? '管理者が登録' : `拡張機能に同梱（${x.origin.slice('extension:'.length)}）`,
        tools: x.tools.map((t) => ({
          name: t.name, description: t.description, risk: t.risk, riskText: RISK_WORDS[t.risk],
          enabled: !view.disabledTools.has(`${x.id}.${t.name}`),
          // 役割（第47.4.1節）。管理者が見たか
          ...(t.role ? { role: t.role, roleText: CONNECTOR_ROLE_WORDS[t.role], roleReviewed: t.roleReviewed === true } : {}),
        })),
        // 接続の説明（振り分けの候補に出すもの）と、役割を管理者が見たか（第47.7節）
        profile: x.profile ? {
          summary: x.profile.summary, site: x.profile.site, reviewedAt: x.profile.reviewedAt,
          unreviewed: x.tools.filter((t) => t.role && !t.roleReviewed).length,
          siteName: x.profile.siteName ?? null, siteUrl: x.profile.siteUrl ?? null,
          agentId: view.agents.find((a) => a.id === connectionAgentId(x.id) || a.id === siteConnectionAgentId(x.id))?.id ?? null,
        } : null,
        // いま使える業務のうち、この接続のツールを使うもの（導入していない拡張機能の業務は数えない）
        usedBy: view.agents.filter((a) => a.tools.some((n) => n.startsWith(`${x.id}.`))).map((a) => ({ id: a.id, name: a.name })),
        // ローカルの方針のときに、この接続（社外）に送ってよいもの（第16.3.7.1節）
        sendPolicy: x.sendPolicy ?? 'block',
      });
    }
    return c.json({
      items,
      // ローカルの方針か（ローカルの方針の会社だけ、接続ごとに送ってよいものを決める。第16.3.7.1節）
      localPolicy: isLocalPolicy(await deps.ai.policyFor(tenant.id)),
      risks: RISK_LEVELS.map((r) => ({ value: r, text: RISK_WORDS[r] })),
      roles: CONNECTOR_TOOL_ROLES.map((r) => ({ value: r, text: CONNECTOR_ROLE_WORDS[r] })),
      // よく使うサービスの型（第12.11.6.7節）。すでに登録したものも出す（同じ型を 2 つ登録するには ID を変える）
      presets: CONNECTION_PRESETS.map((p) => ({ id: p.id, name: p.name, description: p.description, url: p.url })),
    });
  });

  /**
   * 接続を登録する。MCP サーバにツールの一覧を問い合わせ、危険度の初期値を付けて保存する。
   *
   * @remarks ID を省けば URL から作る。内蔵のツールの頭の部分と、会社のほかの接続とは重ならない
   */
  app.post('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{
      id?: string; name?: string; url?: string; description?: string; preset?: string; auth?: string; header?: string;
    }>().catch(() => ({}) as Record<string, never>);
    const preset = presetById(body.preset);
    if (body.preset && !preset) return c.json({ error: `型 ${body.preset} はありません` }, 400);
    const url = preset?.url ?? String(body.url ?? '').trim();
    const id = String(body.id ?? '').trim() || preset?.id || idFromUrl(url);
    const existing = await deps.repo.listConnections(tenant.id);
    if (existing.some((x) => x.id === id)) return c.json({ error: `ID ${id} の接続はすでにあります。別の ID にしてください` }, 400);
    // 「basic」は会社の鍵の一つ（利用者名とパスワードを Basic の形で送る。第45.18.5節）
    const type = preset?.auth.type ?? (body.auth === 'oauth' || body.auth === 'api_key' ? body.auth : body.auth === 'basic' ? 'api_key' : 'none');
    let auth: ConnectorAuth = preset ? { ...preset.auth } : { type, ...(body.auth === 'basic' ? { scheme: 'basic' as const } : {}) };
    let tools: TenantConnection['tools'] = [];
    let profile: TenantConnection['profile'];
    // URL の形と宛先を、接続を試す前に確かめる（社内のアドレスへ送らせない。2026-10-12 の点検）
    const urlProblems = checkConnector({ id, name: id, transport: 'http', url, auth, tools: [] } as unknown as Parameters<typeof checkConnector>[0], deps.hub.builtinPrefixes())
      .filter((p) => p.startsWith('url '));
    if (urlProblems.length > 0) return c.json({ error: '登録できません', problems: urlProblems }, 400);
    const blocked = await checkOutboundUrl(url);
    if (blocked) return c.json({ error: '登録できません', problems: [blocked] }, 400);
    if (type === 'none') {
      const listed = await deps.hub.listMcpTools(url);
      if (!listed.ok) return c.json({ error: `MCP サーバに接続できませんでした: ${listed.error}` }, 400);
      ({ tools, profile } = await profiledTools(deps, tenant.id, String(body.name ?? '').trim() || preset?.name || id, listed.tools, null, preset));
    } else if (type === 'oauth' && !preset) {
      // 認可の口は相手のサーバの案内から見つける。見つからなければ、あとで管理者が入れる（第12.11.6.2節）
      const found = await discoverOAuthEndpoints(url);
      if (found) {
        auth = {
          ...auth, authorizeUrl: found.authorizeUrl, tokenUrl: found.tokenUrl, ...(found.scopesSupported.length > 0 ? { scopes: found.scopesSupported } : {}),
          // 自動登録の口があれば、会社がアプリを登録しなくてよい（第12.11.6.2節、Q-99）
          ...(found.registrationUrl ? { registrationUrl: found.registrationUrl, tokenAuthMethods: found.tokenAuthMethods } : {}),
        };
      }
    } else if (type === 'api_key' && body.header) {
      auth = { ...auth, header: String(body.header).trim() };
    }
    const now = new Date().toISOString();
    // 認証の要る接続のツールは、認証情報を登録したあと（oauth は管理者が接続したあと）に問い合わせる
    const conn: TenantConnection = {
      tenantId: tenant.id, id, name: String(body.name ?? '').trim() || preset?.name || id,
      description: String(body.description ?? '').trim() || preset?.description || '',
      transport: 'http', url, auth, tools, ...(profile ? { profile } : {}),
      origin: 'manual', createdBy: user.id, createdAt: now, updatedAt: now,
    };
    const problems = checkConnector(conn, deps.hub.builtinPrefixes());
    if (problems.length > 0) return c.json({ error: '登録できません', problems }, 400);
    await deps.repo.saveConnection(conn);
    await audit(deps, tenant.id, user.id, 'connection.mcp.create', id, { url, tools: conn.tools.length, auth: type, preset: preset?.id ?? null });
    return c.json({ ok: true, id, tools: conn.tools.length, auth: type }, 201);
  });

  /**
   * 認証情報を登録する（第12.11.6.2節・第12.11.6.6節）。値は暗号化して持ち、返さない。
   *
   * @remarks
   * `oauth`: クライアント ID とシークレット。**クライアント ID を替えたら、接続している全員の認可を消す**（シークレットだけなら消さない）。
   * `api_key`: 会社の鍵。登録したら、その鍵でツールの一覧を問い合わせる。
   */
  app.put('/:id/credentials', async (c) => {
    const { tenant, user } = c.get('ctx');
    const conn = (await deps.repo.listConnections(tenant.id)).find((x) => x.id === c.req.param('id'));
    if (!conn) return c.json({ error: '接続が見つかりません' }, 404);
    const body = await c.req.json<{ clientId?: string; clientSecret?: string; apiKey?: string; username?: string; password?: string }>().catch(() => ({}) as Record<string, never>);
    const prev = await deps.repo.getConnectionSecret(tenant.id, conn.id);
    const now = new Date().toISOString();
    if (conn.auth.type === 'oauth') {
      const clientId = String(body.clientId ?? '').trim();
      const secret = String(body.clientSecret ?? '').trim();
      if (!clientId) return c.json({ error: 'クライアント ID を入れてください' }, 400);
      if (!secret && !prev?.clientSecretEnc) return c.json({ error: 'クライアント シークレットを入れてください' }, 400);
      const changed = !!prev?.clientId && prev.clientId !== clientId;
      // 管理者が手で登録したアプリは、自動で登録したものより先に使う（自動登録の印を外す）
      await deps.repo.saveConnectionSecret({
        tenantId: tenant.id, connectionId: conn.id, clientId,
        clientSecretEnc: secret ? deps.box.encrypt(secret) : prev!.clientSecretEnc, apiKeyEnc: null, autoRegistered: false, updatedBy: user.id, updatedAt: now,
      });
      const reset = changed ? await deps.repo.deleteUserConnectionsFor(tenant.id, conn.id) : 0;
      await audit(deps, tenant.id, user.id, 'connection.secret.update', conn.id, { kind: 'oauth', clientIdChanged: changed, secretChanged: !!secret, reset });
      return c.json({ ok: true, reset });
    }
    if (conn.auth.type === 'api_key') {
      let key = String(body.apiKey ?? '').trim();
      if (conn.auth.scheme === 'basic') {
        const username = String(body.username ?? '').trim();
        // アプリケーションパスワードは 4 文字ごとの空白つきで表示される。空白は外して預かる
        const password = String(body.password ?? '').replace(/\s+/g, '');
        if (!username || !password) return c.json({ error: '利用者名とパスワードを入れてください' }, 400);
        if (username.includes(':')) return c.json({ error: '利用者名に「:」は使えません' }, 400);
        key = `${username}:${password}`;
      }
      if (!key) return c.json({ error: '鍵を入れてください' }, 400);
      await deps.repo.saveConnectionSecret({
        tenantId: tenant.id, connectionId: conn.id, clientId: null, clientSecretEnc: null, apiKeyEnc: deps.box.encrypt(key),
        updatedBy: user.id, updatedAt: now,
      });
      await audit(deps, tenant.id, user.id, 'connection.secret.update', conn.id, { kind: 'api_key' });
      // 鍵でツールを問い合わせる。つながらなくても鍵は残す（相手の側の準備が後のことがある）
      const h = await deps.connections.headersFor(tenant.id, user.id, conn);
      const listed = h.ok ? await deps.hub.listMcpTools(conn.url, h.headers) : { ok: false as const, error: h.error };
      if (!listed.ok) return c.json({ ok: true, tools: conn.tools.length, warning: `鍵は登録しました。ツールを問い合わせられませんでした: ${listed.error}` });
      const { tools, profile } = await profiledTools(deps, tenant.id, conn.name, listed.tools, conn, presetById(conn.auth.preset));
      await deps.repo.saveConnection({ ...conn, tools, profile, updatedAt: now });
      return c.json({ ok: true, tools: tools.length });
    }
    return c.json({ error: 'この接続は認証が要りません' }, 400);
  });

  /** 名前・説明・ツールごとの危険度を変える。 */
  app.put('/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const conn = (await deps.repo.listConnections(tenant.id)).find((x) => x.id === c.req.param('id'));
    if (!conn) return c.json({ error: '接続が見つかりません' }, 404);
    const body = await c.req.json<{ name?: string; description?: string; tools?: { name: string; risk?: string; role?: string }[]; sendPolicy?: string; summary?: string }>().catch(() => ({}) as Record<string, never>);
    for (const t of body.tools ?? []) {
      if (t.risk !== undefined && !RISK_LEVELS.includes(t.risk as RiskLevel)) return c.json({ error: `危険度は ${RISK_LEVELS.join('・')} のどれかです` }, 400);
      if (t.role !== undefined && !CONNECTOR_TOOL_ROLES.includes(t.role as ConnectorToolRole)) return c.json({ error: `役割は ${CONNECTOR_TOOL_ROLES.join('・')} のどれかです` }, 400);
    }
    const summary = typeof body.summary === 'string' ? body.summary.replace(/\s+/g, ' ').trim().slice(0, 200) : null;
    // ローカルの方針のときに、この接続（社外）に送ってよいもの（第16.3.7.1節）
    if (body.sendPolicy !== undefined && body.sendPolicy !== 'block' && body.sendPolicy !== 'deidentified') {
      return c.json({ error: 'sendPolicy は block か deidentified です' }, 400);
    }
    const next: TenantConnection = {
      ...conn,
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : conn.name,
      description: typeof body.description === 'string' ? body.description.trim() : conn.description,
      tools: conn.tools.map((t) => {
        const want = body.tools?.find((x) => x.name === t.name);
        if (!want) return t;
        // 役割を直したら、管理者が見たものとして、役割から危険度を決め直す（第47.4.1節）。危険度を直したら、それを使う
        const role = (want.role as ConnectorToolRole | undefined) ?? t.role;
        const next = want.role ? applyReviewedRoles([{ ...t, ...(role ? { role } : {}) }])[0]! : t;
        return want.risk ? { ...next, risk: want.risk as RiskLevel } : next;
      }),
      ...(body.sendPolicy ? { sendPolicy: body.sendPolicy as 'block' | 'deidentified' } : {}),
      // 振り分けの説明を管理者が直したら、取り直しで推論が上書きしない（第47.7節）
      ...(summary && conn.profile ? { profile: { ...conn.profile, summary, summaryEdited: true } } : {}),
      updatedAt: new Date().toISOString(),
    };
    await deps.repo.saveConnection(next);
    await audit(deps, tenant.id, user.id, 'connection.mcp.update', conn.id, {
      risks: next.tools.filter((t, i) => t.risk !== conn.tools[i]?.risk).map((t) => ({ tool: t.name, risk: t.risk })),
      ...(body.sendPolicy && body.sendPolicy !== (conn.sendPolicy ?? 'block') ? { sendPolicy: body.sendPolicy } : {}),
    });
    return c.json({ ok: true });
  });

  /** ツールの一覧を取り直す。決めた危険度は残し、増えたツールは初期値で足し、無くなったツールは外す。 */
  app.post('/:id/refresh', async (c) => {
    const { tenant, user } = c.get('ctx');
    const conn = (await deps.repo.listConnections(tenant.id)).find((x) => x.id === c.req.param('id'));
    if (!conn) return c.json({ error: '接続が見つかりません' }, 404);
    // 認証の要る接続は、管理者自身の認可（会社の鍵なら会社の鍵）で問い合わせる（第12.11.6.2節 手順 4）
    const h = await deps.connections.headersFor(tenant.id, user.id, conn);
    if (!h.ok) return c.json({ error: h.error }, 400);
    const listed = await deps.hub.listMcpTools(conn.url, h.headers);
    if (!listed.ok) return c.json({ error: `MCP サーバに接続できませんでした: ${listed.error}` }, 400);
    const { tools, profile } = await profiledTools(deps, tenant.id, conn.name, listed.tools, conn, presetById(conn.auth.preset));
    // 会社のサイトを扱う接続なら、サイトの名前と URL を読み直す（第47.3節）
    const site = profile.site ? await readSiteInfo(deps, tenant.id, user.id, conn, tools) : {};
    await deps.repo.saveConnection({ ...conn, tools, profile: { ...profile, ...site }, updatedAt: new Date().toISOString() });
    const added = tools.filter((t) => !conn.tools.some((k) => k.name === t.name)).map((t) => t.name);
    const removed = conn.tools.filter((k) => !tools.some((t) => t.name === k.name)).map((t) => t.name);
    await audit(deps, tenant.id, user.id, 'connection.mcp.refresh', conn.id, { added, removed });
    return c.json({ ok: true, added, removed });
  });

  /**
   * 推論が決めたツールの役割を、管理者が見て「この役割で使う」とする（仕様書 第47.4.1節、Q-368）。
   *
   * @remarks
   * 役割から危険度を決め直す（読む・見直しは読むだけ、準備は下書き、確定と戻すは社外へ送る）。
   * これで、その接続の道具を使う汎用の業務が秘書の振り分けに出る（第47.7節）。
   * その業務の利用範囲が決まっていなければ、管理者だけにする（社外に出る道具を持つため）。危険度: write-internal（会社の設定を変える）
   */
  app.post('/:id/roles/review', async (c) => {
    const { tenant, user } = c.get('ctx');
    const conn = (await deps.repo.listConnections(tenant.id)).find((x) => x.id === c.req.param('id'));
    if (!conn) return c.json({ error: '接続が見つかりません' }, 404);
    if (!conn.profile) return c.json({ error: 'まだ役割が決まっていません。ツールを取り直してください' }, 400);
    const now = new Date().toISOString();
    const tools = applyReviewedRoles(conn.tools);
    const site = conn.profile.site ? await readSiteInfo(deps, tenant.id, user.id, conn, tools) : {};
    await deps.repo.saveConnection({ ...conn, tools, profile: { ...conn.profile, ...site, reviewedAt: now, reviewedBy: user.id }, updatedAt: now });
    const settings = await deps.repo.getTenantSettings(tenant.id);
    // サイトの接続はサイトの更新の付属の業務で、利用範囲はサイトの更新と同じ（第47.7節）。ほかの接続の業務は管理者だけから始める
    const scopeId = conn.profile.site ? siteConnectionAgentId(conn.id) : connectionAgentId(conn.id);
    if (!conn.profile.site && !settings.access.scopes[scopeId]) {
      const admins = (await deps.repo.listUsers(tenant.id)).filter((u) => u.status === 'active' && u.roles.includes('admin')).map((u) => u.id);
      await deps.repo.saveTenantSettings(tenant.id, 'access', { ...settings.access, scopes: { ...settings.access.scopes, [scopeId]: { users: admins, groups: [] } } }, user.id);
    }
    await audit(deps, tenant.id, user.id, 'connection.mcp.roles_review', conn.id, {
      roles: tools.filter((t) => t.role).map((t) => ({ tool: t.name, role: t.role, risk: t.risk })),
    });
    return c.json({ ok: true, agentId: scopeId });
  });

  /**
   * その接続を自分のアカウントで許可している人（`oauth`。仕様書 第12.11.6.3節・第47.3節）。M2Office の利用者・相手のアカウント・許可した日時。
   * 認可の中身は返さない。「接続 › 更新サイト」で、REST API の WordPress の利用者の表と同じ形で並べる
   */
  app.get('/:id/users', async (c) => {
    const { tenant } = c.get('ctx');
    const id = c.req.param('id');
    const [rows, users] = await Promise.all([deps.repo.listUserConnections(tenant.id, { connectionId: id }), deps.repo.listUsers(tenant.id)]);
    return c.json({
      items: rows.map((r) => ({
        userId: r.userId, name: users.find((u) => u.id === r.userId)?.displayName ?? '（利用者）',
        account: r.accountLabel || null, connectedAt: r.connectedAt,
      })),
    });
  });

  /** 接続を確かめる（第12.11.3節）。登録したツールを MCP サーバが提供しているかを返す。状態は変えない。 */
  app.post('/:id/check', async (c) => {
    const { tenant, user } = c.get('ctx');
    const conn = (await deps.repo.listConnections(tenant.id)).find((x) => x.id === c.req.param('id'));
    if (!conn) return c.json({ error: '接続が見つかりません' }, 404);
    const h = await deps.connections.headersFor(tenant.id, user.id, conn);
    if (!h.ok) return c.json({ ok: false, error: h.error });
    return c.json(await deps.hub.checkConnector(conn, h.headers));
  });

  /** 接続を消すと使えなくなる業務（止まる業務の名前を示して確かめる。第12.11.0節）。 */
  app.get('/:id/impact', async (c) => {
    const { tenant } = c.get('ctx');
    const view = await deps.tenantView(tenant.id);
    const id = c.req.param('id');
    const blocked = view.agents.filter((a) => a.tools.some((n) => n.startsWith(`${id}.`)));
    // 消すと、接続している人の認可も消える（第12.11.6.2節）
    const connectedUsers = (await deps.repo.listUserConnections(tenant.id, { connectionId: id })).length;
    return c.json({ agents: blocked.map((a) => ({ id: a.id, name: a.name })), connectedUsers });
  });

  /** ツールを止めると使えなくなる業務（仕様書 第6.6.3.1節）。 */
  app.get('/:id/tools/:tool/impact', async (c) => {
    const { tenant } = c.get('ctx');
    const view = await deps.tenantView(tenant.id);
    const conn = view.connections.find((x) => x.id === c.req.param('id'));
    const tool = conn?.tools.find((t) => t.name === c.req.param('tool'));
    if (!conn || !tool) return c.json({ error: 'ツールが見つかりません' }, 404);
    const name = `${conn.id}.${tool.name}`;
    const blocked = view.agents.filter((a) => a.tools.includes(name));
    const schedules = (await deps.repo.listSchedules(tenant.id, null)).filter((s) => s.enabled && blocked.some((a) => a.id === s.agentId));
    return c.json({ tool: name, agents: blocked.map((a) => ({ id: a.id, name: a.name })), schedules: schedules.length });
  });

  /**
   * ツールを 1 つ、有効または無効にする（仕様書 第6.6.3.1節）。
   *
   * @remarks 止めたツールを使う業務は、メニュー・秘書・定時実行・API から消える。動いている実行は止めない
   */
  app.put('/:id/tools/:tool/enabled', async (c) => {
    const { tenant, user } = c.get('ctx');
    const conn = (await deps.repo.listConnections(tenant.id)).find((x) => x.id === c.req.param('id'));
    const tool = conn?.tools.find((t) => t.name === c.req.param('tool'));
    if (!conn || !tool) return c.json({ error: 'ツールが見つかりません' }, 404);
    const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({}) as { enabled?: boolean });
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled を指定してください' }, 400);
    await deps.repo.setConnectorToolEnabled(tenant.id, conn.id, tool.name, body.enabled, user.id);
    await audit(deps, tenant.id, user.id, 'connection.mcp.tool.toggle', conn.id, { tool: tool.name, enabled: body.enabled });
    return c.json({ ok: true, enabled: body.enabled });
  });

  /** 接続を消す。そのツールを使う業務は使えなくなる（先に `impact` で確かめる）。 */
  app.delete('/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const removed = await deps.repo.deleteConnection(tenant.id, c.req.param('id'));
    if (!removed) return c.json({ error: '接続が見つかりません' }, 404);
    await audit(deps, tenant.id, user.id, 'connection.mcp.delete', c.req.param('id'), {});
    return c.json({ ok: true });
  });

  return app;
}

/**
 * 会社のサイトを扱う接続の、サイトの名前と URL を読む（仕様書 第47.3節）。サイトの情報を返す読む道具があるときだけ。
 *
 * @returns 読めなければ空（接続の名前を使う）
 * @remarks 危険度: read（必ず渡す引数の無い読む道具を、管理者の認可で 1 回呼ぶ）
 */
async function readSiteInfo(deps: AppDeps, tenantId: string, userId: string, conn: TenantConnection, tools: TenantConnection['tools']): Promise<{ siteName?: string; siteUrl?: string }> {
  const info = siteInfoTool(tools);
  if (!info) return {};
  const h = await deps.connections.headersFor(tenantId, userId, conn);
  const res = h.ok ? await deps.hub.callMcpTool(conn.url, info.name, {}, h.headers) : null;
  return res?.ok ? parseSiteInfo(res.text) : {};
}

async function audit(deps: AppDeps, tenantId: string, userId: string, action: string, targetId: string, detail: Record<string, unknown>) {
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType: 'connection', targetId,
    detail, occurredAt: new Date().toISOString(),
  });
}
