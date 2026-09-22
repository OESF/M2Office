import { randomUUID } from 'node:crypto';
import type { AgentDefinition } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import { enqueueJob } from '../engine/enqueue.js';
import { nextRunAt } from './rule.js';

export interface SchedulerDeps {
  repo: Repository;
  resolveDefinition(agentId: string, version: number): AgentDefinition | undefined;
}

/**
 * 定時実行の起動役。ワーカーの中で定期的に呼ぶ。
 *
 * 実行時刻を過ぎた定時実行を見つけ、通常と同じ待ち行列へ入れる。
 * 実行そのものは行わない。起動の経路が違うだけで、以降は画面からの依頼と同じ扱いになる。
 *
 * @remarks
 * - 対象者の権限で実行する。停止された利用者の定時実行は起動しない
 * - ワーカーが止まっていた間に過ぎた回は、**まとめて 1 回だけ**起動する。
 *   週次ブリーフが 3 通届くような事態を避けるため
 *
 * @see 仕様書 第9.5.5節 AG-05 週次ブリーフ
 */
export class Scheduler {
  constructor(private readonly deps: SchedulerDeps) {}

  /**
   * 実行時刻を過ぎたものをすべて起動する。
   *
   * @param now 現在時刻
   * @returns 起動した実行の ID
   */
  async tick(now: Date = new Date()): Promise<string[]> {
    const { repo } = this.deps;
    const started: string[] = [];
    for (;;) {
      // 次回は「今」より後に置く。止まっていた間の回は飛ばす
      const due = await repo.claimDueSchedule(now, (s) => nextRunAt(s.rule, s.timezone, now));
      if (!due) break;

      const def = this.deps.resolveDefinition(due.agentId, due.agentVersion);
      const user = await repo.findUserById(due.tenantId, due.userId);
      if (!def || !user || user.status !== 'active') {
        await repo.appendAudit({
          id: randomUUID(), tenantId: due.tenantId, actorType: 'system', actorId: 'scheduler',
          action: 'schedule.skip', targetType: 'schedule', targetId: due.id,
          detail: { reason: !def ? '定義が見つかりません' : '対象者が利用できません' },
          occurredAt: now.toISOString(),
        });
        continue;
      }

      const { runId } = await enqueueJob(repo, {
        tenantId: due.tenantId, requestedBy: due.userId, def, input: due.input,
        origin: 'schedule', actor: { type: 'system', id: 'scheduler' },
      });
      started.push(runId);
    }
    return started;
  }
}
