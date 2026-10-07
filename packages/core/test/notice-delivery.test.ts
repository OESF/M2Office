/**
 * @file 社内のお知らせのブリーフ以外の届け方の単体テスト（仕様書 第10.15.1節、ADR-0080）。
 * 済んだ人の数（出した人と管理者だけ・済んでいない人の名前は締切の後だけ）、もう知らせない、
 * 締切の 3 日前と当日の知らせ（済んだ人・止めた人には出さない・1 度だけ・朝 8 時から）、
 * Chat への投稿（グループに合うスペース・社内だけと確かめたときだけ・1 回だけ）を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS, type Notification, type UserGroup } from '@m2office/shared';
import { MemoryNoticeStore, NoticeService, answerNotice, type LlmProvider, type Repository, type WorkspaceConnector } from '../src/index.js';

const USERS = [
  { id: 'u-admin', tenantId: 't1', email: 'admin@a.example.jp', displayName: '管理者', roles: ['admin'], status: 'active' },
  { id: 'u-a', tenantId: 't1', email: 'a@a.example.jp', displayName: '佐藤', roles: ['member'], status: 'active' },
  { id: 'u-b', tenantId: 't1', email: 'b@a.example.jp', displayName: '鈴木', roles: ['member'], status: 'active' },
  { id: 'u-c', tenantId: 't1', email: 'c@a.example.jp', displayName: '高橋', roles: ['member'], status: 'active' },
];

function setup(chat?: { members: Record<string, { in: string[]; external?: number }>; spaces: { space: string; displayName: string; external: boolean }[] }) {
  const groups: UserGroup[] = [{ id: 'g-dev', tenantId: 't1', name: '開発', description: '', memberIds: ['u-a', 'u-b'], chatSpace: null }];
  const sent: Notification[] = [];
  const audits: string[] = [];
  const posts: { space: string; text: string }[] = [];
  const repo = {
    getUserSettings: async () => structuredClone(DEFAULT_USER_SETTINGS),
    listGroups: async () => groups,
    listUserGroupIds: async (_t: string, u: string) => groups.filter((g) => g.memberIds.includes(u)).map((g) => g.id),
    findUserById: async (_t: string, u: string) => USERS.find((x) => x.id === u) ?? null,
    listUsers: async () => USERS,
    createNotification: async (n: Notification) => { sent.push(n); },
    appendAudit: async (e: { action: string }) => { audits.push(e.action); },
    getGoogleConnection: async () => null,
    setGroupChatSpace: async () => undefined,
  } as unknown as Repository;
  const connector = chat ? {
    sourceFor: () => 'google',
    chat: {
      listSpaces: async () => chat.spaces,
      members: async (_p: unknown, space: string, emails: string[]) => {
        const m = chat.members[space];
        if (!m) return null;
        return { humans: m.in.length, googleGroups: 0, external: m.external ?? 0, present: emails.filter((e) => m.in.includes(e)), absent: emails.filter((e) => !m.in.includes(e)), unknown: [] };
      },
      findSpace: async (_p: unknown, name: string) => ({ reason: `「${name}」がありません` }),
      post: async (_p: unknown, msg: { space: string; text: string }) => { posts.push(msg); return { messageId: 'm1' }; },
    },
  } as unknown as WorkspaceConnector : null;
  const store = new MemoryNoticeStore({ 'u-admin': '管理者', 'u-a': '佐藤' });
  const notices = new NoticeService({ store, repo, ...(connector ? { chat: { connector, repo } } : {}) });
  return { notices, store, sent, audits, posts };
}

/** 2026-11-20 10:00（日本時間）。 */
const NOW = new Date('2026-11-20T01:00:00.000Z');
const at = (day: string, hour: number) => new Date(new Date(`${day}T00:00:00+09:00`).getTime() + hour * 3_600_000);

test('済んだ人の数: 出した人と管理者だけ。済んでいない人の名前は締切を過ぎてから', async () => {
  const s = setup();
  const r = await s.notices.create('t1', 'u-a', { title: '年末調整の書類', all: true, dueOn: '2026-11-25' }, NOW);
  assert.ok('notice' in r);
  await s.notices.done('t1', 'u-b', r.notice.id, NOW);
  const mine = await s.notices.progress('t1', 'u-a', r.notice.id, NOW);
  assert.ok(!('error' in mine));
  assert.deepEqual({ total: mine.total, done: mine.done, notDone: mine.notDone }, { total: 4, done: 1, notDone: null });
  assert.ok('error' in (await s.notices.progress('t1', 'u-c', r.notice.id, NOW)), 'ほかの人は見られない');
  const later = await s.notices.progress('t1', 'u-admin', r.notice.id, new Date('2026-11-26T01:00:00Z'));
  assert.ok(!('error' in later));
  assert.deepEqual(later.notDone, ['管理者', '佐藤', '高橋']);
});

test('締切の前の知らせ: 3 日前と当日の朝 8 時から、済んでいない・止めていない宛先の人に 1 度だけ', async () => {
  const s = setup();
  const r = await s.notices.create('t1', 'u-admin', { title: '健康診断の申し込み', all: false, groupIds: ['g-dev'], dueOn: '2026-11-25' }, NOW);
  assert.ok('notice' in r);
  assert.equal(await s.notices.remind('t1', at('2026-11-22', 7)), 0, '朝 8 時より前は出さない');
  assert.equal(await s.notices.remind('t1', at('2026-11-22', 9)), 2);
  assert.deepEqual(s.sent.map((n) => [n.userId, n.kind, n.title]), [
    ['u-a', 'notice', '「健康診断の申し込み」の締切まで 3 日です'], ['u-b', 'notice', '「健康診断の申し込み」の締切まで 3 日です'],
  ]);
  assert.equal(await s.notices.remind('t1', at('2026-11-22', 10)), 0, '同じ日は 1 度だけ');
  assert.equal(await s.notices.remind('t1', at('2026-11-23', 9)), 0, '2 日前は出さない');
  await s.notices.done('t1', 'u-a', r.notice.id, at('2026-11-24', 9));
  await s.notices.mute('t1', 'u-b', r.notice.id, at('2026-11-24', 9));
  assert.equal(await s.notices.remind('t1', at('2026-11-25', 8)), 0, '済んだ人・止めた人には出さない');
  const r2 = await s.notices.create('t1', 'u-admin', { title: '鍵の返却', all: true, dueOn: '2026-11-25' }, NOW);
  assert.ok('notice' in r2);
  assert.equal(await s.notices.remind('t1', at('2026-11-25', 8)), 4);
  assert.match(s.sent[s.sent.length - 1]!.title, /「鍵の返却」の締切は今日です/);
});

test('Chat: グループ宛ては合うスペースに、社内の人だけと確かめたときだけ 1 回投稿する', async () => {
  const s = setup({
    spaces: [{ space: 'spaces/dev', displayName: '開発チーム', external: false }],
    members: { 'spaces/dev': { in: ['a@a.example.jp', 'b@a.example.jp'] } },
  });
  const r = await s.notices.create('t1', 'u-admin', { title: '健康診断の申し込み', link: 'https://example.jp/k', all: false, groupIds: ['g-dev'], dueOn: '2026-12-05' }, NOW);
  assert.ok('notice' in r);
  await new Promise((x) => setTimeout(x, 0));
  assert.equal(s.posts.length, 1);
  assert.equal(s.posts[0]!.space, 'spaces/dev');
  assert.equal(s.posts[0]!.text, '【お知らせ】健康診断の申し込み（締切 12/5）\nhttps://example.jp/k\n管理者 より');
  assert.ok(s.audits.includes('notice.chat_post'));
  assert.deepEqual(await s.notices.postToChat('t1', r.notice), { skipped: 'すでに投稿しています' });
  // 会社の外の人がいるスペースには投稿しない
  const ext = setup({
    spaces: [{ space: 'spaces/dev', displayName: '開発チーム', external: false }],
    members: { 'spaces/dev': { in: ['a@a.example.jp', 'b@a.example.jp'], external: 1 } },
  });
  const r2 = await ext.notices.create('t1', 'u-admin', { title: '健康診断', all: false, groupIds: ['g-dev'] }, NOW);
  assert.ok('notice' in r2);
  assert.deepEqual(await ext.notices.postToChat('t1', r2.notice), { skipped: '社内の人だけのスペースだと確かめられませんでした' });
  assert.equal(ext.posts.length, 0);
  // 全員宛ては、全員が入っているスペースが 1 つに決まったときだけ
  const all = setup({
    spaces: [{ space: 'spaces/all', displayName: '全社', external: false }, { space: 'spaces/dev', displayName: '開発チーム', external: false }],
    members: { 'spaces/all': { in: USERS.map((u) => u.email) }, 'spaces/dev': { in: ['a@a.example.jp'] } },
  });
  const r3 = await all.notices.create('t1', 'u-admin', { title: '大掃除', all: true }, NOW);
  assert.ok('notice' in r3);
  await new Promise((x) => setTimeout(x, 0));
  assert.deepEqual(all.posts.map((p) => p.space), ['spaces/all']);
});

test('秘書: 出した人が「何人済んだ？」と聞けば数で答え、本人が「もう知らせないで」と言えば締切の前の知らせを止める', async () => {
  const s = setup();
  const r = await s.notices.create('t1', 'u-a', { title: '年末調整の書類', all: true, dueOn: '2026-11-25' }, NOW);
  assert.ok('notice' in r);
  await s.notices.done('t1', 'u-b', r.notice.id, NOW);
  const llm: LlmProvider = { name: 'fake', complete: async () => ({ text: JSON.stringify({ id: r.notice.id }), tokensUsed: 1 }) };
  const repo = { listGroups: async () => [], getUserSettings: async () => structuredClone(DEFAULT_USER_SETTINGS), findUserById: async (_t: string, u: string) => USERS.find((x) => x.id === u) ?? null, listUserGroupIds: async () => [] } as unknown as Repository;
  const deps = { notices: s.notices, repo, llm };
  const p = await answerNotice(deps, 't1', 'u-a', '年末調整のお知らせ、何人済んだ？', NOW);
  assert.equal(p?.action, 'progress');
  assert.match(p?.text ?? '', /宛先 4 人のうち、済んだ人が 1 人です。\n済んでいない人の名前は、締切を過ぎてからお伝えします/);
  const m = await answerNotice(deps, 't1', 'u-c', '年末調整はもう知らせないで', NOW);
  assert.equal(m?.action, 'mute');
  assert.equal(await s.notices.remind('t1', at('2026-11-22', 9)), 2, '止めた人（高橋）と済んだ人（鈴木）には出さない');
});

