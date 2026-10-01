/**
 * @file 監査ログの見せ方の単体テスト。
 *
 * 誰が（人の名前・秘書や業務が行ったものは指示した人・仕組みの名前）、何をしたか（業務の言葉）、何に対して（名前）に直すこと、
 * 引けない名前は推測で作らず記録の値のまま出すこと、CSV が Excel で開ける形であることを確かめる。
 *
 * @see 仕様書 第6.6.8.1節 監査ログの画面
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditEvent } from '@m2office/shared';
import { auditCsv, categoryOf, presentAudit, type AuditNames } from '../src/audit/present.js';

const names: AuditNames = {
  user: (id) => ({ u1: '三浦雅孝', u2: '山田花子' } as Record<string, string>)[id],
  agent: (id) => (id === 'minutes' ? '議事録作成・共有' : undefined),
  connection: (id) => (id === 'slack' ? 'Slack' : undefined),
  group: () => undefined,
  compartment: () => undefined,
  run: (id) => (id === 'r1' ? { agentName: '議事録作成・共有', requestedBy: 'u2' } : undefined),
};

const ev = (e: Partial<AuditEvent>): AuditEvent => ({
  id: 'e', tenantId: 't', actorType: 'user', actorId: 'u1', action: 'x', targetType: 'x', targetId: 'x', detail: {}, occurredAt: '2026-09-27T13:00:54.000Z', ...e,
});

test('誰が・何をしたか・何に対してを、人の名前と業務の言葉で出す', () => {
  const approve = presentAudit(ev({ action: 'approval.decide', targetType: 'approval', targetId: 'a1', detail: { decision: 'rejected', runId: 'r1' } }), names);
  assert.deepEqual([approve.who, approve.what, approve.target, approve.category], ['三浦雅孝', '却下した', '業務「議事録作成・共有」の承認', '承認']);
  const tool = presentAudit(ev({ actorType: 'agent', actorId: 'minutes', action: 'tool.invoke', targetType: 'tool', targetId: 'slack.slack_send_message', detail: { runId: 'r1' } }), names);
  assert.equal(tool.who, '業務「議事録作成・共有」（山田花子さんの依頼）', '業務が行ったものは指示した人を添える');
  assert.equal(tool.target, 'Slack のツール slack_send_message');
  assert.equal(presentAudit(ev({ actorType: 'secretary', action: 'secretary.lookup' }), names).who, '秘書（三浦雅孝さんの依頼）');
  assert.equal(presentAudit(ev({ actorType: 'system', actorId: 'scheduler', action: 'schedule.skip' }), names).who, 'システム（定時実行）');
  assert.equal(presentAudit(ev({ action: 'connection.oauth.connect', targetType: 'connection', targetId: 'slack' }), names).what, 'サービスと接続した');
});

test('引けない名前は推測で作らず記録の値のまま出す。知らない操作は記録の名前のまま', () => {
  const r = presentAudit(ev({ actorId: 'u-unknown', action: 'something.new', targetType: 'user', targetId: 'u-gone' }), names);
  assert.deepEqual([r.who, r.what, r.target, r.category], ['u-unknown', 'something.new', 'u-gone', 'その他']);
  assert.equal(categoryOf('connection.secret.update'), '接続');
});

test('CSV は BOM 付きで、区切りや改行を含む値を囲み、日本時間で出す', () => {
  const rows = [presentAudit(ev({ action: 'approval.decide', targetType: 'approval', targetId: 'a1', detail: { decision: 'approved', runId: 'r1', comment: '確認, OK\n次へ' } }), names)];
  const csv = auditCsv(rows);
  assert.ok(csv.startsWith('﻿日時,誰が,何をしたか,何に対して,種類,記録の名前,記録の主体,記録の対象,詳細\r\n'));
  assert.match(csv, /2026\/09\/27 22:00:54,三浦雅孝,承認した,業務「議事録作成・共有」の承認,承認,approval\.decide,user: u1,approval: a1,"/);
  assert.match(csv, /""comment"":""確認, OK\\n次へ""/, 'JSON の中の引用符は重ねる');
});
