/**
 * @file 拡張機能を入れる・切る処理。管理者のスイッチと導入（拡張機能の API）と、体験版の見本のデータ（仕様書 第23.3.2節）が同じ道を通る。
 *
 * 内蔵の拡張は会社の設定の入り切りで決まり、初めて入れたときに利用範囲や人事区画を用意するものがある（第12.13節）。
 * 体験版でも管理者がスイッチを入れたときと同じ状態にするため、ここにまとめる。
 *
 * @see 仕様書 第12.10.4節 スイッチ
 * @see 仕様書 第12.13節 内蔵の拡張
 */

import { randomUUID } from 'node:crypto';
import {
  CONTRACTS_EXTENSION_ID, DECISIONS_EXTENSION_ID, SALES_DOCS_EXTENSION_ID, SITE_UPDATES_EXTENSION_ID, SUBSIDIES_EXTENSION_ID, type TenantSettings,
} from '@m2office/shared';
import { bundledConnection, consentSnapshot, ensureHrCompartment, type BuiltinSection, type ExtensionPackage, type Repository } from '@m2office/core';
import type { AppDeps } from './context.js';

/** 拡張機能を入れる・切るのに要る部品。 */
export type ExtensionSwitchDeps = Pick<AppDeps, 'repo' | 'contracts' | 'signage'>;

/** 初めて入れたときに、利用範囲を管理者だけにする内蔵の拡張（第42.9節・第39.2節・第43.2節・第45.2節）。 */
const ADMIN_SCOPED_FIRST: ReadonlySet<BuiltinSection> = new Set(['salesDocs', 'subsidies', 'decisions', 'siteUpdates']);

/** 区分から、利用範囲の鍵にする拡張機能の ID を引く。 */
const SCOPE_IDS: Partial<Record<BuiltinSection, string>> = {
  salesDocs: SALES_DOCS_EXTENSION_ID, subsidies: SUBSIDIES_EXTENSION_ID, decisions: DECISIONS_EXTENSION_ID, siteUpdates: SITE_UPDATES_EXTENSION_ID,
};

/**
 * 内蔵の拡張を入れる・切る。切ってもデータは消さない（第12.13節）。監査ログに残す。
 *
 * @param extensionId - 拡張機能の ID（監査ログの対象）
 * @param section - 入り切りを持つ会社の設定の区分
 * @remarks
 * 危険度: write-internal（会社の設定を変える。社外へは送らない）。
 * 入れたときの付随の処理: 契約の管理は契約書の置き場を作る（作れなくても入れる）、販売の書類・補助金の案内・意思決定支援は初めてなら利用範囲を管理者だけにする、
 * サイネージは画面に知らせる、人事・給与は人事区画を用意して入れた管理者を区画に入れる。
 */
export async function setBuiltinEnabled(
  deps: ExtensionSwitchDeps, tenantId: string, userId: string, extensionId: string, section: BuiltinSection, enabled: boolean,
): Promise<void> {
  const { repo } = deps;
  const settings = await repo.getTenantSettings(tenantId);
  const current = settings[section] as TenantSettings[BuiltinSection];
  await repo.saveTenantSettings(tenantId, section, { ...current, enabled } as never, userId);
  if (section === 'contracts' && enabled && !settings.contracts.storage) {
    // 入れたら、入れた管理者のドライブに契約書の置き場を作る（まだ無ければ。作れなくても入れる。第38.7節）
    await deps.contracts.service.connectStorage({ tenantId, userId }).catch(() => null);
  }
  const scopeId = SCOPE_IDS[section];
  if (enabled && ADMIN_SCOPED_FIRST.has(section) && scopeId && !settings.access.scopes[scopeId]) {
    // 初めて入れたときは、利用範囲を管理者だけにする（管理者は「利用できる人」で広げられる）
    const admins = (await repo.listUsers(tenantId)).filter((u) => u.status === 'active' && u.roles.includes('admin')).map((u) => u.id);
    await repo.saveTenantSettings(tenantId, 'access', { ...settings.access, scopes: { ...settings.access.scopes, [scopeId]: { users: admins, groups: [] } } }, userId);
  }
  // 切ったら、画面は無地にする（登録・素材・流れは消さない。第31.2節）
  if (section === 'signage') deps.signage.service.settingsChanged(tenantId);
  // 人事・給与を入れたら、人事区画を用意し、入れた管理者を区画に入れる（第30.2節）
  if (section === 'hr' && enabled) {
    const prepared = await ensureHrCompartment(repo, tenantId, userId);
    if (prepared.created || prepared.added) {
      await repo.appendAudit({
        id: randomUUID(), tenantId, actorType: 'user', actorId: userId,
        action: prepared.created ? 'compartment.create' : 'compartment.enter',
        targetType: 'compartment', targetId: 'hr', detail: { by: 'hr.enable', member: userId }, occurredAt: new Date().toISOString(),
      });
    }
  }
  await repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: userId,
    action: enabled ? 'extension.enable' : 'extension.disable',
    targetType: 'extension', targetId: extensionId, detail: { builtin: true }, occurredAt: new Date().toISOString(),
  });
}

/**
 * 同意した拡張機能を導入する。導入すると有効（スイッチが入った状態）になる。同意した権限を記録し、同梱の接続を会社の接続として登録する。
 *
 * @param origin - 監査ログに残す出どころ（公式の配布元か、自社専用か）
 * @returns 画面に出す知らせ（同じ ID の会社の接続が別の接続先で登録済みのときなど）
 * @remarks 危険度: write-internal（会社に拡張機能を入れる。社外へは送らない）。同意の確かめは呼ぶ側で行う（不変則 I-8）
 */
export async function installExtensionPackage(
  repo: Repository, tenantId: string, userId: string, pkg: ExtensionPackage, origin: 'official' | 'private',
): Promise<string[]> {
  const now = new Date().toISOString();
  const consented = consentSnapshot(pkg);
  await repo.installExtension({
    tenantId, extensionId: pkg.manifest.id, version: pkg.manifest.version,
    consentedPermissions: consented, installedBy: userId, installedAt: now, enabled: true,
  });
  // 同梱の接続を会社の接続として登録する。あれば使い回し、接続先が違えば置き換えずに知らせる（第12.11.0節）
  const connections = await repo.listConnections(tenantId);
  const notices: string[] = [];
  for (const decl of pkg.connectors) {
    const have = connections.find((x) => x.id === decl.id);
    if (!have) await repo.saveConnection(bundledConnection(tenantId, decl, pkg.manifest.id, userId));
    else if (have.url !== decl.url) notices.push(`会社の接続「${decl.id}」は別の接続先（${have.url}）で登録済みのため、そのまま使います`);
  }
  await repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action: 'extension.install',
    targetType: 'extension', targetId: pkg.manifest.id,
    detail: { version: pkg.manifest.version, origin, permissions: consented }, occurredAt: now,
  });
  return notices;
}
