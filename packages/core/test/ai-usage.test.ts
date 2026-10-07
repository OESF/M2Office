/**
 * @file AI の利用の記録と上限の単体テスト（仕様書 第6.6.2節「AI の利用の記録と上限」、ADR-0079）。
 * 実際に効く上限の決め方、月の区切り、上限の確かめ（会社と 1 人）、8 割・10 割・1 人の上限の知らせ（月に 1 度）、
 * 暴走の見張り、AI の呼び出しの包み（記録・業務の実行の中とローカル AI は止めない）、用途と持ち主の受け渡し。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AiLimitSettings, Notification } from '@m2office/shared';
import {
  AiUsageMeter, AiLimitError, effectiveMonthlyLimit, jstMonth, meterLlm, purposeGroup, withAiUsage,
  type AiUsageEntry, type AiUsageStore, type AiUsageTotals, type LlmProvider,
} from '../src/index.js';

/** 手元の記録の置き場。 */
function memoryStore() {
  const rows: (AiUsageEntry & { at: Date })[] = [];
  const alerts = new Set<string>();
  let clock = new Date('2026-10-15T03:00:00Z');
  const store: AiUsageStore = {
    insert: async (_t, e) => { rows.push({ ...e, at: clock }); },
    totals: async (_t, since): Promise<AiUsageTotals> => {
      const xs = rows.filter((r) => r.at >= since);
      const byUser = new Map<string | null, { userId: string | null; costJpy: number; calls: number }>();
      const byPurpose = new Map<string, { purpose: string; costJpy: number; calls: number }>();
      for (const r of xs) {
        const u = byUser.get(r.userId) ?? { userId: r.userId, costJpy: 0, calls: 0 }; u.costJpy += r.costJpy; u.calls++; byUser.set(r.userId, u);
        const p = byPurpose.get(r.purpose) ?? { purpose: r.purpose, costJpy: 0, calls: 0 }; p.costJpy += r.costJpy; p.calls++; byPurpose.set(r.purpose, p);
      }
      return { costJpy: xs.reduce((a, r) => a + r.costJpy, 0), calls: xs.length, byUser: [...byUser.values()], byPurpose: [...byPurpose.values()] };
    },
    daily: async (_t, since) => {
      const m = new Map<string, number>();
      for (const r of rows.filter((x) => x.at >= since)) {
        const day = new Date(r.at.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
        m.set(day, (m.get(day) ?? 0) + r.costJpy);
      }
      return [...m.entries()].sort().map(([day, costJpy]) => ({ day, costJpy }));
    },
    markAlert: async (_t, month, level, userId) => { const k = `${month}/${level}/${userId}`; if (alerts.has(k)) return false; alerts.add(k); return true; },
    prune: async () => 0,
  };
  return { store, rows, setClock: (d: Date) => { clock = d; }, now: () => clock };
}

function setup(limits: AiLimitSettings, source: 'platform' | 'tenant' = 'platform', cap: number | null = null) {
  const mem = memoryStore();
  const sent: Notification[] = [];
  const meter = new AiUsageMeter({
    store: mem.store, platformCap: cap, now: mem.now,
    limits: { limits: async () => limits, source: async () => source },
    notify: async (n) => { sent.push(n); },
    admins: async () => ['admin1'],
  });
  return { ...mem, meter, sent };
}

const entry = (userId: string | null, costJpy: number, purpose = 'secretary'): AiUsageEntry => ({
  userId, purpose, model: 'gemini-3.1-flash-lite', inputTokens: 100, outputTokens: 10, units: 0, costJpy, local: false, runId: null,
});

test('実際に効く上限: 自社の鍵は会社の設定どおり。運営一括は運営の上限を超えない（未設定なら運営の上限）', () => {
  assert.equal(effectiveMonthlyLimit({ monthlyJpy: null, perUserShare: 0.4 }, 'tenant', 5000), null);
  assert.equal(effectiveMonthlyLimit({ monthlyJpy: 9000, perUserShare: 0.4 }, 'tenant', 5000), 9000);
  assert.equal(effectiveMonthlyLimit({ monthlyJpy: null, perUserShare: 0.4 }, 'platform', 5000), 5000);
  assert.equal(effectiveMonthlyLimit({ monthlyJpy: 9000, perUserShare: 0.4 }, 'platform', 5000), 5000);
  assert.equal(effectiveMonthlyLimit({ monthlyJpy: 3000, perUserShare: 0.4 }, 'platform', 5000), 3000);
  assert.equal(effectiveMonthlyLimit({ monthlyJpy: null, perUserShare: 0.4 }, 'platform', null), null);
});

test('月の区切り: 日本の時刻の 1 日 0 時から', () => {
  assert.deepEqual(jstMonth(new Date('2026-09-30T15:30:00Z')), { month: '2026-10', start: new Date('2026-09-30T15:00:00Z') });
  assert.equal(jstMonth(new Date('2026-09-30T14:59:00Z')).month, '2026-09');
  assert.equal(purposeGroup('api:columns/abc'), 'api:columns');
  assert.equal(purposeGroup('agent:minutes'), 'agent:minutes');
});

test('上限: 会社の上限と 1 人の上限（4 割）で止める。上限なしなら止めない', async () => {
  const s = setup({ monthlyJpy: 1000, perUserShare: 0.4 });
  assert.equal((await s.meter.check('t1', 'u1')).blocked, null);
  await s.meter.record('t1', entry('u1', 400));
  const mine = (await s.meter.check('t1', 'u1')).blocked;
  assert.ok(mine instanceof AiLimitError && mine.scope === 'user');
  assert.equal((await s.meter.check('t1', 'u2')).blocked, null, 'ほかの人は止めない');
  await s.meter.record('t1', entry('u2', 300));
  await s.meter.record('t1', entry(null, 300, 'worker'));
  const all = (await s.meter.check('t1', 'u3')).blocked;
  assert.ok(all instanceof AiLimitError && all.scope === 'company');
  const none = setup({ monthlyJpy: null, perUserShare: 0.4 }, 'tenant');
  await none.meter.record('t1', entry('u1', 99_999));
  assert.equal((await none.meter.check('t1', 'u1')).blocked, null);
});

test('知らせ: 8 割と 10 割で管理者に、1 人の上限で本人に。月に 1 度だけ', async () => {
  const s = setup({ monthlyJpy: 1000, perUserShare: 0.5 });
  await s.meter.record('t1', entry('u1', 500));
  assert.deepEqual(s.sent.map((n) => [n.userId, n.kind]), [['u1', 'usageSelf']]);
  await s.meter.record('t1', entry('u2', 350));
  assert.deepEqual(s.sent.slice(1).map((n) => [n.userId, n.kind, n.title]), [['admin1', 'usage', '今月の AI の利用が上限の 8 割を超えました']]);
  await s.meter.record('t1', entry('u2', 10));
  assert.equal(s.sent.length, 2, '同じ知らせは繰り返さない');
  await s.meter.record('t1', entry('u3', 200));
  assert.equal(s.sent[2]!.title, '今月の AI の利用が上限に達しました');
  assert.match(s.sent[2]!.body, /今月 1,060 円 \/ 上限 1,000 円/);
});

test('暴走の見張り: 前の 14 日の平均の 3 倍を超えた日を、止めずに 1 度だけ知らせる', async () => {
  const s = setup({ monthlyJpy: null, perUserShare: 0.4 }, 'tenant');
  for (let d = 1; d <= 14; d++) {
    s.setClock(new Date(Date.UTC(2026, 9, d, 3)));
    await s.meter.record('t1', entry('u1', 50));
  }
  s.setClock(new Date(Date.UTC(2026, 9, 15, 3)));
  await s.meter.record('t1', entry('u1', 400));
  s.setClock(new Date(Date.UTC(2026, 9, 16, 1)));
  assert.equal(await s.meter.watchSpike('t1'), true);
  assert.match(s.sent[0]!.title, /2026-10-15 の AI の利用がふだんより多く/);
  assert.equal(await s.meter.watchSpike('t1'), false, '同じ日は 1 度だけ');
});

test('包み: 呼び出しごとに用途と人と費用を残す。上限なら新しい呼び出しを止め、業務の実行の中とローカル AI は止めない', async () => {
  const s = setup({ monthlyJpy: 100, perUserShare: 1 });
  const inner: LlmProvider = {
    name: 'fake',
    complete: async () => ({ text: 'ok', tokensUsed: 1100, inputTokens: 1000, outputTokens: 100, model: 'gemini-3.1-flash-lite' }),
  };
  const llm = meterLlm('t1', inner, s.meter);
  await withAiUsage({ userId: 'u1', purpose: 'api:columns' }, () => llm.complete({ tier: 'fast', messages: [] }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0]!.purpose, 'api:columns');
  assert.equal(s.rows[0]!.userId, 'u1');
  assert.ok(s.rows[0]!.costJpy > 0);
  await s.meter.record('t1', entry('u1', 200));
  await assert.rejects(() => withAiUsage({ userId: 'u1', purpose: 'secretary' }, () => llm.complete({ tier: 'fast', messages: [] })), AiLimitError);
  // 始まっている業務の実行は止めない
  await withAiUsage({ userId: 'u1', purpose: 'agent:minutes', runId: 'r1' }, () => llm.complete({ tier: 'fast', messages: [] }));
  // ローカル AI は止めず、0 円で残す
  const local = meterLlm('t1', inner, s.meter, true);
  await withAiUsage({ userId: 'u1', purpose: 'secretary' }, () => local.complete({ tier: 'fast', messages: [] }));
  await new Promise((r) => setTimeout(r, 0));
  const last = s.rows[s.rows.length - 1]!;
  assert.equal(last.local, true);
  assert.equal(last.costJpy, 0);
});
