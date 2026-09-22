/**
 * @file 定時実行の設定の API。作成・停止と再開・規則の変更・今すぐ実行。
 *
 * @see 仕様書 第9.5.5節 AG-05 週次ブリーフ
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { Schedule, ScheduleRule } from '@m2office/shared';
import { describeRule, nextRunAt, validateRule } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

/**
 * 定時実行の設定（FR-311）。
 *
 * @remarks
 * 利用者は自分の定時実行だけを作成・変更できる。実行は本人の権限で行われる。
 * 管理者はテナント全体の一覧を見られるが、他人の分を作ることはしない
 * （本人の権限で動くものを他人が勝手に仕掛けられないようにするため）。
 */
export function schedulesRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    const all = c.req.query('scope') === 'tenant' && user.roles.includes('admin');
    const items = await deps.repo.listSchedules(tenant.id, all ? null : user.id);
    return c.json({ items: items.map((s) => ({ ...s, label: describeRule(s.rule) })) });
  });

  app.post('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{
      agentId: string; agentVersion?: number; input?: Record<string, unknown>;
      rule: ScheduleRule; timezone?: string;
    }>();
    const view = await deps.tenantView(tenant.id);
    const def = view.resolve(body.agentId, body.agentVersion ?? 1);
    if (!def || !(await deps.canUse(tenant.id, user.id, def.id))) {
      return c.json({ error: `エージェントが見つかりません: ${body.agentId}` }, 404);
    }
    try {
      validateRule(body.rule);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    // 既定は本人の個人設定のタイムゾーン（仕様書 第6.5.1節）
    const timezone = body.timezone ?? (await deps.repo.getUserSettings(tenant.id, user.id)).profile.timezone;
    const now = new Date();
    const schedule: Schedule = {
      id: randomUUID(), tenantId: tenant.id, userId: user.id, agentId: def.id,
      agentVersion: def.version, input: body.input ?? {}, rule: body.rule, timezone,
      enabled: true, nextRunAt: nextRunAt(body.rule, timezone, now), lastRunAt: null,
      createdBy: user.id, createdAt: now.toISOString(),
    };
    await deps.repo.createSchedule(schedule);
    await audit(deps, tenant.id, user.id, 'schedule.create', schedule.id, { agentId: def.id, rule: body.rule });
    return c.json({ ...schedule, label: describeRule(schedule.rule) }, 201);
  });

  app.patch('/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const current = await deps.repo.getSchedule(tenant.id, c.req.param('id'));
    if (!current || current.userId !== user.id) return c.json({ error: '定時実行が見つかりません' }, 404);
    const body = await c.req.json<{ enabled?: boolean; rule?: ScheduleRule }>();
    const rule = body.rule ?? current.rule;
    try {
      validateRule(rule);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const next: Schedule = {
      ...current,
      rule,
      enabled: body.enabled ?? current.enabled,
      nextRunAt: body.rule ? nextRunAt(rule, current.timezone, new Date()) : current.nextRunAt,
    };
    await deps.repo.updateSchedule(next);
    await audit(deps, tenant.id, user.id, 'schedule.update', next.id, { enabled: next.enabled, rule });
    return c.json({ ...next, label: describeRule(next.rule) });
  });

  /**
   * 次の回を今すぐにする。ワーカーが次の見回りで起動する。
   *
   * @remarks 設定を変えずに動作を確かめるためのもの。
   */
  app.post('/:id/trigger', async (c) => {
    const { tenant, user } = c.get('ctx');
    const current = await deps.repo.getSchedule(tenant.id, c.req.param('id'));
    if (!current || current.userId !== user.id) return c.json({ error: '定時実行が見つかりません' }, 404);
    await deps.repo.updateSchedule({ ...current, enabled: true, nextRunAt: new Date().toISOString() });
    await audit(deps, tenant.id, user.id, 'schedule.trigger', current.id, {});
    return c.json({ ok: true });
  });

  return app;
}

async function audit(
  deps: AppDeps, tenantId: string, userId: string, action: string, id: string,
  detail: Record<string, unknown>,
) {
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action,
    targetType: 'schedule', targetId: id, detail, occurredAt: new Date().toISOString(),
  });
}
