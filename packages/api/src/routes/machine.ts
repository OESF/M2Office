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
  holdUpdates, machineDir,
  appPath, backupConfigFromEnv, machineConfigFromEnv, machineStatus, requestBackup, runtimeEnvironment, sampleDays, inferenceText, localLlmFromEnv,
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
   * 動いている環境（第8.6.7.1節）。M2Office の版・API とワーカーの Node.js（段階とサポートの終わり）・PostgreSQL・OS と CPU・
   * メモリー・動いている形・推論・起動してからの時間。クラウドの形では 404（運営の画面の「稼働状況」に出す）。
   *
   * @remarks 外へは見に行かない。秘密の値・業務の中身・個人の情報は返さない。取れなかった値は `null`
   */
  app.get('/runtime', async (c) => {
    if (deps.ai.deployment() !== 'onsite') return c.json({ error: 'ローカルの形だけで使えます' }, 404);
    const [beats, postgres, database] = await Promise.all([
      deps.runtime.store.read().catch(() => []), deps.runtime.store.postgresVersion().catch(() => null), deps.runtime.store.database().catch(() => null),
    ]);
    return c.json(runtimeEnvironment(beats, postgres, { deployment: 'onsite', debug: !!deps.debug, inference: inferenceText(localLlmFromEnv(process.env), 'onsite'), database }));
  });

  /**
   * 機械の資源の推移（第23.8.7節「機械の資源の図」）。`?days=1`（既定。5 分ごと）か `?days=7`（30 分ごと）。クラウドの形では 404。
   *
   * @remarks 使っている割合（%）だけを返す。秘密の値・業務の中身・個人の情報は返さない
   */
  app.get('/runtime/samples', async (c) => {
    if (deps.ai.deployment() !== 'onsite') return c.json({ error: 'ローカルの形だけで使えます' }, 404);
    return c.json({ samples: await deps.runtime.store.samples(sampleDays(c.req.query('days'))) });
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
