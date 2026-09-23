/**
 * @file Google の許可がなくなったとき（本人の取り消し、OAuth クライアントの削除、利用者の停止）の後始末。
 *
 * Google のツールを使う業務のうち、待ち行列・実行中・承認待ちのものを止めて「中止」にし、
 * 承認待ちの承認を承認トレイから外し、依頼した本人と承認する人に知らせる。
 * ほかの人のトークンや見本の接続口で代わりに動かすことはしない（不変則 I-9）。
 *
 * @see 仕様書 第6.5.2.1節 許可がなくなったときの業務の扱い（Q-54）
 */

import { randomUUID } from 'node:crypto';
import type { AgentDefinition, Job, Run } from '@m2office/shared';
import { CANCELLABLE, cancelRun, createdDriveLinks } from '../engine/cancel.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Repository } from '../repository/types.js';
import type { Logger } from '../log/logger.js';

/** 止めた理由。知らせる文と、実行の失敗の理由に使う。 */
export type RevocationCause = 'disconnect' | 'client-removed' | 'user-suspended';

const REASON: Record<RevocationCause, string> = {
  disconnect: 'Google との連携を解除したため止めました',
  'client-removed': '会社の Google Workspace の接続の設定が削除されたため止めました',
  'user-suspended': '依頼した人の利用が停止されたため止めました',
};

/**
 * 業務が Google のツールを使うか。定義のツールに、権限（`google`）を宣言したものがあれば使う（仕様書 第9.4.4節）。
 */
export function agentUsesGoogle(def: Pick<AgentDefinition, 'tools'>, registry: ToolRegistry): boolean {
  return def.tools.some((name) => !!registry.get(name)?.google);
}


export interface GoogleRevocationDeps {
  repo: Repository;
  /** その依頼の業務が Google のツールを使うか（定義のツールに、権限 `google` を宣言したものがあるか）。 */
  usesGoogle(tenantId: string, agentId: string, agentVersion: number): Promise<boolean>;
  logger: Logger;
}

/** 取り消しで影響を受けるもの（取り消す前の確認に示す）。 */
export interface RevocationImpact {
  /** 止まる業務（待ち行列・実行中・承認待ち）。 */
  runs: { runId: string; agentId: string; status: string }[];
  /** 許可がない間は起動を飛ばす定時実行の数。 */
  schedules: number;
}

/**
 * 許可がなくなったときの後始末の役。
 *
 * @remarks テナント境界: 会社と利用者を指定して、その範囲だけを扱う（不変則 I-2）。
 */
export class GoogleRevocation {
  constructor(private readonly deps: GoogleRevocationDeps) {}

  /** その人の、Google のツールを使う動いている途中の業務と、定時実行の数を返す。 */
  async impact(tenantId: string, userId: string): Promise<RevocationImpact> {
    const runs = await this.activeGoogleRuns(tenantId, userId);
    let schedules = 0;
    for (const s of await this.deps.repo.listSchedules(tenantId, userId)) {
      if (s.enabled && (await this.deps.usesGoogle(tenantId, s.agentId, s.agentVersion))) schedules++;
    }
    return { runs: runs.map(({ run, job }) => ({ runId: run.id, agentId: job.agentId, status: run.status })), schedules };
  }

  /**
   * その人の、Google のツールを使う動いている途中の業務を止める。
   *
   * @returns 止めた実行の ID
   * @remarks
   * 実行中の業務は、ここで「中止」にしておき、エンジンが手順の区切りで気づいて続きを行わない（`RunEngine` の `onCancelled`）。
   * 呼び出し中の Google の操作は途中では切れない。
   */
  async stopUserRuns(tenantId: string, userId: string, cause: RevocationCause, now: Date): Promise<string[]> {
    const { repo } = this.deps;
    const at = now.toISOString();
    const reason = REASON[cause];
    const stopped: string[] = [];
    for (const { run, job } of await this.activeGoogleRuns(tenantId, userId)) {
      // 止め方は本人が止めるときと同じ（第9.3.1節）。知らせる文だけが違う
      const result = await cancelRun(
        repo, job, run, reason,
        { actorType: 'system', actorId: 'revocation' },
        { cause }, now,
      );
      if (!result.stopped) continue;
      const approvers = result.approvers.filter((id) => id !== job.requestedBy);

      const links = await createdDriveLinks(repo, tenantId, run.id);
      const leftover = links.length > 0 ? `\n作りかけの文書がドライブに残っています: ${links.join(' ')}` : '';
      await repo.createNotification({
        id: randomUUID(), tenantId, userId: job.requestedBy, kind: 'failure',
        title: '業務を止めました', body: `${reason}。必要なら、接続し直してから、もう一度依頼してください。${leftover}`,
        runId: run.id, readAt: null, createdAt: at,
      });
      for (const id of approvers) {
        await repo.createNotification({
          id: randomUUID(), tenantId, userId: id, kind: 'approval',
          title: '承認待ちの業務が止まりました', body: `${reason}。この承認は判断しなくてよくなりました。`,
          runId: run.id, readAt: null, createdAt: at,
        });
      }
      stopped.push(run.id);
    }
    if (stopped.length > 0) this.deps.logger.info('許可がなくなったため業務を止めました', { tenantId, userId, cause, runs: stopped.length });
    return stopped;
  }

  /** その人の、Google のツールを使う動いている途中の業務。 */
  private async activeGoogleRuns(tenantId: string, userId: string): Promise<{ run: Run; job: Job }[]> {
    const live = await this.deps.repo.listLiveRuns(tenantId, new Date().toISOString());
    const out: { run: Run; job: Job }[] = [];
    for (const r of live) {
      if (r.job.requestedBy !== userId || !CANCELLABLE.has(r.run.status)) continue;
      if (await this.deps.usesGoogle(tenantId, r.job.agentId, r.job.agentVersion)) out.push(r);
    }
    return out;
  }

}
