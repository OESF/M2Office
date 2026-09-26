/**
 * @file 会社の接続（コネクタ。MCP サーバ）を管理する API（仕様書 第12.11.0節・第6.6.3節、ADR-0037）。
 *
 * コネクタは拡張機能の一部ではなく、道具を供給する会社の資源である。
 * 管理者が URL から登録し、道具ごとに危険度と入り切りを決める。秘書・公式の業務・拡張機能のどれからでも使う。
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { RISK_LEVELS, type RiskLevel } from '@m2office/shared';
import { checkConnector, type TenantConnection } from '@m2office/core';
import type { AppDeps } from '../context.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';

/** 危険度を、管理者に見せる言葉にする。 */
const RISK_WORDS: Record<RiskLevel, string> = {
  read: '読むだけ',
  draft: '下書きを作る',
  'write-internal': '社内に書き込む',
  'external-send': '社外や他の人へ送る',
  financial: 'お金に関わる',
};

/**
 * MCP の道具の一覧を、会社の接続の道具にする（仕様書 第12.11.2節）。
 *
 * @param keep 前に決めた危険度（取り直しのとき）。残す
 * @remarks 危険度の初期値は、読むだけの目印があれば read、無ければ external-send（承認が入る安全側）
 */
function toTools(
  listed: { name: string; description: string; readOnly?: boolean }[],
  keep: TenantConnection['tools'] = [],
): TenantConnection['tools'] {
  return listed.map((t) => ({
    name: t.name,
    description: t.description.trim() || `${t.name}（説明がありません）`,
    risk: keep.find((k) => k.name === t.name)?.risk ?? (t.readOnly === true ? 'read' : 'external-send'),
  }));
}

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

  /** 会社の接続の一覧。道具ごとの危険度と入り切り、その接続を使う業務を返す。 */
  app.get('/', async (c) => {
    const { tenant } = c.get('ctx');
    const view = await deps.tenantView(tenant.id);
    return c.json({
      items: view.connections.map((x) => ({
        id: x.id, name: x.name, description: x.description, url: x.url, auth: x.auth.type,
        origin: x.origin, originText: x.origin === 'manual' ? '管理者が登録' : `拡張機能に同梱（${x.origin.slice('extension:'.length)}）`,
        tools: x.tools.map((t) => ({
          name: t.name, description: t.description, risk: t.risk, riskText: RISK_WORDS[t.risk],
          enabled: !view.disabledTools.has(`${x.id}.${t.name}`),
        })),
        // いま使える業務のうち、この接続の道具を使うもの（導入していない拡張機能の業務は数えない）
        usedBy: view.agents.filter((a) => a.tools.some((n) => n.startsWith(`${x.id}.`))).map((a) => ({ id: a.id, name: a.name })),
      })),
      risks: RISK_LEVELS.map((r) => ({ value: r, text: RISK_WORDS[r] })),
    });
  });

  /**
   * 接続を登録する。MCP サーバに道具の一覧を問い合わせ、危険度の初期値を付けて保存する。
   *
   * @remarks ID を省けば URL から作る。内蔵の道具の頭の部分と、会社のほかの接続とは重ならない
   */
  app.post('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ id?: string; name?: string; url?: string; description?: string }>().catch(() => ({}) as Record<string, never>);
    const url = String(body.url ?? '').trim();
    const id = String(body.id ?? '').trim() || idFromUrl(url);
    const existing = await deps.repo.listConnections(tenant.id);
    if (existing.some((x) => x.id === id)) return c.json({ error: `ID ${id} の接続はすでにあります。別の ID にしてください` }, 400);
    const listed = await deps.hub.listMcpTools(url);
    if (!listed.ok) return c.json({ error: `MCP サーバに接続できませんでした: ${listed.error}` }, 400);
    const now = new Date().toISOString();
    const conn: TenantConnection = {
      tenantId: tenant.id, id, name: String(body.name ?? '').trim() || id, description: String(body.description ?? '').trim(),
      transport: 'http', url, auth: { type: 'none' }, tools: toTools(listed.tools),
      origin: 'manual', createdBy: user.id, createdAt: now, updatedAt: now,
    };
    const problems = checkConnector(conn, deps.hub.builtinPrefixes());
    if (problems.length > 0) return c.json({ error: '登録できません', problems }, 400);
    await deps.repo.saveConnection(conn);
    await audit(deps, tenant.id, user.id, 'connection.mcp.create', id, { url, tools: conn.tools.length });
    return c.json({ ok: true, id, tools: conn.tools.length }, 201);
  });

  /** 名前・説明・道具ごとの危険度を変える。 */
  app.put('/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const conn = (await deps.repo.listConnections(tenant.id)).find((x) => x.id === c.req.param('id'));
    if (!conn) return c.json({ error: '接続が見つかりません' }, 404);
    const body = await c.req.json<{ name?: string; description?: string; tools?: { name: string; risk: string }[] }>().catch(() => ({}) as Record<string, never>);
    for (const t of body.tools ?? []) {
      if (!RISK_LEVELS.includes(t.risk as RiskLevel)) return c.json({ error: `危険度は ${RISK_LEVELS.join('・')} のどれかです` }, 400);
    }
    const next: TenantConnection = {
      ...conn,
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : conn.name,
      description: typeof body.description === 'string' ? body.description.trim() : conn.description,
      tools: conn.tools.map((t) => {
        const want = body.tools?.find((x) => x.name === t.name);
        return want ? { ...t, risk: want.risk as RiskLevel } : t;
      }),
      updatedAt: new Date().toISOString(),
    };
    await deps.repo.saveConnection(next);
    await audit(deps, tenant.id, user.id, 'connection.mcp.update', conn.id, {
      risks: next.tools.filter((t, i) => t.risk !== conn.tools[i]?.risk).map((t) => ({ tool: t.name, risk: t.risk })),
    });
    return c.json({ ok: true });
  });

  /** 道具の一覧を取り直す。決めた危険度は残し、増えた道具は初期値で足し、無くなった道具は外す。 */
  app.post('/:id/refresh', async (c) => {
    const { tenant, user } = c.get('ctx');
    const conn = (await deps.repo.listConnections(tenant.id)).find((x) => x.id === c.req.param('id'));
    if (!conn) return c.json({ error: '接続が見つかりません' }, 404);
    const listed = await deps.hub.listMcpTools(conn.url);
    if (!listed.ok) return c.json({ error: `MCP サーバに接続できませんでした: ${listed.error}` }, 400);
    const tools = toTools(listed.tools, conn.tools);
    await deps.repo.saveConnection({ ...conn, tools, updatedAt: new Date().toISOString() });
    const added = tools.filter((t) => !conn.tools.some((k) => k.name === t.name)).map((t) => t.name);
    const removed = conn.tools.filter((k) => !tools.some((t) => t.name === k.name)).map((t) => t.name);
    await audit(deps, tenant.id, user.id, 'connection.mcp.refresh', conn.id, { added, removed });
    return c.json({ ok: true, added, removed });
  });

  /** 接続を確かめる（第12.11.3節）。登録した道具を MCP サーバが提供しているかを返す。状態は変えない。 */
  app.post('/:id/check', async (c) => {
    const { tenant } = c.get('ctx');
    const conn = (await deps.repo.listConnections(tenant.id)).find((x) => x.id === c.req.param('id'));
    if (!conn) return c.json({ error: '接続が見つかりません' }, 404);
    return c.json(await deps.hub.checkConnector(conn));
  });

  /** 接続を消すと使えなくなる業務（止まる業務の名前を示して確かめる。第12.11.0節）。 */
  app.get('/:id/impact', async (c) => {
    const { tenant } = c.get('ctx');
    const view = await deps.tenantView(tenant.id);
    const id = c.req.param('id');
    const blocked = view.agents.filter((a) => a.tools.some((n) => n.startsWith(`${id}.`)));
    return c.json({ agents: blocked.map((a) => ({ id: a.id, name: a.name })) });
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

  /** 接続を消す。その道具を使う業務は使えなくなる（先に `impact` で確かめる）。 */
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
