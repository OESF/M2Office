/**
 * @file 朝のブリーフの定時実行を、秘書が本人ごとに自動で用意することの単体テスト（仕様書 第9.5.5.1節、ADR-0034）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Schedule } from '@m2office/shared';
import { DEFAULT_USER_SETTINGS } from '@m2office/shared';
import { ensureMorningBrief } from '../src/secretary/morning.js';
import type { AppDeps } from '../src/context.js';

function deps(o: { proactivity?: 'low' | 'normal'; canUse?: boolean; disabled?: string[]; existing?: Schedule[] } = {}) {
  let prefs = structuredClone({ ...DEFAULT_USER_SETTINGS, secretary: { ...DEFAULT_USER_SETTINGS.secretary, proactivity: o.proactivity ?? 'normal' } });
  const created: Schedule[] = [];
  const d = {
    canUse: async () => o.canUse ?? true,
    repo: {
      getUserSettings: async () => structuredClone(prefs),
      saveUserSettings: async (_t: string, _u: string, section: string, value: unknown) => { prefs = { ...prefs, [section]: value }; },
      getTenantSettings: async () => ({ agents: { disabled: o.disabled ?? [] } }),
      listSchedules: async () => [...(o.existing ?? []), ...created],
      createSchedule: async (s: Schedule) => { created.push(s); },
      appendAudit: async () => undefined,
    },
  } as unknown as AppDeps;
  return { d, created, prefs: () => prefs };
}

const NOW = new Date('2026-09-28T01:00:00Z'); // 月曜 10:00（日本時間）

test('まだなら、平日 7:30 の定時実行を用意し、用意したことを記録する。二度目は作らない', async () => {
  const { d, created, prefs } = deps();
  const s = await ensureMorningBrief(d, 't', 'u', NOW);
  assert.equal(s?.agentId, 'morning-brief');
  assert.deepEqual(s?.rule, { kind: 'weekdays', hour: 7, minute: 30 });
  assert.equal(s?.nextRunAt, '2026-09-28T22:30:00.000Z', '次は火曜の 7:30');
  assert.ok(prefs().onboarding.morningBriefAt);
  assert.equal(await ensureMorningBrief(d, 't', 'u', NOW), null);
  assert.equal(created.length, 1);
});

test('積極性が「控えめ」の人・使えない人・会社が無効にした業務には用意しない', async () => {
  for (const o of [{ proactivity: 'low' as const }, { canUse: false }, { disabled: ['morning-brief'] }]) {
    const { d, created } = deps(o);
    assert.equal(await ensureMorningBrief(d, 't', 'u', NOW), null);
    assert.equal(created.length, 0);
  }
});

test('自分で作った朝のブリーフの定時実行があれば、重ねて作らない', async () => {
  const { d, created, prefs } = deps({ existing: [{ agentId: 'morning-brief' } as Schedule] });
  assert.equal(await ensureMorningBrief(d, 't', 'u', NOW), null);
  assert.equal(created.length, 0);
  assert.ok(prefs().onboarding.morningBriefAt, '用意したことは記録する（以後は作らない）');
});
