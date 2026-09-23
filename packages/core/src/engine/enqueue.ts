/**
 * @file ジョブを作り、実行を待ち行列へ入れる。画面・秘書・定時実行・API の共通の入口。
 *
 * @see 仕様書 第8.4節 同期・非同期の境界
 */

import { randomUUID } from 'node:crypto';
import type { AgentDefinition, Job, Run } from '@m2office/shared';
import type { Repository } from '../repository/types.js';

/**
 * ジョブを作り、実行を待ち行列へ入れる。
 *
 * @param repo 永続化層
 * @param p 対象のテナント・依頼者・定義・入力・起動経路
 * @returns 作成したジョブと実行の ID
 *
 * @remarks
 * 画面・秘書・定時実行・API のどこから起動しても、この 1 か所を通す。
 * 実行はワーカーが担い、呼び出し側を待たせない（仕様書 第8.4節）。
 * 監査ログに起動経路を残す（不変則 I-4）。
 */
export async function enqueueJob(
  repo: Repository,
  p: {
    tenantId: string;
    requestedBy: string;
    def: AgentDefinition;
    input: Record<string, unknown>;
    origin: Job['origin'];
    /** 監査ログに残す起動者。定時実行では `scheduler`。 */
    actor: { type: 'user' | 'system'; id: string };
  },
): Promise<{ jobId: string; runId: string }> {
  const now = new Date().toISOString();
  const job: Job = {
    id: randomUUID(), tenantId: p.tenantId, agentId: p.def.id, agentVersion: p.def.version,
    requestedBy: p.requestedBy, origin: p.origin, input: p.input, createdAt: now,
  };
  const run: Run = {
    id: randomUUID(), jobId: job.id, tenantId: p.tenantId, status: 'queued', cursor: 0,
    startedAt: now, endedAt: null, tokensUsed: 0, costJpy: 0, savedMinutes: 0, failureReason: null,
  };
  await repo.createJob(job);
  await repo.createRun(run);
  await repo.appendAudit({
    id: randomUUID(), tenantId: p.tenantId, actorType: p.actor.type, actorId: p.actor.id,
    action: 'job.create', targetType: 'job', targetId: job.id,
    detail: { agentId: p.def.id, runId: run.id, origin: job.origin, requestedBy: p.requestedBy },
    occurredAt: now,
  });
  return { jobId: job.id, runId: run.id };
}
