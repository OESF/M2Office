/**
 * @file ヘルプセンターの API。記事の一覧・本文・検索と、業務の説明を返す。
 *
 * 利用者の役割で見られない記事と、会社で無効にした業務の記事は返さない。
 *
 * @see 仕様書 第6.10節 ヘルプと案内
 */

import { Hono } from 'hono';
import type { HelpContext } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

export function helpRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  /** 要求ごとの出し分けの文脈（役割・無効にした業務・自動化ポリシー）。 */
  async function contextOf(tenantId: string, userId: string, roles: readonly string[]): Promise<HelpContext> {
    const [settings, view, agents] = await Promise.all([
      deps.repo.getTenantSettings(tenantId), deps.tenantView(tenantId), deps.agentsFor(tenantId, userId),
    ]);
    return {
      roles, disabledAgents: settings.agents.disabled, automation: settings.automation,
      // 本人の利用範囲の外の業務の説明は出さない（第16.7.4節）
      agents, registry: view.registry,
    };
  }

  /** 記事の一覧。本文は含めない。 */
  app.get('/articles', async (c) => {
    const { tenant, user } = c.get('ctx');
    const ctx = await contextOf(tenant.id, user.id, user.roles);
    const items = deps.help.list(ctx).map(({ body: _body, ...meta }) => meta);
    return c.json({ items });
  });

  app.get('/articles/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const article = deps.help.get(c.req.param('id'), await contextOf(tenant.id, user.id, user.roles));
    return article ? c.json(article) : c.json({ error: '記事が見つかりません' }, 404);
  });

  /** 記事の検索。問い合わせ文は記録しない（開発規約 第7.5節）。 */
  app.get('/search', async (c) => {
    const { tenant, user } = c.get('ctx');
    const q = (c.req.query('q') ?? '').slice(0, 200);
    const hits = deps.help.search(q, await contextOf(tenant.id, user.id, user.roles), 10);
    return c.json({
      items: hits.map((h) => ({ id: h.article.id, title: h.article.title, category: h.article.category, excerpt: h.excerpt })),
    });
  });

  /** 業務の説明。業務の画面に出す（仕様書 第6.10.5節）。 */
  app.get('/agents/:agentId', async (c) => {
    const { tenant, user } = c.get('ctx');
    const ctx = await contextOf(tenant.id, user.id, user.roles);
    const def = ctx.agents?.find((a) => a.id === c.req.param('agentId'));
    if (!def || ctx.disabledAgents.includes(def.id)) return c.json({ error: '業務が見つかりません' }, 404);
    return c.json(deps.help.agentHelp(def, ctx));
  });

  return app;
}
