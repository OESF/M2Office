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
  /**
   * 業務が Google のツールを使うのに、対象者が Google と接続していないか（仕様書 第6.5.2.1節）。
   *
   * @remarks 見本の接続口で動かしている間は、接続が無くても動くため、常に `false` を返す。
   */
  missingGoogleConnection?(tenantId: string, userId: string, def: AgentDefinition): Promise<boolean>;
  /**
   * 管理者が止めたコネクタのツールのうち、その業務が使うもの（仕様書 第6.6.3.1節）。
   *
   * @returns 止まっているツールの名前。無ければ `null`
   */
  disabledToolOf?(tenantId: string, def: AgentDefinition): Promise<string | null>;
  /**
   * 業務が使う、利用者ごとに許可する会社の接続のうち、対象者がまだ接続していないもの（仕様書 第12.11.6.3節）。
   *
   * @returns 接続の名前。無ければ `null`
   */
  missingConnection?(tenantId: string, userId: string, def: AgentDefinition): Promise<string | null>;
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

      const def = await this.deps.resolveDefinition(due.agentId, due.agentVersion, due.tenantId);
      const user = await repo.findUserById(due.tenantId, due.userId);
      const settings = await repo.getTenantSettings(due.tenantId);
      let disabledTool: string | null = null;
      let missing: string | null = null;
      const reason = !def ? '定義が見つかりません'
        : !user || user.status !== 'active' ? '対象者が利用できません'
        : settings.agents.disabled.includes(def.id) ? '管理者がこの業務を無効にしています'
        // 管理者が止めたツールを使う業務は動かせない（仕様書 第6.6.3.1節）。拡張機能の未導入より先に見る
        : (disabledTool = this.deps.disabledToolOf ? await this.deps.disabledToolOf(due.tenantId, def) : null)
          ? TOOL_DISABLED
        : this.deps.isAvailable && !(await this.deps.isAvailable(due.tenantId, def.id)) ? 'この業務の拡張機能が導入されていません'
        // 利用範囲から外れた人の定時実行は起動しない（仕様書 第16.7.4節）
        : !canUseAgent(settings.access, def.id, due.userId, await repo.listUserGroupIds(due.tenantId, due.userId))
          ? '対象者がこの業務の利用範囲の外です'
        : def.compartment && !(await repo.listUserCompartments(due.tenantId, due.userId)).includes(def.compartment)
          ? '対象者がこの業務の権限区画に割り当てられていません'
        // 許可がない間は飛ばす。設定は残し、接続し直せば次から起動する（仕様書 第6.5.2.1節）
        : this.deps.missingGoogleConnection && (await this.deps.missingGoogleConnection(due.tenantId, due.userId, def))
          ? GOOGLE_MISSING
        // 会社の接続も同じ。接続するまで飛ばす（第12.11.6.3節）
        : (missing = this.deps.missingConnection ? await this.deps.missingConnection(due.tenantId, due.userId, def) : null)
          ? CONNECTION_MISSING
        : null;
      if (!def || reason) {
        (this.deps.logger ?? silentLogger).warn('定時実行を見送りました', {
          scheduleId: due.id, tenantId: due.tenantId, reason,
        });
        await repo.appendAudit({
          id: randomUUID(), tenantId: due.tenantId, actorType: 'system', actorId: 'scheduler',
          action: 'schedule.skip', targetType: 'schedule', targetId: due.id,
          detail: { reason, ...(disabledTool ? { tool: disabledTool } : {}) },
          occurredAt: now.toISOString(),
        });
        if (reason === GOOGLE_MISSING) await this.notifySkipOnce(due.tenantId, due.userId, def?.name ?? due.agentId, now);
        if (reason === CONNECTION_MISSING) {
          await this.notifyOnce(due.tenantId, due.userId, SCHEDULE_CONNECTION_TITLE,
            `「${def?.name ?? due.agentId}」の定時実行は、「${missing}」との接続が要るため動かせません。`
            + '個人設定の「サービスとの接続」から接続すると、次の回から自動で動きます。', now);
        }
        if (reason === TOOL_DISABLED) {
          await this.notifyOnce(due.tenantId, due.userId, SCHEDULE_TOOL_DISABLED_TITLE,
            `「${def?.name ?? due.agentId}」の定時実行は、管理者が止めたツール（${disabledTool}）を使うため動かせません。`
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

/** ツールが止められているために飛ばしたことを表す理由。 */
const TOOL_DISABLED = '管理者がこの業務の使うツールを止めています';

const GOOGLE_MISSING = '対象者が Google と接続していません';
const CONNECTION_MISSING = '対象者が業務の使うサービスと接続していません';
