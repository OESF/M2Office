/**
 * @file 朝のブリーフと本人の情報の単体テスト（仕様書 第9.5.5.1節、ADR-0034）。
 *
 * 定時実行の「毎平日」、本人の情報を読む道具 `profile.read`、朝のブリーフの定義（読むだけ・天気とニュースを調べる）を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_TOOLS, MORNING_BRIEF, OFFICIAL_AGENTS, ToolRegistry, describeRule, nextRunAt, validateDefinition, type ToolContext,
} from '../src/index.js';

const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);

test('毎平日: 金曜の朝の後は月曜の朝。土日は飛ばす', () => {
  const rule = { kind: 'weekdays' as const, hour: 7, minute: 30 };
  // 2026-10-02 は金曜。8 時（日本時間）を過ぎたら、次は 10-05（月）の 7:30
  assert.equal(nextRunAt(rule, 'Asia/Tokyo', new Date('2026-10-01T23:00:00Z')), '2026-10-04T22:30:00.000Z');
  // 月曜の 7 時なら、その日の 7:30
  assert.equal(nextRunAt(rule, 'Asia/Tokyo', new Date('2026-10-04T22:00:00Z')), '2026-10-04T22:30:00.000Z');
  assert.equal(describeRule(rule), '毎平日（月〜金） 7:30');
});

function ctx(profile: { home: string; workplace: string }, address = '東京都千代田区丸の内 1-1'): ToolContext {
  return {
    tenantId: 't', userId: 'u', runId: 'r', compartment: null,
    repo: {
      findUserById: async () => ({ id: 'u', displayName: '三浦' }),
      getUserSettings: async () => ({ profile: { furigana: '', title: '代表', timezone: 'Asia/Tokyo', ...profile } }),
      getTenantSettings: async () => ({ company: { legalName: '株式会社見本', shortName: '見本', address } }),
    } as never,
    connector: {} as never, files: {} as never,
  };
}

test('profile.read: 本人の自宅・勤務地を返す。勤務地が空なら会社の住所、自宅が空なら登録されていないと返す', async () => {
  const tool = registry.get('profile.read')!;
  assert.equal(tool.risk, 'read');
  const a = await tool.invoke({}, ctx({ home: '横浜市港北区・日吉駅', workplace: '' })) as Record<string, unknown>;
  assert.equal(a['home'], '横浜市港北区・日吉駅');
  assert.equal(a['workplace'], '東京都千代田区丸の内 1-1');
  assert.equal(a['workplaceIsCompanyAddress'], true);
  assert.match(String(a['today']), /^\d{4}-\d{2}-\d{2}（[日月火水木金土]）$/);
  const b = await tool.invoke({}, ctx({ home: '', workplace: '大阪支店' })) as Record<string, unknown>;
  assert.equal(b['home'], '（登録されていません）', '推測で埋めない');
  assert.equal(b['workplace'], '大阪支店');
});

test('朝のブリーフ: 公式の業務で、読むだけの道具だけを使い、天気とニュースを調べる', () => {
  assert.ok(OFFICIAL_AGENTS.includes(MORNING_BRIEF));
  assert.doesNotThrow(() => validateDefinition(MORNING_BRIEF, registry));
  for (const name of MORNING_BRIEF.tools) assert.equal(registry.get(name)?.risk, 'read', `${name} は読むだけ`);
  assert.ok(MORNING_BRIEF.tools.includes('web.research') && MORNING_BRIEF.tools.includes('profile.read'));
  const collect = MORNING_BRIEF.steps[0]!;
  assert.ok(collect.type === 'agent' && /天気/.test(collect.instruction) && /ニュース/.test(collect.instruction));
  assert.ok(!MORNING_BRIEF.steps.some((s) => s.type === 'approval'), '承認は無い');
  assert.ok(OFFICIAL_AGENTS.find((a) => a.id === 'secretary-lookup')!.tools.includes('profile.read'), '調べものも出発地を読める');
});
