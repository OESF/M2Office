/**
 * @file 昇華（個人の記憶を組織知識へ引き上げる）。仕様書 第11.3・11.3.1節、ADR-0016。
 *
 * 二重の承認を経る。本人が出すことを決め、管理者または承認者の役割を持つ人が組織知識への登録を判断する。
 * 承認したときに登録するのは、承認者が読んだ一文そのものである。
 */

import { randomUUID } from 'node:crypto';
import type { User } from '@m2office/shared';
import type { Promotion, Repository } from '../repository/types.js';

/** 昇華を承認できる役割（Q-24）。本人以外が判断する。 */
export const PROMOTION_APPROVER_ROLES = ['admin', 'approver'];

/** その人が昇華を判断できるか。提案した本人は判断できない（第11.3節の二重の承認）。 */
export function canDecidePromotion(promotion: Promotion, user: Pick<User, 'id' | 'roles'>): boolean {
  if (promotion.userId === user.id) return false;
  return user.roles.some((r) => PROMOTION_APPROVER_ROLES.includes(r));
}

/** 昇華した知識の題名（先頭の 30 字）。 */
export function promotionTitle(text: string): string {
  return text.length <= 30 ? text : `${text.slice(0, 30)}…`;
}

export interface PromoteDeps {
  repo: Repository;
  /** 通知を作る（承認できる人と、提案した本人へ）。 */
  notify(tenantId: string, userId: string, title: string, body: string): Promise<void>;
}

/**
 * 本人が、自分の記憶を組織知識へ出す（提案する）。
 *
 * @param memoryId 記憶の ID。本人のものでなければ提案しない
 * @returns 作った提案。記憶が見つからなければ `null`
 */
export async function proposePromotion(
  deps: PromoteDeps, tenantId: string, user: User, memoryId: string, now: Date,
): Promise<Promotion | null> {
  const memory = (await deps.repo.listMemories(tenantId, user.id)).find((m) => m.id === memoryId);
  if (!memory) return null;
  const already = (await deps.repo.listPromotions(tenantId, { userId: user.id }))
    .find((p) => p.memoryId === memoryId && (p.status === 'pending' || p.status === 'proposed'));
  if (already) return already;

  const promotion: Promotion = {
    id: randomUUID(), tenantId, userId: user.id, memoryId, text: memory.text,
    // 本人が出したものは、本人の承認を済んだものとして組織の承認待ちにする
    status: 'pending', knowledgeId: null, decidedBy: null, comment: null,
    createdAt: now.toISOString(), decidedAt: null,
  };
  await deps.repo.createPromotion(promotion);
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: user.id,
    action: 'memory.promote', targetType: 'promotion', targetId: promotion.id,
    detail: { memoryId }, occurredAt: promotion.createdAt,
  });
  // 判断できる人に知らせる（第6.5.5.1節）
  for (const u of await deps.repo.listUsers(tenantId)) {
    if (u.status !== 'active' || !canDecidePromotion(promotion, u)) continue;
    await deps.notify(
      tenantId, u.id, '会社の知識にする提案があります',
      `${user.displayName}さんから提案がありました。管理者ページの「知識」で判断してください。`,
    );
  }
  return promotion;
}

/**
 * 秘書が作った候補を、本人が組織の承認へ出す（第11.3節の本人の承認）。
 *
 * @returns 出した提案。本人のものでなければ `null`
 */
export async function submitPromotion(
  deps: PromoteDeps, tenantId: string, user: User, id: string, now: Date,
): Promise<Promotion | null> {
  const promotion = await deps.repo.getPromotion(tenantId, id);
  // 本人の判断待ちのものだけを出せる
  if (!promotion || promotion.userId !== user.id || promotion.status !== 'proposed') return null;
  const submitted: Promotion = { ...promotion, status: 'pending' };
  await deps.repo.updatePromotion(submitted);
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: user.id,
    action: 'memory.promote', targetType: 'promotion', targetId: promotion.id,
    detail: { from: 'suggestion' }, occurredAt: now.toISOString(),
  });
  for (const u of await deps.repo.listUsers(tenantId)) {
    if (u.status !== 'active' || !canDecidePromotion(submitted, u)) continue;
    await deps.notify(
      tenantId, u.id, '会社の知識にする提案があります',
      `${user.displayName}さんから提案がありました。管理者ページの「知識」で判断してください。`,
    );
  }
  return submitted;
}

/**
 * 秘書が作った候補を、本人がやめる。記憶は消さない。
 *
 * @returns やめた提案。本人のものでなければ `null`
 */
export async function withdrawPromotion(
  deps: PromoteDeps, tenantId: string, user: User, id: string, now: Date,
): Promise<Promotion | null> {
  const promotion = await deps.repo.getPromotion(tenantId, id);
  if (!promotion || promotion.userId !== user.id || promotion.status !== 'proposed') return null;
  const withdrawn: Promotion = {
    ...promotion, status: 'withdrawn', decidedBy: user.id, decidedAt: now.toISOString(),
  };
  await deps.repo.updatePromotion(withdrawn);
  return withdrawn;
}

/**
 * 組織の承認者が判断する。承認したときだけ組織知識に登録する。
 *
 * @param decision 承認または却下
 * @returns 判断した後の提案。判断できない場合は `null`
 */
export async function decidePromotion(
  deps: PromoteDeps, tenantId: string, id: string, decision: 'approved' | 'rejected',
  decider: User, comment: string | null, now: Date,
): Promise<Promotion | null> {
  const promotion = await deps.repo.getPromotion(tenantId, id);
  if (!promotion || promotion.status !== 'pending') return null;
  if (!canDecidePromotion(promotion, decider)) return null;

  const at = now.toISOString();
  let knowledgeId: string | null = null;
  if (decision === 'approved') {
    const owner = await deps.repo.findUserById(tenantId, promotion.userId);
    knowledgeId = `promoted-${promotion.id}`;
    await deps.repo.saveKnowledge({
      id: knowledgeId, tenantId, kind: 'promoted', title: promotionTitle(promotion.text),
      body: promotion.text,
      source: `個人の記憶からの昇華（提案: ${owner?.displayName ?? promotion.userId}）`,
      // 区画のデータは昇華の対象にしない（不変則 I-12）
      compartment: null, updatedAt: at,
    });
  }
  const decided: Promotion = {
    ...promotion, status: decision, knowledgeId, decidedBy: decider.id, comment, decidedAt: at,
  };
  await deps.repo.updatePromotion(decided);
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: decider.id,
    action: 'memory.promote.decide', targetType: 'promotion', targetId: promotion.id,
    detail: { decision, knowledgeId }, occurredAt: at,
  });
  await deps.notify(
    tenantId, promotion.userId,
    decision === 'approved' ? '提案が会社の知識になりました' : '提案は見送りになりました',
    decision === 'approved'
      ? '提案した内容を、会社の知識として登録しました。以後、秘書と業務が参照します。'
      : `見送りになりました。${comment ?? ''}覚えていることはそのまま残っています。`,
  );
  return decided;
}
