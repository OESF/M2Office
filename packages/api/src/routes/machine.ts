/**
 * @file ローカルの形の「機械」の API（仕様書 第8.6.7節）。版と更新・遠隔の保守・稼働の知らせ・控え・システムログと証拠保全。
 *
 * 会社の管理者は `/v1/admin/machine` から、機械の管理者（第8.6.3節）は `/v1/machine-admin` から、同じ口を使う。
 * どちらも呼び出し側で誰かを確かめてから置く。業務のデータは返さない。
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  readMaintenanceStatus, requestMaintenance, frontDir, setHeartbeatOff, MAINTENANCE_DEFAULT_HOURS, MAINTENANCE_MAX_HOURS, holdUpdates, machineDir,
  appPath, backupConfigFromEnv, machineConfigFromEnv, machineStatus, requestBackup,
} from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';
import { systemLogsRoute } from './system-logs.js';

/**
 * ローカルの形の「機械」の API（仕様書 第8.6.7節）。クラウドの形では 404。
 *
 * @remarks 誰が呼べるかは置く側で決める（会社の管理者のロール、または機械の管理者のログイン状態）。操作は監査ログに残す
 */
export function machineRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  /**
   * ローカルの形の「機械」の様子（仕様書 第8.6.7節）。版・各部の動き・ディスク・証明書・ローカル AI・控え。クラウドの形では 404。
   *
   * @remarks 業務のデータは返さない
   */
  app.get('/', async (c) => {
    if (deps.ai.deployment() !== 'onsite') return c.json({ error: 'ローカルの形だけで使えます' }, 404);
    const version = (() => { try { return (JSON.parse(readFileSync(appPath('package.json'), 'utf8')) as { version?: string }).version ?? '0'; } catch { return '0'; } })();
    return c.json(await machineStatus(machineConfigFromEnv(process.env, version)));
  });

  /**
   * 夜の自動の更新を止める（延ばす）か、止めるのをやめる（第8.6.4節）。本文 `days`（1〜30）、`null` で止めるのをやめる。
   *
   * @remarks 更新そのものは機械の上の update.sh が行い、この印を見て飛ばす。M2Office のプロセスから更新は始めない
   */
  app.put('/update-hold', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (deps.ai.deployment() !== 'onsite') return c.json({ error: 'ローカルの形だけで使えます' }, 404);
    const b = await c.req.json<{ days?: unknown }>().catch(() => ({} as { days?: unknown }));
    const days = b.days === null ? null : Number(b.days);
    if (days !== null && !(days >= 1 && days <= 30)) return c.json({ error: '延ばす日数は 1〜30 日にしてください' }, 400);
    const until = await holdUpdates(machineDir(process.env), days, user.id);
    await audit(deps, tenant.id, user.id, until ? 'machine.update_hold' : 'machine.update_resume', 'machine', 'update', { until });
    return c.json({ heldUntil: until });
  });

  /**
   * 遠隔の保守を開ける（本文 `hours`。1〜24 時間）か、閉じる（`null`）（第8.6.4節）。会社の管理者だけ。運営は自分で開けられない。
   * 同じ機械の M2Medical が遠隔の保守を持つときは 409（第8.6.9節）。
   *
   * @remarks トンネルの開け閉めは機械の上の maintenance.sh が行う。ここは印を書くだけ
   */
  app.put('/maintenance', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (deps.ai.deployment() !== 'onsite') return c.json({ error: 'ローカルの形だけで使えます' }, 404);
    const dir = machineDir(process.env);
    const st = await readMaintenanceStatus(dir, new Date(), frontDir(process.env));
    // 同じ機械の M2Medical が持つときは、その管理者だけが開ける（第8.6.9節）
    if (st.managedBy) return c.json({ error: `この機械の遠隔の保守は ${st.managedBy} の管理者が開けます` }, 409);
    if (!st.configured) return c.json({ error: '遠隔の保守は入れていません（導入のときに入れます）' }, 400);
    const b = await c.req.json<{ hours?: unknown }>().catch(() => ({} as { hours?: unknown }));
    const hours = b.hours === null ? null : Number(b.hours ?? MAINTENANCE_DEFAULT_HOURS);
    if (hours !== null && !(hours >= 1 && hours <= MAINTENANCE_MAX_HOURS)) return c.json({ error: `開けておく時間は 1〜${MAINTENANCE_MAX_HOURS} 時間にしてください` }, 400);
    const until = await requestMaintenance(dir, hours, user.id);
    await audit(deps, tenant.id, user.id, until ? 'machine.maintenance_open' : 'machine.maintenance_close', 'machine', 'maintenance', { until });
    return c.json({ until });
  });

  /** 運営への稼働の知らせを切る（本文 `on: false`）か、入れる（`on: true`）（第8.6.8節）。 */
  app.put('/heartbeat', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (deps.ai.deployment() !== 'onsite') return c.json({ error: 'ローカルの形だけで使えます' }, 404);
    const b = await c.req.json<{ on?: unknown }>().catch(() => ({} as { on?: unknown }));
    if (typeof b.on !== 'boolean') return c.json({ error: 'on を指定してください' }, 400);
    await setHeartbeatOff(machineDir(process.env), !b.on, user.id);
    await audit(deps, tenant.id, user.id, b.on ? 'machine.heartbeat_on' : 'machine.heartbeat_off', 'machine', 'heartbeat', {});
    return c.json({ on: b.on });
  });

  // システムログと証拠保全（ローカルの形だけ。第16.10.4節・第16.10.5節）
  app.route('/', systemLogsRoute(deps));

  /** 今すぐ控えを取る（ワーカーが次の見回りで取る。第8.6.5節）。控えの置き場が無ければ 400。 */
  app.post('/backup', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (deps.ai.deployment() !== 'onsite') return c.json({ error: 'ローカルの形だけで使えます' }, 404);
    const cfg = backupConfigFromEnv(process.env);
    if (!cfg) return c.json({ error: '控えの置き場が設定されていません（M2O_BACKUP_DIR）' }, 400);
    await requestBackup(cfg.dir, user.id);
    await audit(deps, tenant.id, user.id, 'machine.backup_request', 'machine', 'backup', {});
    return c.json({ ok: true }, 202);
  });

  return app;
}

async function audit(deps: AppDeps, tenantId: string, userId: string, action: string, targetType: string, targetId: string, detail: Record<string, unknown>) {
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType, targetId, detail, occurredAt: new Date().toISOString(),
  });
}
