/**
 * @file 会話ログの単体テスト。残すか残さないかと、入れ替えを確かめる。
 *
 * @see 仕様書 第11.9.4.1・11.9.6節、ADR-0014
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS, type AuditEvent, type UserSettings } from '@m2office/shared';
import {
  CONVERSATION_RETENTION_DAYS, ConversationRotation, DIRECT_QUERIES, MockWorkspaceConnector,
  type Repository,
} from '../src/index.js';
import type { Conversation } from '../src/repository/types.js';

/** 会話ログの操作だけを持つ、記憶上の永続化層。 */
class ConversationRepo {
  settings: UserSettings = structuredClone(DEFAULT_USER_SETTINGS);
  conversations: Conversation[] = [];
  audits: AuditEvent[] = [];
  async listTenantIds() { return ['t']; }
  async getUserSettings() { return this.settings; }
  async appendConversation(c: Conversation) { this.conversations.push(c); }
  async clearConversations(_t: string, userId: string, since?: string) {
    const keep = this.conversations.filter(
      (c) => !(c.userId === userId && (!since || c.createdAt >= since)),
    );
    const removed = this.conversations.length - keep.length;
    this.conversations = keep;
    return removed;
  }
  async deleteConversationsBefore(_t: string, before: string) {
    const keep = this.conversations.filter((c) => c.createdAt >= before);
    const removed = this.conversations.length - keep.length;
    this.conversations = keep;
    return removed;
  }
  async appendAudit(e: AuditEvent) { this.audits.push(e); }
}

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: `c-${Math.random()}`, tenantId: 't', userId: 'u', message: '承認待ちある？',
  reply: '承認待ちはありません。', layer: 'direct', agentId: null, runId: null,
  createdAt: new Date().toISOString(), ...over,
});

test('「この会話は残さないで」は、直近 1 時間の会話を消す', async () => {
  const repo = new ConversationRepo();
  const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
  repo.conversations.push(conversation({ createdAt: old }), conversation(), conversation());

  const query = DIRECT_QUERIES.find((q) => q.id === 'conversation-forget');
  assert.ok(query);
  const res = await query.answer({
    tenantId: 't', userId: 'u', message: 'この会話は残さないで',
    repo: repo as unknown as Repository, connector: new MockWorkspaceConnector(),
  });
  assert.equal(repo.conversations.length, 1, '1 時間より前の会話は残す');
  assert.match(res.text, /2 件/);
  const audit = repo.audits.find((a) => a.action === 'conversation.clear');
  assert.ok(audit);
  assert.equal(JSON.stringify(audit.detail).includes('承認待ち'), false, '監査ログに中身を入れない');
});

test('「覚えておいて」の照会と取り違えない', () => {
  const match = (message: string) => DIRECT_QUERIES.find(
    (q) => q.patterns.some((p) => p.test(message)) && !q.excludes?.some((p) => p.test(message)),
  )?.id;
  assert.equal(match('この会話は残さないで'), 'conversation-forget');
  assert.equal(match('人事評価のことは覚えないで'), 'memory-forget');
  assert.equal(match('山田さんは経理だと覚えておいて'), 'memory-remember');
});

test('保持期間（4 週）を過ぎた逐語を消す', async () => {
  const repo = new ConversationRepo();
  const now = new Date('2026-09-23T00:00:00.000Z');
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  repo.conversations.push(
    conversation({ createdAt: day(CONVERSATION_RETENTION_DAYS + 1) }),
    conversation({ createdAt: day(CONVERSATION_RETENTION_DAYS - 1) }),
    conversation({ createdAt: day(0) }),
  );
  const rotation = new ConversationRotation({ repo: repo as unknown as Repository });
  assert.equal(await rotation.sweep(now), 1);
  assert.equal(repo.conversations.length, 2, '4 週以内は残す');
});
