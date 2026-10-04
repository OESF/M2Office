/**
 * @file 定時実行の起動役。時刻を過ぎた定時実行を見つけ、待ち行列へ入れる。
 *
 * ワーカーの中から定期的に呼ぶ。止まっていた間に過ぎた回はまとめて 1 回だけ起動する。
 *
 * @see 仕様書 第9.5.5節 AG-05 週次ブリーフ
 */

import { randomUUID } from 'node:crypto';
import type { Repository } from '../repository/types.js';
import { enqueueJob } from '../engine/enqueue.js';
import { localDay, nextRunAt } from './rule.js';
import { scheduleBlocker, type ScheduleChecks } from './blocker.js';
import { silentLogger, type Logger } from '../log/logger.js';

/** 起動役の依存。動かない理由の判定に要るもの（{@link ScheduleChecks}）と、アプリログ。 */
export interface SchedulerDeps extends ScheduleChecks {
  /** アプリログ。省略時は何も書かない。 */
  logger?: Logger;
  /**
   * その日（YYYY-MM-DD）が会社の営業日か（第 0.243.0 版）。「会社の営業日」の定時実行は、営業日でない日には動かさない。
   * 無ければ、毎日動かす
   */
  businessDay?(tenantId: string, day: string): Promise<boolean>;
}

/** 接続が無いために定時実行を飛ばしたときの知らせの題名。未読の同じ知らせがあれば重ねて知らせない。 */
export const SCHEDULE_SKIP_TITLE = 'Google と接続していないため、定時実行を飛ばしました';

/** 会社の接続に本人が接続していないために定時実行を飛ばしたときの知らせの題名（仕様書 第12.11.6.3節）。 */
export const SCHEDULE_CONNECTION_TITLE = 'サービスと接続していないため、定時実行を飛ばしました';

/** ツールが止められたために定時実行を飛ばしたときの知らせの題名（仕様書 第6.6.3.1節）。 */
export const SCHEDULE_TOOL_DISABLED_TITLE = '管理者がツールを止めたため、定時実行を飛ばしました';

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

      // 会社の営業日でない日（営業しない曜日・祝日・休業の期間）は動かさない。次の回はもう先に置いてある
      if (due.rule.kind === 'business' && this.deps.businessDay
        && !(await this.deps.businessDay(due.tenantId, localDay(now, due.timezone)).catch(() => true))) continue;

      const { def, block } = await scheduleBlocker(this.deps, due);
      const reason = block?.reason ?? null;
      if (!def || block) {
        (this.deps.logger ?? silentLogger).warn('定時実行を見送りました', {
          scheduleId: due.id, tenantId: due.tenantId, reason,
        });
        await repo.appendAudit({
          id: randomUUID(), tenantId: due.tenantId, actorType: 'system', actorId: 'scheduler',
          action: 'schedule.skip', targetType: 'schedule', targetId: due.id,
          detail: { reason, ...(block?.tool ? { tool: block.tool } : {}) },
          occurredAt: now.toISOString(),
        });
        if (block?.kind === 'google') await this.notifySkipOnce(due.tenantId, due.userId, def?.name ?? due.agentId, now);
        if (block?.kind === 'connection') {
          await this.notifyOnce(due.tenantId, due.userId, SCHEDULE_CONNECTION_TITLE,
            `「${def?.name ?? due.agentId}」の定時実行は、「${block.connection}」との接続が要るため動かせません。`
            + '個人設定の「サービスとの接続」から接続すると、次の回から自動で動きます。', now);
        }
        if (block?.kind === 'tool-disabled') {
          await this.notifyOnce(due.tenantId, due.userId, SCHEDULE_TOOL_DISABLED_TITLE,
            `「${def?.name ?? due.agentId}」の定時実行は、管理者が止めたツール（${block.tool}）を使うため動かせません。`
            + '管理者がツールを戻すと、次の回から自動で動きます。', now);
        }
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

  /** 接続が無いために飛ばしたことを本人に知らせる。未読の同じ知らせがあれば重ねない（「一度だけ」）。 */
  private async notifySkipOnce(tenantId: string, userId: string, agentName: string, now: Date): Promise<void> {
    await this.notifyOnce(tenantId, userId, SCHEDULE_SKIP_TITLE,
      `「${agentName}」などの定時実行は、Google と接続し直すと、次の回から自動で動きます。個人設定の「Google 連携」から接続してください。`,
      now);
  }

  /**
   * 飛ばしたことを本人に一度だけ知らせる。
   *
   * @remarks 同じ題名の未読の知らせがあれば重ねない。毎回の見回りで知らせが積み上がるのを防ぐ。
   */
  private async notifyOnce(
    tenantId: string, userId: string, title: string, body: string, now: Date,
  ): Promise<void> {
    const { repo } = this.deps;
    const recent = await repo.listNotifications(tenantId, userId, 50);
    if (recent.some((n) => n.title === title && !n.readAt)) return;
    await repo.createNotification({
      id: randomUUID(), tenantId, userId, kind: 'failure', title, body,
      runId: null, readAt: null, createdAt: now.toISOString(),
    });
  }
}
