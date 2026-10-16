/**
 * @file 採用支援（AG-16）の応募書類と結果を、保持期間を過ぎたら消す（仕様書 第9.6.6節、Q-239、ADR-0103）。
 *
 * 不採用の人の書類を長く持たないため、実行の始まりから 6 か月で、実行の中身（ステップの入出力・成果物・依頼の入力）と、
 * 扱ったファイル（業務が作ったもの・入力に渡した応募書類）を消す。実行の記録（いつ・誰が・何の業務を）は残す。
 * 採用した人は、それまでに人事の台帳（第30章）に移す。
 */

import { randomUUID } from 'node:crypto';
import type { Repository } from '../repository/types.js';
import type { FileStore } from '../files/store.js';

/** 応募書類と結果を持つ長さ（ミリ秒。6 か月）。 */
export const RECRUITING_KEEP_MS = 183 * 86_400_000;
/** 採用支援の業務の ID。 */
const RECRUITING_AGENT_ID = 'recruiting';

/** 入力に渡したファイルの ID（`f-…`。「,」で区切ったものも）。 */
function inputFileIds(input: Record<string, unknown>): string[] {
  return Object.values(input).flatMap((v) => (typeof v === 'string' ? v.split(/[,\s]+/) : [])).filter((x) => /^f-[A-Za-z0-9-]+$/.test(x));
}

/**
 * 全社を見回り、保持期間を過ぎた採用支援の実行の中身を消す（ワーカーが 1 日 1 回呼ぶ）。
 *
 * @returns 消した実行の数
 * @remarks テナント境界: 会社ごとに、その会社の実行とファイルだけを消す（不変則 I-2）。監査ログ `recruiting.purge`（数だけ）
 */
export async function purgeRecruitingRuns(repo: Repository, files: FileStore, now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - RECRUITING_KEEP_MS).toISOString();
  let purged = 0;
  for (const tenantId of await repo.listTenantIds()) {
    for (const r of await repo.listRunsToPurge(tenantId, RECRUITING_AGENT_ID, before, 100).catch(() => [])) {
      const made = await repo.purgeRunContents(tenantId, r.runId, r.jobId, now.toISOString());
      // 入力に渡した応募書類（本人が上げたもの）も消す
      for (const id of inputFileIds(r.input)) {
        await repo.deleteFile(tenantId, id).catch(() => undefined);
      }
      for (const id of [...made, ...inputFileIds(r.input)]) await files.remove(tenantId, id).catch(() => undefined);
      await repo.appendAudit({
        id: randomUUID(), tenantId, actorType: 'system', actorId: 'recruiting-retention', action: 'recruiting.purge', targetType: 'run', targetId: r.runId,
        detail: { files: made.length + inputFileIds(r.input).length }, occurredAt: now.toISOString(),
      });
      purged++;
    }
  }
  return purged;
}
