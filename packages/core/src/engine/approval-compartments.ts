/**
 * @file 権限区画を持つ前に作った承認に、業務の定義から区画を埋める（仕様書 第9.2.3節・第16.3.6節。第 0.366.0 版、移行 138）。
 *
 * 承認は作ったときに業務の区画を持つ。移行 138 より前の承認は区画が `null` のままなので、ワーカーが起動のたびに
 * 残っているものだけを埋める（埋め終われば何もしない）。定義が見つからない業務（削除した業務）は、区画に属さない業務として扱わず、
 * 埋めずに残す（判断のときは実行エンジンが定義を引き直し、見つからなければ判断させない側に倒す）。
 */

import type { AgentDefinition } from '@m2office/shared';
import type { Repository } from '../repository/types.js';

/** 1 回に埋める数（会社ごと）。 */
const BATCH = 200;

/**
 * 区画をまだ持たない承認に、業務の定義の区画を埋める。
 *
 * @returns 埋めた数
 *
 * @remarks テナント境界: 会社ごとに、その会社の承認と業務の定義だけを読む（不変則 I-2）
 */
export async function fillApprovalCompartments(
  repo: Repository,
  resolveDefinition: (id: string, version: number, tenantId: string) => Promise<AgentDefinition | null | undefined>,
): Promise<number> {
  let filled = 0;
  for (const tenantId of await repo.listTenantIds()) {
    // 定義が見つからず埋めなかったものを読み直さないよう、ID の順に続きから読む
    let after = '';
    for (;;) {
      const rows = await repo.listApprovalsWithoutCompartment(tenantId, after, BATCH);
      if (rows.length === 0) break;
      for (const r of rows) {
        after = r.id;
        const def = await resolveDefinition(r.agentId, r.agentVersion, tenantId).catch(() => null);
        if (!def) continue;
        await repo.setApprovalCompartment(tenantId, r.id, def.compartment ?? '');
        filled++;
      }
    }
  }
  return filled;
}
