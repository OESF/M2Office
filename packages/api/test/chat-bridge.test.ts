/**
 * @file Chat で秘書に頼む橋渡しの単体テスト（仕様書 第10.16.3節、ADR-0138）。
 *
 * 送った人の秘書が答えること（個別メッセージはそのまま、スペースは本人にだけ見える形で同じスレッドに）、
 * 会社の利用者でない人には頼みを扱わず一言だけ返すこと、重ねて届いた発言を扱わないこと、
 * 後ろへ回した依頼は承認待ちと終わったときに同じ場所へ返し、画面の秘書と重ねて伝えないことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOKUP_AGENT_ID, MemoryChatInboxStore, silentLogger, type Repository } from '@m2office/core';
import { DEFAULT_USER_SETTINGS } from '@m2office/shared';
import { CHAT_NOT_A_USER, ChatSecretaryBridge, MockChatReplySender } from '../src/chat/bridge.js';

const USERS = [
  { id: 'u1', tenantId: 't1', email: 'sato@a.example.jp', displayName: '佐藤', roles: ['member'], status: 'active' },
  { id: 'u2', tenantId: 't1', email: 'suzuki@a.example.jp', displayName: '鈴木', roles: ['member'], status: 'active' },
];

function setup(reply: { text: string; lookup?: { runId: string; request: string } } = { text: '10 時から定例です。' }) {
  const store = new MemoryChatInboxStore();
  const sender = new MockChatReplySender();
  const asked: { userId: string; message: string; channel?: string }[] = [];
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const dmSpaces = new Map<string, string>();
  const run = { id: 'r1', status: 'running', endedAt: null as string | null, failureReason: null };
  const claimed = new Set<string>();
  const conversations: { message: string }[] = [];
  const repo = {
    findUserByEmail: async (_t: string, email: string) => USERS.find((u) => u.email === email) ?? null,
    findUserById: async (_t: string, id: string) => USERS.find((u) => u.id === id) ?? null,
    listGoogleConnections: async () => [{ userId: 'u2', googleEmail: 'suzuki.g@a.example.jp' }],
    setChatDmSpace: async (_t: string, u: string, space: string) => { dmSpaces.set(u, space); },
    appendAudit: async (e: { action: string; detail: Record<string, unknown> }) => { audits.push(e); },
    listRunsWithJobs: async () => [{ run, job: { agentId: LOOKUP_AGENT_ID, origin: 'secretary', input: { request: '来週の出張の行程' }, planStepId: null } }],
    listToldLookups: async () => [...claimed],
    listRunSteps: async () => [{ stepId: 'answer', status: run.status === 'completed' ? 'completed' : 'running', input: {}, output: { text: '新幹線は 8:00 発です。' }, startedAt: new Date().toISOString() }],
    listArtifacts: async () => [],
    listActivePlans: async () => [],
    getRun: async () => run,
    claimLookupDelivery: async (_t: string, id: string) => { if (claimed.has(id)) return false; claimed.add(id); return true; },
    getUserSettings: async () => structuredClone(DEFAULT_USER_SETTINGS),
    appendConversation: async (c: { message: string }) => { conversations.push(c); },
  } as unknown as Repository;
  const bridge = new ChatSecretaryBridge({
    repo, store, log: silentLogger, senderFor: () => sender, appUrl: async () => 'https://a.m2office.example',
    secretary: { respond: async (_t: string, userId: string, message: string, _f?: unknown, opts?: { channel?: 'chat' }) => {
      asked.push({ userId, message, channel: opts?.channel });
      return { layer: 'direct', evidence: [], tokensUsed: 0, ...reply };
    } } as never,
  });
  return { bridge, store, sender, asked, audits, dmSpaces, run, claimed, conversations };
}

const event = (over: { email?: string; space?: string; dm?: boolean; name?: string; text?: string } = {}) => ({
  type: 'MESSAGE',
  message: {
    name: over.name ?? 'spaces/DM1/messages/m1', text: over.text ?? '今日の予定は？', argumentText: over.text ?? '今日の予定は？',
    sender: { name: 'users/111', email: over.email ?? 'sato@a.example.jp', type: 'HUMAN' },
    thread: { name: `${over.space ?? 'spaces/DM1'}/threads/t1` },
    space: { name: over.space ?? 'spaces/DM1', spaceType: over.dm === false ? 'SPACE' : 'DIRECT_MESSAGE' },
  },
});

test('個別メッセージ: 送った人の秘書が答え、同じ個別メッセージに返す', async () => {
  const s = setup();
  assert.equal(await s.bridge.handle('t1', event()), 'answered');
  assert.deepEqual(s.asked, [{ userId: 'u1', message: '今日の予定は？', channel: 'chat' }]);
  assert.deepEqual(s.sender.outbox, [{ tenantId: 't1', space: 'spaces/DM1', text: '10 時から定例です。', thread: 'spaces/DM1/threads/t1', privateViewer: null }]);
  assert.equal(s.dmSpaces.get('u1'), 'spaces/DM1', '通知の控えも同じ場所に届くよう覚える');
  assert.equal(await s.bridge.handle('t1', event()), 'duplicate', '重ねて届いた発言は扱わない');
  assert.equal(s.asked.length, 1);
});

test('スペースでの言及: 言及した人にだけ見える形で、同じスレッドに返す。Google の接続のアカウントでも本人を探す', async () => {
  const s = setup();
  assert.equal(await s.bridge.handle('t1', event({ email: 'suzuki.g@a.example.jp', space: 'spaces/ROOM', dm: false, name: 'spaces/ROOM/messages/m9' })), 'answered');
  assert.equal(s.asked[0]!.userId, 'u2');
  assert.equal(s.sender.outbox[0]!.privateViewer, 'users/111');
  assert.equal(s.sender.outbox[0]!.thread, 'spaces/ROOM/threads/t1');
  assert.equal(s.dmSpaces.size, 0, 'スペースは個別メッセージの場所として覚えない');
});

test('会社の利用者でない人には、頼みを扱わずに一言だけ返す', async () => {
  const s = setup();
  assert.equal(await s.bridge.handle('t1', event({ email: 'guest@other.example.com', space: 'spaces/ROOM', dm: false, name: 'spaces/ROOM/messages/m3' })), 'rejected');
  assert.equal(s.asked.length, 0);
  assert.equal(s.sender.outbox[0]!.text, CHAT_NOT_A_USER);
  assert.equal(s.sender.outbox[0]!.privateViewer, 'users/111');
  assert.deepEqual(s.audits.map((a) => [a.action, a.detail['sender']]), [['chat.inbound_rejected', 'guest@other.example.com']]);
});

test('後ろへ回した依頼: 終わったら同じ場所に結果を返し、画面の秘書と重ねて伝えない', async () => {
  const s = setup({ text: 'お調べします。', lookup: { runId: 'r1', request: '来週の出張の行程' } });
  assert.equal(await s.bridge.handle('t1', event({ text: '来週の出張の行程' })), 'answered');
  assert.match(s.sender.outbox[0]!.text, /^お調べします。\n<https:\/\/a\.m2office\.example\/runs\/r1\|画面で開く>$/);
  assert.equal((await s.store.listPending('t1')).length, 1);
  assert.equal(await s.bridge.sweep(), 0, 'まだ動いている');
  s.run.status = 'awaiting_approval';
  assert.equal(await s.bridge.sweep(), 1);
  assert.match(s.sender.outbox[1]!.text, /承認を待っています。\n<https:\/\/a\.m2office\.example\/approvals\|画面で開く>/);
  assert.equal(await s.bridge.sweep(), 0, '承認待ちは 1 度だけ伝える');
  s.run.status = 'completed';
  s.run.endedAt = new Date().toISOString();
  assert.equal(await s.bridge.sweep(), 1);
  assert.match(s.sender.outbox[2]!.text, /^「来週の出張の行程」の結果です。\n\n新幹線は 8:00 発です。/);
  assert.ok(s.claimed.has('r1'), '伝えたと記録する（画面では重ねて伝えない）');
  assert.equal(s.conversations.length, 1, '伝えた結果を会話の記録に残す');
  assert.equal((await s.store.listPending('t1')).length, 0);
});
