/**
 * @file 昇華（個人の記憶を組織知識へ）の単体テスト。
 *
 * 二重の承認、判断できる人、承認したときだけ登録することを確かめる。
 *
 * @see 仕様書 第11.3.1節、ADR-0016
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditEvent, User } from '@m2office/shared';
import {
  canDecidePromotion, decidePromotion, promotionTitle, proposePromotion, submitPromotion,
  withdrawPromotion, type Repository,
} from '../src/index.js';
import type { KnowledgeItem, Memory, Promotion } from '../src/repository/types.js';

const owner: User = { id: 'u-member', tenantId: 't', email: 'm@x', displayName: '一般', roles: ['member'], status: 'active' };
const admin: User = { id: 'u-admin', tenantId: 't', email: 'a@x', displayName: '管理者', roles: ['admin', 'approver'], status: 'active' };
const approver: User = { id: 'u-appr', tenantId: 't', email: 'p@x', displayName: '承認者', roles: ['approver'], status: 'active' };

class PromotionRepo {
  memories: Memory[] = [{
    id: 'm1', tenantId: 't', userId: 'u-member', text: '経費の精算は佐藤さんに出す',
    source: 'secretary', createdAt: '2026-09-22T00:00:00.000Z',
  }];
  promotions: Promotion[] = [];
  knowledge: KnowledgeItem[] = [];
  audits: AuditEvent[] = [];
  users = [owner, admin, approver];
  // 本物の永続化層と同じく、本人のものだけを返す
  async listMemories(_t: string, userId: string) { return this.memories.filter((m) => m.userId === userId); }
  async listPromotions(_t: string, opts: { status?: string; userId?: string }) {
    return this.promotions.filter(
      (p) => (!opts.status || p.status === opts.status) && (!opts.userId || p.userId === opts.userId),
    );
  }
  async createPromotion(p: Promotion) { this.promotions.push(p); }
  async getPromotion(_t: string, id: string) { return this.promotions.find((p) => p.id === id) ?? null; }
  async updatePromotion(p: Promotion) { this.promotions = this.promotions.map((x) => (x.id === p.id ? p : x)); }
  async listUsers() { return this.users; }
  async findUserById(_t: string, id: string) { return this.users.find((u) => u.id === id) ?? null; }
  async saveKnowledge(k: KnowledgeItem) { this.knowledge.push(k); }
  async appendAudit(e: AuditEvent) { this.audits.push(e); }
}

function setup() {
  const repo = new PromotionRepo();
  const notices: { userId: string; title: string }[] = [];
  const deps = {
    repo: repo as unknown as Repository,
    notify: async (_t: string, userId: string, title: string) => { notices.push({ userId, title }); },
  };
  return { repo, deps, notices };
}

const NOW = new Date('2026-09-23T02:00:00.000Z');

test('判断できるのは、管理者と承認者の役割を持つ人。本人は判断できない', () => {
  const promotion = { userId: 'u-member' } as Promotion;
  assert.equal(canDecidePromotion(promotion, admin), true);
  assert.equal(canDecidePromotion(promotion, approver), true);
  assert.equal(canDecidePromotion(promotion, owner), false, '提案した本人は判断できない');
  assert.equal(canDecidePromotion(promotion, { id: 'x', roles: ['member'] }), false);
  assert.equal(promotionTitle('あ'.repeat(40)).length, 31, '題名は先頭の 30 字に省略記号');
});

test('本人が出すと、判断できる人に知らせ、組織の承認待ちになる', async () => {
  const { repo, deps, notices } = setup();
  const promotion = await proposePromotion(deps, 't', owner, 'm1', NOW);
  assert.equal(promotion?.status, 'pending');
  assert.equal(promotion?.text, '経費の精算は佐藤さんに出す');
  assert.deepEqual(notices.map((n) => n.userId).sort(), ['u-admin', 'u-appr'], '本人には知らせない');
  assert.equal(repo.knowledge.length, 0, '承認の前に知識へ入れない');

  const audit = repo.audits.find((a) => a.action === 'memory.promote');
  assert.equal(JSON.stringify(audit).includes('佐藤'), false, '監査ログに記憶の中身を入れない');

  // 同じ記憶を二度出しても増えない
  const again = await proposePromotion(deps, 't', owner, 'm1', NOW);
  assert.equal(again?.id, promotion?.id);
  assert.equal(repo.promotions.length, 1);

  // 他人の記憶は出せない
  assert.equal(await proposePromotion(deps, 't', admin, 'm1', NOW), null);
});

test('承認すると、その文のまま組織知識に登録し、本人に知らせる', async () => {
  const { repo, deps, notices } = setup();
  const promotion = (await proposePromotion(deps, 't', owner, 'm1', NOW))!;
  notices.length = 0;
  const decided = await decidePromotion(deps, 't', promotion.id, 'approved', admin, null, NOW);
  assert.equal(decided?.status, 'approved');
  assert.equal(repo.knowledge.length, 1);
  assert.equal(repo.knowledge[0]!.body, '経費の精算は佐藤さんに出す', '承認した文をそのまま登録する');
  assert.equal(repo.knowledge[0]!.kind, 'promoted');
  assert.equal(repo.knowledge[0]!.compartment, null);
  assert.match(repo.knowledge[0]!.source, /個人の記憶からの昇華（提案: 一般）/);
  assert.deepEqual(notices.map((n) => n.userId), ['u-member'], '判断を本人に知らせる');
  assert.equal(repo.memories.length, 1, '記憶は消さない');

  // 判断済みのものは、もう判断できない
  assert.equal(await decidePromotion(deps, 't', promotion.id, 'rejected', admin, null, NOW), null);
});

test('却下しても知識に入れず、記憶は残る。本人と権限のない人は判断できない', async () => {
  const { repo, deps } = setup();
  const promotion = (await proposePromotion(deps, 't', owner, 'm1', NOW))!;
  assert.equal(await decidePromotion(deps, 't', promotion.id, 'approved', owner, null, NOW), null, '本人は判断できない');
  assert.equal(
    await decidePromotion(deps, 't', promotion.id, 'approved', { ...owner, id: 'u-other' }, null, NOW),
    null, '権限のない人は判断できない',
  );

  const decided = await decidePromotion(deps, 't', promotion.id, 'rejected', approver, '全社には広げない', NOW);
  assert.equal(decided?.status, 'rejected');
  assert.equal(decided?.comment, '全社には広げない');
  assert.equal(repo.knowledge.length, 0);
  assert.equal(repo.memories.length, 1);
});

test('秘書が作った候補は、本人が出すか、やめるかを選ぶ（第11.3.1節）', async () => {
  const { repo, deps, notices } = setup();
  const suggested: Promotion = {
    id: 'p1', tenantId: 't', userId: 'u-member', memoryId: 'm1', text: '経費の精算は佐藤さんに出す',
    status: 'proposed', knowledgeId: null, decidedBy: null, comment: null,
    createdAt: '2026-09-23T00:00:00.000Z', decidedAt: null,
  };
  repo.promotions.push(suggested);

  // 本人の確認待ちの間は、承認者も判断できない
  assert.equal(await decidePromotion(deps, 't', 'p1', 'approved', admin, null, NOW), null);

  // ほかの人は出せない
  assert.equal(await submitPromotion(deps, 't', admin, 'p1', NOW), null);

  const submitted = await submitPromotion(deps, 't', owner, 'p1', NOW);
  assert.equal(submitted?.status, 'pending');
  assert.deepEqual(notices.map((n) => n.userId).sort(), ['u-admin', 'u-appr'], '判断できる人に知らせる');
  assert.equal(await submitPromotion(deps, 't', owner, 'p1', NOW), null, '二度は出せない');

  // 出したものは承認できる
  assert.equal((await decidePromotion(deps, 't', 'p1', 'approved', admin, null, NOW))?.status, 'approved');
});

test('本人がやめた候補は、承認へ回らず、記憶も消えない', async () => {
  const { repo, deps } = setup();
  repo.promotions.push({
    id: 'p2', tenantId: 't', userId: 'u-member', memoryId: 'm1', text: '経費の精算は佐藤さんに出す',
    status: 'proposed', knowledgeId: null, decidedBy: null, comment: null,
    createdAt: '2026-09-23T00:00:00.000Z', decidedAt: null,
  });
  const withdrawn = await withdrawPromotion(deps, 't', owner, 'p2', NOW);
  assert.equal(withdrawn?.status, 'withdrawn');
  assert.equal(await decidePromotion(deps, 't', 'p2', 'approved', admin, null, NOW), null);
  assert.equal(repo.knowledge.length, 0);
  assert.equal(repo.memories.length, 1);
});
