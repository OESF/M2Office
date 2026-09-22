/**
 * @file 実行の中身を見られる人の規則（canViewRun）の単体テスト。
 *
 * @see 仕様書 第6.2.1節 実行の中身を見られる人
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Approval } from '@m2office/shared';
import { canViewRun, type Repository } from '../src/index.js';

const approval = (over: Partial<Approval>): Approval => ({
  id: 'a1', runStepId: 's1', tenantId: 't', approverRole: ['approver'], approverUserId: null, present: '',
  decision: null, decidedBy: null, comment: null, decidedAt: null, createdAt: '2026-09-23T00:00:00.000Z', ...over,
} as Approval);
const repoWith = (approvals: Approval[]) => ({ listRunApprovals: async () => approvals }) as unknown as Repository;
const member = { id: 'u-member', roles: ['member'] };
const approver = { id: 'u-approver', roles: ['approver', 'member'] };

test('依頼した本人は、承認がなくても見られる', async () => {
  assert.equal(await canViewRun(repoWith([]), 't', { requestedBy: 'u-member' }, 'r1', member), true);
});

test('承認者の役割を持つだけでは、承認のない実行を見られない', async () => {
  assert.equal(await canViewRun(repoWith([]), 't', { requestedBy: 'u-member' }, 'r1', approver), false);
});

test('自分が判断できる承認がある実行は、判断を終えた後も見られる', async () => {
  const decided = approval({ decision: 'approved', decidedBy: 'u-approver' });
  assert.equal(await canViewRun(repoWith([decided]), 't', { requestedBy: 'u-member' }, 'r1', approver), true);
});

test('依頼者本人が判断する承認は、承認者の役割があってもほかの人には見せない', async () => {
  const own = approval({ approverRole: [], approverUserId: 'u-member' });
  assert.equal(await canViewRun(repoWith([own]), 't', { requestedBy: 'u-member' }, 'r1', approver), false);
});
