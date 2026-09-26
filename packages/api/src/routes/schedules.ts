/**
 * @file 定時実行の設定の API。登録・編集（繰り返し・時刻・入力）・停止と再開・今すぐ実行・削除。
 *
 * @see 仕様書 第6.1.7節 定時実行の画面
 * @see 仕様書 第9.5.5節 AG-05 週次ブリーフ
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { Schedule, ScheduleRule } from '@m2office/shared';
import {
  describeRule, isSchedulable, missingInputs, nextRunAt, triggeredNow, validateRule, withEnabled,
} from '@m2office/core';
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
    if ((await deps.repo.getTenantSettings(tenant.id)).agents.disabled.includes(def.id)) {
      return c.json({ error: 'この業務は管理者によって無効にされています' }, 403);
    }
    // ファイルを受け取る業務と秘書の調べものは登録できない（仕様書 第6.1.7節）
    if (!isSchedulable(def)) return c.json({ error: 'この業務は定時実行に登録できません（毎回ファイルや依頼を渡す業務のため）' }, 400);
    const missing = missingInputs(def, body.input ?? {});
    if (missing.length > 0) return c.json({ error: `必須の欄が空です: ${missing.join('、')}` }, 400);
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

  /**
   * 繰り返し・時刻・入力・有効かどうかを変える（仕様書 第6.1.7節）。業務は変えない。
   *
   * @remarks
   * 繰り返しか時刻を変えたら、次回の時刻を求め直す。再開したときも今から求め直し、止めていた間の回は起動しない。
   */
  app.patch('/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const current = await deps.repo.getSchedule(tenant.id, c.req.param('id'));
    if (!current || current.userId !== user.id) return c.json({ error: '定時実行が見つかりません' }, 404);
    const body = await c.req.json<{ enabled?: boolean; rule?: ScheduleRule; input?: Record<string, unknown> }>();
    const rule = body.rule ?? current.rule;
    try {
      validateRule(rule);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    if (body.input !== undefined) {
      const def = (await deps.tenantView(tenant.id)).resolve(current.agentId, current.agentVersion);
      const missing = def ? missingInputs(def, body.input) : [];
      if (missing.length > 0) return c.json({ error: `必須の欄が空です: ${missing.join('、')}` }, 400);
    }
    const now = new Date();
    const edited: Schedule = {
      ...current,
      rule,
      input: body.input ?? current.input,
      nextRunAt: body.rule ? nextRunAt(rule, current.timezone, now) : current.nextRunAt,
    };
    const next = body.enabled === undefined ? edited : withEnabled(edited, body.enabled, now);
    await deps.repo.updateSchedule(next);
    await audit(deps, tenant.id, user.id, 'schedule.update', next.id, { enabled: next.enabled, rule, inputChanged: body.input !== undefined });
    return c.json({ ...next, label: describeRule(next.rule) });
  });

  /**
   * 消す（仕様書 第6.1.7節）。確かめの画面は出さない（社外にもお金にも関わらない。ADR-0028）。
   *
   * @remarks 動いている実行は止めない。
   */
  app.delete('/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const current = await deps.repo.getSchedule(tenant.id, c.req.param('id'));
    if (!current || current.userId !== user.id) return c.json({ error: '定時実行が見つかりません' }, 404);
    await deps.repo.deleteSchedule(tenant.id, current.id);
    await audit(deps, tenant.id, user.id, 'schedule.delete', current.id, { agentId: current.agentId });
    return c.json({ ok: true });
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
    await deps.repo.updateSchedule(triggeredNow(current));
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
