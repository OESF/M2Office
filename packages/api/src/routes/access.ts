/**
 * @file グループと利用範囲の API（管理者向け）。グループの作成・変更・削除・所属と、業務ごとの利用範囲。
 *
 * 利用範囲の対象は、公式の業務エージェントの ID か、拡張機能の ID（その業務すべてに効く）である。
 * 対象の設定が無い業務は全員が使える。範囲の外の人には、業務を無いものとして扱う（仕様書 第16.7.4節）。
 *
 * 権限区画の割当も同じ形（グループと個別の人）で行う。区画に入れる人が変わったら、
 * 監査ログに区画への出入りとして残し、管理者全員に通知する（第16.7.5節）。
 *
 * @see 仕様書 第16.7節 グループと利用範囲
 * @see 仕様書 第16.3節 権限区画
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { AccessScope, TenantSettings } from '@m2office/shared';
import type { AppDeps } from '../context.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';
import { groupEmails, reachNotes, resolveGroupSpace } from '@m2office/core';

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

/** 区画ごとの、入れる人（個別の割当と、割り当てたグループの所属者）。 */
async function compartmentMembers(deps: AppDeps, tenantId: string): Promise<Map<string, { name: string; users: Set<string> }>> {
  const [compartments, groups] = await Promise.all([
    deps.repo.listCompartmentAssignments(tenantId), deps.repo.listGroups(tenantId),
  ]);
  const out = new Map<string, { name: string; users: Set<string> }>();
  for (const c of compartments) {
    const users = new Set(c.users);
    for (const g of groups.filter((x) => c.groups.includes(x.id))) for (const u of g.memberIds) users.add(u);
    out.set(c.id, { name: c.description ?? c.name, users });
  }
  return out;
}

/**
 * 変更の前後で区画に入れる人を比べ、出入りを記録して管理者全員に通知する（第16.7.5節）。
 *
 * @param change 何の変更による出入りか（通知の文に使う）
 */
async function reportCompartmentChanges(
  deps: AppDeps, tenantId: string, actorId: string,
  before: Map<string, { name: string; users: Set<string> }>, change: string,
): Promise<void> {
  const after = await compartmentMembers(deps, tenantId);
  const users = await deps.repo.listUsers(tenantId);
  const nameOf = (id: string) => users.find((u) => u.id === id)?.displayName ?? id;
  const now = new Date().toISOString();
  const lines: string[] = [];
  for (const [id, cur] of after) {
    const prev = before.get(id)?.users ?? new Set<string>();
    const entered = [...cur.users].filter((u) => !prev.has(u));
    const left = [...prev].filter((u) => !cur.users.has(u));
    for (const [action, list] of [['compartment.enter', entered], ['compartment.leave', left]] as const) {
      for (const u of list) {
        await deps.repo.appendAudit({
          id: randomUUID(), tenantId, actorType: 'user', actorId, action, targetType: 'compartment', targetId: id,
          detail: { userId: u, change }, occurredAt: now,
        });
      }
    }
    if (entered.length > 0) lines.push(`「${cur.name}」に入った人: ${entered.map(nameOf).join('、')}`);
    if (left.length > 0) lines.push(`「${cur.name}」から出た人: ${left.map(nameOf).join('、')}`);
  }
  if (lines.length === 0) return;
  const body = [`${nameOf(actorId)}さんの操作（${change}）により、権限区画に入れる人が変わりました。`, '', ...lines].join('\n');
  for (const admin of users.filter((u) => u.status === 'active' && u.roles.includes('admin'))) {
    await deps.repo.createNotification({
      id: randomUUID(), tenantId, userId: admin.id, kind: 'security', title: '権限区画に入れる人が変わりました',
      body, runId: null, readAt: null, createdAt: now,
    });
  }
}

/** グループの API。`/v1/admin/groups` に置く。 */
export function groupsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireRole('admin'));

  /** グループの一覧。どの区画・どの業務に割り当てられているか（`usedBy`）を添える（第16.7.5節 規定 4）。 */
  app.get('/', async (c) => {
    const { tenant } = c.get('ctx');
    const [groups, compartments, settings, targets] = await Promise.all([
      deps.repo.listGroups(tenant.id), deps.repo.listCompartmentAssignments(tenant.id),
      deps.repo.getTenantSettings(tenant.id), targetsOf(deps, tenant.id),
    ]);
    return c.json({
      items: groups.map((g) => ({
        ...g,
        usedBy: {
          compartments: compartments.filter((x) => x.groups.includes(g.id)).map((x) => x.description ?? x.name),
          agents: Object.entries(settings.access.scopes).filter(([, sc]) => sc.groups.includes(g.id))
            .map(([t]) => targets.find((x) => x.id === t)?.name ?? t),
        },
      })),
    });
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

  /**
   * グループに合う Chat のスペースと、メンバーの違いを確かめる（仕様書 第16.7.12.1節。見るだけ）。管理者の Google の接続で探す。
   * 見つかれば覚える（共有を頼んだときと同じ）。
   */
  app.get('/:id/chat-space', async (c) => {
    const { tenant, user } = c.get('ctx');
    const g = (await deps.repo.listGroups(tenant.id)).find((x) => x.id === c.req.param('id'));
    if (!g) return c.json({ error: 'グループが見つかりません' }, 404);
    const p = { tenantId: tenant.id, userId: user.id };
    try {
      const r = await resolveGroupSpace(deps, p, g.name);
      if (r.kind === 'problem') return c.json({ found: false, reason: r.reason });
      let target: { space: string; name: string; by: 'name' | 'members' | 'told'; emails: string[] };
      if (r.kind === 'found') target = { space: r.space, name: r.name, by: r.by, emails: r.emails };
      else {
        // グループと同じ名前のスペースがある
        const f = await deps.connector.chat.findSpace(p, g.name);
        if ('reason' in f) return c.json({ found: false, reason: f.reason });
        target = { space: f.space, name: f.displayName ?? g.name, by: 'name', emails: await groupEmails(deps.repo, tenant.id, g) };
      }
      const reach = await reachNotes(deps, p, target.space, { group: g, by: target.by, emails: target.emails });
      return c.json({ found: true, space: target.name, notes: reach.notes });
    } catch (err) {
      return c.json({ found: false, reason: err instanceof Error ? err.message : 'Chat のスペースを確かめられませんでした' });
    }
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
    const before = await compartmentMembers(deps, tenant.id);
    await deps.repo.setGroupMembers(tenant.id, target.id, ids);
    await audit(deps, tenant.id, user.id, 'group.members', target.id, {
      added: ids.filter((id) => !target.memberIds.includes(id)),
      removed: target.memberIds.filter((id) => !ids.includes(id)),
    });
    await reportCompartmentChanges(deps, tenant.id, user.id, before, `グループ「${target.name}」の所属の変更`);
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
    const before = await compartmentMembers(deps, tenant.id);
    const name = (await deps.repo.listGroups(tenant.id)).find((g) => g.id === id)?.name ?? id;
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
    await reportCompartmentChanges(deps, tenant.id, user.id, before, `グループ「${name}」の削除`);
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

/** 権限区画の API。`/v1/admin/compartments` に置く。区画の作成と、入れるグループと人の割当。 */
export function compartmentsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireRole('admin'));

  app.get('/', async (c) => {
    const { tenant } = c.get('ctx');
    return c.json({ items: await deps.repo.listCompartmentAssignments(tenant.id) });
  });

  /** 区画を作る。名前は英小文字・数字・ハイフン（知識と業務の定義から参照するため）。 */
  app.post('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ name?: string; description?: string }>().catch(() => ({} as { name?: string; description?: string }));
    const name = (body.name ?? '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(name)) return c.json({ error: '区画の名前は英小文字・数字・ハイフンで書いてください（例: legal）' }, 400);
    if ((await deps.repo.listCompartmentAssignments(tenant.id)).some((x) => x.name === name)) {
      return c.json({ error: `区画「${name}」はすでにあります` }, 409);
    }
    const id = `c-${randomUUID()}`;
    const description = (body.description ?? '').trim().slice(0, 100) || name;
    await deps.repo.createCompartment({ id, tenantId: tenant.id, name, description });
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'compartment.create',
      targetType: 'compartment', targetId: id, detail: { name }, occurredAt: new Date().toISOString(),
    });
    return c.json({ id, name, description, enabled: true, groups: [], users: [] }, 201);
  });

  /**
   * 入れるグループと人を丸ごと置き換える。本文 `{ groups, users }`。
   *
   * @remarks 区画は「全員」を持たない。空にすると誰も入れない（第16.3.2節「既定は区画外」）。
   */
  app.put('/:id/assignment', async (c) => {
    const { tenant, user } = c.get('ctx');
    const id = c.req.param('id');
    const target = (await deps.repo.listCompartmentAssignments(tenant.id)).find((x) => x.id === id);
    if (!target) return c.json({ error: '区画が見つかりません' }, 404);
    const body = await c.req.json<{ groups?: unknown; users?: unknown }>().catch(() => ({} as { groups?: unknown; users?: unknown }));
    const groups = Array.isArray(body.groups) ? [...new Set(body.groups.map(String))] : [];
    const users = Array.isArray(body.users) ? [...new Set(body.users.map(String))] : [];
    const [known, members] = await Promise.all([deps.repo.listGroups(tenant.id), deps.repo.listUsers(tenant.id)]);
    const badGroup = groups.find((g) => !known.some((k) => k.id === g));
    if (badGroup) return c.json({ error: `グループが見つかりません: ${badGroup}` }, 400);
    const badUser = users.find((u) => !members.some((m) => m.id === u));
    if (badUser) return c.json({ error: `利用者が見つかりません: ${badUser}` }, 400);
    const before = await compartmentMembers(deps, tenant.id);
    await deps.repo.setCompartmentAssignment(tenant.id, id, { groups, users }, user.id);
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'compartment.assign',
      targetType: 'compartment', targetId: id, detail: { groups, users }, occurredAt: new Date().toISOString(),
    });
    await reportCompartmentChanges(deps, tenant.id, user.id, before, `区画「${target.description ?? target.name}」の割当の変更`);
    return c.json({ ...target, groups, users });
  });

  /**
   * 区画を使う・使わないを切り替える（仕様書 第16.3.6.1節）。
   *
   * @remarks 無効の間は誰も区画に入れない。区画の知識・業務は誰にも見えない（外す側に倒さない）。
   */
  app.put('/:id/enabled', async (c) => {
    const { tenant, user } = c.get('ctx');
    const id = c.req.param('id');
    const target = (await deps.repo.listCompartmentAssignments(tenant.id)).find((x) => x.id === id);
    if (!target) return c.json({ error: '区画が見つかりません' }, 404);
    const body = await c.req.json<{ enabled?: unknown }>().catch(() => ({} as { enabled?: unknown }));
    const enabled = body.enabled !== false;
    const before = await compartmentMembers(deps, tenant.id);
    await deps.repo.setCompartmentEnabled(tenant.id, id, enabled);
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id,
      action: enabled ? 'compartment.enable' : 'compartment.disable',
      targetType: 'compartment', targetId: id, detail: { name: target.name }, occurredAt: new Date().toISOString(),
    });
    await reportCompartmentChanges(
      deps, tenant.id, user.id, before,
      `区画「${target.description ?? target.name}」を${enabled ? '有効に' : '無効に'}した`,
    );
    return c.json({ ...target, enabled });
  });

  /**
   * 区画を消す（仕様書 第16.3.6.1節）。
   *
   * @remarks その区画に属する知識・業務が残っていれば断り、何が残っているかを示す。
   */
  app.delete('/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const id = c.req.param('id');
    const target = (await deps.repo.listCompartmentAssignments(tenant.id)).find((x) => x.id === id);
    if (!target) return c.json({ error: '区画が見つかりません' }, 404);

    const [knowledge, view] = await Promise.all([
      deps.repo.countKnowledgeInCompartment(tenant.id, target.name),
      deps.tenantView(tenant.id),
    ]);
    const agents = view.allAgents.filter((a) => a.compartment === target.name).map((a) => a.name);
    if (knowledge > 0 || agents.length > 0) {
      const left = [
        knowledge > 0 ? `知識 ${knowledge} 件` : '',
        agents.length > 0 ? `業務 ${agents.length} 件（${agents.join('、')}）` : '',
      ].filter(Boolean).join('、');
      return c.json({
        error: `この区画には ${left} が残っています。先に消すか、区画の外へ移してから削除してください`,
        knowledge, agents,
      }, 409);
    }

    const before = await compartmentMembers(deps, tenant.id);
    await deps.repo.deleteCompartment(tenant.id, id);
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action: 'compartment.delete',
      targetType: 'compartment', targetId: id, detail: { name: target.name }, occurredAt: new Date().toISOString(),
    });
    await reportCompartmentChanges(
      deps, tenant.id, user.id, before, `区画「${target.description ?? target.name}」の削除`,
    );
    return c.json({ ok: true });
  });

  return app;
}

async function audit(deps: AppDeps, tenantId: string, userId: string, action: string, groupId: string, detail: Record<string, unknown>) {
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType: 'group', targetId: groupId,
    detail, occurredAt: new Date().toISOString(),
  });
}
