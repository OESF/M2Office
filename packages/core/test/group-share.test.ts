/**
 * @file グループの名前で共有を頼めるようにする仕組みの単体テスト（仕様書 第16.7.12.1節、ADR-0076）。
 * 名前の整え方、メンバーの重なりの選び方、グループに合うスペースの探し方（覚えた組み合わせ → 名前 → メンバー → 決まらなければ止める）、
 * 承認の画面に出す届く先の説明（メンバーの数・会社の外の人・グループとの違い・確かめられないときは社内と言わない）、chat.post の確かめ。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GroupChatSpace, UserGroup } from '@m2office/shared';
import {
  namesMatch, normalizeGroupName, pickByOverlap, reachNotes, resolveGroupSpace,
  type ChatSpaceMembers, type Repository, type ToolContext, type WorkspaceConnector,
} from '../src/index.js';
import { chatPost } from '../src/tools/workspace.js';

const p = { tenantId: 't1', userId: 'u1' };
const USERS = [
  { id: 'u1', email: 'u1@alpha.example.jp', displayName: '山田', status: 'active', roles: ['member'] },
  { id: 'u2', email: 'u2@alpha.example.jp', displayName: '佐藤', status: 'active', roles: ['member'] },
  { id: 'u3', email: 'u3@alpha.example.jp', displayName: '鈴木', status: 'active', roles: ['member'] },
];

function setup(opts: {
  groups?: UserGroup[];
  spaces?: { space: string; displayName: string; external: boolean }[];
  members?: Record<string, { in: string[]; humans: number; external?: number | null; groups?: number }>;
} = {}) {
  const groups: UserGroup[] = opts.groups ?? [{ id: 'g1', tenantId: 't1', name: '技術部', description: '', memberIds: ['u1', 'u2', 'u3'], chatSpace: null }];
  const saved: { groupId: string; link: GroupChatSpace | null }[] = [];
  const repo = {
    listGroups: async () => groups,
    setGroupChatSpace: async (_t: string, groupId: string, link: GroupChatSpace | null) => {
      saved.push({ groupId, link });
      const g = groups.find((x) => x.id === groupId);
      if (g) g.chatSpace = link;
    },
    getGoogleConnection: async () => null,
    findUserById: async (_t: string, id: string) => USERS.find((u) => u.id === id) ?? null,
  } as unknown as Repository;
  const spaces = opts.spaces ?? [];
  const members = opts.members ?? {};
  const connector = {
    sourceFor: () => 'google',
    chat: {
      listSpaces: async () => spaces,
      members: async (_p: unknown, space: string, emails: string[]): Promise<ChatSpaceMembers | null> => {
        const m = members[space];
        if (!m) return null;
        return {
          humans: m.humans, googleGroups: m.groups ?? 0, external: m.external === undefined ? 0 : m.external,
          present: emails.filter((e) => m.in.includes(e)), absent: emails.filter((e) => !m.in.includes(e)), unknown: [],
        };
      },
      findSpace: async (_p: unknown, input: string) => {
        const s = spaces.find((x) => x.displayName === input);
        return s ? { space: s.space, displayName: s.displayName, external: s.external } : { reason: `「${input}」という名前のチャットのスペースが見つかりません` };
      },
      post: async () => ({ messageId: 'm1' }),
    },
  } as unknown as WorkspaceConnector;
  return { repo, connector, groups, saved };
}

const E = (id: string) => `${id}@alpha.example.jp`;

test('名前: 全角と半角・括弧の中・「チーム」「グループ」などの言い添えを除いて比べる', () => {
  assert.equal(normalizeGroupName('技術部（全体）'), '技術部');
  assert.equal(normalizeGroupName('ＳＡＬＥＳ チーム'), 'sales');
  assert.equal(namesMatch('技術部', '技術部（全体）'), true);
  assert.equal(namesMatch('技術部', '技術チーム'), true);
  assert.equal(namesMatch('技術部', '営業部'), false);
  assert.equal(namesMatch('部', '技術部'), false);
});

test('メンバーの重なり: 下限を超え、ほかより大きいものだけを選ぶ', () => {
  assert.equal(pickByOverlap([{ space: 'a', ratio: 0.9 }, { space: 'b', ratio: 0.3 }]), 'a');
  assert.equal(pickByOverlap([{ space: 'a', ratio: 0.5 }]), null);
  assert.equal(pickByOverlap([{ space: 'a', ratio: 1 }, { space: 'b', ratio: 1 }]), null);
  assert.equal(pickByOverlap([]), null);
});

test('探す: グループでなければ・同じ名前のスペースがあれば、これまでどおりスペースの名前で探す', async () => {
  const s = setup({ spaces: [{ space: 'spaces/1', displayName: '技術部', external: false }] });
  assert.deepEqual(await resolveGroupSpace(s, p, '営業部'), { kind: 'not-group' });
  assert.deepEqual(await resolveGroupSpace(s, p, '技術部'), { kind: 'not-group' });
  assert.deepEqual(await resolveGroupSpace(s, p, 'spaces/AAA'), { kind: 'not-group' });
});

test('探す: 名前が 1 つに合えば選んで覚え、次は覚えた組み合わせを使う', async () => {
  const s = setup({ spaces: [{ space: 'spaces/t', displayName: '技術チーム', external: false }, { space: 'spaces/s', displayName: '営業部', external: false }] });
  const r = await resolveGroupSpace(s, p, '技術部');
  assert.equal(r.kind, 'found');
  assert.equal(r.kind === 'found' && r.space, 'spaces/t');
  assert.equal(r.kind === 'found' && r.by, 'name');
  assert.deepEqual(r.kind === 'found' && r.emails, [E('u1'), E('u2'), E('u3')]);
  assert.equal(s.saved[0]!.link!.space, 'spaces/t');
  // 覚えた組み合わせ（教えてもらったもの）が先
  s.groups[0]!.chatSpace = { space: 'spaces/s', name: '営業部', by: 'told', at: '2026-10-07T00:00:00Z' };
  const again = await resolveGroupSpace(s, p, '技術部のみなさん');
  assert.equal(again.kind === 'found' && again.space, 'spaces/s');
  assert.equal(again.kind === 'found' && again.by, 'told');
});

test('探す: 名前で決まらなければメンバーの重なりで選ぶ。決まらなければ候補を挙げて止める', async () => {
  const spaces = [{ space: 'spaces/a', displayName: '開発の連絡', external: false }, { space: 'spaces/b', displayName: '雑談', external: false }];
  const s = setup({ spaces, members: { 'spaces/a': { in: [E('u1'), E('u2'), E('u3')], humans: 4 }, 'spaces/b': { in: [E('u1')], humans: 20 } } });
  const r = await resolveGroupSpace(s, p, '技術部');
  assert.equal(r.kind === 'found' && r.space, 'spaces/a');
  assert.equal(r.kind === 'found' && r.by, 'members');
  // 重なりが同じなら決めない
  const tie = setup({ spaces, members: { 'spaces/a': { in: [E('u1'), E('u2')], humans: 4 }, 'spaces/b': { in: [E('u1'), E('u2')], humans: 4 } } });
  const t = await resolveGroupSpace(tie, p, '技術部');
  assert.equal(t.kind, 'problem');
  assert.match(t.kind === 'problem' ? t.reason : '', /1 つに決められません.*開発の連絡/);
  assert.equal(tie.saved.length, 0, '決まらなければ覚えない');
  // 合うものが無い
  const none = setup({ spaces, members: {} });
  assert.match(((await resolveGroupSpace(none, p, '技術部')) as { reason: string }).reason, /見つかりません.*Chat でスペースを作る/);
});

test('届く先の説明: メンバーの数・グループとの違いを出し、会社の外の人・Google のグループ・確かめられないときは社内と言わない', async () => {
  const s = setup({ members: {
    'spaces/t': { in: [E('u1'), E('u2')], humans: 5 },
    'spaces/x': { in: [E('u1'), E('u2'), E('u3')], humans: 3, external: 1 },
    'spaces/g': { in: [E('u1'), E('u2'), E('u3')], humans: 3, groups: 1 },
  } });
  const g = s.groups[0]!;
  const emails = [E('u1'), E('u2'), E('u3')];
  const r = await reachNotes(s, p, 'spaces/t', { group: g, by: 'name', emails });
  assert.equal(r.internalOnly, true);
  assert.deepEqual(r.notes, [
    'グループ「技術部」に合う Chat のスペースです（名前が合いました）',
    'メンバー 5 人',
    'グループにいて、スペースにいない人（読めません）: 鈴木',
    'スペースにいて、グループにいない人（届きます）: 3 人',
  ]);
  const ext = await reachNotes(s, p, 'spaces/x', { group: g, by: 'members', emails });
  assert.equal(ext.internalOnly, false);
  assert.match(ext.notes[1]!, /うち会社の外の人 1 人/);
  assert.equal((await reachNotes(s, p, 'spaces/g', null)).internalOnly, false);
  const unknown = await reachNotes(s, p, 'spaces/none', null);
  assert.deepEqual(unknown, { notes: ['スペースのメンバーを確かめられませんでした'], internalOnly: false });
});

test('chat.post: グループの名前で頼むと合うスペースに決め、届く先の説明を添える。社内だけなら承認を自動で通せる', async () => {
  const s = setup({
    spaces: [{ space: 'spaces/t', displayName: '技術チーム', external: false }],
    members: { 'spaces/t': { in: [E('u1'), E('u2'), E('u3')], humans: 3 } },
  });
  const ctx = { tenantId: 't1', userId: 'u1', repo: s.repo, connector: s.connector } as unknown as ToolContext;
  const r = await chatPost.prepare!({ space: '技術部', text: '議事録です' }, ctx);
  assert.equal(r.kind, 'ready');
  if (r.kind !== 'ready') return;
  assert.equal(r.args['space'], 'spaces/t');
  assert.equal(r.shown, '技術チーム（グループ「技術部」）');
  assert.equal(r.audience, 'internal');
  assert.ok(r.notes?.includes('メンバー 3 人'));
  // メンバーを確かめられなければ社外として扱う（承認に回す）
  const s2 = setup({ spaces: [{ space: 'spaces/t', displayName: '技術チーム', external: false }] });
  const r2 = await chatPost.prepare!({ space: '技術部', text: 'x' }, { ...ctx, repo: s2.repo, connector: s2.connector } as unknown as ToolContext);
  assert.equal(r2.kind === 'ready' && r2.audience, 'external');
  // 合うスペースが無ければ行えない
  const s3 = setup({ spaces: [{ space: 'spaces/z', displayName: '雑談', external: false }] });
  const r3 = await chatPost.prepare!({ space: '技術部', text: 'x' }, { ...ctx, repo: s3.repo, connector: s3.connector } as unknown as ToolContext);
  assert.equal(r3.kind, 'problem');
});
