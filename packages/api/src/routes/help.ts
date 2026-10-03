/**
 * @file ヘルプセンターの API。記事の一覧・本文・検索と、業務の説明を返す。
 *
 * 利用者の役割で見られない記事と、会社で無効にした業務の記事は返さない。
 *
 * @see 仕様書 第6.10節 ヘルプと案内
 */

import { Hono } from 'hono';
import type { HelpContext, HelpScope } from '@m2office/core';
import { CARDS_EXTENSION_ID, HR_EXTENSION_ID, INVENTORY_EXTENSION_ID, SIGNAGE_EXTENSION_ID, WEB_COLUMNS_EXTENSION_ID, INQUIRIES_EXTENSION_ID } from '@m2office/shared';
import type { AppDeps } from '../context.js';
import { agentGroup } from '../agent-group.js';
import type { AppEnv } from '../middleware/tenant.js';

export function helpRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  /** 要求ごとの出し分けの文脈（役割・無効にした業務・自動化ポリシー・使える内蔵の拡張）。 */
  async function contextOf(tenantId: string, userId: string, roles: readonly string[]): Promise<HelpContext> {
    const [settings, view, agents, cards, inventory, hr, signage, hrSelf, columns, inquiries] = await Promise.all([
      deps.repo.getTenantSettings(tenantId), deps.tenantView(tenantId), deps.agentsFor(tenantId, userId),
      deps.cards.access(tenantId, userId), deps.inventory.access(tenantId, userId), deps.hr.access(tenantId, userId), deps.signage.access(tenantId, userId),
      deps.hr.attendance.selfEmployee(tenantId, userId), deps.columns.access(tenantId, userId), deps.inquiries.access(tenantId, userId),
    ]);
    return {
      roles, disabledAgents: settings.agents.disabled, automation: settings.automation,
      // 本人の利用範囲の外の業務の説明は出さない（第16.7.4節）
      agents, registry: view.registry,
      // 業務の要点の記事とマニュアルは、その業務を使える人だけに出す（第6.10.7節・第6.10.7.3節）
      // 業務の記事を、ダッシュボードと同じまとまりで木に入れる（第6.10.7節）
      groupOf: (agentId: string) => {
        const def = agents.find((a) => a.id === agentId);
        return def ? agentGroup(view, def) : { id: `agent:${agentId}`, name: agentId };
      },
      extensions: [cards ? CARDS_EXTENSION_ID : '', inventory ? INVENTORY_EXTENSION_ID : '', hr ? HR_EXTENSION_ID : '', signage ? SIGNAGE_EXTENSION_ID : '', columns ? WEB_COLUMNS_EXTENSION_ID : '', inquiries ? INQUIRIES_EXTENSION_ID : '', hrSelf ? 'hr-self' : ''].filter(Boolean),
    };
  }

  /** 出す所（`scope`: `admin` は管理者ページ、それ以外はワークスペース。第6.10.7節）。 */
  const scopeOf = (v: string | undefined): HelpScope => (v === 'admin' ? 'admin' : 'workspace');

  /** 記事の一覧（出す所に合うものだけ）と、読めるマニュアルの名前。本文は含めない。 */
  app.get('/articles', async (c) => {
    const { tenant, user } = c.get('ctx');
    const ctx = await contextOf(tenant.id, user.id, user.roles);
    const items = deps.help.list(ctx, scopeOf(c.req.query('scope'))).map(({ body: _body, ...meta }) => meta);
    const manuals = deps.helpManuals.filter((m) => items.some((i) => i.business === m.id && i.category === 'manual')).map(({ id, title }) => ({ id, title }));
    return c.json({ items, manuals });
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
    const hits = deps.help.search(q, await contextOf(tenant.id, user.id, user.roles), 10, scopeOf(c.req.query('scope')));
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
