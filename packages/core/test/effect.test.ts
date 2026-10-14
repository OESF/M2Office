/**
 * @file 効果の欄と効果のレポートの単体テスト（仕様書 第6.7.13節）。期間の決め方・数字の計算（プログラムが計算する）・気づき・
 * 推論が使えないときの文・Markdown・毎月 1 日 7 時の見回り（1 回だけ・使っていない会社には作らない・管理者に知らせる）・作り直し。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type Notification, type TenantSettings } from '@m2office/shared';
import {
  EffectService, MemoryEffectStore, buildEffectFigures, effectNotices, effectMonthRange, effectPeriodRange, effectReportMarkdown, plainEffectReport,
  type Repository,
} from '../src/index.js';

test('月の期間は日本時間の暦で、今月は今日まで', () => {
  const now = new Date('2026-10-14T03:00:00Z'); // 日本時間 10 月 14 日 12 時
  const r = effectMonthRange('2026-10', now);
  assert.equal(r.from.toISOString(), '2026-09-30T15:00:00.000Z');
  assert.equal(r.until, now);
  assert.equal(r.toDay, '2026-10-14');
  assert.equal(r.label, '2026 年 10 月（14 日まで）');
  const last = effectPeriodRange('lastMonth', now, null);
  assert.equal(last.fromDay, '2026-09-01');
  assert.equal(last.toDay, '2026-09-30');
  assert.equal(last.until.toISOString(), '2026-09-30T15:00:00.000Z');
  const all = effectPeriodRange('all', now, new Date('2026-08-20T01:00:00Z'));
  assert.equal(all.fromDay, '2026-08-20');
  assert.match(all.label, /導入から/);
});

const base = {
  period: 'lastMonth' as const,
  range: effectPeriodRange('lastMonth', new Date('2026-10-14T03:00:00Z'), null),
  names: (id: string) => ({ minutes: '議事録の作成・共有', inbox: 'メールの整理', qa: '社内ナレッジ Q&A', 'secretary-lookup': '調べもの' } as Record<string, string>)[id] ?? id,
  defaults: { minutes: 30, inbox: 15, qa: 10 },
  purposeLabel: (p: string) => ({ secretary: '秘書', 'agent:minutes': '議事録の作成・共有' } as Record<string, string>)[p] ?? p,
  internal: new Set(['secretary-lookup']),
};

test('数字はプログラムが計算する（削減時間・費用・1 時間あたり・前の期間・使われなかった業務）', () => {
  const f = buildEffectFigures({
    ...base,
    runs: [{ agentId: 'minutes', completed: 12, savedMinutes: 360 }, { agentId: 'inbox', completed: 4, savedMinutes: 80 }, { agentId: 'qa', completed: 0, savedMinutes: 0 }],
    ai: [{ purpose: 'secretary', costJpy: 300.4, calls: 50 }, { purpose: 'agent:minutes', costJpy: 580.2, calls: 12 }],
    previous: { label: '2026 年 8 月', runs: [{ agentId: 'minutes', completed: 4, savedMinutes: 120 }], aiCostJpy: 400 },
    usable: [{ id: 'minutes', name: '議事録' }, { id: 'inbox', name: 'メール' }, { id: 'qa', name: 'Q&A' }, { id: 'secretary-lookup', name: '調べもの' }],
    minutesPerRun: { inbox: 20 },
  });
  assert.equal(f.completed, 16);
  assert.equal(f.savedMinutes, 440);
  assert.equal(f.aiCostJpy, 881);
  // 881 円 ÷ 7.33 時間
  assert.equal(f.costPerSavedHourJpy, 120);
  assert.deepEqual(f.byAgent.map((a) => a.agentId), ['minutes', 'inbox']);
  assert.equal(f.byAgent[0]!.previousCompleted, 4);
  assert.equal(f.byAgent[1]!.customized, true);
  assert.equal(f.byAgent[1]!.minutesPerRun, 20);
  assert.equal(f.byAgent[0]!.minutesPerRun, 30);
  assert.deepEqual(f.byPurpose.map((x) => x.label), ['議事録の作成・共有', '秘書']);
  assert.deepEqual(f.previous, { label: '2026 年 8 月', completed: 4, savedMinutes: 120, aiCostJpy: 400 });
  // 秘書が自分で使う業務は「使われなかった」に出さない
  assert.deepEqual(f.unusedAgents, ['社内ナレッジ Q&A']);
  const notices = effectNotices(f);
  assert.ok(notices.some((n) => n.includes('4 件から 12 件に増えました')));
  assert.ok(notices.some((n) => n.includes('社内ナレッジ Q&A')));
  assert.ok(notices.some((n) => n.includes('公式の既定値のまま')));
});

test('削減時間が 0 なら 1 時間あたりの費用は出さず、決まった形の文で作れる', () => {
  const f = buildEffectFigures({ ...base, runs: [], ai: [{ purpose: 'secretary', costJpy: 12, calls: 3 }], previous: null, usable: [], minutesPerRun: {} });
  assert.equal(f.costPerSavedHourJpy, null);
  const body = plainEffectReport(f, []);
  assert.equal(body.summary.length, 3);
  assert.match(body.balance, /比べられません/);
  const md = effectReportMarkdown({ figures: f, body }, 'アルファ');
  assert.match(md, /^# アルファ M2Office の効果のレポート/);
  assert.match(md, /推計です/);
});

function setup() {
  const settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, company: { ...DEFAULT_TENANT_SETTINGS.company, legalName: '株式会社アルファ商事', shortName: 'アルファ' } };
  const notes: Notification[] = [];
  const audits: string[] = [];
  const users = [
    { id: 'boss', roles: ['admin'], status: 'active' },
    { id: 'u1', roles: ['member'], status: 'active' },
  ];
  const repo = {
    listTenantIds: async () => ['t1', 't2'],
    getTenantSettings: async () => settings,
    listUsers: async () => users,
    createNotification: async (n: Notification) => { notes.push(n); },
    appendAudit: async (e: { action: string }) => { audits.push(e.action); },
  } as unknown as Repository;
  const store = new MemoryEffectStore();
  const service = new EffectService({
    store, repo, llmFor: async () => ({ name: 'stub' }) as never,
    agentsFor: async () => ({ usable: [{ id: 'minutes', name: '議事録の作成・共有' }], all: [{ id: 'minutes', name: '議事録の作成・共有' }] }),
  });
  return { service, store, notes, audits };
}

test('毎月 1 日 7 時を過ぎたら先月の分を 1 回だけ作り、管理者に知らせる。使っていない会社には作らない', async () => {
  const { service, store, notes } = setup();
  store.runs.push({ tenantId: 't1', agentId: 'minutes', completed: 3, savedMinutes: 90, at: new Date('2026-09-10T00:00:00Z') });
  store.ai.push({ tenantId: 't1', purpose: 'secretary', costJpy: 50, calls: 5, at: new Date('2026-09-11T00:00:00Z') });
  // 1 日の 6 時台（日本時間）はまだ作らない
  assert.deepEqual(await service.tick(new Date('2026-09-30T21:30:00Z')), { created: 0 });
  assert.deepEqual(await service.tick(new Date('2026-09-30T22:30:00Z')), { created: 1 });
  assert.deepEqual(await service.tick(new Date('2026-10-01T03:00:00Z')), { created: 0 });
  const [r] = await store.list('t1', 25);
  assert.equal(r!.month, '2026-09');
  assert.equal(r!.kind, 'monthly');
  assert.equal((await store.list('t2', 25)).length, 0);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.userId, 'boss');
  assert.equal(notes[0]!.kind, 'effect');
  const full = await store.byMonth('t1', '2026-09');
  assert.equal(full!.figures.savedMinutes, 90);
  assert.equal(full!.figures.aiCostJpy, 50);
});

test('管理者は今月の分を作り直せ、同じ月は置き換える', async () => {
  const { service, store, audits } = setup();
  const now = new Date('2026-10-14T03:00:00Z');
  store.runs.push({ tenantId: 't1', agentId: 'minutes', completed: 2, savedMinutes: 60, at: new Date('2026-10-05T00:00:00Z') });
  const a = await service.create({ tenantId: 't1', userId: 'boss' }, 'this', now);
  assert.equal(a.month, '2026-10');
  assert.equal(a.kind, 'manual');
  store.runs.push({ tenantId: 't1', agentId: 'minutes', completed: 1, savedMinutes: 30, at: new Date('2026-10-06T00:00:00Z') });
  const b = await service.create({ tenantId: 't1', userId: 'boss' }, 'this', now);
  assert.equal(b.id, a.id);
  assert.equal(b.figures.savedMinutes, 90);
  assert.equal((await service.list('t1')).length, 1);
  assert.deepEqual(audits, ['effect.report', 'effect.report']);
  // ほかの会社からは見えない
  assert.equal(await service.get('t2', a.id), null);
});
