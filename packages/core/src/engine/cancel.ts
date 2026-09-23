/**
 * @file 実行を途中で止める（中止）。
 *
 * 止め方は 1 つにまとめてある。依頼した本人が止める場合（仕様書 第9.3.1節）と、
 * Google の許可がなくなって止める場合（第6.5.2.1節）で、後始末を変えないためである。
 *
 * ここで行うのは状態の書き換えまでで、動いているワーカーを割り込んで止めることはしない。
 * エンジンが手順の区切りで状態を読み直し、止められていれば続きを行わない（`RunEngine`）。
 *
 * @see 仕様書 第9.3.1節 実行の中止
 */

import { randomUUID } from 'node:crypto';
import { canDecide, type Job, type Run } from '@m2office/shared';
import type { Repository } from '../repository/types.js';

/** 動いている途中とみなす状態。これ以外は止められない。 */
export const CANCELLABLE = new Set<Run['status']>(['queued', 'running', 'awaiting_approval']);

/** 止めた人。監査ログの `actor` に記録する。 */
export interface CancelActor {
  actorType: 'user' | 'system';
  actorId: string;
}

/** 止めた結果。 */
export interface CancelOutcome {
  /** 止められたか。すでに終わっていれば `false`。 */
  stopped: boolean;
  /** 承認トレイから外した承認を判断できた人。知らせる相手に使う。 */
  approvers: string[];
}

/**
 * 実行を 1 つ止める。
 *
 * @param reason 止めた理由。実行の `failureReason` と、知らせる文に使う
 * @param actor 止めた人（監査ログに残す）
 * @param detail 監査ログに添える中身
 *
 * @returns 止められたかと、知らせるべき承認者
 *
 * @remarks
 * テナント境界: `job.tenantId` の範囲だけを扱う（不変則 I-2）。
 *
 * 承認待ちの承認は承認トレイから外し、判断できた人を返す。
 * 呼び出し側が、その人たちに「判断しなくてよくなった」ことを知らせる。
 *
 * **止めるまでの間に終わっていれば、何もしない。** 終わった実行の状態は書き換えない。
 */
export async function cancelRun(
  repo: Repository,
  job: Job,
  run: Run,
  reason: string,
  actor: CancelActor,
  detail: Record<string, unknown> = {},
  now: Date = new Date(),
): Promise<CancelOutcome> {
  const tenantId = job.tenantId;
  const at = now.toISOString();
  // 止めるまでの間に終わっていることがある。状態は必ず読み直してから書き換える
  const latest = await repo.getRun(tenantId, run.id);
  if (!latest || !CANCELLABLE.has(latest.status)) return { stopped: false, approvers: [] };

  await repo.updateRun({ ...latest, status: 'cancelled', endedAt: at, failureReason: reason });

  // 承認を待っていたステップを「中止」にする。承認待ちのままに見えると、判断が要ると誤解される
  for (const step of await repo.listRunSteps(tenantId, latest.id)) {
    if (step.status !== 'awaiting' && step.status !== 'running') continue;
    await repo.updateRunStep(tenantId, { ...step, status: 'cancelled', endedAt: at });
  }

  const users = await repo.listUsers(tenantId);
  const approvers = new Set<string>();
  for (const a of await repo.listRunApprovals(tenantId, latest.id)) {
    if (a.decision) continue;
    await repo.updateApproval({ ...a, decision: 'cancelled', decidedAt: at, comment: reason });
    // 止めた本人には知らせない。自分で止めたことは分かっている
    for (const u of users) {
      if (u.id !== actor.actorId && u.status === 'active' && canDecide(a, u)) approvers.add(u.id);
    }
  }

  await repo.appendAudit({
    id: randomUUID(), tenantId, actorType: actor.actorType, actorId: actor.actorId,
    action: 'run.cancel', targetType: 'run', targetId: latest.id,
    detail: { agentId: job.agentId, ...detail }, occurredAt: at,
  });

  return { stopped: true, approvers: [...approvers] };
}

/**
 * 実行の途中で作られた Google 側のファイルのリンク（最大 3）。
 *
 * @remarks
 * 中止は、すでに起きたことを取り消さない（仕様書 第9.3.1節）。
 * 作りかけの文書がドライブに残っていることを本人に示すために使う。
 */
export async function createdDriveLinks(
  repo: Repository, tenantId: string, runId: string,
): Promise<string[]> {
  const links: string[] = [];
  for (const s of await repo.listRunSteps(tenantId, runId)) {
    const tools = (s.output as { tools?: { result?: { url?: unknown } }[] } | null)?.tools ?? [];
    for (const t of tools) {
      const url = t.result?.url;
      if (typeof url === 'string' && /^https:\/\/(docs|drive)\.google\.com\//.test(url) && links.length < 3) {
        links.push(url);
      }
    }
  }
  return links;
}
