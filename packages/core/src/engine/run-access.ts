/**
 * @file 実行の中身（ステップ・根拠・成果物・業務が扱ったファイル）を見られる人の規則。
 *
 * 実行の中身には、業務が Google から取得したメールや文書が入る。
 * 見られる人を、その実行に関わる人（依頼した本人と、その実行の承認を判断できる人）に限る。
 * 実行の詳細の API とファイルの取り出しが同じ規則を使うよう、ここに 1 つだけ置く。
 *
 * @see 仕様書 第6.2.3節 実行の中身を見られる人
 */

import { canDecide, needsCompartments, type Approval, type Job } from '@m2office/shared';
import type { Repository } from '../repository/types.js';

/** 判定の対象の利用者。 */
export interface RunViewer {
  id: string;
  roles: readonly string[];
}

/**
 * その利用者が、実行の中身を見られるかを返す。
 *
 * @param job 実行のもとの依頼（依頼した本人を見る）
 * @param runId 実行
 * @returns 依頼した本人か、その実行に自分が判断できる承認（判断済みを含む）があれば `true`
 *
 * @remarks
 * 承認者の役割を持つだけでは見られない。承認者の役割は「その業務の承認を判断する」ためのもので、
 * 会社の中のすべての実行を見る権限ではない（第6.2.1節）。管理者も中身は見られない。
 * 権限区画に属する業務の実行は、区画に入っている間だけ見られる（第6.2.3節・第16.3.6節）。
 */
export async function canViewRun(
  repo: Repository, tenantId: string, job: Pick<Job, 'requestedBy'>, runId: string, who: RunViewer,
): Promise<boolean> {
  if (job.requestedBy === who.id) return true;
  const approvals = await repo.listRunApprovals(tenantId, runId);
  return decidableBy(repo, tenantId, approvals, who);
}

/**
 * 判断する人に、入っている権限区画を添える（区画に属する承認があるときだけ引く）。
 *
 * @remarks {@link canDecide} は区画を渡さない呼び出しで区画の承認を判断させない。判断と絞り込みの前にこれで添える
 */
export async function withCompartments<U extends { id: string; roles: readonly string[] }>(
  repo: Repository, tenantId: string, approvals: readonly Pick<Approval, 'approverUserId' | 'compartment'>[], who: U,
): Promise<U & { compartments: readonly string[] }> {
  const compartments = needsCompartments(approvals) ? await repo.listUserCompartments(tenantId, who.id) : [];
  return { ...who, compartments };
}

/** 承認のどれかを、その利用者が判断できるか（区画を添えて確かめる）。 */
export async function decidableBy(
  repo: Repository, tenantId: string, approvals: readonly Approval[], who: RunViewer,
): Promise<boolean> {
  const decider = await withCompartments(repo, tenantId, approvals, who);
  return approvals.some((a) => canDecide(a, decider));
}
