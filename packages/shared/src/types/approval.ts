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
 * @param user 判断しようとする利用者の ID とロール
 * @returns 判断できれば `true`
 *
 * @remarks
 * 実行エンジンの判定・承認トレイの絞り込み・ツールの一覧で同じ規則を使うため、
 * ここに 1 つだけ置く（仕様書 第9.2.3節）。
 * 依頼者の承認（`approverUserId` あり）では、ロールに関係なく本人だけが判断できる。
 */
export function canDecide(
  approval: Pick<Approval, 'approverRole' | 'approverUserId'>,
  user: { id: string; roles: readonly string[] },
): boolean {
  if (approval.approverUserId) return approval.approverUserId === user.id;
  return approval.approverRole.some((r) => user.roles.includes(r));
}
