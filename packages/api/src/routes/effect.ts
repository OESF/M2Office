/**
 * @file 効果の欄と効果のレポート（`/v1/admin/effect`。仕様書 第6.7.13節）。管理者だけ。
 *
 * 欄の数字はその場で計算し、レポートは月ごとに 1 つ（作り直すと置き換える）。Google ドキュメントへの書き出しは、書き出す管理者本人の Google の接続で行う。
 */

import { Hono } from 'hono';
import { ConnectorUnavailableError, effectReportMarkdown, withAiUsage } from '@m2office/core';
import type { EffectPeriod } from '@m2office/shared';
import type { AppDeps } from '../context.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';

const PERIODS: EffectPeriod[] = ['thisMonth', 'lastMonth', 'all'];

/**
 * 効果の口。
 *
 * @remarks テナント境界: どれも本人の会社の分だけを読む（不変則 I-2）。人ごとの数字は返さない（第6.7.10節）
 */
export function effectRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireRole('admin'));
  const companyName = async (tenantId: string) => {
    const s = await deps.repo.getTenantSettings(tenantId);
    return s.company.shortName || s.company.legalName;
  };

  /** 欄の数字（`period` は `thisMonth`・`lastMonth`・`all`）。 */
  app.get('/', async (c) => {
    const p = c.req.query('period') ?? 'thisMonth';
    if (!PERIODS.includes(p as EffectPeriod)) return c.json({ error: '期間は thisMonth・lastMonth・all のどれかです' }, 400);
    return c.json({ figures: await deps.effect.figures(c.get('ctx').tenant.id, p as EffectPeriod) });
  });

  app.get('/reports', async (c) => c.json({ reports: await deps.effect.list(c.get('ctx').tenant.id) }));

  app.get('/reports/:id', async (c) => {
    const tenantId = c.get('ctx').tenant.id;
    const r = await deps.effect.get(tenantId, c.req.param('id'));
    if (!r) return c.json({ error: 'レポートが見つかりません' }, 404);
    // コピーする Markdown（Google ドキュメントに書き出すものと同じ）
    return c.json({ report: r, markdown: effectReportMarkdown(r, await companyName(tenantId)) });
  });

  /** 今月（ここまで）か先月のレポートを作る（同じ月は置き換える）。AI の利用は「効果のレポート」として数える。 */
  app.post('/reports', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ month?: unknown }>().catch(() => ({} as { month?: unknown }));
    if (body.month !== 'this' && body.month !== 'last') return c.json({ error: '月は this（今月）か last（先月）です' }, 400);
    const which = body.month;
    const report = await withAiUsage({ userId: user.id, purpose: 'api:effect' }, () => deps.effect.create({ tenantId: tenant.id, userId: user.id }, which));
    return c.json({ report });
  });

  /** Google ドキュメントに書き出す（書き出す管理者本人の Google の接続。本人のマイドライブに作る）。 */
  app.post('/reports/:id/doc', async (c) => {
    const { tenant, user } = c.get('ctx');
    const r = await deps.effect.get(tenant.id, c.req.param('id'));
    if (!r) return c.json({ error: 'レポートが見つかりません' }, 404);
    const company = await companyName(tenant.id);
    try {
      const file = await deps.connector.docs.create({ tenantId: tenant.id, userId: user.id }, {
        title: `M2Office の効果のレポート（${r.figures.label}）`, body: effectReportMarkdown(r, company), folderId: null,
      });
      return c.json({ url: file.url, name: file.name });
    } catch (err) {
      if (err instanceof ConnectorUnavailableError) return c.json({ error: 'Google ドキュメントに書き出せません。Google の接続を確かめてください（個人設定の「接続」）' }, 409);
      throw err;
    }
  });

  return app;
}
