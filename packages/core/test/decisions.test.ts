/**
 * @file 意思決定支援（仕様書 第43章）の確かめ。発言の形の読み取り、ターンの配り方、討論の流れ（本討論・途中のまとめ・深掘り・終わりのまとめ・報告）、
 * 早めの終わり、突き合わせ、止める、見せる範囲、書かれるそばから置き場に書き足すこと、OpenAI 互換の少しずつの応答の読み取りを見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, decisionMainTurns, clampDecisionTurns, type TenantSettings } from '@m2office/shared';
import {
  DecisionRunner, DecisionService, MemoryDecisionStore, parseSpeech, splitReport,
  type LlmProvider, type LlmRequest, type LlmResponse, type Repository,
} from '../src/index.js';
import { readChatStream } from '../src/llm/stream.js';
import type { FileStore } from '../src/files/store.js';

test('発言の形を読む: 見出し・種類・対象・論点・根拠・要旨。番号は振り直し、無い主張を指す返しは新しい論点にする', () => {
  const text = [
    '【A3-1｜反論｜対象 B2-2｜論点 客離れ｜根拠 材料 4・推測】',
    '前回は競合も値上げしていました（材料 4）。',
    '【A3-9｜修正案｜対象 B9-9｜論点 粗利｜根拠 材料5】',
    '3 品だけにすべきです。',
    '要旨:',
    'A3-1: 今回の客離れは前回より大きい',
  ].join('\n');
  const p = parseSpeech(text, 'A3-', new Set(['B2-2']));
  assert.deepEqual(p.problems, []);
  assert.equal(p.claims.length, 2);
  assert.deepEqual([p.claims[0]!.code, p.claims[0]!.kind, p.claims[0]!.target, p.claims[0]!.issue, p.claims[0]!.grounds], ['A3-1', 'rebut', 'B2-2', '客離れ', ['材料 4', '推測']]);
  assert.equal(p.claims[0]!.gist, '今回の客離れは前回より大きい');
  // 2 つ目は番号を振り直し、無い主張（B9-9）を指していたので新しい論点として残す
  assert.deepEqual([p.claims[1]!.code, p.claims[1]!.kind, p.claims[1]!.target, p.claims[1]!.grounds], ['A3-2', 'new', null, ['材料 5']]);
  assert.equal(p.claims[1]!.gist, '3 品だけにすべきです。');
  // 見出しが無ければ崩れている
  assert.ok(parseSpeech('ただの文です', 'A1-', new Set()).problems.length > 0);
  assert.deepEqual(splitReport('前置き\n## 見立て\n条件つきで進めてよい\n理由\n## 第三の案\n3 品だけ').map((x) => x.heading), ['見立て', '第三の案']);
});

test('ターン数: 既定 10・1〜30。本討論は指定の 7 割まで（切り上げ）、3 以下は全部を本討論に使う', () => {
  assert.equal(clampDecisionTurns(undefined), 10);
  assert.equal(clampDecisionTurns(500), 30);
  assert.equal(clampDecisionTurns(0), 1);
  assert.deepEqual([1, 3, 4, 10, 30].map(decisionMainTurns), [1, 3, 3, 7, 21]);
});

test('OpenAI 互換の少しずつの応答を、切れ端ごとに渡して全文と使った量を返す（行が途中で切れても読む）', async () => {
  const body = [
    'data: {"model":"m1","choices":[{"delta":{"content":"こん"}}]}\n',
    'data: {"choices":[{"delta":{"content":"にちは"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}\n',
    'data: [DONE]\n',
  ].join('');
  const enc = new TextEncoder().encode(body);
  const stream = new ReadableStream({ start(c) { c.enqueue(enc.slice(0, 30)); c.enqueue(enc.slice(30)); c.close(); } });
  const chunks: string[] = [];
  const res = await readChatStream(new Response(stream), [{ role: 'user', content: 'あ' }], 'fallback', (c) => chunks.push(c));
  assert.deepEqual(chunks, ['こん', 'にちは']);
  assert.deepEqual([res.text, res.inputTokens, res.outputTokens, res.model], ['こんにちは', 12, 3, 'm1']);
});

/** 決まった答えを返す推論。少しずつ返す。 */
function fakeLlm(opts: { freshUntil?: number; failOn?: RegExp } = {}): LlmProvider & { calls: string[] } {
  const calls: string[] = [];
  const answer = (req: LlmRequest): string => {
    const system = req.messages[0]?.content ?? '';
    const user = req.messages.map((m) => m.content).join('\n');
    calls.push(user);
    if (opts.failOn?.test(user)) throw new Error('わざと失敗');
    if (user.includes('お題: ')) return '{"question": "主力商品 A を来月から 10% 値上げするか", "viewpoints": ["客離れ", "粗利"], "unclear": ""}';
    if (user.includes('書き直してください')) return '【X|新しい論点】ダメ';
    const prefix = /主張の番号は ([AB])(\d+)-1/.exec(user);
    if (prefix && (system.includes('慎重の役') || system.includes('推進の役'))) {
      const [, letter, t] = prefix;
      const turn = Number(t);
      const other = letter === 'A' ? 'B' : 'A';
      const fresh = turn <= (opts.freshUntil ?? 99);
      const dig = /論点「(.+?)」だけについて/.exec(user)?.[1];
      if (turn === 1 && letter === 'A') {
        return ['【A1-1｜新しい論点｜論点 客離れ｜根拠 材料 1】', '常連が離れる。', '【A1-2｜新しい論点｜論点 粗利｜根拠 推測】', '10% は上げ過ぎ。', '要旨:', 'A1-1: 常連が離れる', 'A1-2: 上げ過ぎ'].join('\n');
      }
      if (turn === 1 && letter === 'B' && user.includes('A1-1')) {
        return ['【B1-1｜反論｜対象 A1-1｜根拠 材料 2】', '前回は −2% で済んだ。', '要旨:', 'B1-1: 前回は −2%'].join('\n');
      }
      if (turn === 1) {
        return [`【${letter}1-1｜新しい論点｜論点 粗利｜根拠 材料 1】`, '粗利が戻る。', '要旨:', `${letter}1-1: 粗利が戻る`].join('\n');
      }
      // 2 ターン目から: 相手の前のターンの 1 つ目に返す。fresh の間は新しい材料を根拠にする
      const target = `${other}${letter === 'A' ? turn - 1 : turn}-1`;
      const known = user.includes(target) ? target : `${other}1-1`;
      const ground = fresh ? `材料 ${turn + 2}` : '材料 1';
      return [`【${letter}${turn}-1｜反論｜対象 ${known}${dig ? `｜論点 ${dig}` : ''}｜根拠 ${ground}】`, `${turn} ターン目の反論。`, '要旨:', `${letter}${turn}-1: ${turn} ターン目の反論`].join('\n');
    }
    if (user.includes('本討論で決着しなかった論点')) return '{"digs": [{"issue": "客離れ", "question": "3 か月の客離れは 5% を超えるか"}]}';
    if (user.includes('2 つの討論を別々に')) return '{"agreement": "split", "splits": [{"issue": "客離れ", "reason": "B1-1 の評価が違う"}], "onlyIn": []}';
    if (user.includes('経営者への報告')) return '## 見立て\n条件つきで進めてよい\n客離れは小さい\n## 議論の流れ\n客離れは B1-1 で崩れた\n## 進めるなら\n3 か月で客数が 15% 減ったら戻す';
    if (user.includes('いまの区切り')) {
      const final = user.includes('pivots');
      return JSON.stringify({
        claims: [{ code: 'A1-1', state: 'refuted', by: 'B1-1', reason: '前回の数で崩れた' }, { code: 'A1-2', state: 'unanswered', reason: '答えが無い' }],
        issues: [{ issue: '客離れ', lean: 'even', changedBy: 'B1-1', reason: '互角' }, { issue: '粗利', lean: 'con', reason: '慎重が優勢' }],
        note: 'まとめ', ...(final ? { pivots: [{ code: 'B1-1', change: '客離れの懸念が弱まった' }], verdict: '条件つきで進めてよい' } : {}),
      });
    }
    return '{}';
  };
  const complete = async (req: LlmRequest): Promise<LlmResponse> => ({ text: answer(req), tokensUsed: 10, inputTokens: 8, outputTokens: 2, model: 'fake' });
  return {
    name: 'fake', calls, complete,
    async completeStream(req, onText) {
      const text = answer(req);
      for (let i = 0; i < text.length; i += 20) onText(text.slice(i, i + 20));
      return { text, tokensUsed: 10, inputTokens: 8, outputTokens: 2, model: 'fake' };
    },
  };
}

function setup(llm: LlmProvider = fakeLlm()) {
  const settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, decisions: { enabled: true }, company: { ...DEFAULT_TENANT_SETTINGS.company, legalName: '株式会社アルファ商事' } };
  const users = [
    { id: 'boss', roles: ['admin'], status: 'active' },
    { id: 'exec', roles: ['member'], status: 'active' },
    { id: 'other', roles: ['admin'], status: 'active' },
  ];
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const notes: { userId: string; kind: string; title: string }[] = [];
  const repo = {
    listUsers: async () => users,
    getTenantSettings: async () => settings,
    listTenantIds: async () => ['t1'],
    listUserGroupIds: async () => [],
    getUserSettings: async () => ({ notifications: { kinds: { decision: true } } }),
    createNotification: async (n: { userId: string; kind: string; title: string }) => { notes.push(n); },
    appendAudit: async (e: { action: string; detail: Record<string, unknown> }) => { audits.push(e); },
    getFile: async () => null,
  } as unknown as Repository;
  const store = new MemoryDecisionStore();
  let writes = 0;
  const setTurn = store.setTurn.bind(store);
  store.setTurn = async (...a) => { writes++; return setTurn(...a); };
  const service = new DecisionService({ store, repo, files: {} as FileStore, llmFor: async () => llm });
  // 材料集め（付属の業務）の代わり
  (service.engine as unknown as { deps: { gather: unknown } }).deps.gather = async () => ({
    materials: [
      { no: 0, kind: 'company', title: '会社情報', source: '会社情報', summary: '株式会社アルファ商事', ok: true },
      { no: 0, kind: 'data', title: '売上', source: 'sales.brief', summary: '主力商品 A の月の売上 300 万円', ok: true },
    ],
    missing: ['原価'],
  });
  (service.engine as unknown as { flushMs: number }).flushMs = 0;
  const runner = new DecisionRunner(service, repo, { staleMs: 60_000 });
  return { service, store, runner, audits, notes, writes: () => writes };
}

const boss = { tenantId: 't1', userId: 'boss' };

test('討論の流れ: 判断の問い → 材料 → 本討論（7 割）→ 途中のまとめ → 深掘り → 終わりのまとめ → 報告。知らせと監査の中身', async () => {
  const s = setup();
  const created = await s.service.start(boss, { topic: 'この商品の値上げを 10% 考えているが、いかがでしょうか？', turns: 4 });
  assert.equal(created.status, 'queued');
  assert.equal(await s.runner.poll(), 1);
  await s.runner.idle();
  const d = (await s.service.detail(boss, created.id))!;
  assert.equal(d.session.status, 'done', d.session.endNote);
  assert.equal(d.session.question, '主力商品 A を来月から 10% 値上げするか');
  assert.deepEqual(d.materials.map((m) => [m.no, m.kind]), [[1, 'company'], [2, 'data']]);
  assert.deepEqual(d.session.missing, ['原価']);
  // 本討論は 4 の 7 割（切り上げ）= 3 ターン、残りの 1 ターンを深掘りに
  const speeches = d.turns.filter((t) => t.role === 'con' || t.role === 'pro');
  assert.deepEqual([...new Set(speeches.filter((t) => t.stage === 'main').map((t) => t.turn))], [1, 2, 3]);
  assert.deepEqual(speeches.filter((t) => t.stage === 'dig').map((t) => [t.turn, t.issue]), [[4, '客離れ'], [4, '客離れ']]);
  assert.deepEqual(d.session.digs.map((x) => [x.issue, x.turns, x.done]), [['客離れ', 1, true]]);
  // 全文を残す（書きかけの間も書き足す）
  assert.ok(speeches.every((t) => t.done && t.text.includes('【')));
  assert.ok(s.writes() > speeches.length, '書かれるそばから書き足す');
  // 主張: 返しは向けた主張の論点に属する。判定の役が状態と分かれ目を付ける
  const b11 = d.claims.find((c) => c.code === 'B1-1')!;
  assert.deepEqual([b11.target, b11.issue, b11.pivot], ['A1-1', '客離れ', true]);
  const a11 = d.claims.find((c) => c.code === 'A1-1')!;
  assert.deepEqual([a11.state, a11.refutedBy], ['refuted', 'B1-1']);
  // 優勢の推移: 3 ターン目は本討論の終わりと同じなので途中のまとめは置かず、本討論の終わり・深掘りの終わり・討論の終わり
  assert.deepEqual([...new Set(d.issueStates.map((x) => x.at))], ['main', 'dig:客離れ', 'end']);
  // 報告
  assert.equal(d.session.report?.verdict, '条件つきで進めてよい');
  assert.deepEqual(d.session.report?.sections.map((x) => x.heading), ['見立て', '議論の流れ', '進めるなら']);
  assert.equal(d.session.endReason, 'turns');
  assert.equal(s.notes[0]?.kind, 'decision');
  // 監査ログに、お題と報告の中身を入れない
  assert.ok(!JSON.stringify(s.audits).includes('値上げ'));
});

test('早めの終わり: 2 ターン続けて新しい論点も新しい材料の根拠も無ければ、本討論を終えて残りを深掘りに回す', async () => {
  const s = setup(fakeLlm({ freshUntil: 2 }));
  const created = await s.service.start(boss, { topic: '値上げ', turns: 10 });
  await s.runner.poll();
  await s.runner.idle();
  const d = (await s.service.detail(boss, created.id))!;
  assert.equal(d.session.status, 'done', d.session.endNote);
  const main = [...new Set(d.turns.filter((t) => t.stage === 'main' && t.role === 'con').map((t) => t.turn))];
  assert.deepEqual(main, [1, 2, 3, 4]);
  assert.equal(d.session.endReason, 'exhausted');
  assert.match(d.session.endNote, /4 ターンで論点が出尽くしました/);
  // 3 ターン目に途中のまとめ
  assert.ok(d.issueStates.some((x) => x.at === 't3'));
  // 残り 6 ターンを深掘りに（1 ターンで新しい主張が無ければ終える）
  assert.ok(d.turns.some((t) => t.stage === 'dig'));
});

test('突き合わせ: 2 つの討論を別々に（討論 2 は推進の役から）。番号に 2: を付け、割れた論点を残す', async () => {
  const s = setup();
  const created = await s.service.start(boss, { topic: '出店', turns: 3, crossCheck: true });
  await s.runner.poll();
  await s.runner.idle();
  const d = (await s.service.detail(boss, created.id))!;
  assert.equal(d.session.status, 'done', d.session.endNote);
  const two = d.turns.filter((t) => t.debate === 2 && (t.role === 'con' || t.role === 'pro'));
  assert.equal(two[0]!.role, 'pro', '討論 2 は推進の役から');
  assert.ok(d.claims.some((c) => c.code.startsWith('2:')));
  assert.ok(d.claims.filter((c) => c.debate === 2).every((c) => !c.target || c.target.startsWith('2:') || c.target.startsWith('人')));
  assert.equal(d.session.comparison?.agreement, 'split');
  assert.deepEqual(d.session.comparison?.splits.map((x) => x.issue), ['客離れ']);
  assert.ok(d.turns.some((t) => t.stage === 'compare'));
});

test('見せる範囲: 始めた人と共有された人だけ。共有された人は見るだけ。割り込みは記録と材料の両方に残る', async () => {
  const s = setup();
  const created = await s.service.start(boss, { topic: '採用', turns: 1 });
  assert.equal(await s.service.detail({ tenantId: 't1', userId: 'other' }, created.id), null, '管理者でも、ほかの人の相談は見られない');
  await s.service.share(boss, created.id, ['exec']);
  assert.ok(await s.service.detail({ tenantId: 't1', userId: 'exec' }, created.id));
  await assert.rejects(s.service.interject({ tenantId: 't1', userId: 'exec' }, created.id, '口を挟む'), /見るだけ/);
  await s.service.interject(boss, created.id, '原価はここ 1 年上がっていない');
  const d = (await s.service.detail(boss, created.id))!;
  assert.ok(d.claims.some((c) => c.code === '人1' && c.role === 'human'));
  assert.ok(d.materials.some((m) => m.kind === 'human'));
  assert.deepEqual((await s.service.list({ tenantId: 't1', userId: 'exec' })).map((x) => x.mine), [false]);
});

test('止める: 動いている討論は、そこまでで報告をまとめて「止めた」にする。始める前なら、そのまま止める', async () => {
  const s = setup();
  const queued = await s.service.start(boss, { topic: 'A', turns: 2 });
  await s.service.stop(boss, queued.id);
  assert.equal((await s.store.get('t1', queued.id))!.status, 'stopped');

  const created = await s.service.start(boss, { topic: 'B', turns: 10 });
  // 2 ターン目の慎重の役が話し始めたら止める
  const store = s.store;
  const create = store.createTurn.bind(store);
  store.createTurn = async (t, sid, d) => {
    const row = await create(t, sid, d);
    if (d.role === 'con' && d.turn === 2) await store.update(t, sid, { stopRequested: true });
    return row;
  };
  await s.runner.poll();
  await s.runner.idle();
  const d = (await s.service.detail(boss, created.id))!;
  assert.equal(d.session.status, 'stopped');
  assert.equal(d.session.endReason, 'stopped');
  assert.ok(d.turns.some((t) => t.stopped), '書きかけの発言は、そこまでを残して印を付ける');
  assert.ok(d.session.report, 'そこまでの討論で報告をまとめる');
  // 続ける
  await s.service.continueDebate(boss, created.id, 2);
  assert.equal((await s.store.get('t1', created.id))!.pending?.kind, 'continue');
});

test('差分: 前に受け取った番号より後に変わったものだけを返す', async () => {
  const s = setup();
  const created = await s.service.start(boss, { topic: 'C', turns: 1 });
  const first = (await s.service.changes(boss, created.id, 0))!;
  assert.ok(first.session);
  const none = (await s.service.changes(boss, created.id, first.rev))!;
  assert.equal(none.session, undefined);
  await s.runner.poll();
  await s.runner.idle();
  const after = (await s.service.changes(boss, created.id, first.rev))!;
  assert.ok((after.turns?.length ?? 0) > 0 && after.rev > first.rev);
  assert.equal(await s.service.changes({ tenantId: 't1', userId: 'other' }, created.id, 0), null);
});
