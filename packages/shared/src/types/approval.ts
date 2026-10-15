/**
 * @file 承認を判断できるかどうかの規則（ロール、または依頼者本人）。
 *
 * 実行エンジン・承認トレイ・ツールが同じ規則を使うよう、ここに 1 つだけ置く。
 *
 * @see 仕様書 第9.2.3節 承認者の指定
 */

import type { Approval } from './run.js';

/**
 * その利用者が承認を判断できるかどうかを返す。
 *
 * @param approval 対象の承認
 * @param user 判断しようとする利用者の ID・ロール・入っている権限区画
 * @returns 判断できれば `true`
 *
 * @remarks
 * 実行エンジンの判定・承認トレイの絞り込み・ツールの一覧・実行を見られる人で同じ規則を使うため、
 * ここに 1 つだけ置く（仕様書 第9.2.3節）。
 * 依頼者の承認（`approverUserId` あり）では、ロールに関係なく本人だけが判断できる。
 * 権限区画に属する業務の承認は、ロールを持ち、かつ区画に入っている者だけが判断できる（第16.3.6節）。
 * 区画を渡さない呼び出しでは、区画に属する承認を判断できないとみなす（外す側に倒さない）。
 */
export function canDecide(
  approval: Pick<Approval, 'approverRole' | 'approverUserId'> & { compartment?: string | null },
  user: { id: string; roles: readonly string[]; compartments?: readonly string[] },
): boolean {
  if (approval.approverUserId) return approval.approverUserId === user.id;
  if (approval.compartment && !(user.compartments ?? []).includes(approval.compartment)) return false;
  return approval.approverRole.some((r) => user.roles.includes(r));
}

/** 承認の中に、区画に属するもの（判断の前に入っている区画を引く要るもの）があるか。 */
export function needsCompartments(approvals: readonly { compartment?: string | null; approverUserId: string | null }[]): boolean {
  return approvals.some((a) => !a.approverUserId && !!a.compartment);
}
