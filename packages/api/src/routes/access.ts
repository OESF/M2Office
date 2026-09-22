/**
 * @file グループと利用範囲の API（管理者向け）。グループの作成・変更・削除・所属と、業務ごとの利用範囲。
 *
 * 利用範囲の対象は、公式の業務エージェントの ID か、拡張機能の ID（その業務すべてに効く）である。
 * 対象の設定が無い業務は全員が使える。範囲の外の人には、業務を無いものとして扱う（仕様書 第16.7.4節）。
 *
 * @see 仕様書 第16.7節 グループと利用範囲
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { AccessScope, TenantSettings } from '@m2office/shared';
import type { AppDeps } from '../context.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';

/** 利用範囲を設定できる対象（公式の業務エージェントと拡張機能）。 */
async function targetsOf(deps: AppDeps, tenantId: string) {
  const view = await deps.tenantView(tenantId);
  return [
    ...view.allAgents.filter((a) => !a.id.includes(':')).map((a) => ({ id: a.id, name: a.name, kind: 'agent' as const })),
    ...view.entries.map((e) => ({ id: e.pkg.manifest.id, name: e.pkg.manifest.name, kind: 'extension' as const })),
  ];
}

/**
 * 1 つの対象の利用範囲を保存する。`null` なら設定を消して全員に戻す。
 *
 * @remarks 拡張機能の導入・削除の API からも使う。監査ログには `settings.update`（区分 `access`）で残す。
 */
export async function saveScope(
  deps: AppDeps, tenantId: string, userId: string, target: string, scope: AccessScope | null,
): Promise<void> {
  const current = (await deps.repo.getTenantSettings(tenantId)).access;
  const scopes = { ...current.scopes };
  if (scope) scopes[target] = scope;
  else delete scopes[target];
  await deps.repo.saveTenantSettings(tenantId, 'access', { scopes }, userId);
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action: 'settings.update',
    targetType: 'tenant_settings', targetId: 'access',
    detail: { section: 'access', target, scope: scope ?? 'all' }, occurredAt: new Date().toISOString(),
  });
}

/**
 * 画面から受け取った利用範囲を検証する。`null`・`"all"` は全員。
 *
 * @returns 正規化した範囲。グループも人も選ばない指定は誤りとする（第16.7.3節）
 */
export async function parseScope(
  deps: AppDeps, tenantId: string, input: unknown,
): Promise<{ scope: AccessScope | null } | { error: string }> {
  if (input === null || input === undefined || input === 'all') return { scope: null };
  const o = input as { groups?: unknown; users?: unknown };
  const groups = Array.isArray(o.groups) ? [...new Set(o.groups.map(String))] : [];
  const users = Array.isArray(o.users) ? [...new Set(o.users.map(String))] : [];
  if (groups.length === 0 && users.length === 0) {
    return { error: '使える人を指定する場合は、グループか人を 1 つ以上選んでください。誰にも使わせない場合は「無効」にしてください' };
  }
  const [known, members] = await Promise.all([deps.repo.listGroups(tenantId), deps.repo.listUsers(tenantId)]);
  const badGroup = groups.find((g) => !known.some((k) => k.id === g));
  if (badGroup) return { error: `グループが見つかりません: ${badGroup}` };
  const badUser = users.find((u) => !members.some((m) => m.id === u));
  if (badUser) return { error: `利用者が見つかりません: ${badUser}` };
  return { scope: { groups, users } };
}

/** グループの API。`/v1/admin/groups` に置く。 */
export function groupsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireRole('admin'));

  app.get('/', async (c) => {
    const { tenant } = c.get('ctx');
    return c.json({ items: await deps.repo.listGroups(tenant.id) });
  });

  /** グループを作る。名前は会社の中で重ならない。 */
  app.post('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ name?: string; description?: string }>().catch(() => ({} as { name?: string; description?: string }));
    const name = (body.name ?? '').trim().slice(0, 50);
    if (!name) return c.json({ error: 'グループの名前を入力してください' }, 400);
    const groups = await deps.repo.listGroups(tenant.id);
    if (groups.some((g) => g.name === name)) return c.json({ error: `「${name}」はすでにあります` }, 409);
    const group = { id: `g-${randomUUID()}`, tenantId: tenant.id, name, description: (body.description ?? '').trim().slice(0, 200) };
    await deps.repo.saveGroup(group);
    await audit(deps, tenant.id, user.id, 'group.create', group.id, { name });
    return c.json({ ...group, memberIds: [] }, 201);
  });

  /** 名前と説明を変える。 */
  app.patch('/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const groups = await deps.repo.listGroups(tenant.id);
    const target = groups.find((g) => g.id === c.req.param('id'));
    if (!target) return c.json({ error: 'グループが見つかりません' }, 404);
    const body = await c.req.json<{ name?: string; description?: string }>().catch(() => ({} as { name?: string; description?: string }));
    const name = body.name === undefined ? target.name : body.name.trim().slice(0, 50);
    if (!name) return c.json({ error: 'グループの名前を入力してください' }, 400);
    if (groups.some((g) => g.id !== target.id && g.name === name)) return c.json({ error: `「${name}」はすでにあります` }, 409);
    const description = body.description === undefined ? target.description : body.description.trim().slice(0, 200);
    await deps.repo.saveGroup({ id: target.id, tenantId: tenant.id, name, description });
    await audit(deps, tenant.id, user.id, 'group.update', target.id, { name });
    return c.json({ ...target, name, description });
  });

  /** 所属を丸ごと置き換える。追加・削除した人を監査ログに残す。 */
  app.put('/:id/members', async (c) => {
    const { tenant, user } = c.get('ctx');
    const target = (await deps.repo.listGroups(tenant.id)).find((g) => g.id === c.req.param('id'));
    if (!target) return c.json({ error: 'グループが見つかりません' }, 404);
    const body = await c.req.json<{ userIds?: unknown }>().catch(() => ({ userIds: undefined }));
    if (!Array.isArray(body.userIds)) return c.json({ error: 'userIds に利用者の ID の一覧を指定してください' }, 400);
    const ids = [...new Set(body.userIds.map(String))];
    const users = await deps.repo.listUsers(tenant.id);
    const unknown = ids.filter((id) => !users.some((u) => u.id === id));
    if (unknown.length > 0) return c.json({ error: `利用者が見つかりません: ${unknown.join(', ')}` }, 400);
    await deps.repo.setGroupMembers(tenant.id, target.id, ids);
    await audit(deps, tenant.id, user.id, 'group.members', target.id, {
      added: ids.filter((id) => !target.memberIds.includes(id)),
      removed: target.memberIds.filter((id) => !ids.includes(id)),
    });
    return c.json({ ...target, memberIds: ids });
  });

  /**
   * グループを消す。利用者は消えない。利用範囲からそのグループを外す。
   *
   * @remarks
   * 外した結果、範囲に誰も残らない業務は、全員には戻さず誰も使えないままにする（開く方向に倒さない）。
   * その業務を `emptied` で返し、画面で知らせる（仕様書 第16.7.2節）。
   */
  app.delete('/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const id = c.req.param('id');
    if (!(await deps.repo.deleteGroup(tenant.id, id))) return c.json({ error: 'グループが見つかりません' }, 404);
    const settings = await deps.repo.getTenantSettings(tenant.id);
    const scopes: TenantSettings['access']['scopes'] = {};
    const emptied: string[] = [];
    for (const [target, scope] of Object.entries(settings.access.scopes)) {
      const groups = scope.groups.filter((g) => g !== id);
      scopes[target] = { groups, users: scope.users };
      if (scope.groups.includes(id) && groups.length === 0 && scope.users.length === 0) emptied.push(target);
    }
    await deps.repo.saveTenantSettings(tenant.id, 'access', { scopes }, user.id);
    await audit(deps, tenant.id, user.id, 'group.delete', id, { emptied });
    return c.json({ ok: true, emptied });
  });

  return app;
}

/** 利用範囲の API。`/v1/admin/access` に置く。 */
export function accessRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireRole('admin'));

  /** 利用範囲の一覧と、設定できる対象・グループ・利用者（画面の選択肢）。 */
  app.get('/', async (c) => {
    const { tenant } = c.get('ctx');
    const [settings, groups, users, targets] = await Promise.all([
      deps.repo.getTenantSettings(tenant.id), deps.repo.listGroups(tenant.id),
      deps.repo.listUsers(tenant.id), targetsOf(deps, tenant.id),
    ]);
    return c.json({
      scopes: settings.access.scopes,
      targets,
      groups: groups.map((g) => ({ id: g.id, name: g.name, memberCount: g.memberIds.length })),
      users: users.filter((u) => u.status === 'active').map((u) => ({ id: u.id, displayName: u.displayName, email: u.email })),
    });
  });

  /** 1 つの対象の利用範囲を設定する。本文 `{ scope: "all" | { groups, users } }`。 */
  app.put('/:target', async (c) => {
    const { tenant, user } = c.get('ctx');
    const target = c.req.param('target');
    if (!(await targetsOf(deps, tenant.id)).some((t) => t.id === target)) {
      return c.json({ error: `業務か拡張機能が見つかりません: ${target}` }, 404);
    }
    const body = await c.req.json<{ scope?: unknown }>().catch(() => ({ scope: undefined }));
    const parsed = await parseScope(deps, tenant.id, body.scope);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    await saveScope(deps, tenant.id, user.id, target, parsed.scope);
    return c.json({ ok: true, scope: parsed.scope ?? 'all' });
  });

  return app;
}

async function audit(deps: AppDeps, tenantId: string, userId: string, action: string, groupId: string, detail: Record<string, unknown>) {
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType: 'group', targetId: groupId,
    detail, occurredAt: new Date().toISOString(),
  });
}
