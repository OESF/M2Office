/**
 * @file ヘルプセンターの API。記事の一覧・本文・検索と、業務の説明を返す。記事が役に立ったかを受け、管理者に見つからなかった質問と件数を返す（第6.10.10節）。
 *
 * 利用者の役割で見られない記事と、会社で無効にした業務の記事は返さない。
 *
 * @see 仕様書 第6.10節 ヘルプと案内
 */

import { Hono } from 'hono';
import { noteText, suggestHelpNote, type HelpContext, type HelpScope } from '@m2office/core';
import { CARDS_EXTENSION_ID, HR_EXTENSION_ID, INVENTORY_EXTENSION_ID, SIGNAGE_EXTENSION_ID, WEB_COLUMNS_EXTENSION_ID, INQUIRIES_EXTENSION_ID, COMPETITORS_EXTENSION_ID, ANNOUNCEMENTS_EXTENSION_ID, WEB_REVIEW_EXTENSION_ID, CONTRACTS_EXTENSION_ID, RESERVATIONS_EXTENSION_ID, SUBSIDIES_EXTENSION_ID, MEMBERS_EXTENSION_ID, PRINT_DESIGNS_EXTENSION_ID } from '@m2office/shared';
import type { AppDeps } from '../context.js';
import { agentGroup } from '../agent-group.js';
import type { AppEnv } from '../middleware/tenant.js';

export function helpRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  /** 要求ごとの出し分けの文脈（役割・無効にした業務・自動化ポリシー・使える内蔵の拡張）。 */
  async function contextOf(tenantId: string, userId: string, roles: readonly string[]): Promise<HelpContext> {
    const [settings, view, agents, cards, inventory, hr, signage, hrSelf, columns, inquiries, competitors, announcements, webReview, contracts, reservations, subsidies, members, printDesigns] = await Promise.all([
      deps.repo.getTenantSettings(tenantId), deps.tenantView(tenantId), deps.agentsFor(tenantId, userId),
      deps.cards.access(tenantId, userId), deps.inventory.access(tenantId, userId), deps.hr.access(tenantId, userId), deps.signage.access(tenantId, userId),
      deps.hr.attendance.selfEmployee(tenantId, userId), deps.columns.access(tenantId, userId), deps.inquiries.access(tenantId, userId), deps.competitors.access(tenantId, userId), deps.announcements.access(tenantId, userId), deps.webReview.access(tenantId, userId),
      deps.contracts.access(tenantId, userId), deps.reservations.access(tenantId, userId), deps.subsidies.access(tenantId, userId), deps.members.access(tenantId, userId), deps.printDesigns.access(tenantId, userId),
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
      extensions: [cards ? CARDS_EXTENSION_ID : '', inventory ? INVENTORY_EXTENSION_ID : '', hr ? HR_EXTENSION_ID : '', signage ? SIGNAGE_EXTENSION_ID : '', columns ? WEB_COLUMNS_EXTENSION_ID : '', inquiries ? INQUIRIES_EXTENSION_ID : '', competitors ? COMPETITORS_EXTENSION_ID : '', announcements ? ANNOUNCEMENTS_EXTENSION_ID : '', webReview ? WEB_REVIEW_EXTENSION_ID : '', contracts ? CONTRACTS_EXTENSION_ID : '', reservations ? RESERVATIONS_EXTENSION_ID : '', subsidies ? SUBSIDIES_EXTENSION_ID : '', members ? MEMBERS_EXTENSION_ID : '', printDesigns ? PRINT_DESIGNS_EXTENSION_ID : '', hrSelf ? 'hr-self' : ''].filter(Boolean),
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

  /** 記事の本文と、会社の補足（第6.10.7節）。管理者には補足を書けることを返す。 */
  app.get('/articles/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const article = deps.help.get(c.req.param('id'), await contextOf(tenant.id, user.id, user.roles));
    if (!article) return c.json({ error: '記事が見つかりません' }, 404);
    const note = await deps.helpNotes.get(tenant.id, article.id);
    return c.json({ ...article, companyNote: note ? { text: note.text, updatedAt: note.updatedAt } : null, canEditNote: user.roles.includes('admin') });
  });

  /** 会社の補足を書く・直す・消す（管理者だけ。文が空なら消す。第6.10.7節）。本人が見られる記事にだけ。 */
  app.put('/notes/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (!user.roles.includes('admin')) return c.json({ error: '会社の補足を書けるのは管理者だけです' }, 403);
    const article = deps.help.get(c.req.param('id'), await contextOf(tenant.id, user.id, user.roles));
    if (!article) return c.json({ error: '記事が見つかりません' }, 404);
    const body = await c.req.json<{ text?: unknown }>().catch(() => ({} as { text?: unknown }));
    if (typeof body.text !== 'string') return c.json({ error: '補足の文を入れてください（消すときは空に）' }, 400);
    const text = noteText(body.text);
    await deps.helpNotes.set(tenant.id, article.id, text, user.id);
    await deps.repo.appendAudit({
      id: crypto.randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: text ? 'help.note.set' : 'help.note.remove',
      targetType: 'help', targetId: article.id, detail: { chars: text.length }, occurredAt: new Date().toISOString(),
    });
    return c.json({ ok: true, companyNote: text ? { text } : null });
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
    // 会社の補足（業務の説明の記事 `agent-<業務の ID>` に書いたもの。第6.10.7節）
    const note = await deps.helpNotes.get(tenant.id, `agent-${def.id}`);
    return c.json({ ...deps.help.agentHelp(def, ctx), companyNote: note?.text ?? null });
  });

  /** 記事が役に立ったか（ヘルプセンターの記事か、秘書の答え。押し直せば置き換える。第6.10.10節）。本人が読める記事だけ。 */
  app.post('/feedback', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ articleId?: unknown; source?: unknown; helpful?: unknown }>().catch(() => ({} as { articleId?: unknown; source?: unknown; helpful?: unknown }));
    const articleId = typeof body.articleId === 'string' ? body.articleId : '';
    const source = body.source === 'secretary' ? 'secretary' : body.source === 'article' ? 'article' : null;
    if (!articleId || !source || typeof body.helpful !== 'boolean') return c.json({ error: '記事と、役に立ったかを入れてください' }, 400);
    if (!deps.help.get(articleId, await contextOf(tenant.id, user.id, user.roles))) return c.json({ error: '記事が見つかりません' }, 404);
    await deps.helpFeedback.rate(tenant.id, user.id, articleId, source, body.helpful);
    return c.json({ ok: true });
  });

  /**
   * ヘルプの見直し（管理者だけ。第6.10.10節）。秘書がヘルプに見当たらなかった使い方の質問（同じものをまとめた件数。質問した人は出さない）と、
   * 記事ごとの役に立った・立たなかったの件数。
   */
  app.get('/feedback', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (!user.roles.includes('admin')) return c.json({ error: 'ヘルプの見直しは管理者だけが見られます' }, 403);
    const s = await deps.helpFeedback.summary(tenant.id);
    const ctx = await contextOf(tenant.id, user.id, user.roles);
    return c.json({
      misses: s.misses, missDays: s.missDays,
      ratings: s.ratings.map((r) => ({ ...r, title: deps.help.get(r.articleId, ctx)?.title ?? r.articleId })),
    });
  });

  /**
   * 答えられなかった質問から、会社の補足の案を出す（管理者だけ。第6.10.10節）。推論が補足を書くとよい記事を選び、文の案を書く。
   * 材料はヘルプの記事の題名と始めの部分・社内の規程の当たった節だけ。会社のやり方を推測で作らない。書くのは管理者が案を直してから。
   */
  app.post('/feedback/suggest', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (!user.roles.includes('admin')) return c.json({ error: '補足の案を出せるのは管理者だけです' }, 403);
    const body = await c.req.json<{ question?: unknown }>().catch(() => ({} as { question?: unknown }));
    const question = typeof body.question === 'string' ? body.question.trim().slice(0, 200) : '';
    if (!question) return c.json({ error: '質問を入れてください' }, 400);
    const ctx = await contextOf(tenant.id, user.id, user.roles);
    // 業務の説明を含む、ワークスペースで読める記事（管理者向けの記事には社内の人が読まないので書かない）
    const articles = deps.help.list(ctx, 'workspace').filter((a) => a.category !== 'updates');
    const candidates = articles.map((a) => ({ id: a.id, title: a.title, summary: a.body.replace(/^#.*$/gm, '').trim().slice(0, 120) }));
    const found = await deps.repo.searchKnowledge(tenant.id, question, null, [], { categories: ['rule'] }).catch(() => ({ hits: [] as { citation: string; body: string }[] }));
    const llm = await deps.ai.llmFor(tenant.id);
    const s = await suggestHelpNote(llm, question, candidates, found.hits.slice(0, 2).map((h) => ({ citation: h.citation, body: h.body })));
    if (!s) return c.json({ error: '補足の案を出せませんでした（AI が使えないか、案を読めませんでした）。記事を選んで、ご自身で書いてください' }, 422);
    const article = s.articleId ? articles.find((a) => a.id === s.articleId) ?? null : null;
    const existing = article ? (await deps.helpNotes.get(tenant.id, article.id))?.text ?? null : null;
    return c.json({ articleId: article?.id ?? null, title: article?.title ?? null, note: s.note, reason: s.reason, existing });
  });

  /** 片付いた質問を「ヘルプの見直し」から外す（管理者だけ。補足を書いたとき・補わないと決めたとき）。 */
  app.post('/feedback/dismiss', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (!user.roles.includes('admin')) return c.json({ error: 'ヘルプの見直しは管理者だけが扱えます' }, 403);
    const body = await c.req.json<{ question?: unknown }>().catch(() => ({} as { question?: unknown }));
    if (typeof body.question !== 'string' || !body.question.trim()) return c.json({ error: '質問を入れてください' }, 400);
    return c.json({ removed: await deps.helpFeedback.dismiss(tenant.id, body.question) });
  });

  return app;
}
