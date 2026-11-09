/**
 * @file 初回の案内と、管理者の初期設定チェックリスト・セットアップウィザードの API。
 *
 * チェックリストの項目は、できるだけ他のデータから判定する（会社情報・知識の件数・利用者数など）。
 * 判定できないもの（業務の確認・従業員への告知）だけを記録する。ウィザードは同じ判定を使う（ADR-0130）。
 *
 * @see 仕様書 第6.10.3節 初回の案内
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { AppDeps } from '../context.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';
import { googleClient } from './connections.js';

/** チェックリストの 1 項目（第6.10.3節の表）。 */
export interface ChecklistItem {
  id: 'ai' | 'company' | 'google' | 'agents' | 'knowledge' | 'users' | 'notify';
  label: string;
  done: boolean;
  /** 管理者ページの移り先。無ければ `null`。 */
  go: string | null;
  /** ヘルプの記事。 */
  help: string;
  important?: boolean;
  note?: string | null;
}

/**
 * 管理者の初期設定のチェックリストを作る（第6.10.3節）。セットアップウィザードも同じ判定を使う（ADR-0130）。
 *
 * @param userId 見ている管理者。「Google Workspace を接続する」は、この人が自分の Google を接続したかで決める
 *
 * @remarks
 * できるだけ他のデータから判定する（会社情報・知識の件数・利用者数など）。判定できないもの（業務の確認・従業員への告知）だけを記録する。
 */
export async function buildChecklist(deps: AppDeps, tenantId: string, userId: string): Promise<ChecklistItem[]> {
  const [settings, knowledge, users, client, conn] = await Promise.all([
    deps.repo.getTenantSettings(tenantId),
    // 規程を登録したか（秘書が学んだこと・議事録は数えない。第11.11.1節）
    deps.repo.listKnowledge(tenantId).then((ks) => ks.filter((k) => k.category === 'rule').length),
    deps.repo.listUsers(tenantId),
    googleClient(deps, tenantId).catch(() => null),
    deps.repo.getGoogleConnection(tenantId, userId).catch(() => null),
  ]);
  const source = deps.connector.sourceFor(tenantId);
  // スターターと有料の会社は自社の鍵で動く（第23.4.5節）。鍵を入れるまで AI が動かないので、いちばん上に出す
  const needsOwnKey = deps.ai.deployment() === 'cloud' && (await deps.billing.store.category(tenantId).catch(() => 'none')) !== 'none';
  const aiItems: ChecklistItem[] = needsOwnKey
    ? [{ id: 'ai', label: 'Gemini の鍵を入れる', done: (await deps.ai.geminiFor(tenantId)).source === 'tenant', go: 'connectors', help: 'admin-gemini-key', important: true }]
    : [];
  return [
    ...aiItems,
    { id: 'company', label: '会社情報を入力する', done: settings.company.legalName.trim() !== '', go: 'company', help: 'admin-setup' },
    {
      // 会社の OAuth クライアントがあり、見ている管理者が接続したら済み（第 0.536.0 版。前は接続口の種類だけを見ていた）
      id: 'google', label: 'Google Workspace を接続する', done: source === 'google' && !!client && !!conn, go: 'connectors',
      help: source === 'mock' ? 'faq-dummy' : 'admin-google-setup', note: source === 'mock' ? 'いまは準備中のため、見本のデータで動いています' : null,
    },
    { id: 'agents', label: '使う業務を選ぶ', done: !!settings.onboarding.agentsReviewedAt, go: 'agents', help: 'admin-agents' },
    { id: 'knowledge', label: '就業規則などの規程を登録する', done: knowledge > 0, go: 'knowledge', help: 'admin-knowledge', important: true },
    { id: 'users', label: '同僚を招待する', done: users.filter((u) => u.status === 'active').length >= 2, go: 'users', help: 'admin-users' },
    {
      id: 'notify', label: '従業員へ、ダッシュボードで見える範囲を知らせる', done: !!settings.onboarding.employeesNotifiedAt,
      go: null, help: 'faq-privacy',
    },
  ];
}

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
    // ほかの記録（朝のブリーフを用意したことなど）を消さない
    const current = (await deps.repo.getUserSettings(tenant.id, user.id)).onboarding;
    await deps.repo.saveUserSettings(tenant.id, user.id, 'onboarding', { ...current, tourCompletedAt });
    return c.json({ completedAt: tourCompletedAt });
  });

  /** 管理者の初期設定チェックリスト（第6.10.3節の表）。 */
  app.get('/checklist', requireRole('admin'), async (c) => {
    const { tenant, user } = c.get('ctx');
    const items = await buildChecklist(deps, tenant.id, user.id);
    return c.json({ items, done: items.every((i) => i.done) });
  });

  /**
   * セットアップウィザードの様子（第6.10.3節、ADR-0130）。段ごとの済みは、チェックリストと同じ判定。
   * `wizardDone` は会社として終えたか（終えていなければ、管理者のログインのたびに出す）。
   */
  app.get('/wizard', requireRole('admin'), async (c) => {
    const { tenant, user } = c.get('ctx');
    const [items, settings] = await Promise.all([buildChecklist(deps, tenant.id, user.id), deps.repo.getTenantSettings(tenant.id)]);
    return c.json({ items, wizardDone: !!settings.onboarding.wizardDoneAt, deployment: deps.ai.deployment() });
  });

  /** セットアップウィザードを終えた（最後の「使い始める」）。会社に 1 回だけ記録し、ほかの管理者にも出さない。 */
  app.post('/wizard/done', requireRole('admin'), async (c) => {
    const { tenant, user } = c.get('ctx');
    const settings = await deps.repo.getTenantSettings(tenant.id);
    if (!settings.onboarding.wizardDoneAt) {
      const at = new Date().toISOString();
      await deps.repo.saveTenantSettings(tenant.id, 'onboarding', { ...settings.onboarding, wizardDoneAt: at }, user.id);
      await deps.repo.appendAudit({
        id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'onboarding.wizard.done',
        targetType: 'tenant', targetId: tenant.id, detail: {}, occurredAt: at,
      });
    }
    return c.json({ ok: true });
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
