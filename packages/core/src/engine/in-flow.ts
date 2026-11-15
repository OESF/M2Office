/**
 * @file 一連の流れの中の承認かを見分ける（仕様書 第47.5節、ADR-0148）。
 *
 * 2026-11-15 に三浦さんが、お知らせを出す・サイトに入れるといった一連の流れの中で、そのたびに承認トレイへ移って承認するのは
 * 使いにくく、件数も増えると指摘した。承認トレイは、時間がかかるもの・外から頼まれたもののためにし、
 * 業務の流れの中で起きる承認は、その流れの中（秘書のキャンバス）で済ませる。
 *
 * **流れの中の承認**: 本人が操作して起こした業務（秘書に頼んだ・画面で「承認へ進める」を押した。そこから続けて起きた業務も）の承認で、
 * 本人が判断でき、作られてから {@link IN_FLOW_HOURS} 時間の内のもの。
 * **承認トレイに出すもの**: ほかの人が頼んだ業務の承認・システムが起こした業務（定時実行・会議の後の自動の議事録・
 * 先回りの準備・相手からの返事・外部のアプリ）の承認・時間がたったもの。
 */

import type { Approval, Job } from '@m2office/shared';

/** 流れの中の承認として、承認トレイに出さずに秘書のキャンバスで判断する時間。過ぎたら承認トレイに出す。 */
export const IN_FLOW_HOURS = 12;

/**
 * 一連の流れの中の承認か。
 *
 * @param viewerId 見ている人（承認待ちの一覧は、見ている人が判断できるものだけに絞ってから渡す）
 * @remarks 移行 209 より前の依頼（起こした人の記録が無いもの）は、定時実行でなければ本人が起こしたものとみなす
 */
export function isInFlowApproval(approval: Pick<Approval, 'createdAt'>, job: Pick<Job, 'requestedBy' | 'origin' | 'startedBy'> | null, viewerId: string, now = Date.now()): boolean {
  if (!job || job.requestedBy !== viewerId) return false;
  if (job.origin === 'schedule' || job.startedBy === 'system') return false;
  return now - Date.parse(approval.createdAt) < IN_FLOW_HOURS * 3_600_000;
}
