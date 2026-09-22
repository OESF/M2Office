/**
 * @file 定時実行の起動役。時刻を過ぎた定時実行を見つけ、待ち行列へ入れる。
 *
 * ワーカーの中から定期的に呼ぶ。止まっていた間に過ぎた回はまとめて 1 回だけ起動する。
 *
 * @see 仕様書 第9.5.5節 AG-05 週次ブリーフ
 */

import { randomUUID } from 'node:crypto';
import { canUseAgent, type AgentDefinition } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import { enqueueJob } from '../engine/enqueue.js';
import { nextRunAt } from './rule.js';
import { silentLogger, type Logger } from '../log/logger.js';

export interface SchedulerDeps {
  repo: Repository;
  /** エージェント定義を解決する。自社専用の拡張機能はその会社でしか解決できない（仕様書 第12.10.3節）。 */
  resolveDefinition(
    agentId: string, version: number, tenantId: string,
  ): AgentDefinition | undefined | Promise<AgentDefinition | undefined>;
  /** アプリログ。省略時は何も書かない。 */
  logger?: Logger;
  /** その会社で業務エージェントを使えるか（拡張機能を導入しているか）。 */
  isAvailable?(tenantId: string, agentId: string): Promise<boolean>;
}

/**
 * 定時実行の起動役。ワーカーの中で定期的に呼ぶ。
 *
 * 実行時刻を過ぎた定時実行を見つけ、通常と同じ待ち行列へ入れる。
 * 実行そのものは行わない。起動の経路が違うだけで、以降は画面からの依頼と同じ扱いになる。
 *
 * @remarks
 * - 対象者の権限で実行する。停止された利用者と、無効にされた業務の定時実行は起動しない
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

      const def = await this.deps.resolveDefinition(due.agentId, due.agentVersion, due.tenantId);
      const user = await repo.findUserById(due.tenantId, due.userId);
      const settings = await repo.getTenantSettings(due.tenantId);
      const reason = !def ? '定義が見つかりません'
        : !user || user.status !== 'active' ? '対象者が利用できません'
        : settings.agents.disabled.includes(def.id) ? '管理者がこの業務を無効にしています'
        : this.deps.isAvailable && !(await this.deps.isAvailable(due.tenantId, def.id)) ? 'この業務の拡張機能が導入されていません'
        // 利用範囲から外れた人の定時実行は起動しない（仕様書 第16.7.4節）
        : !canUseAgent(settings.access, def.id, due.userId, await repo.listUserGroupIds(due.tenantId, due.userId))
          ? '対象者がこの業務の利用範囲の外です'
        : def.compartment && !(await repo.listUserCompartments(due.tenantId, due.userId)).includes(def.compartment)
          ? '対象者がこの業務の権限区画に割り当てられていません'
        : null;
      if (!def || reason) {
        (this.deps.logger ?? silentLogger).warn('定時実行を見送りました', {
          scheduleId: due.id, tenantId: due.tenantId, reason,
        });
        await repo.appendAudit({
          id: randomUUID(), tenantId: due.tenantId, actorType: 'system', actorId: 'scheduler',
          action: 'schedule.skip', targetType: 'schedule', targetId: due.id,
          detail: { reason },
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
