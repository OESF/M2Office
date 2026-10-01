/**
 * @file 朝のブリーフの人ごとの中身と、社内のお知らせの単体テスト（仕様書 第9.5.5.1.1節・第10.15節、ADR-0047）。
 *
 * お知らせの宛先・期間・初めて載せたか・済んだ・取り下げ（出した人と管理者だけ）・会社の境界、
 * ツール `notices.list`・`brief.settings`、秘書が最初の分野を選ぶこと、会話で中身を直すこと、
 * 秘書がお知らせを出す・取り下げること、ブリーフが「完了」でなく「ブリーフ」の通知として中身ごと届くことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TENANT_SETTINGS, DEFAULT_USER_SETTINGS,
  type AgentDefinition, type Job, type Notification, type Run, type UserSettings,
} from '@m2office/shared';
import {
  BUILTIN_TOOLS, MemoryFileStore, MemoryNoticeStore, MockWorkspaceConnector, NoticeService, RunEngine, ToolRegistry,
  answerBriefSettings, answerNotice, seedBriefTopics,
  type LlmProvider, type LlmRequest, type Repository, type ToolContext,
} from '../src/index.js';

const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);

/** お知らせと設定が使う操作だけを持つ、記憶上の永続化層。 */
function fakeRepo() {
  const settings = new Map<string, UserSettings>();
  const audits: { action: string; tenantId: string }[] = [];
  const users = [
    { id: 'u-admin', tenantId: 't1', displayName: '管理者', roles: ['admin'] },
    { id: 'u-a', tenantId: 't1', displayName: '佐藤', roles: ['member'] },
    { id: 'u-b', tenantId: 't1', displayName: '鈴木', roles: ['member'] },
    { id: 'u-x', tenantId: 't2', displayName: '他社', roles: ['admin'] },
  ];
  const groups = [
    { id: 'g-dev', tenantId: 't1', name: '開発', description: '', memberIds: ['u-b'] },
    { id: 'g-other', tenantId: 't2', name: '開発', description: '', memberIds: ['u-x'] },
  ];
  const key = (t: string, u: string) => `${t}:${u}`;
  const repo = {
    settings, audits,
    getUserSettings: async (t: string, u: string) => settings.get(key(t, u)) ?? structuredClone(DEFAULT_USER_SETTINGS),
    saveUserSettings: async (t: string, u: string, section: keyof UserSettings, value: unknown) => {
      const cur = settings.get(key(t, u)) ?? structuredClone(DEFAULT_USER_SETTINGS);
      settings.set(key(t, u), { ...cur, [section]: value } as UserSettings);
    },
    listGroups: async (t: string) => groups.filter((g) => g.tenantId === t),
    listUserGroupIds: async (t: string, u: string) => groups.filter((g) => g.tenantId === t && g.memberIds.includes(u)).map((g) => g.id),
    findUserById: async (t: string, u: string) => users.find((x) => x.tenantId === t && x.id === u) ?? null,
    getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, company: { ...DEFAULT_TENANT_SETTINGS.company, shortName: '見本' } }),
    appendAudit: async (e: { action: string; tenantId: string }) => { audits.push(e); },
  };
  return repo;
}

function setup() {
  const repo = fakeRepo();
  const store = new MemoryNoticeStore({ 'u-admin': '管理者', 'u-a': '佐藤', 'u-b': '鈴木', 'u-x': '他社' });
  const notices = new NoticeService({ store, repo: repo as unknown as Repository });
  return { repo, store, notices };
}

/** 2026-11-20 10:00（日本時間）。 */
const NOW = new Date('2026-11-20T01:00:00.000Z');

test('お知らせ: 全員宛ては全員に、グループ宛てはその人にだけ載る。初めては本文ごと、次からは 1 行', async () => {
  const { notices } = setup();
  const a = await notices.create('t1', 'u-a', { title: '年末調整の書類', body: '12/5 までに総務へ', all: true, dueOn: '2026-12-05' }, NOW);
  assert.ok('notice' in a);
  const b = await notices.create('t1', 'u-admin', { title: '健康診断の申し込み', link: 'https://example.jp/kenshin', all: false, groupIds: ['g-dev'] }, NOW);
  assert.ok('notice' in b);
  assert.equal(b.notice.until, '2026-12-04', '締切が無ければ出した日から 14 日');

  const forA = await notices.forUser('t1', 'u-a', NOW);
  assert.deepEqual(forA.map((n) => n.title), ['年末調整の書類'], 'グループの外の人には載らない');
  assert.equal(forA[0]!.daysLeft, 15);
  const forB = await notices.forUser('t1', 'u-b', NOW, { markShown: true });
  assert.equal(forB.length, 2);
  assert.ok(forB.every((n) => n.isNew), '初めて載せるもの');
  const again = await notices.forUser('t1', 'u-b', NOW);
  assert.ok(again.every((n) => !n.isNew), '一度載せたら 1 行で');
  assert.ok((await notices.forUser('t1', 'u-a', NOW)).every((n) => n.isNew), 'ほかの人の受け取りは別');
});

test('お知らせ: 入力を確かめる（題名・https のリンク・無いグループ・過ぎた締切）', async () => {
  const { notices } = setup();
  assert.deepEqual(await notices.create('t1', 'u-a', { title: '', all: true }, NOW), { error: '題名が要ります' });
  assert.match(String((await notices.create('t1', 'u-a', { title: 'x', link: 'http://example.jp', all: true }, NOW) as { error: string }).error), /https/);
  assert.match(String((await notices.create('t1', 'u-a', { title: 'x', all: false, groupIds: ['g-other'] }, NOW) as { error: string }).error), /グループが見つかりません/, 'ほかの会社のグループは宛先にできない');
  assert.match(String((await notices.create('t1', 'u-a', { title: 'x', all: true, dueOn: '2026-11-01' }, NOW) as { error: string }).error), /過ぎて/);
});

test('お知らせ: 済んだら載せない。取り下げは出した人と管理者だけ。期間を過ぎたら載せない', async () => {
  const { notices, repo } = setup();
  const made = await notices.create('t1', 'u-a', { title: '年末調整の書類', all: true, dueOn: '2026-12-05' }, NOW) as { notice: { id: string } };
  const id = made.notice.id;
  assert.ok('notice' in await notices.done('t1', 'u-b', id, NOW));
  assert.equal((await notices.forUser('t1', 'u-b', NOW)).length, 0, '済んだ人には載せない');
  assert.equal((await notices.forUser('t1', 'u-admin', NOW)).length, 1, 'ほかの人には載る');

  const denied = await notices.withdraw('t1', 'u-b', id, NOW);
  assert.ok('error' in denied && denied.status === 403, '出していない一般の人は取り下げられない');
  assert.ok('notice' in await notices.withdraw('t1', 'u-admin', id, NOW), '管理者は取り下げられる');
  assert.equal((await notices.forUser('t1', 'u-admin', NOW)).length, 0);
  assert.ok(repo.audits.some((a) => a.action === 'notice.create') && repo.audits.some((a) => a.action === 'notice.withdraw'));

  await notices.create('t1', 'u-a', { title: '期間のあるもの', all: true, until: '2026-11-21' }, NOW);
  assert.equal((await notices.forUser('t1', 'u-a', new Date('2026-11-22T01:00:00.000Z'))).length, 0, '期間を過ぎたら載せない');
});

test('お知らせ: ほかの会社のものは見えず、取り下げもできない（不変則 I-2）', async () => {
  const { notices } = setup();
  const made = await notices.create('t1', 'u-a', { title: 'A 社のお知らせ', all: true }, NOW) as { notice: { id: string } };
  assert.equal((await notices.forUser('t2', 'u-x', NOW)).length, 0);
  const r = await notices.withdraw('t2', 'u-x', made.notice.id, NOW);
  assert.ok('error' in r && r.status === 404, 'ほかの会社の管理者には「見つからない」');
});

function ctx(repo: ReturnType<typeof fakeRepo>, notices?: NoticeService, userId = 'u-b'): ToolContext {
  return {
    tenantId: 't1', userId, runId: 'r', compartment: null,
    repo: repo as unknown as Repository, connector: {} as never, files: {} as never, ...(notices ? { notices } : {}),
  };
}

test('ツール notices.list: 本人宛てを返し、初めて返したものを「載せた」と記録する。読むだけ', async () => {
  const { repo, notices } = setup();
  await notices.create('t1', 'u-a', { title: '年末調整の書類', body: '総務へ', all: true, dueOn: '2026-12-05' }, NOW);
  const tool = registry.get('notices.list')!;
  assert.equal(tool.risk, 'read');
  const first = await tool.invoke({}, ctx(repo, notices)) as { notices: { title: string; isNew: boolean }[] };
  assert.deepEqual(first.notices.map((n) => [n.title, n.isNew]), [['年末調整の書類', true]]);
  const second = await tool.invoke({}, ctx(repo, notices)) as { notices: { isNew: boolean }[] };
  assert.equal(second.notices[0]!.isNew, false);
  const none = await tool.invoke({}, ctx(repo)) as { notices: unknown[]; note?: string };
  assert.equal(none.notices.length, 0);
  assert.match(String(none.note), /読めませんでした/, '読めないときは空として扱わせない');
});

test('ツール brief.settings: 分野と外した項目を返し、秘書が選んだことは一度だけ伝える', async () => {
  const { repo } = setup();
  await repo.saveUserSettings('t1', 'u-b', 'brief', {
    topics: [{ label: '技術の動き', query: '生成AI 最新ニュース' }], omit: ['weather'], seededAt: NOW.toISOString(), seedNote: true,
  });
  const tool = registry.get('brief.settings')!;
  assert.equal(tool.risk, 'read');
  const a = await tool.invoke({}, ctx(repo)) as { topics: unknown[]; omit: string[]; seededTopics: boolean };
  assert.deepEqual(a.omit, ['天気']);
  assert.equal(a.seededTopics, true);
  const b = await tool.invoke({}, ctx(repo)) as { seededTopics: boolean };
  assert.equal(b.seededTopics, false, '二度目は伝えない');
});

/** 決まった答えを返し、渡されたものを控える推論の代わり。 */
class FakeLlm implements LlmProvider {
  readonly name = 'fake';
  readonly seen: LlmRequest[] = [];
  constructor(private readonly reply: (req: LlmRequest) => string) {}
  async complete(req: LlmRequest) {
    this.seen.push(req);
    return { text: this.reply(req), tokensUsed: 10 };
  }
}

test('最初の分野: 役職・グループ・会社の名前から秘書が選び、一度だけ。推論が使えなければ選ばない', async () => {
  const { repo } = setup();
  await repo.saveUserSettings('t1', 'u-b', 'profile', { ...DEFAULT_USER_SETTINGS.profile, title: 'エンジニア' });
  const llm = new FakeLlm(() => '{"topics": [{"label": "技術の動き", "query": "生成AI 最新ニュース"}]}');
  const picked = await seedBriefTopics(repo as unknown as Repository, llm, 't1', 'u-b', NOW);
  assert.deepEqual(picked, [{ label: '技術の動き', query: '生成AI 最新ニュース' }]);
  const sent = String(llm.seen[0]!.messages.at(-1)!.content);
  assert.match(sent, /エンジニア/);
  assert.match(sent, /開発/, '所属のグループの名前を渡す');
  const b = (await repo.getUserSettings('t1', 'u-b')).brief;
  assert.equal(b.seedNote, true);
  assert.equal(await seedBriefTopics(repo as unknown as Repository, llm, 't1', 'u-b', NOW), null, '二度は選ばない');
  assert.equal(llm.seen.length, 1);

  const stub = new FakeLlm(() => '{}');
  (stub as { name: string }).name = 'stub';
  assert.equal(await seedBriefTopics(repo as unknown as Repository, stub, 't1', 'u-a', NOW), null);
  assert.equal((await repo.getUserSettings('t1', 'u-a')).brief.seededAt, null, '推論が使えるようになってから選ぶ');
});

test('会話で直す: 足す・項目を外す。定時実行の操作と、ブリーフの話でないものは扱わない', async () => {
  const { repo } = setup();
  const llm = new FakeLlm(() => '{"about": true, "add": [{"label": "経済・金融", "query": "日経平均 為替 今日"}], "set": [], "remove": [], "omit": ["天気"], "restore": [], "ask": false}');
  const a = await answerBriefSettings(repo as unknown as Repository, llm, 't1', 'u-a', '毎朝のブリーフに為替と日経平均も入れて。天気はいらない');
  assert.ok(a);
  assert.match(a.text, /直しました/);
  const b = (await repo.getUserSettings('t1', 'u-a')).brief;
  assert.deepEqual(b.topics.map((t) => t.label), ['経済・金融']);
  assert.deepEqual(b.omit, ['weather']);
  assert.ok(b.seededAt, '本人が決めたら、秘書は最初の分野を選び直さない');

  assert.equal(await answerBriefSettings(repo as unknown as Repository, llm, 't1', 'u-a', '朝のブリーフを止めて'), null, '定時実行の停止は定時実行の答えへ');
  assert.equal(await answerBriefSettings(repo as unknown as Repository, llm, 't1', 'u-a', '明日の会議の資料を作って'), null);
  const notAbout = new FakeLlm(() => '{"about": false}');
  assert.equal(await answerBriefSettings(repo as unknown as Repository, notAbout, 't1', 'u-a', '毎朝ニュースを見るのが日課です'), null);
});

test('秘書: 「全員に〜伝えて」でお知らせを出す。無いグループなら聞き返す。取り下げ・済んだ', async () => {
  const { repo, notices } = setup();
  const created = new FakeLlm(() => '{"about": true, "title": "年末調整の書類の提出", "body": "12 月 5 日までに総務へ出してください", "link": "", "all": true, "groups": [], "dueOn": "2026-12-05", "until": null}');
  const deps = { notices, repo: repo as unknown as Repository, llm: created };
  const a = await answerNotice(deps, 't1', 'u-a', '全員に、年末調整の書類を 12 月 5 日までに出すよう伝えて', NOW);
  assert.equal(a?.action, 'create');
  assert.equal((await notices.forUser('t1', 'u-b', NOW)).length, 1);

  const unknown = new FakeLlm(() => '{"about": true, "title": "x", "body": "", "link": "", "all": false, "groups": ["経理部"], "dueOn": null, "until": null}');
  const ask = await answerNotice({ ...deps, llm: unknown }, 't1', 'u-a', '経理部に、請求書の締めを伝えて', NOW);
  assert.equal(ask?.action, 'ask');
  assert.match(ask!.text, /経理部/);
  assert.match(ask!.text, /開発/, 'ある会社のグループを示す');

  const id = (await notices.forUser('t1', 'u-b', NOW))[0]!.id;
  const pickIt = new FakeLlm(() => JSON.stringify({ id }));
  const done = await answerNotice({ ...deps, llm: pickIt }, 't1', 'u-b', '年末調整、出したよ', NOW);
  assert.equal(done?.action, 'done');
  assert.equal((await notices.forUser('t1', 'u-b', NOW)).length, 0);

  const denied = await answerNotice({ ...deps, llm: pickIt }, 't1', 'u-b', '年末調整のお知らせを取り下げて', NOW);
  assert.equal(denied?.action, 'ask', '出していない一般の人は取り下げられない');
  const ok = await answerNotice({ ...deps, llm: pickIt }, 't1', 'u-a', '年末調整のお知らせを取り下げて', NOW);
  assert.equal(ok?.action, 'withdraw');
});

test('ブリーフの業務が終わったら、「完了」を切っている人にも「ブリーフ」の通知として中身ごと届く', async () => {
  const created: Notification[] = [];
  const steps: Record<string, unknown>[] = [];
  const now = new Date().toISOString();
  const job: Job = { id: 'j1', tenantId: 't', agentId: 'brief-test', agentVersion: 1, requestedBy: 'u', origin: 'schedule', input: {}, createdAt: now };
  const runs: Run[] = [{ id: 'r1', jobId: 'j1', tenantId: 't', status: 'running', cursor: 0, startedAt: now, endedAt: null, tokensUsed: 0, costJpy: 0, savedMinutes: 0, failureReason: null }];
  const prefs = structuredClone(DEFAULT_USER_SETTINGS);
  prefs.notifications.kinds.run = false;
  const repo = {
    getJob: async () => job, getRun: async () => runs[0] ?? null, updateRun: async (r: Run) => { runs[0] = r; },
    listRunSteps: async () => steps, appendRunStep: async (_t: string, s: Record<string, unknown>) => { steps.push(s); },
    updateRunStep: async (_t: string, s: Record<string, unknown>) => { steps[steps.findIndex((x) => x['id'] === s['id'])] = s; },
    appendAudit: async () => undefined, createNotification: async (n: Notification) => { created.push(n); },
    listNotifications: async () => created, listArtifacts: async () => [],
    findUserById: async () => ({ id: 'u', tenantId: 't', displayName: '三浦', roles: ['member'] }),
    getTenantSettings: async () => DEFAULT_TENANT_SETTINGS, getUserSettings: async () => prefs,
    listUserCompartments: async () => [], listUserGroupIds: async () => [],
  };
  const def: AgentDefinition = {
    schemaVersion: 1, id: 'brief-test', version: 1, name: '朝のブリーフ', category: 'briefing', description: 'テスト',
    locale: 'ja-JP', compartment: null, inputs: {}, tools: [],
    steps: [{ id: 'write', type: 'agent', instruction: 'まとめる' }],
    constraints: [], limits: { maxSteps: 3, maxTokens: 10_000, timeoutSec: 60 },
  };
  const engine = new RunEngine({
    repo: repo as unknown as Repository, llm: new FakeLlm(() => '今日は雨です。傘をお持ちください。'), registry,
    connector: new MockWorkspaceConnector(), files: new MemoryFileStore(), resolveDefinition: () => def,
  });
  const res = await engine.advance(runs[0]!);
  assert.equal(res.outcome, 'completed');
  assert.equal(created.length, 1);
  assert.equal(created[0]!.kind, 'brief');
  assert.match(created[0]!.title, /^朝のブリーフ（\d+\/\d+）$/);
  assert.equal(created[0]!.body, '今日は雨です。傘をお持ちください。', '本文にブリーフをそのまま入れる');
});

test('前の段の結果: 上限を超えても各段の文を残し、後ろの段を落とさない（第9.3.2節）', async () => {
  const { previousResults } = await import('../src/engine/run-engine.js');
  const small = previousResults([{ stepId: 'a', kind: 'agent', output: { text: '短い', tools: [] } }]);
  assert.match(small, /"短い"/, '収まればそのまま渡す');
  const huge = 'x'.repeat(30_000);
  const out = previousResults([
    { stepId: 'collect', kind: 'agent', output: { text: '予定は 2 件', tools: [{ name: 'calendar.list', result: huge }] } },
    { stepId: 'outside', kind: 'agent', output: { text: '経済・金融: 日経平均は最高値', tools: [{ name: 'web.research', result: huge }] } },
  ]);
  assert.ok(out.length <= 17_000, '上限の近くに収める');
  assert.match(out, /予定は 2 件/);
  assert.match(out, /日経平均は最高値/, '後ろの段の文が届く（2026-09-28 に届かなかった）');
  assert.match(out, /省略/);
});

test('会話で直す: 「週のブリーフに〜いらない」は週だけを外し、朝は変えない（ADR-0048）', async () => {
  const { repo } = setup();
  const llm = new FakeLlm(() => '{"about": true, "target": "weekly", "add": [], "set": [], "remove": [], "omit": ["天気予報", "イベント"], "restore": [], "ask": false}');
  const a = await answerBriefSettings(repo as unknown as Repository, llm, 't1', 'u-a', '週のブリーフに天気予報とイベントはいらない');
  assert.ok(a);
  assert.match(a.text, /週のブリーフを直しました/);
  const b = (await repo.getUserSettings('t1', 'u-a')).brief;
  assert.deepEqual(b.weeklyOmit, ['weather', 'events']);
  assert.deepEqual(b.omit, [], '朝のブリーフは変えない');
  const restore = new FakeLlm(() => '{"about": true, "target": "weekly", "add": [], "set": [], "remove": [], "omit": [], "restore": ["天気"], "ask": false}');
  await answerBriefSettings(repo as unknown as Repository, restore, 't1', 'u-a', '週のブリーフの天気を戻して');
  assert.deepEqual((await repo.getUserSettings('t1', 'u-a')).brief.weeklyOmit, ['events'], '「天気」も週では天気予報として戻す');
});
