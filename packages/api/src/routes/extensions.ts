/**
 * @file 拡張機能の導入の API（管理者向け）。導入できる拡張機能の一覧、同意して導入、削除。
 *
 * 導入の前に必要な権限を平易な言葉で示し、管理者の同意を得て、同意した権限を記録する（不変則 I-8）。
 * 読み込まれた拡張機能でも、導入していない会社では使えない。
 *
 * @see 仕様書 第12.9.3節 会社への導入
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { RiskLevel } from '@m2office/shared';
import type { ExtensionPackage } from '@m2office/core';
import type { AppDeps } from '../context.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';

/** 危険度を利用者向けの言葉にする。 */
const RISK_WORDS: Record<RiskLevel, string> = {
  read: '読むだけ（書き込みも送信もしない）',
  draft: '下書きや資料を作る（送信はしない）',
  'write-internal': '社内に書き込む（ToDo の登録など）',
  'external-send': '社外や他の人へ送る（必ず承認のあと）',
  financial: 'お金に関わる処理をする（必ず承認のあと）',
};

export function extensionsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireRole('admin'));

  /** 必要な権限を、ツールの「すること」と最大の危険度で説明する。 */
  function describe(pkg: ExtensionPackage) {
    const { tools, max_risk_level } = pkg.manifest.permissions;
    return {
      id: pkg.manifest.id,
      name: pkg.manifest.name,
      version: pkg.manifest.version,
      description: pkg.manifest.description ?? '',
      publisher: pkg.manifest.publisher,
      agents: pkg.agents.map((a) => ({ id: a.id, name: a.name, summary: a.help?.summary ?? a.description })),
      permissions: {
        maxRisk: max_risk_level,
        maxRiskText: RISK_WORDS[max_risk_level],
        tools: tools.map((t) => ({ name: t, does: deps.registry.get(t)?.helpText ?? '（不明なツール）' })),
      },
    };
  }

  app.get('/', async (c) => {
    const { tenant } = c.get('ctx');
    const installed = await deps.repo.listInstalledExtensions(tenant.id);
    const items = deps.catalog.extensions().map((pkg) => {
      const rec = installed.find((i) => i.extensionId === pkg.manifest.id);
      return { ...describe(pkg), installed: rec ? { version: rec.version, installedAt: rec.installedAt } : null };
    });
    return c.json({ items });
  });

  /**
   * 同意して導入する。
   *
   * @remarks 本文に `consent: true` が無ければ導入しない。同意した権限の一覧を記録する。
   */
  app.post('/:id/install', async (c) => {
    const { tenant, user } = c.get('ctx');
    const pkg = deps.catalog.extensions().find((p) => p.manifest.id === c.req.param('id'));
    if (!pkg) return c.json({ error: '拡張機能が見つかりません' }, 404);
    const body = await c.req.json<{ consent?: boolean }>().catch(() => ({ consent: false }));
    if (body.consent !== true) {
      return c.json({ error: '必要な権限を確認し、同意してから導入してください' }, 400);
    }
    const now = new Date().toISOString();
    await deps.repo.installExtension({
      tenantId: tenant.id, extensionId: pkg.manifest.id, version: pkg.manifest.version,
      consentedPermissions: pkg.manifest.permissions, installedBy: user.id, installedAt: now,
    });
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'extension.install',
      targetType: 'extension', targetId: pkg.manifest.id,
      detail: { version: pkg.manifest.version, permissions: pkg.manifest.permissions }, occurredAt: now,
    });
    return c.json({ ok: true });
  });

  /** 導入をやめる。業務エージェントは使えなくなるが、実行の記録は残る。 */
  app.delete('/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const ok = await deps.repo.uninstallExtension(tenant.id, c.req.param('id'));
    if (!ok) return c.json({ error: '導入されていません' }, 404);
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'extension.uninstall',
      targetType: 'extension', targetId: c.req.param('id'), detail: {}, occurredAt: new Date().toISOString(),
    });
    return c.json({ ok: true });
  });

  return app;
}
