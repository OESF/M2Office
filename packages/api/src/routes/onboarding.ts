/**
 * @file 初回の案内と、管理者の初期設定チェックリストの API。
 *
 * チェックリストの項目は、できるだけ他のデータから判定する（会社情報・知識の件数・利用者数など）。
 * 判定できないもの（業務の確認・従業員への告知）だけを記録する。
 *
 * @see 仕様書 第6.10.3節 初回の案内
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { AppDeps } from '../context.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';

export function onboardingRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  /** 本人の初回の案内の状態。 */
  app.get('/tour', async (c) => {
    const { tenant, user } = c.get('ctx');
    const s = await deps.repo.getUserSettings(tenant.id, user.id);
    return c.json({ completedAt: s.onboarding.tourCompletedAt });
  });

  /** 案内を見終えた（飛ばした）ことを記録する。`reset: true` で次回また出す（見直し用）。 */
  app.post('/tour', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ reset?: boolean }>().catch(() => ({ reset: false }));
    const tourCompletedAt = body.reset ? null : new Date().toISOString();
    await deps.repo.saveUserSettings(tenant.id, user.id, 'onboarding', { tourCompletedAt });
    return c.json({ completedAt: tourCompletedAt });
  });

  /** 管理者の初期設定チェックリスト（第6.10.3節の表）。 */
  app.get('/checklist', requireRole('admin'), async (c) => {
    const { tenant } = c.get('ctx');
    const [settings, knowledge, users] = await Promise.all([
      deps.repo.getTenantSettings(tenant.id),
      deps.repo.countKnowledge(tenant.id),
      deps.repo.listUsers(tenant.id),
    ]);
    const items = [
      { id: 'company', label: '会社情報を入力する', done: settings.company.legalName.trim() !== '', go: 'company', help: 'admin-setup' },
      {
        id: 'google', label: 'Google Workspace を接続する', done: deps.connector.source === 'google', go: 'connectors',
        help: 'faq-dummy', note: deps.connector.source === 'mock' ? 'いまは準備中のため、見本のデータで動いています' : null,
      },
      { id: 'agents', label: '使う業務を選ぶ', done: !!settings.onboarding.agentsReviewedAt, go: 'agents', help: 'admin-agents' },
      { id: 'knowledge', label: '就業規則などの規程を登録する', done: knowledge > 0, go: 'knowledge', help: 'admin-knowledge', important: true },
      { id: 'users', label: '同僚を招待する', done: users.filter((u) => u.status === 'active').length >= 2, go: 'users', help: 'admin-users' },
      {
        id: 'notify', label: '従業員へ、ダッシュボードで見える範囲を知らせる', done: !!settings.onboarding.employeesNotifiedAt,
        go: null, help: 'faq-privacy',
      },
    ];
    return c.json({ items, done: items.every((i) => i.done) });
  });

  /** 従業員へ知らせたことを記録する（第6.10.3節 項目 6）。 */
  app.post('/checklist/notified', requireRole('admin'), async (c) => {
    const { tenant, user } = c.get('ctx');
    const settings = await deps.repo.getTenantSettings(tenant.id);
    await deps.repo.saveTenantSettings(tenant.id, 'onboarding',
      { ...settings.onboarding, employeesNotifiedAt: new Date().toISOString() }, user.id);
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'onboarding.notified',
      targetType: 'tenant', targetId: tenant.id, detail: {}, occurredAt: new Date().toISOString(),
    });
    return c.json({ ok: true });
  });

  return app;
}
