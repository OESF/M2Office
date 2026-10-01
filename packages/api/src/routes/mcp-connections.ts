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
  CONNECTION_PRESETS, checkConnector, discoverOAuthEndpoints, isLocalPolicy, presetById, presetRisk,
  type ConnectorAuth, type ConnectionPreset, type TenantConnection,
} from '@m2office/core';
import type { AppDeps } from '../context.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';
import { requestedScopes } from './connection-auth.js';

/** 危険度を、管理者に見せる言葉にする。 */
const RISK_WORDS: Record<RiskLevel, string> = {
  read: '読むだけ',
  draft: '下書きを作る',
  'write-internal': '社内に書き込む',
  'external-send': '社外や他の人へ送る',
  financial: 'お金に関わる',
};

/**
 * MCP のツールの一覧を、会社の接続のツールにする（仕様書 第12.11.2節）。
 *
 * @param keep 前に決めた危険度（取り直しのとき）。残す
 * @remarks 危険度の初期値は、読むだけの目印があれば read、無ければ external-send（承認が入る安全側）
 */
function toTools(
  listed: { name: string; description: string; readOnly?: boolean; args?: TenantConnection['tools'][number]['args'] }[],
  keep: TenantConnection['tools'] = [],
  preset?: ConnectionPreset,
): TenantConnection['tools'] {
  return listed.map((t) => ({
    name: t.name,
    description: t.description.trim() || `${t.name}（説明がありません）`,
    // 引数の定義は、取り直すたびに相手の最新のものにする（推論が引数を知って呼べるように）
    ...(t.args ? { args: t.args } : {}),
    // 目印が無ければ、型の読むだけの名前で決める。型も無ければ external-send（第12.11.6.7節）
    risk: keep.find((k) => k.name === t.name)?.risk
      ?? (t.readOnly === true ? 'read' : t.readOnly === undefined && preset ? presetRisk(preset, t.name) : 'external-send'),
  }));
}

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
        return { type: 'api_key', text: AUTH_WORDS.api_key, ready: !!secret?.apiKeyEnc, keySet: !!secret?.apiKeyEnc, header: x.auth.header ?? 'Authorization' };
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
        })),
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
    const type = preset?.auth.type ?? (body.auth === 'oauth' || body.auth === 'api_key' ? body.auth : 'none');
    let auth: ConnectorAuth = preset ? { ...preset.auth } : { type };
    let tools: TenantConnection['tools'] = [];
    if (type === 'none') {
      const listed = await deps.hub.listMcpTools(url);
      if (!listed.ok) return c.json({ error: `MCP サーバに接続できませんでした: ${listed.error}` }, 400);
      tools = toTools(listed.tools);
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
      transport: 'http', url, auth, tools,
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
    const body = await c.req.json<{ clientId?: string; clientSecret?: string; apiKey?: string }>().catch(() => ({}) as Record<string, never>);
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
      const key = String(body.apiKey ?? '').trim();
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
      const tools = toTools(listed.tools, conn.tools, presetById(conn.auth.preset));
      await deps.repo.saveConnection({ ...conn, tools, updatedAt: now });
      return c.json({ ok: true, tools: tools.length });
    }
    return c.json({ error: 'この接続は認証が要りません' }, 400);
  });

  /** 名前・説明・ツールごとの危険度を変える。 */
  app.put('/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const conn = (await deps.repo.listConnections(tenant.id)).find((x) => x.id === c.req.param('id'));
    if (!conn) return c.json({ error: '接続が見つかりません' }, 404);
    const body = await c.req.json<{ name?: string; description?: string; tools?: { name: string; risk: string }[]; sendPolicy?: string }>().catch(() => ({}) as Record<string, never>);
    for (const t of body.tools ?? []) {
      if (!RISK_LEVELS.includes(t.risk as RiskLevel)) return c.json({ error: `危険度は ${RISK_LEVELS.join('・')} のどれかです` }, 400);
    }
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
        return want ? { ...t, risk: want.risk as RiskLevel } : t;
      }),
      ...(body.sendPolicy ? { sendPolicy: body.sendPolicy as 'block' | 'deidentified' } : {}),
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
    const tools = toTools(listed.tools, conn.tools, presetById(conn.auth.preset));
    await deps.repo.saveConnection({ ...conn, tools, updatedAt: new Date().toISOString() });
    const added = tools.filter((t) => !conn.tools.some((k) => k.name === t.name)).map((t) => t.name);
    const removed = conn.tools.filter((k) => !tools.some((t) => t.name === k.name)).map((t) => t.name);
    await audit(deps, tenant.id, user.id, 'connection.mcp.refresh', conn.id, { added, removed });
    return c.json({ ok: true, added, removed });
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

async function audit(deps: AppDeps, tenantId: string, userId: string, action: string, targetId: string, detail: Record<string, unknown>) {
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType: 'connection', targetId,
    detail, occurredAt: new Date().toISOString(),
  });
}
